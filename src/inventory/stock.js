// Stock movements: receiving (on the floor or the item page, ticked off open POs first), corrections,
// stocktakes, and one item's page.
import { all, get, insert, run, writeTx } from '../db.js';
import { ALLOCATABLE, PO_IS_OPEN } from '../lineState.js';
import { skuNow } from '../relink.js';
import { ACTIVE_VAN, MAX_QTY, NOW_SQL, PRIORITY, checkQty, getItem, httpError, q } from './shared.js';
import { allocateItem, trimReservations } from './allocation.js';
import { lineCover, shortagesCached } from './shortages.js';
import { spareAcks } from './spare.js';
import { reorderSuggestions } from './reorder.js';
import { itemHistory } from './history.js';

// Stock in. Received for a particular van (a PO line for that van, a delivery booked for it): it is
// locked to that van, so re-prioritising never moves it.
// `poRef`: the order number it came on (the van's line naming that order is filled first — see allocateItem).
export async function receive(itemId, qty, { ref = '', note = '', vanId = null, by = '', poRef = '' } = {}) {
  checkQty(qty);
  return writeTx(async () => {
    const mv = await insert(`INSERT INTO movements(item_id, qty, type, ref, note, van_id, worker) VALUES(?, ?, 'receive', ?, ?, ?, ?)`, itemId, qty, ref, note, vanId, by);
    await stockIn(itemId, qty, vanId, by, poRef);
    return mv; // the movement, so a delivery booked on the floor can be undone
  });
}
// Put stock on the shelf and hand it out: received for `vanId` → set aside and locked for that van first.
async function stockIn(itemId, qty, vanId, by = '', poRef = '') {
  await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', qty, itemId);
  await allocateItem(itemId, vanId, { firm: vanId ? qty : 0, reason: 'receive', worker: by, poRef });
}
// How much of a part a van still needs locked for it (customer supplies / to be decided / fitted lines need nothing).
export async function vanNeedLocked(vanId, itemId) {
  return (await get(`SELECT COALESCE(SUM(GREATEST(0, l.qty - l.issued - l.reserved_firm)), 0) AS n FROM van_lines l
              WHERE l.van_id = ? AND l.item_id = ? AND ${ALLOCATABLE('l')}`, vanId, itemId)).n;
}

// Tick some quantity off an open PO line; the PO closes once everything on it has arrived.
// Returns true if this closed the PO.
export async function bookPoLine(pl, q) {
  await run('UPDATE po_lines SET received = received + ? WHERE id = ?', q, pl.id);
  return closePoIfDone(pl.po_id);
}
// A PO is finished once every line has arrived or had its balance cancelled. Returns true if it closed now.
export async function closePoIfDone(poId) {
  if ((await get('SELECT COUNT(*) AS c FROM po_lines WHERE po_id = ? AND received + closed < qty - 1e-9', poId)).c) return false;
  return (await run(`UPDATE purchase_orders SET status = 'closed' WHERE id = ? AND status = 'open'`, poId)).changes > 0;
}

// A delivery booked in on the floor or the item page (not from the PO screen). It's ticked off the
// open purchase orders first, so it isn't counted a second time when the PO is received later:
// lines for this van, then lines for no particular van, then (shelf stock only) other vans' lines —
// those in build order (the shared PRIORITY: the van with first call on stock is ticked off first,
// lines for finished vans last), the PO / line number only as the tie-break. Follow-up round 1
// (chk-r3-1): in line-number order a delivery of 2 went to vans #2 and #4 while #1 and #3 waited.
export async function receiveDelivery(itemId, qty, { ref = '', note = '', vanId = null, by = '' } = {}) {
  checkQty(qty);
  return writeTx(async () => {
    const item = await get('SELECT kind FROM items WHERE id = ?', itemId);
    if (!item) throw httpError(404, 'Item not found');
    const lines = await all(`SELECT pl.*, p.po_no, v.chassis FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                       LEFT JOIN vans v ON v.id = pl.van_id
                       WHERE ${PO_IS_OPEN} AND pl.item_id = ?
                         AND (pl.van_id = ? OR pl.van_id IS NULL OR ? = 'stock')
                       ORDER BY CASE WHEN pl.van_id = ? THEN 0 WHEN pl.van_id IS NULL THEN 1 WHEN ${ACTIVE_VAN} THEN 2 ELSE 3 END,
                         ${PRIORITY}, pl.po_id, pl.id`,
                      itemId, vanId ?? -1, item.kind, vanId ?? -1);
    let left = qty;
    const pos = [];
    // What this booking changes, so Undo (phone round 1, C11) can put every bit of it back.
    const rec = { kind: 'receive', po: [], reopen: [], alloc: [] };
    const held = async () => new Map((await all('SELECT id, van_id, reserved, reserved_firm FROM van_lines WHERE item_id = ? ORDER BY id', itemId)).map(r => [r.id, r]));
    const before = await held();
    const forVan = new Map(); // van → how much of this delivery was ticked off that van's PO lines
    const chassis = new Map(lines.filter(pl => pl.van_id != null).map(pl => [pl.van_id, pl.chassis || '']));
    for (const pl of lines) {
      if (left <= 0) break;
      const q = Math.min(left, pl.qty - pl.received - pl.closed);
      if (await bookPoLine(pl, q)) rec.reopen.push(pl.po_id);
      rec.po.push([pl.id, q]);
      left -= q;
      if (!pos.includes(pl.po_no)) pos.push(pl.po_no);
      if (pl.van_id != null) {
        // per van, per order number (the van's line naming that order is filled first)
        const parts = forVan.get(pl.van_id) || [];
        const same = parts.find(x => x.po === pl.po_no);
        if (same) same.n += q; else parts.push({ po: pl.po_no, n: q });
        forVan.set(pl.van_id, parts);
      }
    }
    // Small fixes & phone round 3 (check-r2-1): what was ticked off a van's PO line is set aside and locked
    // for THAT van (as receiving the PO on the PO screen does) — handing it out in build order instead left
    // the van whose line was ticked with no stock and no open order, so it came back in "Check: already
    // ordered?". Only what is left (shelf PO lines, more than was ordered, a van that no longer needs it)
    // goes to the van the worker picked, or out in build order. One movement, so Undo still covers it all.
    const vanTxt = [];
    let rest = qty;
    for (const [v, parts] of forVan) {
      let got = 0;
      for (const { po, n } of parts) {
        const toVan = Math.min(n, await vanNeedLocked(v, itemId));
        if (toVan > 1e-9) { await stockIn(itemId, toVan, v, by, po); rest -= toVan; got += toVan; }
      }
      if (got > 1e-9) vanTxt.push(`${chassis.get(v)}${forVan.size > 1 || got !== qty ? ` (${q(got)})` : ''}`);
    }
    if (rest > 1e-9) await stockIn(itemId, rest, vanId, by);
    const forNote = vanTxt.length && !(forVan.size === 1 && forVan.has(vanId)) ? `For ${vanTxt.join(', ')}` : '';
    const mv = await insert(`INSERT INTO movements(item_id, qty, type, ref, note, van_id, worker) VALUES(?, ?, 'receive', ?, ?, ?, ?)`, itemId, qty,
      [ref, pos.length ? `PO ${pos.join(', ')}` : ''].filter(Boolean).join(' — '), [note, forNote].filter(Boolean).join(' — '), vanId, by);
    const movementId = mv;
    const after = await held();
    for (const [id, r] of after) {
      const b = before.get(id) || { reserved: 0, reserved_firm: 0 };
      const d = r.reserved - b.reserved, df = r.reserved_firm - b.reserved_firm;
      if (Math.abs(d) > 1e-9 || Math.abs(df) > 1e-9) rec.alloc.push([id, d, df]);
    }
    await run('UPDATE movements SET undo = ? WHERE id = ?', JSON.stringify(rec), movementId);
    // Follow-up round 1 (worker-r3-4): which van(s) THIS delivery went to and how many each — what was newly set
    // aside per van (net, so stock that only changed hands between vans is not counted) — and how many stay on
    // the shelf for no van. The worker's pop-up names only these ("1 → ST0380"), not every van holding the part.
    const perVan = new Map();
    for (const [lineId, d] of rec.alloc) {
      const vId = after.get(lineId).van_id;
      perVan.set(vId, (perVan.get(vId) || 0) + d);
    }
    const got = [...perVan].filter(([, n]) => n > 1e-9);
    // in build order, with each van's chassis number
    const to = got.length ? (await all(`SELECT v.id, v.chassis FROM vans v WHERE v.id IN (${got.map(() => '?').join(',')}) ORDER BY ${PRIORITY}`,
      ...got.map(([v]) => v))).map(v => ({ van_id: v.id, chassis: v.chassis, qty: Math.min(perVan.get(v.id), qty) })) : [];
    const shelf = Math.max(0, qty - to.reduce((s, x) => s + x.qty, 0));
    return { pos, movement_id: movementId, to, shelf: shelf > 1e-9 ? shelf : 0 };
  });
}

// mode 'set' = a count of the shelf: written as movement type 'count' (and the item's "last counted"
// date is set), even when the count matches. mode 'add' = a correction (type 'adjust').
// `type: 'adjust'` forces an adjustment even for 'set' (e.g. "set shelf stock to zero").
export async function adjust(itemId, { mode = 'set', qty, note = '', type, by = '' }) {
  await writeTx(async () => {
    const item = await get('SELECT * FROM items WHERE id = ?', itemId);
    if (!item) throw httpError(404, 'Item not found');
    qty = Number(qty);
    if (!Number.isFinite(qty)) throw httpError(400, 'Type a quantity');
    if (Math.abs(qty) > MAX_QTY) throw httpError(400, `That's too many — at most ${MAX_QTY} at a time`);
    const kind = type || (mode === 'set' ? 'count' : 'adjust');
    // A stock figure that is not a number (Infinity / NaN, saved before quantities were checked): nothing can be
    // added to it, but a count (or "set to zero") puts the real figure back. The movement says so; its qty is
    // 0 because the change from "not a number" has no size.
    if (!Number.isFinite(item.on_hand)) {
      if (mode !== 'set') throw httpError(400, "This part's stock figure is broken — count it (set the number on the shelf) to fix it");
      await run('UPDATE items SET on_hand = ? WHERE id = ?', qty, itemId);
      await run(`INSERT INTO movements(item_id, qty, type, note, worker) VALUES(?, 0, ?, ?, ?)`, itemId, kind,
          [note || (kind === 'count' ? 'Stocktake' : 'Adjustment'), `stock figure was not a number (${item.on_hand}) — set to ${q(qty)}`].join(' · '), by);
      if (kind === 'count') await run(`UPDATE items SET last_counted = ${NOW_SQL} WHERE id = ?`, itemId);
      await trimReservations(itemId, { reason: kind, worker: by });
      await allocateItem(itemId, null, { reason: kind, worker: by });
      return;
    }
    const delta = mode === 'set' ? qty - item.on_hand : qty;
    if (!Number.isFinite(delta) || (delta === 0 && kind !== 'count')) return;
    await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', delta, itemId);
    await run(`INSERT INTO movements(item_id, qty, type, note, worker) VALUES(?, ?, ?, ?, ?)`, itemId, delta, kind,
        note || (kind === 'count' ? (delta ? 'Stocktake' : 'Counted — matches') : 'Adjustment'), by);
    if (kind === 'count') await run(`UPDATE items SET last_counted = ${NOW_SQL} WHERE id = ?`, itemId);
    if (delta < 0) await trimReservations(itemId, { reason: kind, worker: by }); else if (delta > 0) await allocateItem(itemId, null, { reason: kind, worker: by });
  });
}

// rows: [{sku, qty}] — sets the on-hand count for each SKU found.
export async function stocktake(rows, note = 'Stocktake', by = '') {
  const result = { updated: 0, unknown: [] };
  // One write transaction per row, as before (one row's error doesn't undo the rows before it); the part is
  // looked up inside it, so nobody renames it in between.
  for (const r of rows) await writeTx(async () => {
    const item = await get('SELECT id FROM items WHERE sku = ?', skuNow(String(r.sku).trim().toUpperCase()));
    if (!item) { result.unknown.push(r.sku); return; }
    await adjust(item.id, { mode: 'set', qty: Number(r.qty), note, by });
    result.updated++;
  });
  return result;
}

export async function itemDetail(id) {
  const item = await getItem(id);
  if (!item) throw httpError(404, 'Item not found');
  item.area_name = item.area_id ? (await get('SELECT name FROM floor_areas WHERE id = ?', item.area_id))?.name || '' : '';
  const movements = await all(`SELECT m.*, v.chassis FROM movements m LEFT JOIN vans v ON v.id = m.van_id
                         WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 200`, id);
  const usage = await all(`SELECT l.*, v.chassis, v.eta, v.status AS van_status FROM van_lines l JOIN vans v ON v.id = l.van_id
                     WHERE l.item_id = ? AND ${ACTIVE_VAN} ORDER BY ${PRIORITY}`, id);
  const pos = await all(`SELECT pl.*, p.po_no, p.supplier, p.status AS po_status, p.created_at, v.chassis, v.status AS van_status
                   FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id LEFT JOIN vans v ON v.id = pl.van_id
                   WHERE pl.item_id = ? ORDER BY p.id DESC LIMIT 50`, id);
  const rules = await all('SELECT id, name, conditions, qty FROM rules WHERE item_id = ? ORDER BY sort, id', id);
  // Set-aside history (C11) and the suggested reorder level (C10, never applied by itself).
  const history = await itemHistory(id);
  const reorder = item.kind === 'stock' && !item.placeholder ? (await reorderSuggestions([Number(id)])).get(Number(id)) || null : null;
  const unassigned = item.kind === 'per-van' ? Math.max(0, item.available) : 0;
  // check-r4-3: which van lines are covered by another van's spare PO (or a shelf PO), and which PO lines are spare.
  const sh = await shortagesCached();
  const cov = await lineCover({ itemId: Number(id) }, sh);
  for (const u of usage) { const c = cov.get(u.id); if (c) u.cover = c; }
  const spareFor = new Map(); // "po_id|van_id" → vans it covers
  for (const c of sh.cover) if (c.item_id === Number(id)) for (const x of c.from) if (x.spare) {
    const k = `${x.po_id}|${x.van_id}`;
    if (!spareFor.has(k)) spareFor.set(k, []);
    spareFor.get(k).push(`${c.chassis}${x.qty !== 1 ? ` (${q(x.qty)})` : ''}`);
  }
  for (const p of pos) {
    const k = `${p.po_id}|${p.van_id}`;
    if (spareFor.has(k)) p.covers = spareFor.get(k);
    if (p.van_id != null && p.po_status === 'open' && p.qty - p.received - p.closed > 1e-9 && !['planned', 'in_production'].includes(p.van_status)) p.van_gone = 1;
  }
  return { item, movements, usage, pos, rules, history, reorder, unassigned, spare: unassigned ? (await spareAcks([Number(id)])).get(Number(id)) : 0 };
}
