// Purchasing: lead times and dates, and what to order — "Order now / Coming up / Later / No date",
// netted against what is already on order.
import { all, dataVersion, inTx, run, syncSuppliers, writeTx } from '../db.js';
import { OPEN_PO_BY_VAN, PO_IS_OPEN, PO_OPEN, UNANSWERED, addDays, specForPo, today } from '../lineState.js';
import { ACTIVE_VAN, LINE_EXPECTED, httpError, listItems, purchasingSettings, q, vanRanks } from './shared.js';
import { orderGroupOf } from './ordered.js';
import { supplierMatcher } from './special.js';

// When a van needs its parts: in production → today; otherwise due date − build weeks.
// '' = no date (blank, or a planned van whose date has passed: "No date – check").
// (`buildWeeks` left out: the setting.)
export async function vanNeededBy(v, buildWeeks) {
  if (buildWeeks === undefined) buildWeeks = (await purchasingSettings()).build_weeks;
  return neededByFor(v, buildWeeks);
}
export function neededByFor(v, buildWeeks) {
  const t = today();
  if (v.status === 'in_production') return t;
  if (!v.eta || (v.status === 'planned' && v.eta < t)) return '';
  return addDays(v.eta, -7 * buildWeeks);
}
export async function listSuppliers() {
  await syncSuppliers();
  return all(`SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.active = 1 AND trim(i.supplier) = s.name) AS items
              FROM suppliers s ORDER BY lower(s.name), s.name`);
}
export async function setSupplierLead(name, days) {
  const s = String(name || '').trim();
  if (!s) throw httpError(400, 'Which supplier?');
  // An emptied box (round 4, user-r3-2) = "not known": back to the 14-day default, not confirmed — never 0 days.
  // A text value is trimmed first, so a box holding only spaces counts as empty too (round 1 fixes, check-r4-4).
  if (typeof days === 'string') days = days.trim();
  if (days === '' || days == null) {
    await writeTx(() => run(`INSERT INTO suppliers(name, lead_days, lead_confirmed) VALUES(?, 14, 0)
         ON CONFLICT(name) DO UPDATE SET lead_days = 14, lead_confirmed = 0`, s));
    return;
  }
  const n = Math.round(Number(days));
  if (!(n >= 0 && n <= 365)) throw httpError(400, 'Lead time is a number of days (0–365)');
  await writeTx(() => run(`INSERT INTO suppliers(name, lead_days, lead_confirmed) VALUES(?, ?, 1)
       ON CONFLICT(name) DO UPDATE SET lead_days = excluded.lead_days, lead_confirmed = 1`, s, n));
}

// ── what to order: "Order now / Coming up / Later / No date" ──
//
// One row per van line still short (or one per item for a shelf top-up). Left out: "as per plan"
// catch-alls (listed per van instead), lines waiting on an answer ("check: already ordered?", customer
// supplies, to be decided). 'not_ordered' lines are normal shortages.
//
// NETTING, per item, van lines in build order: a line is covered first by what is set aside for it
// (already left out of "short"), then by open PO quantity for that van (only that van), then by free
// shelf stock (shelf items only) and open shelf PO quantity (PO lines with no van). What is left is
// to be ordered. Shelf items are then topped up to "order up to" (or the reorder level) from what is
// still free + still coming for the shelf.
//
// needed_by: today for vans in production and for lines whose part was borrowed (urgent); otherwise
// due date − build weeks; '' = no date. order_by = needed_by − supplier lead days.
// group: 'now' (order_by within 7 days, van in production, or urgent), 'soon' (within short_weeks),
// 'later', 'nodate'. build_pos = the van's place in the build order (#1 = first call on stock).
export async function shortages() {
  await syncSuppliers();
  const set = await purchasingSettings();
  const t = today();
  const nowBy = addDays(t, 7), soonBy = addDays(t, 7 * set.short_weeks);
  const lead = new Map((await all('SELECT * FROM suppliers')).map(s => [s.name, s]));
  const leadOf = sup => lead.get(String(sup || '').trim()) || { lead_days: 14, lead_confirmed: 0 };
  const items = new Map((await listItems()).filter(i => !i.placeholder).map(i => [i.id, i]));
  const ranks = await vanRanks();
  const supOf = await supplierMatcher();
  // Open PO quantity per item for each van / for the shelf (same sums as OPEN_PO_BY_VAN), and each open PO line,
  // earliest delivery first, so what covers a line can be named (check-r4-3).
  const opVan = new Map(), opShelf = new Map();
  const poLinesVan = new Map(), poLinesShelf = new Map();
  for (const r of await all(`SELECT pl.id, pl.po_id, p.po_no, p.supplier, pl.item_id, pl.van_id, ${PO_OPEN} AS q, ${LINE_EXPECTED} AS expected,
                           v.chassis, v.status AS van_status
                         FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id LEFT JOIN vans v ON v.id = pl.van_id
                         WHERE ${PO_IS_OPEN} ORDER BY COALESCE(NULLIF(${LINE_EXPECTED}, ''), '9999'), pl.id`)) {
    if (r.van_id == null) {
      opShelf.set(r.item_id, (opShelf.get(r.item_id) || 0) + r.q);
      if (!poLinesShelf.has(r.item_id)) poLinesShelf.set(r.item_id, []);
      poLinesShelf.get(r.item_id).push(r);
    } else {
      const k = `${r.item_id}|${r.van_id}`;
      opVan.set(k, (opVan.get(k) || 0) + r.q);
      if (!poLinesVan.has(k)) poLinesVan.set(k, []);
      poLinesVan.get(k).push(r);
    }
  }
  // Lines with a plan order number nobody has answered for ("Check: already ordered?") are listed too,
  // marked check = 1 ("plan says ordered – check"), so nothing urgent is hidden while the office finds
  // out (round 2, user-r1-1). They are netted AFTER the real shortages (they never take free stock or
  // shelf POs from them), are not ticked to order, and are not in the "order now" count.
  const lines = (await all(`
    WITH op AS (${OPEN_PO_BY_VAN})
    SELECT l.id, l.item_id, l.van_id, l.qty - l.reserved - l.issued AS short, l.urgent, l.spec, l.po_ref, l.state, l.plan_column,
      v.chassis, v.eta, v.status AS van_status, CASE WHEN ${UNANSWERED('l', 'op')} THEN 1 ELSE 0 END AS unanswered
    FROM van_lines l JOIN vans v ON v.id = l.van_id LEFT JOIN op ON op.item_id = l.item_id AND op.van_id = l.van_id
    WHERE ${ACTIVE_VAN} AND l.qty > l.reserved + l.issued + 1e-9 AND l.state NOT IN ('customer','tbd')
    ORDER BY l.id`)).filter(l => items.has(l.item_id));
  lines.sort((a, b) => a.unanswered - b.unanswered || (ranks.get(a.van_id) ?? 1e9) - (ranks.get(b.van_id) ?? 1e9) || a.id - b.id);
  const byItem = new Map();
  for (const l of lines) { if (!byItem.has(l.item_id)) byItem.set(l.item_id, []); byItem.get(l.item_id).push(l); }
  // Round 4 (check-r3-4): a van PO that its van no longer needs (spare shelf stock was set aside for the van
  // meanwhile, its line was reduced, it's customer supplies…) still arrives. When it does, the van's line is
  // already covered, so the receive hands it on to the next van short in build order. Count it like a shelf
  // PO: per shelf item and van, open van-PO quantity minus that van's still-short lines (`vanPoSpare`).
  // Before, ST0393's back-ordered rangehood PO was never counted for anyone and the list said one too many.
  const vanShort = new Map();
  for (const l of lines) vanShort.set(`${l.item_id}|${l.van_id}`, (vanShort.get(`${l.item_id}|${l.van_id}`) || 0) + l.short);
  const vanPoSpare = new Map();
  // Which van PO lines are the spare (check-r4-3): the van's own short lines use its PO lines first (earliest
  // delivery first); what is left on the later ones is spare. Vans no longer active need none of theirs.
  const spareSrc = new Map();
  for (const [key, qty] of opVan) {
    const spare = qty - (vanShort.get(key) || 0);
    if (spare <= 1e-9) continue;
    const itemId = Number(key.split('|')[0]);
    vanPoSpare.set(itemId, (vanPoSpare.get(itemId) || 0) + spare);
    let own = vanShort.get(key) || 0;
    for (const pl of poLinesVan.get(key) || []) {
      const useOwn = Math.min(own, pl.q); own -= useOwn;
      if (pl.q - useOwn <= 1e-9) continue;
      if (!spareSrc.has(itemId)) spareSrc.set(itemId, []);
      spareSrc.get(itemId).push({ po_id: pl.po_id, po_no: pl.po_no, supplier: pl.supplier, expected: pl.expected || '', van_id: pl.van_id,
        chassis: pl.chassis, van_status: pl.van_status, inactive: ['planned', 'in_production'].includes(pl.van_status) ? 0 : 1, spare: 1, q: pl.q - useOwn });
    }
  }
  // What covers each van line from a shelf PO or another van's spare PO: line_id → [{ po_no, chassis, qty, … }].
  const cover = new Map();

  const rows = [];
  const groupOf = (orderBy, forced) => forced || (orderBy && orderBy <= nowBy) ? 'now' : !orderBy ? 'nodate' : orderBy <= soonBy ? 'soon' : 'later';
  const itemIds = new Set([...byItem.keys(), ...[...items.values()].filter(i => i.kind === 'stock' && (i.order_up_to > 0 || i.reorder_level > 0)).map(i => i.id)]);
  for (const itemId of itemIds) {
    const i = items.get(itemId);
    const ls = byItem.get(itemId) || [];
    const sup = String(i.supplier || '').trim();
    const ld = leadOf(sup);
    let free = i.kind === 'stock' ? Math.max(0, i.available) : 0;
    // shelf POs + (shelf items only) van POs their van no longer needs — per-van parts are never handed on
    let shelfPo = (opShelf.get(itemId) || 0) + (i.kind === 'stock' ? vanPoSpare.get(itemId) || 0 : 0);
    // The same quantity, PO line by PO line: shelf POs first, then other vans' spare (shelf items only).
    const pool = [...(poLinesShelf.get(itemId) || []).map(pl => ({ po_id: pl.po_id, po_no: pl.po_no, supplier: pl.supplier, expected: pl.expected || '',
        van_id: null, chassis: '', inactive: 0, spare: 0, q: pl.q })),
      ...(i.kind === 'stock' ? spareSrc.get(itemId) || [] : [])].map(x => ({ ...x, left: x.q }));
    const takePool = (n, lineId) => {
      const got = [];
      for (const x of pool) {
        if (n <= 1e-9) break;
        const t = Math.min(n, x.left);
        if (t <= 1e-9) continue;
        x.left -= t; n -= t;
        const { left, q: _q, ...src } = x;
        got.push({ ...src, qty: t });
      }
      if (got.length && lineId != null) cover.set(lineId, got);
      return got;
    };
    const vanPoLeft = new Map();
    const base = { item_id: itemId, sku: i.sku, name: i.name, unit: i.unit, kind: i.kind, trade: i.trade || '', supplier: sup,
      lead_days: ld.lead_days, lead_confirmed: ld.lead_confirmed ? 1 : 0, not_counted: i.not_counted, reorder_level: i.reorder_level,
      order_up_to: i.order_up_to || 0, free_now: Math.max(0, i.available), on_order_item: i.on_order };
    let realLeft = null; // free / shelf PO left after the real shortages (the shelf top-up works from this)
    for (const l of ls) {
      if (l.unanswered && !realLeft) realLeft = { free, shelfPo, pool: pool.map(x => x.left) };
      const key = `${itemId}|${l.van_id}`;
      if (!vanPoLeft.has(key)) vanPoLeft.set(key, opVan.get(key) || 0);
      let need = l.short;
      const fromVanPo = Math.min(need, vanPoLeft.get(key)); need -= fromVanPo; vanPoLeft.set(key, vanPoLeft.get(key) - fromVanPo);
      const fromFree = Math.min(need, free); need -= fromFree; free -= fromFree;
      const fromShelfPo = Math.min(need, shelfPo); need -= fromShelfPo; shelfPo -= fromShelfPo;
      const coveredBy = fromShelfPo > 1e-9 ? takePool(fromShelfPo, l.id) : [];
      if (need <= 1e-9) continue;
      const forced = l.van_status === 'in_production' || !!l.urgent;
      const neededBy = l.urgent ? t : neededByFor({ status: l.van_status, eta: l.eta }, set.build_weeks);
      const orderBy = neededBy ? addDays(neededBy, -ld.lead_days) : '';
      rows.push({ ...base, line_id: l.id, van_id: l.van_id, chassis: l.chassis, eta: l.eta, van_status: l.van_status, urgent: l.urgent ? 1 : 0,
        check: l.unanswered ? 1 : 0, po_ref: l.unanswered ? String(l.po_ref).trim() : '',
        check_label: l.unanswered ? orderGroupOf({ ...l, supplier: sup, name: i.name }, supOf).label : '',
        spec: l.spec, po_spec: specForPo(l.spec, l.po_ref), plan_column: l.plan_column, state: l.state,
        short: l.short, covered: l.short - need, on_order: (opVan.get(key) || 0) + (opShelf.get(itemId) || 0), covered_by: coveredBy,
        suggest: need, needed_by: neededBy, order_by: orderBy, group: groupOf(orderBy, forced), forced: forced ? 1 : 0,
        date_passed: l.van_status === 'planned' && l.eta && l.eta < t ? 1 : 0 });
    }
    // Shelf top-up: back to "order up to" (or the reorder level) from what is still free + still coming.
    if (realLeft) { ({ free, shelfPo } = realLeft); realLeft.pool.forEach((v, k) => { pool[k].left = v; }); }
    const target = i.kind === 'stock' ? (i.order_up_to > 0 ? i.order_up_to : i.reorder_level) : 0;
    if (target > 0 && i.reorder_level >= 0 && free + shelfPo < (i.reorder_level > 0 ? i.reorder_level : target)) {
      const topUp = target - free - shelfPo;
      if (topUp > 1e-9) rows.push({ ...base, line_id: null, van_id: null, chassis: '', topup: 1, spec: '', po_spec: '',
        short: 0, covered: 0, on_order: opShelf.get(itemId) || 0, suggest: topUp, needed_by: t, order_by: t, group: 'now', forced: 0 });
    }
  }
  // Order now: in BUILD ORDER (#1, #2… — the same numbers as the Vans page and the receive dialog), so a
  // van in production or an overdue van is never listed after a planned van just because the planned
  // van's supplier has a longer lead time (round 3, user-r2-2); shelf top-ups after the vans. The other
  // groups: earliest order-by date first, then build order.
  const rk = r => ranks.get(r.van_id) ?? 1e9;
  for (const r of rows) r.build_pos = r.van_id != null && ranks.has(r.van_id) ? ranks.get(r.van_id) + 1 : null;
  rows.sort((a, b) => (a.group === 'now' ? 0 : 1) - (b.group === 'now' ? 0 : 1)
    || (a.group === 'now'
      ? rk(a) - rk(b) || (a.order_by || '9999').localeCompare(b.order_by || '9999')
      : (a.order_by || '9999').localeCompare(b.order_by || '9999') || rk(a) - rk(b))
    || a.name.localeCompare(b.name));
  const counts = { now: 0, soon: 0, later: 0, nodate: 0 };
  for (const r of rows) if (!r.check) counts[r.group]++;
  const noSupplier = new Set(rows.filter(r => !r.supplier).map(r => r.item_id));
  const orderNow = orderNowCount(rows);
  orderNow.text = orderNowText(orderNow);
  // cover (check-r4-3): every van line (to order or not) that a shelf PO or another van's spare PO covers.
  return { today: t, settings: set, rows, counts, noSupplier: noSupplier.size, orderNow,
    cover: [...cover.entries()].map(([line_id, from]) => {
      const l = lines.find(x => x.id === line_id);
      return { line_id, van_id: l?.van_id, chassis: l?.chassis, item_id: l?.item_id, check: l?.unanswered ? 1 : 0, from };
    }),
    suppliers: (await listSuppliers()).map(s => ({ name: s.name, lead_days: s.lead_days, lead_confirmed: s.lead_confirmed })) };
}

// What covers a van line from another van's spare PO or a shelf PO, in words (check-r4-3):
// "PO 50 (Caravan & Camping) – ST0367's, spare", "PO 50 – ST0350's (van finished), spare", "PO 12 (for the shelf)".
export function coverText(x) {
  const po = `PO ${x.po_no}${x.supplier ? ` (${x.supplier})` : ''}`;
  if (!x.spare) return `${po} (for the shelf)`;
  const gone = x.inactive ? ` (van ${x.van_status === 'cancelled' ? 'cancelled' : 'finished'})` : '';
  return `${po} – ${x.chassis}'s${gone}, spare`;
}
// shortages() for read-only screens (van page, item page): worked out again only when the data changed since the
// last time (settings.data_version, bumped by every write transaction — on any server instance) or the day
// changed (Melbourne's date). Callers asking at the same moment share one working-out.
// Inside a transaction it is always worked out afresh and never remembered: the transaction may have changed
// things that data_version (bumped only when it commits) doesn't show yet, and may still roll back.
let shortMemo = null;
export async function shortagesCached() {
  if (inTx()) return shortages();
  const key = `${await dataVersion()}|${today()}`;
  if (shortMemo?.key !== key) {
    // (shortages() adds supplier rows for new names first. They are only added when it is worked out again,
    // not on every read as before — two INSERTs each time, about three times per page. Every change bumps
    // data_version, so the first read after any change still adds them.)
    const memo = { key, value: shortages() };
    shortMemo = memo;
    memo.value.catch(() => { if (shortMemo === memo) shortMemo = null; }); // a failed working-out isn't kept
  }
  return shortMemo.value;
}
// Per van line, what covers it (check-r4-3) — the same netting as Purchasing → To order. `vanId` / `itemId`
// narrow it. Returns Map line_id → { from: [...], text, spare (1 = another van's PO), qty }.
// `sh`: a shortages() result already at hand (default: shortagesCached()).
export async function lineCover({ vanId = null, itemId = null } = {}, sh) {
  if (sh === undefined) sh = await shortagesCached();
  const out = new Map();
  for (const c of sh.cover) {
    if (vanId != null && c.van_id !== vanId) continue;
    if (itemId != null && c.item_id !== itemId) continue;
    const qty = c.from.reduce((t, x) => t + x.qty, 0);
    out.set(c.line_id, { from: c.from, qty, spare: c.from.some(x => x.spare) ? 1 : 0,
      text: c.from.map(x => `${c.from.length > 1 ? `${q(x.qty)} on ` : ''}${coverText(x)}`).join(' + ') });
  }
  return out;
}

// THE "order now" number (round 2, user-r1-3) — the same on the Dashboard, the menu badge and the
// Purchasing page: rows in the Order now group with something to order, not counting lines still
// waiting on "Check: already ordered?". parts = different parts, lines = order lines (van lines, plus
// shelf top-ups), check = lines in Order now marked "plan says ordered – check" (shown, not counted).
export function orderNowCount(rows) {
  const now = rows.filter(r => r.group === 'now' && r.suggest > 1e-9);
  const real = now.filter(r => !r.check);
  return { parts: new Set(real.map(r => r.item_id)).size, lines: real.length, topups: real.filter(r => r.topup).length,
    check: now.length - real.length };
}
// Plain words for that number: "103 parts (253 van lines)".
export function orderNowText(c) {
  if (!c.parts) return 'nothing to order now';
  const vanLines = c.lines - c.topups;
  return `${c.parts} part${c.parts === 1 ? '' : 's'} (${vanLines} van line${vanLines === 1 ? '' : 's'}${c.topups ? ` + ${c.topups} shelf top-up${c.topups === 1 ? '' : 's'}` : ''})`;
}
