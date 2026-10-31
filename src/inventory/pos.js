// Purchase orders: the list and one PO, what needs checking on them, editing / merging / closing,
// creating and receiving, late lines and dates to check.
import { ID_LIST, all, get, ids, insert, logAlloc, run, syncSuppliers, writeTx } from '../db.js';
import { PO_IS_OPEN, PO_OPEN, today, validDate } from '../lineState.js';
import { ACTIVE_VAN, LINE_EXPECTED, PRIORITY, buildOrderInfo, checkQty, httpError, nearVanSql, q, vanRanks } from './shared.js';
import { itemMedians, qtyCheckFor } from './vans.js';
import { closePoIfDone, receive, vanNeedLocked } from './stock.js';

// POs made from the production plan (the import's pink cells, or "Yes, on order" on Check: already
// ordered?). The plan never says when they were ordered: a blank ordered date on these shows as
// "unknown (from plan)" until someone types it (Small fixes & phone round 1, user-r4-5).
const PLAN_PO_RE = /Imported from the production plan|Order number from the production plan/;
const withPlanFlag = p => ({ ...p, from_plan: PLAN_PO_RE.test(p.notes || '') ? 1 : 0 });

export async function listPOs() {
  return (await all(`SELECT p.*, COUNT(pl.id) AS line_count, COALESCE(SUM(pl.qty),0) AS qty, COALESCE(SUM(pl.received),0) AS received,
                COALESCE(SUM(pl.closed),0) AS closed, CASE WHEN ${PO_TO_CHECK_SQL} THEN 1 ELSE 0 END AS to_check,
                (SELECT string_agg(d.chassis, ', ' ORDER BY d.chassis) FROM (SELECT DISTINCT v.chassis FROM po_lines x JOIN vans v ON v.id = x.van_id WHERE x.po_id = p.id) d) AS vans,
                MIN(CASE WHEN p.status = 'open' AND ${PO_OPEN} > 1e-9 THEN NULLIF(${LINE_EXPECTED}, '') END) AS next_expected
              FROM purchase_orders p LEFT JOIN po_lines pl ON pl.po_id = p.id
              GROUP BY p.id ORDER BY CASE p.status WHEN 'open' THEN 0 ELSE 1 END, p.id DESC`))
    .map(p => withPlanFlag({ ...p, vans: p.vans || '', next_expected: p.next_expected || '' }));
}

export async function getPO(id) {
  const po = await get('SELECT * FROM purchase_orders WHERE id = ?', id);
  if (!po) throw httpError(404, 'PO not found');
  const ranks = await vanRanks();
  const order = await buildOrderInfo();
  const lines = (await all(`SELECT pl.*, i.sku, i.name, i.unit, i.kind, v.chassis, v.eta, v.status AS van_status,
                       (SELECT string_agg(x.state, ',') FROM van_lines x WHERE x.van_id = pl.van_id AND x.item_id = pl.item_id AND x.issued < x.qty) AS van_states
                     FROM po_lines pl JOIN items i ON i.id = pl.item_id
                     LEFT JOIN vans v ON v.id = pl.van_id WHERE pl.po_id = ? ORDER BY i.name, pl.id`, id))
    .map(l => ({ ...l, open: Math.max(0, l.qty - l.received - l.closed), rank: l.van_id != null ? (ranks.get(l.van_id) ?? 1e6) : 1e7,
                 build_pos: order.get(l.van_id)?.pos ?? null, build_why: order.get(l.van_id)?.why ?? '',
                 expected_eff: l.expected || po.expected || '' }));
  // Rows of one part sit together, vans in build order (the "Total arrived" box fills them in that order).
  lines.sort((a, b) => a.name.localeCompare(b.name) || a.item_id - b.item_id || a.rank - b.rank || a.id - b.id);
  const vans = [...new Set(lines.filter(l => l.chassis).map(l => l.chassis))];
  const facts = (await poFacts([po.id])).get(po.id);
  const inactive = await inactiveVanProblem(po, facts);
  return { po: withPlanFlag({ ...po, problems: [...await poProblems(po, facts), ...inactive], to_check: po.status === 'open' && (po.needs_check || inactive.length) ? 1 : 0 }), lines, vans };
}

// "Yes, all on order" marks the POs it creates (in the notes) so a missing delivery date can be flagged.
export const YES_ALL_MARK = 'Yes, all on order';
// What poProblems / inactiveVanProblem need from the database, for many POs in three statements:
// id → { undated, dups, inactive }.
//   undated:  an open line with no date of its own (round 2, sp-r1-4: parts added to a PO already in the system count too)
//   dups:     other POs with the same number. Order numbers on the plan run per supplier ("White Vision 11",
//             "Onex 08"): the same number is only a problem for the same supplier, or when one of them has no
//             supplier (can't tell them apart).
//   inactive: what is still coming for vans that are finished or cancelled, per van and shelf / bought-for-van
async function poFacts(poIds) {
  const facts = new Map(poIds.map(id => [id, { undated: false, dups: [], inactive: [] }]));
  if (!poIds.length) return facts;
  const list = ids(poIds);
  for (const r of await all(`SELECT DISTINCT pl.po_id FROM po_lines pl
                             WHERE pl.po_id IN ${ID_LIST} AND trim(pl.expected) = '' AND ${PO_OPEN} > 1e-9`, list)) facts.get(r.po_id).undated = true;
  for (const r of await all(`SELECT a.id AS for_id, b.po_no, b.supplier FROM purchase_orders a
                             JOIN purchase_orders b ON b.id <> a.id AND lower(trim(b.po_no)) = lower(trim(a.po_no))
                               AND (lower(trim(b.supplier)) = lower(trim(a.supplier)) OR trim(b.supplier) = '' OR trim(a.supplier) = '')
                             WHERE a.id IN ${ID_LIST} ORDER BY b.id`, list)) facts.get(r.for_id).dups.push(r);
  for (const r of await all(`SELECT pl.po_id, v.chassis, v.status, SUM(${PO_OPEN}) AS q, (i.kind = 'stock')::int AS shelf
                             FROM po_lines pl JOIN vans v ON v.id = pl.van_id JOIN items i ON i.id = pl.item_id
                             WHERE pl.po_id IN ${ID_LIST} AND ${PO_OPEN} > 1e-9 AND v.status NOT IN ('planned','in_production')
                             GROUP BY pl.po_id, v.id, (i.kind = 'stock')::int ORDER BY v.chassis, shelf DESC`, list)) facts.get(r.po_id).inactive.push(r);
  return facts;
}
// Why a PO needs a look: no real number, no supplier, the same number used on another PO, or (check-r4-2) made
// by "Yes, all on order" with no delivery date. (`facts`: from poFacts.)
export async function poProblems(po, facts) {
  facts ??= (await poFacts([po.id])).get(po.id);
  const out = [];
  if (po.status === 'open' && !String(po.expected || '').trim() && String(po.notes || '').includes(`(${YES_ALL_MARK})`) && facts.undated) out.push('no delivery date');
  const no = String(po.po_no || '').trim();
  if (!/\d/.test(no) || /\(no number\)\s*$/i.test(no)) out.push('no PO number');
  if (!String(po.supplier || '').trim()) out.push('no supplier');
  if (/\d/.test(no) && facts.dups.length) out.push(`number ${no} also used on ${facts.dups.map(d => d.supplier || 'a PO with no supplier').join(', ')}`);
  return out;
}
async function refreshPoCheck(poId) {
  const po = await get('SELECT * FROM purchase_orders WHERE id = ?', poId);
  if (po) await run('UPDATE purchase_orders SET needs_check = ? WHERE id = ?', (await poProblems(po)).length ? 1 : 0, poId);
}

// Open PO lines for a van that is finished or cancelled (check-r4-3): still coming, but its van no longer needs
// it, so it is counted as spare for the next van short in build order. Listed under "POs to check" (until the
// office presses "Looks right") so nobody is surprised.
const INACTIVE_VAN_PO_SQL = (p = 'p') => `EXISTS (SELECT 1 FROM po_lines pl JOIN vans v ON v.id = pl.van_id
  WHERE pl.po_id = ${p}.id AND ${PO_OPEN} > 1e-9 AND v.status NOT IN ('planned','in_production'))`;
// Every open PO "POs to check" lists: marked needs_check, or with open lines for a van no longer active.
export const PO_TO_CHECK_SQL = `p.status = 'open' AND (p.needs_check = 1 OR (p.notes NOT ILIKE '%looks right%' AND ${INACTIVE_VAN_PO_SQL('p')}))`;
const VAN_STATUS_WORD = { completed: 'finished', cancelled: 'cancelled' };
// Shelf stock is counted as spare for the next van short; a part bought for one van is never handed on by
// itself, so it is only flagged. (`facts`: from poFacts.)
async function inactiveVanProblem(po, facts) {
  if (po.status !== 'open' || /looks right/.test(po.notes || '')) return [];
  facts ??= (await poFacts([po.id])).get(po.id);
  return facts.inactive.map(r => `${q(r.q)} still coming for ${r.chassis} (van ${VAN_STATUS_WORD[r.status] || r.status}) – ${r.shelf
    ? 'counted as spare for other vans' : 'bought for that van, no van needs it now'}`);
}

// "POs to check": open POs marked needs_check (or with lines for vans no longer active), with the reasons and
// what is on them.
export async function posToCheck() {
  const pos = await all(`SELECT p.* FROM purchase_orders p WHERE ${PO_TO_CHECK_SQL} ORDER BY p.id`);
  if (!pos.length) return [];
  const facts = await poFacts(pos.map(p => p.id));
  const linesOf = new Map(pos.map(p => [p.id, []]));
  for (const { po_id, ...l } of await all(`SELECT pl.po_id, pl.qty, pl.received, pl.closed, pl.spec, i.name, i.unit, v.chassis, v.status AS van_status
                       FROM po_lines pl JOIN items i ON i.id = pl.item_id LEFT JOIN vans v ON v.id = pl.van_id
                       WHERE pl.po_id IN ${ID_LIST} ORDER BY i.name`, ids(linesOf.keys()))) linesOf.get(po_id).push(l);
  const out = [];
  for (const po of pos) {
    const lines = linesOf.get(po.id), f = facts.get(po.id);
    out.push(withPlanFlag({ ...po, problems: [...(po.needs_check ? await poProblems(po, f) : []), ...await inactiveVanProblem(po, f)], lines,
      vans: [...new Set(lines.filter(l => l.chassis).map(l => l.chassis))] }));
  }
  return out;
}

// Set a PO's number, supplier and dates (inline on "POs to check" or the PO page). Old number /
// supplier are kept in the notes. `checked`: the office says it's right as it is.
export async function updatePO(id, { po_no, supplier, ordered_at, expected, notes, checked } = {}, by = '') {
  return writeTx(async () => {
    const po = await get('SELECT * FROM purchase_orders WHERE id = ?', id);
    if (!po) throw httpError(404, 'PO not found');
    const set = {}, was = [];
    if (po_no !== undefined) {
      const no = String(po_no).trim();
      if (!no) throw httpError(400, 'Type the PO number');
      if (no !== po.po_no) { set.po_no = no; was.push(`number was "${po.po_no}"`); }
    }
    if (supplier !== undefined) {
      const s = String(supplier).trim();
      if (s !== po.supplier) { set.supplier = s; was.push(`supplier was "${po.supplier || 'none'}"`); }
    }
    for (const [k, v] of [['ordered_at', ordered_at], ['expected', expected]]) {
      if (v === undefined) continue;
      if (v !== '' && !validDate(v)) throw httpError(400, 'Pick a date');
      set[k] = v || '';
    }
    if (notes !== undefined) set.notes = String(notes);
    if (was.length) set.notes = [set.notes ?? po.notes, `${was.join(', ')} (changed ${today()}${by ? ` by ${by}` : ''})`].filter(Boolean).join('\n');
    const keys = Object.keys(set);
    if (keys.length) await run(`UPDATE purchase_orders SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => set[k]), id);
    if (set.supplier) await syncSuppliers();
    if (checked) {
      await run(`UPDATE purchase_orders SET needs_check = 0, notes = btrim(notes || chr(10) || ?::text, chr(10) || ' ') WHERE id = ?`,
        `Checked – looks right (${today()}${by ? `, ${by}` : ''})`, id);
    }
    else if (po.needs_check || keys.length) await refreshPoCheck(id);
    // Other POs with the old / new number may now be fine (or not).
    if (set.po_no) for (const o of await all(`SELECT id FROM purchase_orders WHERE needs_check = 1 AND id <> ? AND lower(trim(po_no)) IN (lower(?), lower(?))`, id, po.po_no, set.po_no)) await refreshPoCheck(o.id);
    return (await getPO(id)).po;
  });
}

// Move every line of one PO onto another and close the empty one (a vague imported PO that is really
// part of a real one).
export async function mergePO(fromId, intoId, by = '') {
  if (fromId === intoId) throw httpError(400, 'Pick a different PO');
  return writeTx(async () => {
    const from = await get('SELECT * FROM purchase_orders WHERE id = ?', fromId), into = await get('SELECT * FROM purchase_orders WHERE id = ?', intoId);
    if (!from || !into) throw httpError(404, 'PO not found — refresh');
    const n = (await run('UPDATE po_lines SET po_id = ? WHERE po_id = ?', intoId, fromId)).changes;
    const stamp = `${today()}${by ? ` by ${by}` : ''}`;
    await run(`UPDATE purchase_orders SET status = 'closed', needs_check = 0, notes = btrim(notes || chr(10) || ?::text, chr(10) || ' ') WHERE id = ?`, `Merged into PO ${into.po_no} (${into.supplier || 'no supplier'}) – ${n} line(s) moved, ${stamp}`, fromId);
    await run(`UPDATE purchase_orders SET notes = btrim(notes || chr(10) || ?::text, chr(10) || ' ') WHERE id = ?`, `${n} line(s) moved here from "${from.po_no}" (${from.supplier || 'no supplier'}), ${stamp}`, intoId);
    if (await get(`SELECT 1 FROM po_lines pl WHERE pl.po_id = ? AND ${PO_OPEN} > 1e-9`, intoId)) await run(`UPDATE purchase_orders SET status = 'open' WHERE id = ?`, intoId);
    if (into.supplier === '' && from.supplier) await run('UPDATE purchase_orders SET supplier = ? WHERE id = ?', from.supplier, intoId);
    await refreshPoCheck(intoId);
    await logAlloc('po merged', { field: 'po', before: `PO ${from.po_no} (#${fromId})`, after: `PO ${into.po_no} (#${intoId})`, worker: by, note: `${n} line(s) moved` });
    return { moved: n };
  });
}

// Close a PO: whatever has not arrived is cancelled (its balance is written on each line), so those
// parts go back on the to-order list. Re-open undoes that.
export async function setPOStatus(id, status, by = '') {
  return writeTx(async () => {
    const po = await get('SELECT * FROM purchase_orders WHERE id = ?', id);
    if (!po) throw httpError(404, 'PO not found');
    if (status === 'closed') {
      for (const pl of await all(`SELECT pl.* FROM po_lines pl WHERE pl.po_id = ? AND ${PO_OPEN} > 1e-9 ORDER BY pl.id`, id)) {
        const bal = pl.qty - pl.received - pl.closed;
        await run('UPDATE po_lines SET closed = closed + ? WHERE id = ?', bal, pl.id);
        await logAlloc('po: balance closed', { van_id: pl.van_id, item_id: pl.item_id, field: 'on order', before: q(bal), after: 0, worker: by, note: `PO ${po.po_no} closed – back on the to-order list` });
        await backToOrderList(pl.van_id, pl.item_id, by, `PO ${po.po_no} closed`);
      }
      await run(`UPDATE purchase_orders SET status = 'closed', needs_check = 0 WHERE id = ?`, id);
    } else {
      for (const pl of await all('SELECT * FROM po_lines WHERE po_id = ? AND closed > 0 ORDER BY id', id)) {
        await logAlloc('po: re-opened', { van_id: pl.van_id, item_id: pl.item_id, field: 'on order', before: 0, after: q(pl.closed), worker: by, note: `PO ${po.po_no} re-opened` });
      }
      await run('UPDATE po_lines SET closed = 0 WHERE po_id = ?', id);
      await run(`UPDATE purchase_orders SET status = 'open' WHERE id = ?`, id);
      await refreshPoCheck(id);
    }
  });
}

// A cancelled PO balance for a van: the van's line goes back on the to-order list. A line with a plan
// order number would otherwise drop into "Check: already ordered?" — it was ordered and cancelled, so
// it's marked 'not_ordered' (still to order).
async function backToOrderList(vanId, itemId, by, why) {
  if (vanId == null) return;
  for (const l of await all(`SELECT id, po_ref FROM van_lines WHERE van_id = ? AND item_id = ? AND state = '' AND trim(po_ref) <> '' AND issued < qty ORDER BY id`, vanId, itemId)) {
    await run(`UPDATE van_lines SET state = 'not_ordered' WHERE id = ?`, l.id);
    await logAlloc('po: balance closed', { van_id: vanId, item_id: itemId, line_id: l.id, field: 'state', before: '', after: 'not_ordered', worker: by, note: `${why} – still to order (plan said order ${l.po_ref})` });
  }
}

// Open PO lines that should have arrived already.
export async function overdueLines() {
  const t = today();
  return all(`SELECT pl.id, pl.po_id, p.po_no, p.supplier, ${PO_OPEN} AS open, ${LINE_EXPECTED} AS expected, pl.spec,
                i.name, i.unit, v.chassis, pl.van_id
              FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id JOIN items i ON i.id = pl.item_id LEFT JOIN vans v ON v.id = pl.van_id
              WHERE ${PO_IS_OPEN} AND ${LINE_EXPECTED} <> '' AND ${LINE_EXPECTED} < ?
              ORDER BY expected, p.po_no`, t);
}

// lines: [{item_id, qty, van_id?, spec?}]. Lines for the same part, van and spec become one PO line
// (shelf stock is combined only when the spec matches too). The PO number already being used, or no
// supplier, needs a yes first (`confirm`): the reply is 409 with `confirm.warnings`.
export async function createPO({ po_no, supplier = '', notes = '', lines = [], ordered_at = '', expected = '', confirm = false }) {
  if (!String(po_no || '').trim()) throw httpError(400, 'PO number is required');
  const valid = lines.filter(l => l.item_id && Number(l.qty) > 0);
  if (!valid.length) throw httpError(400, 'Add at least one line');
  for (const l of valid) checkQty(Number(l.qty)); // (a blank / 0 line is left out, as before; Infinity is refused)
  if (expected && !validDate(expected)) throw httpError(400, 'Pick the expected date');
  return writeTx(async () => {
    // Stops a double-click on "Create PO" making the same order twice (and doubling "on order").
    const no = String(po_no).trim(), sup = String(supplier ?? '').trim();
    if (await get(`SELECT 1 FROM purchase_orders WHERE status = 'open' AND lower(trim(po_no)) = lower(?) AND lower(trim(supplier)) = lower(?)`, no, sup))
      throw httpError(409, `PO ${no}${sup ? ` for ${sup}` : ''} already exists`);
    const warnings = [];
    // (numbers run per supplier: only the same supplier, or a PO with no supplier, counts as "used")
    const used = await all(`SELECT po_no, supplier, status FROM purchase_orders WHERE lower(trim(po_no)) = lower(?)
                        AND (lower(trim(supplier)) = lower(?) OR trim(supplier) = '' OR ? = '') ORDER BY id`, no, sup, sup);
    if (used.length) warnings.push(`PO number ${no} is already used (${used.map(u => `${u.supplier || 'no supplier'}, ${u.status}`).join('; ')})`);
    if (!sup) warnings.push('No supplier is filled in');
    if (warnings.length && !confirm) throw Object.assign(httpError(409, warnings.join('. ')), { confirm: { warnings } });
    const id = await insert('INSERT INTO purchase_orders(po_no, supplier, notes, ordered_at, expected) VALUES(?,?,?,?,?)',
      no, sup, notes, validDate(ordered_at) || today(), validDate(expected));
    const merged = new Map();
    for (const l of valid) {
      const spec = String(l.spec || '').trim();
      const k = `${Number(l.item_id)}|${l.van_id || ''}|${spec.toLowerCase()}`;
      if (merged.has(k)) merged.get(k).qty += Number(l.qty);
      else merged.set(k, { item_id: Number(l.item_id), van_id: Number(l.van_id) || null, qty: Number(l.qty), spec });
    }
    for (const l of merged.values()) checkQty(l.qty); // (lines for the same part add up)
    for (const l of merged.values()) await run('INSERT INTO po_lines(po_id, item_id, qty, van_id, spec) VALUES(?,?,?,?,?)', id, l.item_id, l.qty, l.van_id, l.spec);
    if (!sup) await run('UPDATE purchase_orders SET needs_check = 1 WHERE id = ?', id);
    await syncSuppliers();
    return id;
  });
}

// Book a delivery against a PO.
//   receipts: [{id, qty}] what arrived per PO line (the screen's "Total arrived" box fills the van rows
//             of a part in build order).
//   backorder: {lineId: 'YYYY-MM-DD'} new expected date for what is still to come (short delivery).
//   closeBalance: [lineId] the supplier cancelled the rest: it comes off "on order" and the van goes
//             back on the to-order list (logged).
// Received for a van = locked to it. More than ordered → the extra goes on the shelf (free stock).
// A van line now customer supplies / to be decided / fitted → that part goes on the shelf too.
// Returns { warnings } in plain words.
export async function receivePO(poId, receipts = [], { backorder = {}, closeBalance = [], by = '' } = {}) {
  return writeTx(async () => {
    const po = await get('SELECT * FROM purchase_orders WHERE id = ?', poId);
    if (!po) throw httpError(404, 'PO not found');
    // A second click on "Receive delivery" must not book the same delivery twice.
    if (po.status === 'closed') throw httpError(409, 'This PO is already fully received. Re-open it to book more.');
    const ref = `PO ${po.po_no}`;
    const warnings = [];
    let booked = 0;
    const lineRow = async id => get(`SELECT pl.*, i.name, i.unit, v.chassis FROM po_lines pl JOIN items i ON i.id = pl.item_id
                               LEFT JOIN vans v ON v.id = pl.van_id WHERE pl.id = ? AND pl.po_id = ?`, Number(id), poId);
    for (const r of receipts) {
      const pl = await lineRow(r.id);
      const got = Number(r.qty);
      if (!pl || !(got > 0)) continue;
      checkQty(got);
      booked++;
      const due = Math.max(0, pl.qty - pl.received - pl.closed);
      const take = Math.min(got, due), extra = got - take;
      if (take > 0) {
        await run('UPDATE po_lines SET received = received + ? WHERE id = ?', take, pl.id);
        if (pl.van_id != null) {
          const vanNeed = await vanNeedLocked(pl.van_id, pl.item_id);
          const toVan = Math.min(take, vanNeed), toShelf = take - toVan;
          if (toVan > 1e-9) await receive(pl.item_id, toVan, { ref, vanId: pl.van_id, by, poRef: po.po_no });
          if (toShelf > 1e-9) {
            const msg = `${q(toShelf)} ${pl.unit} ${pl.name}: ${pl.chassis} no longer needs ${toShelf < take ? 'all of them' : 'it'} (customer supplies, to be decided or fitted) – put on the shelf`;
            await receive(pl.item_id, toShelf, { ref, note: msg, by });
            warnings.push(msg);
          }
        } else {
          await receive(pl.item_id, take, { ref, by });
        }
      }
      if (extra > 1e-9) {
        const msg = `${q(extra)} ${pl.unit} ${pl.name}: ${q(extra)} more than ordered – put on the shelf`;
        await receive(pl.item_id, extra, { ref, note: msg, by });
        await logAlloc('receive: over', { van_id: pl.van_id, item_id: pl.item_id, field: 'on_hand', before: '', after: `+${q(extra)}`, worker: by, note: `${ref}: ${msg}` });
        warnings.push(msg);
      }
    }
    for (const [lineId, date] of Object.entries(backorder || {})) {
      if (!validDate(date)) continue;
      const pl = await lineRow(lineId);
      const n = (await run(`UPDATE po_lines SET expected = ? WHERE id = ? AND po_id = ? AND qty - received - closed > 1e-9`, date, Number(lineId), poId)).changes;
      if (n && pl) await logAlloc('receive: short', { van_id: pl.van_id, item_id: pl.item_id, field: 'on order', before: '', after: `${q(pl.qty - pl.received - pl.closed)} still to come`, worker: by,
        note: `${ref}: short delivery – rest expected ${date}` });
      booked += n;
    }
    for (const lineId of closeBalance || []) {
      const pl = await lineRow(lineId);
      if (!pl) continue;
      const bal = pl.qty - pl.received - pl.closed;
      if (bal <= 1e-9) continue;
      await run('UPDATE po_lines SET closed = closed + ? WHERE id = ?', bal, pl.id);
      await logAlloc('po: balance closed', { van_id: pl.van_id, item_id: pl.item_id, field: 'on order', before: q(bal), after: 0, worker: by,
        note: `${ref}: supplier cancelled the rest${pl.chassis ? ` – ${pl.chassis} back on the to-order list` : ''}` });
      await backToOrderList(pl.van_id, pl.item_id, by, `${ref}: supplier cancelled`);
      warnings.push(`${q(bal)} ${pl.unit} ${pl.name} cancelled – ${pl.chassis ? `${pl.chassis} is ` : ''}back on the to-order list`);
      booked++;
    }
    if (!booked) throw httpError(400, 'Enter what arrived');
    await closePoIfDone(poId);
    return { warnings };
  });
}

// Vans still to build whose due date needs fixing: blank, or a planned van whose date has passed (C1).
export async function datesToCheck() {
  const t = today();
  return (await all(`SELECT v.id, v.chassis, v.eta, v.status FROM vans v WHERE ${ACTIVE_VAN} ORDER BY ${PRIORITY}`))
    .filter(v => !v.eta || (v.status === 'planned' && v.eta < t));
}

// Lines on vans in production / due soon whose quantity looks odd and nobody has said "quantity is right" (C2).
export async function qtyChecks({ nearOnly = true } = {}) {
  const lines = await all(`SELECT l.*, i.unit, i.name, i.plan_column AS item_plan_column, v.chassis FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id
                     WHERE ${ACTIVE_VAN} AND l.issued < l.qty ${nearOnly ? `AND ${await nearVanSql('v')}` : ''} ORDER BY ${PRIORITY}, i.name`);
  const usual = await itemMedians(lines.map(l => l.item_id));
  return lines.map(l => ({ ...l, why: qtyCheckFor(l, usual.get(l.item_id)) })).filter(l => l.why);
}
