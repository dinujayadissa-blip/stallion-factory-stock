// Shared by the stock modules: SQL pieces (active vans, Melbourne dates, build order), the parts list
// with what is free, small number helpers and the HTTP error / quantity checks.
import { all, get, getSetting, setSetting, writeTx } from '../db.js';
import { COUNTS_SHORT, OPEN_PO_BY_VAN, today } from '../lineState.js';

export const ACTIVE_VAN = `v.status IN ('planned','in_production')`;
// Melbourne's clock in SQL, whatever time zone the database server runs in (Supabase runs in UTC):
// the same text forms SQLite's date('now','localtime') / datetime('now','localtime') gave on the factory PC.
export const MELB = `(now() AT TIME ZONE 'Australia/Melbourne')`;
export const TODAY_SQL = `to_char(${MELB}, 'YYYY-MM-DD')`;
export const NOW_SQL = `to_char(${MELB}, 'YYYY-MM-DD HH24:MI:SS')`;
// Seconds since a Melbourne wall-clock time stored as text ('YYYY-MM-DD HH:MM:SS', e.g. movements.at).
export const AGE_SECS = col => `EXTRACT(EPOCH FROM now() - ((${col})::timestamp AT TIME ZONE 'Australia/Melbourne'))`;
// Build order — which van gets stock first (round 2, user-r1-4: the latest / most overdue van first).
//   1. vans in production:
//        a. a Build order number the office gave (1, 2, 3…) — lets the office put the bays in its own order
//        b. then the earliest due date (so the most overdue van is first); no due date after the dated ones
//        c. tie-break only: furthest along first — in the yard / not on the map, then the highest bay
//           (Bay 6, Bay 5 … Bay 1)
//   2. planned vans the office gave a build order number (1, 2, 3…)
//   3. planned vans by due date — a planned van whose date has already passed counts as "no date"
//      until the office fixes it (an old date must not give it first call on the shelf)
//   4. no date: last, oldest first
// Every list and every allocation step uses this one order (allocation, shortages, borrowing on the
// floor, trimming after a count — which takes from the END of this order — the receive dialog, the
// unassigned list). buildOrderInfo() says in words why each van is where it is.
const BAY_POS = `(SELECT first_number(fa.name) * 100000 + fa.id FROM floor_areas fa WHERE fa.id = v.area_id AND fa.kind = 'bay')`;
const DATED = `(v.eta <> '' AND (v.status <> 'planned' OR v.eta >= ${TODAY_SQL}))`;
export const PRIORITY = `CASE WHEN v.status = 'in_production' THEN 0 WHEN v.build_order IS NOT NULL THEN 1 WHEN ${DATED} THEN 2 ELSE 3 END,
  v.build_order IS NULL, v.build_order,
  CASE WHEN ${DATED} THEN v.eta ELSE '9999' END,
  ${BAY_POS} IS NOT NULL, ${BAY_POS} DESC, v.id`;

// Position of every active van in the build order (0 = first call on stock).
export async function vanRanks() {
  return new Map((await all(`SELECT v.id FROM vans v WHERE ${ACTIVE_VAN} ORDER BY ${PRIORITY}`)).map((r, i) => [r.id, i]));
}

// Every active van's place in the build order (1 = first call on stock) and why, in plain words:
// "In production · build order 1 · Bay 3", "In production · due 18/9 – 26 days late · Bay 3",
// "Planned · due 3/11", "Planned · no due date". Map vanId → { pos, why }.
export const dm = s => (s ? `${Number(s.slice(8, 10))}/${Number(s.slice(5, 7))}` : '');
export async function buildOrderInfo() {
  const t = today();
  const rows = await all(`SELECT v.id, v.status, v.eta, v.build_order, fa.name AS area_name, fa.kind AS area_kind
                    FROM vans v LEFT JOIN floor_areas fa ON fa.id = v.area_id WHERE ${ACTIVE_VAN} ORDER BY ${PRIORITY}`);
  const out = new Map();
  rows.forEach((v, i) => {
    const bits = [v.status === 'in_production' ? 'In production' : 'Planned'];
    if (v.build_order != null) bits.push(`build order ${v.build_order}`);
    if (!v.eta) bits.push('no due date');
    else if (v.status === 'planned' && v.eta < t) bits.push(`date passed (${dm(v.eta)}) – check`);
    else if (v.eta < t) {
      const late = Math.round((Date.parse(t) - Date.parse(v.eta)) / 864e5);
      bits.push(`due ${dm(v.eta)} – ${late} day${late === 1 ? '' : 's'} late`);
    } else bits.push(`due ${dm(v.eta)}`);
    if (v.status === 'in_production') bits.push(v.area_kind === 'bay' ? v.area_name : v.area_name ? `${v.area_name} (yard)` : 'not on the map');
    out.set(v.id, { pos: i + 1, why: bits.join(' · ') });
  });
  return out;
}

export const isPlaceholder = i => !!(i && (i.placeholder || /^PLAN-/i.test(i.sku || '')));

export async function ignoreList() {
  const raw = await getSetting('ignore', '[]'); // (outside the try: a database error must not pass for bad JSON)
  try { return JSON.parse(raw); } catch { return []; }
}

export async function activeRules() {
  return all('SELECT r.* FROM rules r JOIN items i ON i.id = r.item_id WHERE r.active = 1 AND i.active = 1 ORDER BY r.sort, r.id');
}

// Vans whose shortages count as "short" / "waiting on parts" now: in production, or due within the
// "coming up" weeks (short_weeks, C6). A planned van whose date has passed is on "dates to check" instead.
export async function nearVanSql(v = 'v') {
  const days = 7 * (await purchasingSettings()).short_weeks;
  return `(${v}.status = 'in_production' OR (${v}.status = 'planned' AND ${v}.eta <> '' AND ${v}.eta >= ${TODAY_SQL}
           AND ${v}.eta <= to_char(${MELB} + interval '${Math.round(days)} days', 'YYYY-MM-DD')))`;
}

// One pass of aggregated GROUP BY queries (no per-item sub-queries). "short" counts only vans in
// production or due within short_weeks, and leaves out the lines waiting on an answer (customer
// supplies, to be decided, unanswered "check: already ordered?"). on_order_shelf = open PO quantity
// not for a particular van.
async function itemStockSql() {
  const near = await nearVanSql('v');
  return `
  WITH op AS (${OPEN_PO_BY_VAN}),
  ln AS (SELECT l.item_id, SUM(l.reserved) AS reserved,
           SUM(CASE WHEN l.qty > l.reserved + l.issued AND ${COUNTS_SHORT('l', 'op')} AND ${near} THEN l.qty - l.reserved - l.issued ELSE 0 END) AS short
         FROM van_lines l JOIN vans v ON v.id = l.van_id LEFT JOIN op ON op.item_id = l.item_id AND op.van_id = l.van_id
         WHERE ${ACTIVE_VAN} GROUP BY l.item_id),
  oo AS (SELECT item_id, SUM(q) AS q, SUM(CASE WHEN van_id IS NULL THEN q ELSE 0 END) AS qs FROM op GROUP BY item_id)
  SELECT i.*, COALESCE(ln.reserved, 0) AS reserved, COALESCE(ln.short, 0) AS short, COALESCE(oo.q, 0) AS on_order,
    COALESCE(oo.qs, 0) AS on_order_shelf, (SELECT name FROM floor_areas fa WHERE fa.id = i.area_id) AS area_name
  FROM items i LEFT JOIN ln ON ln.item_id = i.id LEFT JOIN oo ON oo.item_id = i.id`;
}

export async function listItems({ includeInactive = false } = {}) {
  const rows = await all(`${await itemStockSql()} ${includeInactive ? '' : 'WHERE i.active = 1'} ORDER BY i.category, i.name`);
  const ctx = { counted: await firstCountDone() };
  return rows.map(r => withAvailable(r, ctx));
}

export async function getItem(id) {
  const row = await get(`${await itemStockSql()} WHERE i.id = ?`, id);
  return row && withAvailable(row, { counted: await firstCountDone() });
}

// Shelf items in counts (C3): every one of them has been counted at least once = go-live step (e) done.
export const COUNTABLE_ITEM = `i.active = 1 AND i.kind = 'stock' AND i.placeholder = 0 AND i.sku NOT ILIKE 'PLAN-%'`;
export async function firstCountDone() {
  return !await get(`SELECT 1 FROM items i WHERE ${COUNTABLE_ITEM} AND i.last_counted = '' LIMIT 1`);
}

// `ctx.counted`: the first full rack count is done (until then low-stock warnings are hidden for items
// nobody has counted — their shelf figure is a guess).
function withAvailable(r, ctx = {}) {
  const available = r.on_hand - r.reserved;
  // Suggest enough to cover every van's shortfall plus get back to the reorder level.
  const suggest = Math.max(0, r.short + Math.max(0, r.reorder_level - Math.max(0, available)) - r.on_order);
  const placeholder = isPlaceholder(r);
  const notCounted = r.kind === 'stock' && !placeholder && !r.last_counted;
  // Below reorder level: shelf stock with a level set, whose free stock + what is coming for the shelf is
  // under it. Van shortfalls are not mixed in (they are ordered for each van, C6).
  const low = !placeholder && r.kind === 'stock' && r.reorder_level > 0 && available + (r.on_order_shelf || 0) < r.reorder_level
    && !(notCounted && ctx.counted === false);
  return { ...r, placeholder: placeholder ? 1 : 0, available, suggest,
    // A shelf item nobody has counted yet: its shelf figure is a guess, so check before ordering.
    not_counted: notCounted ? 1 : 0, low };
}

// One plain status per line: issued (fitted) / customer / tbd / ready (in stock for this van) /
// on_order / check (plan gave an order number, nobody confirmed it) / to_order.
// Needs l.on_order_van (open PO qty for this van) and l.on_order (that + shelf POs).
export function lineStatus(l) {
  if (l.issued >= l.qty - 1e-9) return 'issued';
  if (l.state === 'customer') return 'customer';
  if (l.state === 'tbd') return 'tbd';
  if (l.reserved + l.issued >= l.qty - 1e-9) return 'ready';
  if ((l.on_order_van || 0) > 0) return 'on_order';
  if (String(l.po_ref || '').trim() && !l.state && !l.urgent) return 'check';
  return l.on_order > 0 ? 'on_order' : 'to_order';
}
export const LINE_STATUS_TEXT = { issued: 'Fitted', customer: 'Customer supplies', tbd: 'To be decided', ready: 'In stock for this van',
  on_order: 'Ordered', check: 'Check: already ordered?', to_order: 'Not ordered' };

// Settings: how long a van takes to build (parts must be here by due date − build weeks) and how far
// ahead "Coming up" looks.
export async function purchasingSettings() {
  const n = (s, d) => { const v = Number(s); return s !== '' && Number.isFinite(v) && v >= 0 ? v : d; };
  return { build_weeks: n(await getSetting('build_weeks', ''), 3), short_weeks: n(await getSetting('short_weeks', ''), 4) };
}
export async function savePurchasingSettings({ build_weeks, short_weeks } = {}) {
  for (const [k, v, max] of [['build_weeks', build_weeks, 52], ['short_weeks', short_weeks, 52]]) {
    if (v === undefined || v === '') continue;
    const n = Math.round(Number(v));
    if (!(n >= 0 && n <= max)) throw httpError(400, 'Type a number of weeks (0–52)');
    await writeTx(() => setSetting(k, String(n))); // each one saved on its own, as before
  }
}

// Every open PO line's expected date: its own backorder date, else the PO's.
export const LINE_EXPECTED = `COALESCE(NULLIF(pl.expected, ''), p.expected)`;
// A quantity in words: whole numbers as they are, anything else to 2 decimal places (2.5, 0.33).
export const q = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// The most of a part that one change may book (a take, a delivery, a PO line, a count).
export const MAX_QTY = 100000;
// A quantity that may go on the books: a real number, more than 0, not absurd. JSON reads 1e400 as Infinity
// (and Number('Infinity') is Infinity too); once on_hand is Infinity it never adds up again, so it is refused.
export const goodQty = n => Number.isFinite(n) && n > 0 && n <= MAX_QTY;
// The same as a 400 in plain words: `msg` for nothing / 0 / not a number, "too many" for the rest.
export function checkQty(n, msg = 'Quantity must be more than 0') {
  if (goodQty(n)) return n;
  if (!(n > 0)) throw httpError(400, msg);
  throw httpError(400, `That's too many — at most ${MAX_QTY} at a time`);
}
