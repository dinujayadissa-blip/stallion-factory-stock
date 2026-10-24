// Stock, allocation and purchasing logic. All quantities live in Postgres (src/db.js); every function that
// changes stock runs inside writeTx (one writer at a time, all or nothing) so the numbers can't drift apart.
// Every function that reads or writes the database is async (returns a Promise); the pure helpers
// (lineStatus, qtyCheckFor, coverText, orderNowCount, orderNowText, orderGroupOf, httpError …) are not.
import { all, get, run, insert, writeTx, inTx, dataVersion, getSetting, setSetting, logAlloc, syncSuppliers } from './db.js';
import { buildPartsList } from './rules.js';
import { capFor, leadInfo } from './planMap.js';
import { detectState, dotsCheck, STATES, REMINDER_STATES, STATE_LABEL, PO_OPEN, PO_IS_OPEN, OPEN_PO_BY_VAN, UNANSWERED, UNANSWERED_CORR,
  COUNTS_SHORT, COUNTS_SHORT_CORR, ALLOCATABLE, STILL_MISSING, SPECIAL_ITEM, today, addDays, validDate, specForPo, givenTo, customerSays } from './lineState.js';
import { suggestionsFor, sameTextKey, linkableItems, learnedLinks, mergedCols, textParts, partsFor, vanParts, dealerNames, notAPart, skuNow } from './relink.js';

// Melbourne's date 'YYYY-MM-DD', whatever time zone the server runs in (lineState.js).
export { today };

// ───────────────────────── helpers ─────────────────────────

const ACTIVE_VAN = `v.status IN ('planned','in_production')`;
// Melbourne's clock in SQL, whatever time zone the database server runs in (Supabase runs in UTC):
// the same text forms SQLite's date('now','localtime') / datetime('now','localtime') gave on the factory PC.
const MELB = `(now() AT TIME ZONE 'Australia/Melbourne')`;
const TODAY_SQL = `to_char(${MELB}, 'YYYY-MM-DD')`;
const NOW_SQL = `to_char(${MELB}, 'YYYY-MM-DD HH24:MI:SS')`;
// Seconds since a Melbourne wall-clock time stored as text ('YYYY-MM-DD HH:MM:SS', e.g. movements.at).
const AGE_SECS = col => `EXTRACT(EPOCH FROM now() - ((${col})::timestamp AT TIME ZONE 'Australia/Melbourne'))`;
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
const dm = s => (s ? `${Number(s.slice(8, 10))}/${Number(s.slice(5, 7))}` : '');
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

const isPlaceholder = i => !!(i && (i.placeholder || /^PLAN-/i.test(i.sku || '')));

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
const COUNTABLE_ITEM = `i.active = 1 AND i.kind = 'stock' AND i.placeholder = 0 AND i.sku NOT ILIKE 'PLAN-%'`;
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

// ───────────────────────── allocation ─────────────────────────

// Hand any free stock of one item to the vans that are still short, soonest delivery first.
// Lines on a PO raised for a specific van (`preferVan`) are served first.
// Per-van items (cladding in a customer's colour, a chassis…) only ever go to the van they were
// received for — a spare one left over from another van is never handed on automatically.
// `firm`: this much of the stock was just received for `preferVan` (a PO for that van, a delivery
// booked for it): what goes to that van's lines is locked to it (reserved_firm) — first by locking
// what it already held from the shelf, then from the new stock.
// `reason`: written to the allocation log ('' = don't log, the caller logs the net change).
// `poRef` (follow-up round 1): the order number the stock arrived on — of `preferVan`'s lines, the one that
// names that order (plan "Coast Order 137") is filled first, so a van with the part on two lines (one on
// order, one still to order) gets it on the line that was ordered and never comes back in "Check: already
// ordered?". Only the order of that one van's lines changes; other vans are never touched by it.
export async function allocateItem(itemId, preferVan = null, opts = {}) {
  return writeTx(() => allocate(itemId, preferVan, opts));
}
async function allocate(itemId, preferVan = null, { firm = 0, reason = 'allocate', worker = '', poRef = '' } = {}) {
  const item = await get('SELECT on_hand, kind FROM items WHERE id = ?', itemId);
  if (!item) return;
  let firmLeft = preferVan != null ? Math.max(0, firm) : 0;
  const ref = String(poRef ?? '').trim();
  const log = async (l, field, before, after, extra = {}) => {
    if (reason) await logAlloc(reason, { van_id: l.van_id, item_id: itemId, line_id: l.id, field, before, after, worker, ...extra });
  };
  if (firmLeft > 0) {
    for (const l of await all(`SELECT * FROM van_lines l WHERE van_id = ? AND item_id = ? AND reserved > reserved_firm AND ${ALLOCATABLE('l')}
                         ORDER BY CASE WHEN ? <> '' AND lower(trim(l.po_ref)) = lower(?) THEN 0 ELSE 1 END, id`, preferVan, itemId, ref, ref)) {
      if (firmLeft <= 0) break;
      const lock = Math.min(firmLeft, l.reserved - l.reserved_firm);
      await run('UPDATE van_lines SET reserved_firm = reserved_firm + ? WHERE id = ?', lock, l.id);
      await log(l, 'reserved_firm', l.reserved_firm, l.reserved_firm + lock, { change: 0, firm_change: lock });
      firmLeft -= lock;
    }
  }
  if (item.kind === 'per-van' && preferVan == null) return;
  const reserved = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id
                        WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r;
  let free = item.on_hand - reserved;
  if (free <= 0) return;
  const lines = await all(`SELECT l.* FROM van_lines l JOIN vans v ON v.id = l.van_id
                     WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.qty > l.reserved + l.issued AND ${ALLOCATABLE('l')}
                       AND (? = 'stock' OR v.id = ?)
                     ORDER BY CASE WHEN v.id = ? THEN 0 ELSE 1 END,
                       CASE WHEN v.id = ? AND ? <> '' AND lower(trim(l.po_ref)) = lower(?) THEN 0 ELSE 1 END, ${PRIORITY}, l.id`,
                    itemId, item.kind, preferVan ?? -1, preferVan ?? -1, preferVan ?? -1, ref, ref);
  for (const l of lines) {
    if (free <= 0) break;
    const take = Math.min(free, l.qty - l.reserved - l.issued);
    const lock = l.van_id === preferVan ? Math.min(firmLeft, take) : 0;
    await run('UPDATE van_lines SET reserved = reserved + ?, reserved_firm = reserved_firm + ? WHERE id = ?', take, lock, l.id);
    await log(l, lock ? 'reserved (locked)' : 'reserved', l.reserved, l.reserved + take, { change: take, firm_change: lock });
    firmLeft -= lock;
    free -= take;
  }
}

// Set-aside stock that may move: what was held from the shelf, not what was received for the van.
const FLEX = 'GREATEST(0, l.reserved - l.reserved_firm)';

// If a count shows less on the shelf than is set aside, take the flexible part back from the vans
// built last. Parts received for a van (locked) are never taken here — the count screen asks about
// those. Returns how much is still over (locked stock the shelf doesn't have).
async function trimReservations(itemId, { reason = 'trim', worker = '' } = {}) {
  const item = await get('SELECT on_hand FROM items WHERE id = ?', itemId);
  let over = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id
                  WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r - Math.max(0, item.on_hand);
  if (over <= 0) return 0;
  const ranks = await vanRanks();
  const lines = (await all(`SELECT l.*, ${FLEX} AS flex FROM van_lines l JOIN vans v ON v.id = l.van_id
                     WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.reserved > l.reserved_firm`, itemId))
    .sort((a, b) => (ranks.get(b.van_id) ?? 0) - (ranks.get(a.van_id) ?? 0) || b.id - a.id);
  for (const l of lines) {
    if (over <= 0) break;
    const give = Math.min(over, l.flex);
    await run('UPDATE van_lines SET reserved = reserved - ? WHERE id = ?', give, l.id);
    await logAlloc(reason, { van_id: l.van_id, item_id: itemId, line_id: l.id, field: 'reserved', before: l.reserved, after: l.reserved - give, worker });
    over -= give;
  }
  return Math.max(0, over);
}

// Every active line's set-aside amount: Map lineId → {van_id, item_id, reserved}.
async function reservedSnapshot() {
  return new Map((await all(`SELECT l.id, l.van_id, l.item_id, l.reserved FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE ${ACTIVE_VAN} ORDER BY l.id`))
    .map(r => [r.id, r]));
}

// Hand the flexible shelf stock out again in build order. Only reserved - reserved_firm moves:
// parts received for a van stay with it, and per-van parts are never moved to another van.
async function runReprioritise() {
  await run(`UPDATE van_lines SET reserved = reserved_firm
       WHERE reserved > reserved_firm AND van_id IN (SELECT id FROM vans v WHERE ${ACTIVE_VAN})
         AND item_id IN (SELECT id FROM items WHERE kind = 'stock')`);
  for (const { id } of await all(`SELECT id FROM items WHERE kind = 'stock' ORDER BY id`)) await allocateItem(id, null, { reason: '' });
}

// Per van: the parts it would gain and lose (net, per item).
async function reprioritiseDiff(before, after) {
  const net = new Map(); // `${van}|${item}` → delta
  for (const [id, b] of before) {
    const d = (after.get(id)?.reserved ?? 0) - b.reserved;
    if (Math.abs(d) < 1e-9) continue;
    const k = `${b.van_id}|${b.item_id}`;
    net.set(k, (net.get(k) || 0) + d);
  }
  const vans = new Map();
  const names = new Map((await all('SELECT id, sku, name, unit FROM items')).map(i => [i.id, i]));
  const chassis = new Map((await all('SELECT id, chassis FROM vans')).map(v => [v.id, v.chassis]));
  const ranks = await vanRanks();
  for (const [k, d] of net) {
    if (Math.abs(d) < 1e-9) continue;
    const [vanId, itemId] = k.split('|').map(Number);
    if (!vans.has(vanId)) vans.set(vanId, { van_id: vanId, chassis: chassis.get(vanId), gains: [], loses: [] });
    const it = names.get(itemId) || {};
    vans.get(vanId)[d > 0 ? 'gains' : 'loses'].push({ item_id: itemId, sku: it.sku, name: it.name, unit: it.unit, qty: Math.abs(d) });
  }
  return [...vans.values()].sort((a, b) => (ranks.get(a.van_id) ?? 0) - (ranks.get(b.van_id) ?? 0));
}

// What "Re-prioritise" would do, without doing it: done inside a write transaction (so nobody changes the
// stock meanwhile) that is then rolled back — nothing is kept and data_version is not bumped.
const ROLLBACK = Symbol('roll back the preview');
export async function reprioritisePreview() {
  if (inTx()) throw httpError(409, 'Busy — try again');
  let diff;
  try {
    await writeTx(async () => {
      const before = await reservedSnapshot();
      await runReprioritise();
      diff = await reprioritiseDiff(before, await reservedSnapshot());
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return diff;
}

export async function reprioritiseAll({ by = '' } = {}) {
  return writeTx(async () => {
    const before = await reservedSnapshot();
    await runReprioritise();
    const after = await reservedSnapshot();
    for (const [id, b] of before) {
      const a = after.get(id)?.reserved ?? 0;
      if (Math.abs(a - b.reserved) > 1e-9) await logAlloc('reprioritise', { van_id: b.van_id, item_id: b.item_id, line_id: id, field: 'reserved', before: b.reserved, after: a, worker: by });
    }
    return reprioritiseDiff(before, after);
  });
}

// ───────────────────────── vans / orders ─────────────────────────

// `chassis`: when re-loading an order for a van already in the system, count the stock that's
// already set aside for that van as available to it.
export async function previewOrder(fields, chassis = '') {
  const { lines, review, errors } = buildPartsList(fields, await activeRules(), await ignoreList());
  const stock = new Map((await listItems({ includeInactive: true })).map(i => [i.id, i]));
  const own = new Map((await all(`SELECT l.item_id, SUM(l.reserved + l.issued) AS q FROM van_lines l JOIN vans v ON v.id = l.van_id
                           WHERE v.chassis = ? GROUP BY l.item_id`, chassis)).map(r => [r.item_id, r.q]));
  return {
    lines: lines.map(l => {
      const it = stock.get(l.item_id);
      // customer (user-r4-9): 'auto' = the order says "customer supply" / "supplied by customer" (made Customer
      // supplies unless the office says no), 'suggest' = "customer sending" and the like (one click to accept).
      return { ...l, sku: it?.sku, name: it?.name, category: it?.category, unit: it?.unit, kind: it?.kind,
               supplier: it?.supplier, available: (it?.available ?? 0) + (own.get(l.item_id) || 0), customer: customerSays(l.spec) };
    }).sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || '')),
    review: review.map(r => ({ ...r, customer: customerSays(r.value) })),
    errors,
  };
}

// customer_items / normal_items (user-r4-9): the office's answers on the New dealer order screen — parts the
// customer supplies (accepted suggestions), and parts the order's wording would have made "Customer supplies"
// that the office says are ours to supply.
export async function createVan({ header, fields, dealer = '', customer_items = [], normal_items = [], by = '' }, { replace = false } = {}) {
  const chassis = String(header.chassis || '').trim().toUpperCase();
  if (!chassis) throw httpError(400, 'Chassis number is missing');
  return writeTx(async () => {
    const existing = await get('SELECT * FROM vans WHERE chassis = ?', chassis);
    if (existing && !replace) throw httpError(409, `${chassis} is already in the system`);
    let vanId;
    const vals = [header.customer || '', dealer || '', header.model || '', header.length || '', header.floorPlan || '',
                  header.colour || '', header.atm || '', header.quoteNo || '', header.orderDate || '', header.eta || ''];
    if (existing) {
      vanId = existing.id;
      await run(`UPDATE vans SET customer=?, dealer=?, model=?, length=?, floor_plan=?, colour=?, atm=?, quote_no=?, order_date=?, eta=?, reviewed=0
           WHERE id=?`, ...vals, vanId);
      await run(`DELETE FROM order_fields WHERE van_id = ? AND section <> 'PRODUCTION PLAN'`, vanId);
    } else {
      vanId = await insert(`INSERT INTO vans(chassis, customer, dealer, model, length, floor_plan, colour, atm, quote_no, order_date, eta)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, chassis, ...vals);
    }
    const ins = 'INSERT INTO order_fields(van_id, section, label, value, note, sort) VALUES(?,?,?,?,?,?)';
    for (const [i, f] of fields.entries()) await run(ins, vanId, f.section || '', f.label, f.value || '', f.note || '', i);
    const ids = a => new Set((Array.isArray(a) ? a : []).map(Number).filter(Boolean));
    await applyRules(vanId, { customer: ids(customer_items), normal: ids(normal_items), by });
    return vanId;
  });
}

// (Re)build the rule-generated part lines for a van. Manual lines and anything already issued
// are kept; quantities already issued are carried over so nothing is double-counted.
// Vans brought in from the production plan spreadsheet keep the plan's part lines; the dealer-order
// rules aren't run over them (that would add every part a second time). Returns false then.
// `answers`: { customer: Set of item ids the office marked "Customer supplies", normal: Set it said are not,
// by } — from the New dealer order screen (user-r4-9). Without them the order's own wording decides, as before.
export async function applyRules(vanId, answers = {}) {
  return writeTx(() => applyRulesNow(vanId, answers));
}
async function applyRulesNow(vanId, answers) {
  const yes = answers.customer || new Set(), no = answers.normal || new Set();
  const answerLog = async (lineId, itemId, before, after, spec) => logAlloc('dealer order', { van_id: vanId, item_id: itemId, line_id: lineId, field: 'state',
    before, after, worker: answers.by || 'Office',
    note: after === 'customer' ? `Customer supplies – accepted on the dealer order ("${spec}")` : `Not customer supplies – the office said so on the dealer order ("${spec}")` });
  if (await get(`SELECT 1 FROM van_lines WHERE van_id = ? AND source = 'plan' LIMIT 1`, vanId)) return false;
  const fields = await all(`SELECT * FROM order_fields WHERE van_id = ? AND section <> 'PRODUCTION PLAN' ORDER BY sort`, vanId);
  const { lines } = buildPartsList(fields, await activeRules(), await ignoreList());
  const old = await all(`SELECT * FROM van_lines WHERE van_id = ? AND source = 'rule' ORDER BY id`, vanId);
  const touched = new Set(old.map(l => l.item_id));

  const oldByItem = new Map(old.map(l => [l.item_id, l]));
  for (const l of lines) {
    touched.add(l.item_id);
    const prev = oldByItem.get(l.item_id);
    // "Customer supply" / "TBA" in the order text: a reminder line, not stock or an order (C5).
    const auto = detectState(l.spec);
    const said = yes.has(l.item_id) ? 'customer' : no.has(l.item_id) && auto === 'customer' ? '' : auto;
    if (prev) {
      // keep what was already issued/reserved, but never reserve more than now needed
      let reserved = Math.min(prev.reserved, Math.max(0, l.qty - prev.issued));
      // Only a line nobody has given a status yet takes the one the text says; its shelf stock (not
      // what was received for the van) goes back to the shelf.
      // An answer given on the dealer order screen just now counts as someone's answer too (user-r4-9).
      const state = yes.has(l.item_id) && !prev.state && prev.issued === 0 ? 'customer'
        : !prev.state && prev.issued === 0 && said
        && !await get(`SELECT 1 FROM allocation_log WHERE line_id = ? AND field = 'state'`, prev.id) ? said : prev.state; // never undo someone's answer
      if (yes.has(l.item_id) && state === 'customer' && prev.state !== 'customer') await answerLog(prev.id, l.item_id, prev.state, 'customer', l.spec);
      else if (no.has(l.item_id) && auto === 'customer' && !prev.state && !await get(`SELECT 1 FROM allocation_log WHERE line_id = ? AND field = 'state'`, prev.id))
        await answerLog(prev.id, l.item_id, 'customer', '', l.spec);
      if (state !== prev.state && REMINDER_STATES.includes(state)) {
        const keep = Math.min(reserved, prev.reserved_firm);
        if (reserved > keep) await logAlloc('state', { van_id: vanId, item_id: l.item_id, line_id: prev.id, field: 'reserved', before: reserved, after: keep, note: `${STATE_LABEL[state]} (order says "${l.spec}") – shelf stock released` });
        reserved = keep;
      }
      await run('UPDATE van_lines SET qty = ?, reserved = ?, spec = ?, rule_id = ?, state = ? WHERE id = ?',
          Math.max(l.qty, prev.issued), reserved, l.spec, l.rule_id, state, prev.id);
      oldByItem.delete(l.item_id);
    } else {
      const lineId = await insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, rule_id, state) VALUES(?,?,?,?, 'rule', ?, ?)`,
          vanId, l.item_id, l.qty, l.spec, l.rule_id, said);
      // Logged, so a later re-run of the rules never undoes the office's answer.
      if (yes.has(l.item_id)) await answerLog(lineId, l.item_id, '', 'customer', l.spec);
      else if (no.has(l.item_id) && auto === 'customer') await answerLog(lineId, l.item_id, 'customer', '', l.spec);
    }
  }
  // Rule lines that no longer apply: delete, unless stock was already issued for them.
  for (const prev of oldByItem.values()) {
    if (prev.issued > 0) await run('UPDATE van_lines SET qty = issued, reserved = 0 WHERE id = ?', prev.id);
    else await run('DELETE FROM van_lines WHERE id = ?', prev.id);
  }
  for (const itemId of touched) await allocateItem(itemId);
  return true;
}

// "Still missing" per van, counted the same way on every screen (Small fixes & phone round 1, phone batch 1;
// rule in lineState.js STILL_MISSING). Map van_id → { missing, order, check, special, special_order, special_check }:
// check = the plan has an order number nobody answered for ("Check: already ordered?"), order = the rest (still to
// order, or on order) — so order + check = missing, the same split as the van page's tiles (lineStatus).
// special = how many of the missing lines are "as per plan" catch-alls ("of which N special parts"), counted inside
// order / check by their status (Small fixes & phone round 2, sp-r1-2: they used to be a third group, so a special
// line with an order number was "special" in the split but "check" on the van page's tile).
// trade = only that trade's parts; vanId = one van.
export async function stillMissingByVan({ trade = '', vanId = null } = {}) {
  const args = [trade, vanId].filter(Boolean);
  const rows = await all(`SELECT l.van_id, COUNT(*) AS missing,
      SUM(CASE WHEN ${SPECIAL_ITEM('i')} THEN 1 ELSE 0 END) AS special,
      SUM(CASE WHEN ${UNANSWERED_CORR('l')} THEN 1 ELSE 0 END) AS chk,
      SUM(CASE WHEN ${SPECIAL_ITEM('i')} AND ${UNANSWERED_CORR('l')} THEN 1 ELSE 0 END) AS special_chk
    FROM van_lines l JOIN items i ON i.id = l.item_id
    WHERE ${STILL_MISSING('l')}${trade ? ' AND i.trade = ?' : ''}${vanId ? ' AND l.van_id = ?' : ''}
    GROUP BY l.van_id`, ...args);
  return new Map(rows.map(r => [r.van_id, { missing: r.missing, order: r.missing - r.chk, check: r.chk, special: r.special,
    special_order: r.special - r.special_chk, special_check: r.special_chk }]));
}
export const NO_MISSING = Object.freeze({ missing: 0, order: 0, check: 0, special: 0, special_order: 0, special_check: 0 });

// Follow-up round 1 (owner-r3-2): the still-missing lines of each van split the van page's way — waiting on PO
// (on_order) / still to order (to_order) / to check (check). Same rule as getVan and the plan's "By van" (planGrid
// `ps`): lineStatus with the van's own and the shelf's open PO lines, and a line fully covered by a shelf PO or
// another van's spare PO line counts as on order. Map vanId → { on_order, to_order, check }.
export async function missingSplitByVan(vanIds) {
  const ids = [...new Set(vanIds)].filter(x => x != null);
  const out = new Map(ids.map(id => [id, { on_order: 0, to_order: 0, check: 0 }]));
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const vanQ = new Map(), shelfQ = new Map();
  for (const r of await all(`SELECT pl.item_id, pl.van_id, ${PO_OPEN} AS q FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                       WHERE ${PO_IS_OPEN} AND (pl.van_id IS NULL OR pl.van_id IN (${ph}))`, ...ids)) {
    if (r.van_id == null) shelfQ.set(r.item_id, (shelfQ.get(r.item_id) || 0) + r.q);
    else { const k = `${r.van_id}|${r.item_id}`; vanQ.set(k, (vanQ.get(k) || 0) + r.q); }
  }
  const cov = await lineCover();
  for (const l of await all(`SELECT l.id, l.van_id, l.item_id, l.qty, l.reserved, l.issued, l.state, l.urgent, l.po_ref
                       FROM van_lines l WHERE l.van_id IN (${ph}) AND ${STILL_MISSING('l')}`, ...ids)) {
    const mine = vanQ.get(`${l.van_id}|${l.item_id}`) || 0;
    let st = lineStatus({ ...l, on_order_van: mine, on_order: mine + (shelfQ.get(l.item_id) || 0) });
    const c = cov.get(l.id);
    if (st === 'to_order' && c && c.qty >= Math.max(0, l.qty - l.reserved - l.issued) - 1e-9) st = 'on_order';
    const o = out.get(l.van_id);
    if (o && st in o) o[st]++;
  }
  return out;
}

export async function listVans({ status } = {}) {
  const where = status === 'active' ? `WHERE ${ACTIVE_VAN}` : status ? 'WHERE v.status = ?' : '';
  const args = status && status !== 'active' ? [status] : [];
  const order = await buildOrderInfo();
  const still = await stillMissingByVan();
  // owner-r3-2: "18 waiting on PO · 29 still to order · 10 to check" for vans still to build
  const split = await missingSplitByVan((await all(`SELECT v.id FROM vans v WHERE ${ACTIVE_VAN}`)).map(r => r.id));
  const withOrder = v => ({ ...v, build_pos: order.get(v.id)?.pos ?? null, build_why: order.get(v.id)?.why ?? '', still: still.get(v.id) || NO_MISSING,
    ...(split.has(v.id) ? { split: split.get(v.id) } : {}) });
  return (await all(`
    SELECT v.*,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND (${ALLOCATABLE('l')} OR l.issued >= l.qty)) AS line_count,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND (${ALLOCATABLE('l')} OR l.issued >= l.qty) AND l.reserved + l.issued >= l.qty) AS ready_count,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND l.issued >= l.qty) AS issued_count,
      -- really waiting on parts (not counting lines waiting on an answer)
      -- (and not "as per plan" catch-alls: those are on "special parts to confirm")
      (SELECT COUNT(*) FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.van_id = v.id AND l.qty > l.reserved + l.issued
         AND ${COUNTS_SHORT_CORR('l')} AND i.placeholder = 0 AND i.sku NOT ILIKE 'PLAN-%') AS waiting_count,
      -- in production or due within the "coming up" weeks: only these count as "waiting on parts"
      CASE WHEN ${await nearVanSql('v')} THEN 1 ELSE 0 END AS near,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND l.issued < l.qty AND l.state IN ('customer','tbd')) AS decision_count
    FROM vans v ${where}
    ORDER BY CASE v.status WHEN 'in_production' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, ${PRIORITY}`, ...args)).map(withOrder);
}

export async function getVan(id) {
  const van = await get('SELECT * FROM vans WHERE id = ?', id);
  if (!van) throw httpError(404, 'Van not found');
  const fields = await all('SELECT * FROM order_fields WHERE van_id = ? ORDER BY sort', id);
  // Open PO lines for this van (with supplier and arrival date) and for the shelf.
  const poRows = await all(`SELECT pl.item_id, pl.van_id, ${PO_OPEN} AS q, p.id AS po_id, p.po_no, p.supplier,
                        COALESCE(NULLIF(pl.expected, ''), p.expected) AS expected
                      FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                      WHERE ${PO_IS_OPEN} AND (pl.van_id IS NULL OR pl.van_id = ?) ORDER BY pl.id`, id);
  const neededBy = await vanNeededBy(van);
  const lines = (await all(`SELECT l.*, i.sku, i.name, i.category, i.unit, i.kind, i.supplier, i.location, i.photo, r.name AS rule_name,
                       i.plan_column AS item_plan_column, i.placeholder, i.trade, i.unit_size,
                       (SELECT COUNT(*) FROM allocation_log a WHERE a.line_id = l.id) AS log_count
                     FROM van_lines l JOIN items i ON i.id = l.item_id LEFT JOIN rules r ON r.id = l.rule_id
                     WHERE l.van_id = ? ORDER BY i.category, i.name`, id))
    .map(l => {
      const mine = poRows.filter(p => p.item_id === l.item_id && p.van_id === l.van_id);
      const shelf = poRows.filter(p => p.item_id === l.item_id && p.van_id == null);
      const sum = rs => rs.reduce((s, p) => s + p.q, 0);
      const pos = (mine.length ? mine : shelf);
      const expected = pos.map(p => p.expected).filter(Boolean).sort().pop() || '';
      const lineNeed = l.urgent ? today() : neededBy;
      const withPo = { ...l, on_order_van: sum(mine), on_order: sum(mine) + sum(shelf), placeholder: isPlaceholder(l) ? 1 : 0,
        po_refs: [...new Set(pos.map(p => p.po_no))].join(', '),
        po_list: pos.map(p => ({ po_id: p.po_id, po_no: p.po_no, supplier: p.supplier, expected: p.expected, qty: p.q, shelf: p.van_id == null ? 1 : 0 })),
        expected, needed_by: lineNeed || '', late: !!(expected && lineNeed && expected > lineNeed) };
      return { ...withPo, status: lineStatus(withPo) };
    });
  const usual = await itemMedians(lines.map(l => l.item_id));
  for (const l of lines) l.qty_check = qtyCheckFor(l, usual.get(l.item_id));
  // Covered by another van's spare PO (or a shelf PO), as Purchasing → To order counts it (check-r4-3): say
  // which PO, so a line that dropped off To order is not shown as "Not ordered" with nothing to explain why.
  const cov = await lineCover({ vanId: van.id });
  for (const l of lines) {
    const c = cov.get(l.id);
    if (!c || !['to_order', 'on_order', 'check'].includes(l.status)) continue;
    const short = Math.max(0, l.qty - l.reserved - l.issued);
    l.cover = { ...c, text: `${c.qty < short - 1e-9 ? `${q(c.qty)} of ${q(short)} coming on ` : 'Coming on '}${c.text}` };
    if (l.status === 'to_order' && c.qty >= short - 1e-9) {
      l.status = 'on_order';
      l.po_list = c.from.map(x => ({ po_id: x.po_id, po_no: x.po_no, supplier: x.supplier, expected: x.expected, qty: x.qty, shelf: x.spare ? 0 : 1,
        spare_of: x.spare ? x.chassis : '', inactive: x.inactive }));
      l.expected = c.from.map(x => x.expected).filter(Boolean).sort().pop() || '';
      l.late = !!(l.expected && l.needed_by && l.expected > l.needed_by);
    }
  }
  // From the production plan only the customer requests / extras need checking by hand; the
  // rest of its columns are already parts.
  const reviewFields = fields.filter(f => f.section !== 'PRODUCTION PLAN' || /REQUESTS|EXTRA$/i.test(f.label));
  const { review } = buildPartsList(reviewFields, await activeRules(), await ignoreList());
  const bo = (await buildOrderInfo()).get(van.id);
  return { van: { ...van, build_pos: bo?.pos ?? null, build_why: bo?.why ?? '', still: (await stillMissingByVan({ vanId: van.id })).get(van.id) || NO_MISSING }, fields, lines, review, fromPlan: lines.some(l => l.source === 'plan') };
}

// Median quantity per van for each item (all vans, finished ones too): "what a van normally needs".
export async function itemMedians(itemIds) {
  const ids = [...new Set(itemIds)].filter(Boolean);
  const by = new Map();
  if (!ids.length) return by;
  for (const r of await all(`SELECT item_id, qty FROM van_lines WHERE item_id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
    if (!by.has(r.item_id)) by.set(r.item_id, []);
    by.get(r.item_id).push(r.qty);
  }
  const out = new Map();
  for (const [id, qs] of by) {
    qs.sort((a, b) => a - b);
    const m = Math.floor(qs.length / 2);
    out.set(id, qs.length % 2 ? qs[m] : (qs[m - 1] + qs[m]) / 2);
  }
  return out;
}

// Why a line's quantity looks odd ('' = fine): more than 3x what a van usually needs, more than the
// column's sensible most, or the plan text was unclear. 'qty-ok' in the note = someone said it's right.
export function qtyCheckFor(l, usual = 0) {
  if (/qty-ok/.test(l.note || '')) return '';
  const cap = l.source === 'plan' ? capFor(l.plan_column || l.item_plan_column || '', l.unit, usual) : Infinity;
  if (l.qty > cap) return `more than the usual most for one van (${cap})`;
  if (usual > 0 && l.qty > 3 * usual) return `more than 3× the usual ${q(usual)} ${l.unit || ''}`.trim();
  const m = /Please check quantity: ([^·]+)/.exec(l.note || '');
  if (m) return m[1].trim();
  // Plan text that says two different things ("5 / Black … need to order 2"), or has "...." next to a
  // count / description ("2 ......." — a real part, not "to be decided"; round 2, check-r1-5).
  if (l.source !== 'plan' || l.issued >= l.qty) return '';
  return leadInfo(l.spec || '', 1).check || dotsCheck(l.spec);
}

export async function updateVan(id, patch) {
  const allowed = ['customer', 'dealer', 'model', 'length', 'floor_plan', 'colour', 'atm', 'quote_no', 'order_date', 'eta', 'notes', 'reviewed', 'status', 'build_order'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return;
  if ('build_order' in patch) {
    const n = patch.build_order === '' || patch.build_order == null ? null : Math.round(Number(patch.build_order));
    if (n != null && !(n > 0)) throw httpError(400, 'Build order is a number: 1 = build first');
    patch = { ...patch, build_order: n };
  }
  if ('status' in patch && !['planned', 'in_production', 'completed', 'cancelled'].includes(patch.status)) throw httpError(400, 'Pick a status');
  await writeTx(async () => {
    const before = await get('SELECT * FROM vans WHERE id = ?', id);
    await run(`UPDATE vans SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => patch[k]), id);
    // Follow-up round 1 (chk-r3-2): a status the office sets by hand is written to the history, so undoing a
    // floor take never puts back a status the office chose ('van status' rows are the office's).
    if (before && 'status' in patch && patch.status !== before.status) {
      const word = s => String(s || '').replace(/_/g, ' ');
      await logAlloc('van status', { van_id: id, field: 'van status', before: word(before.status), after: word(patch.status), note: 'status set by the office' });
    }
    // Finishing a van uses up what it still had set aside (it left inside the van); cancelling frees it.
    if (patch.status === 'completed' && before.status !== 'completed') {
      await useUpVan(id);
      await run('UPDATE vans SET area_id = NULL WHERE id = ?', id); // a finished van frees its bay
    }
    if (patch.status === 'cancelled' && before.status !== 'cancelled') await releaseVan(id);
    if (patch.status && ['planned', 'in_production'].includes(patch.status) && ['completed', 'cancelled'].includes(before.status)) {
      for (const { item_id } of await all('SELECT DISTINCT item_id FROM van_lines WHERE van_id = ?', id)) await allocateItem(item_id, id);
    }
  });
}

async function releaseVan(id) {
  const items = await all('SELECT DISTINCT item_id FROM van_lines WHERE van_id = ? AND reserved > 0', id);
  for (const l of await all('SELECT * FROM van_lines WHERE van_id = ? AND reserved > 0 ORDER BY id', id)) {
    await logAlloc('van finished', { van_id: id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0,
      firm_change: -l.reserved_firm, note: 'van cancelled – set-aside back to the shelf' });
  }
  await run('UPDATE van_lines SET reserved = 0, reserved_firm = 0 WHERE van_id = ?', id);
  await run('UPDATE vans SET area_id = NULL WHERE id = ?', id); // a finished van frees its bay
  for (const { item_id } of items) await allocateItem(item_id);
}

// A finished van went out with the parts still set aside for it, so they're counted as used
// (Return puts back anything that came back to the shelf). Lines that are still short aren't
// used up: what little they had set aside goes back to the other vans, as before.
// (Joins the caller's write transaction, or runs in its own.)
export async function useUpVan(vanId) {
  return writeTx(() => useUpVanNow(vanId));
}
async function useUpVanNow(vanId) {
  const van = await get('SELECT chassis FROM vans WHERE id = ?', vanId);
  if (!van) return;
  const freed = new Set();
  for (const l of await all('SELECT * FROM van_lines WHERE van_id = ? AND reserved > 0 ORDER BY id', vanId)) {
    if (l.qty > l.reserved + l.issued) {
      await run('UPDATE van_lines SET reserved = 0, reserved_firm = 0 WHERE id = ?', l.id);
      await logAlloc('van finished', { van_id: vanId, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0,
        firm_change: -l.reserved_firm, note: `${van.chassis} finished while still short – set-aside back to the shelf` });
      freed.add(l.item_id);
      continue;
    }
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', l.reserved, l.item_id);
    await run('UPDATE van_lines SET issued = issued + reserved, reserved = 0, reserved_firm = 0 WHERE id = ?', l.id);
    await logAlloc('van finished', { van_id: vanId, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0,
      firm_change: -l.reserved_firm, note: `${van.chassis} finished – set-aside counted as used` });
    await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note) VALUES(?, ?, 'issue', ?, ?, 'Used — van finished')`,
        l.item_id, -l.reserved, vanId, van.chassis);
  }
  for (const itemId of freed) await allocateItem(itemId);
}

export async function deleteVan(id) {
  await writeTx(async () => {
    const items = await all('SELECT DISTINCT item_id FROM van_lines WHERE van_id = ?', id);
    await run('DELETE FROM vans WHERE id = ?', id);
    for (const { item_id } of items) await allocateItem(item_id);
  });
}

export async function addLine(vanId, { item_id, qty, spec = '', note = '' }) {
  if (!(qty > 0)) throw httpError(400, 'Quantity must be more than 0');
  return writeTx(async () => {
    if (!await get('SELECT 1 FROM vans WHERE id = ?', vanId)) throw httpError(404, 'That van no longer exists — refresh');
    const id = await insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, note, source) VALUES(?,?,?,?,?, 'manual')`, vanId, item_id, qty, spec, note);
    await allocateItem(item_id, vanId);
    return { id };
  });
}

export async function updateLine(lineId, { qty, spec, note }) {
  await writeTx(async () => {
    const l = await get('SELECT * FROM van_lines WHERE id = ?', lineId);
    if (!l) throw httpError(404, 'Line not found');
    const newQty = qty ?? l.qty;
    if (newQty < l.issued) throw httpError(400, `${l.issued} already issued — can't go below that`);
    // Editing a rule line by hand turns it into a manual line so a rebuild won't overwrite it.
    await run(`UPDATE van_lines SET qty = ?, reserved = LEAST(reserved, ?::double precision - issued), spec = ?, note = ?, source = 'manual' WHERE id = ?`,
        newQty, newQty, spec ?? l.spec, note ?? l.note, lineId);
    await allocateItem(l.item_id, l.van_id);
  });
}

export async function deleteLine(lineId) {
  await writeTx(async () => {
    const l = await get('SELECT * FROM van_lines WHERE id = ?', lineId);
    if (!l) return;
    if (l.issued > 0) throw httpError(400, 'Stock was already issued for this line — return it first');
    await run('DELETE FROM van_lines WHERE id = ?', lineId);
    await allocateItem(l.item_id);
  });
}

// Hand reserved stock to the production floor (it leaves the shelf).
export async function issue(vanId, lineIds = null) {
  return writeTx(async () => issueLines(vanId, lineIds));
}

async function issueLines(vanId, lineIds = null) {
  const van = await get('SELECT * FROM vans WHERE id = ?', vanId);
  const lines = (await all('SELECT * FROM van_lines WHERE van_id = ? AND reserved > 0 ORDER BY id', vanId))
    .filter(l => !lineIds || lineIds.includes(l.id));
  for (const l of lines) {
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', l.reserved, l.item_id);
    await run('UPDATE van_lines SET issued = issued + reserved, reserved = 0 WHERE id = ?', l.id);
    await run(`INSERT INTO movements(item_id, qty, type, van_id, ref) VALUES(?, ?, 'issue', ?, ?)`, l.item_id, -l.reserved, vanId, van.chassis);
  }
  if (lines.length && van.status === 'planned') await run(`UPDATE vans SET status = 'in_production' WHERE id = ?`, vanId);
  return lines.length;
}

// Put issued stock back on the shelf (wrong part, van changed…).
export async function returnLine(lineId, qty) {
  await writeTx(async () => {
    const l = await get('SELECT l.*, v.chassis FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.id = ?', lineId);
    if (!l) throw httpError(404, 'That part line no longer exists — refresh');
    const q = Math.min(qty ?? l.issued, l.issued);
    if (!(q > 0)) throw httpError(400, 'Nothing issued to return');
    await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', q, l.item_id);
    await run('UPDATE van_lines SET issued = issued - ? WHERE id = ?', q, lineId);
    await run(`INSERT INTO movements(item_id, qty, type, van_id, ref) VALUES(?, ?, 'return', ?, ?)`, l.item_id, q, l.van_id, l.chassis);
    // Back to its own van first (a per-van part is never handed to another van automatically).
    await allocateItem(l.item_id, l.van_id);
  });
}

// ───────────────────────── stock movements ─────────────────────────

// Stock in. Received for a particular van (a PO line for that van, a delivery booked for it): it is
// locked to that van, so re-prioritising never moves it.
// `poRef`: the order number it came on (the van's line naming that order is filled first — see allocateItem).
export async function receive(itemId, qty, { ref = '', note = '', vanId = null, by = '', poRef = '' } = {}) {
  if (!(qty > 0)) throw httpError(400, 'Quantity must be more than 0');
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
async function vanNeedLocked(vanId, itemId) {
  return (await get(`SELECT COALESCE(SUM(GREATEST(0, l.qty - l.issued - l.reserved_firm)), 0) AS n FROM van_lines l
              WHERE l.van_id = ? AND l.item_id = ? AND ${ALLOCATABLE('l')}`, vanId, itemId)).n;
}

// Tick some quantity off an open PO line; the PO closes once everything on it has arrived.
// Returns true if this closed the PO.
async function bookPoLine(pl, q) {
  await run('UPDATE po_lines SET received = received + ? WHERE id = ?', q, pl.id);
  return closePoIfDone(pl.po_id);
}
// A PO is finished once every line has arrived or had its balance cancelled. Returns true if it closed now.
async function closePoIfDone(poId) {
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
  if (!(qty > 0)) throw httpError(400, 'Quantity must be more than 0');
  return writeTx(async () => {
    const item = await get('SELECT kind FROM items WHERE id = ?', itemId);
    if (!item) throw httpError(404, 'Item not found');
    const lines = await all(`SELECT pl.*, p.po_no FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
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
    const held = async () => new Map((await all('SELECT id, reserved, reserved_firm FROM van_lines WHERE item_id = ? ORDER BY id', itemId)).map(r => [r.id, r]));
    const before = await held();
    const forVan = new Map(); // van → how much of this delivery was ticked off that van's PO lines
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
    const chassisOf = async id => (await get('SELECT chassis FROM vans WHERE id = ?', id))?.chassis || '';
    for (const [v, parts] of forVan) {
      let got = 0;
      for (const { po, n } of parts) {
        const toVan = Math.min(n, await vanNeedLocked(v, itemId));
        if (toVan > 1e-9) { await stockIn(itemId, toVan, v, by, po); rest -= toVan; got += toVan; }
      }
      if (got > 1e-9) vanTxt.push(`${await chassisOf(v)}${forVan.size > 1 || got !== qty ? ` (${q(got)})` : ''}`);
    }
    if (rest > 1e-9) await stockIn(itemId, rest, vanId, by);
    const forNote = vanTxt.length && !(forVan.size === 1 && forVan.has(vanId)) ? `For ${vanTxt.join(', ')}` : '';
    const mv = await insert(`INSERT INTO movements(item_id, qty, type, ref, note, van_id, worker) VALUES(?, ?, 'receive', ?, ?, ?, ?)`, itemId, qty,
      [ref, pos.length ? `PO ${pos.join(', ')}` : ''].filter(Boolean).join(' — '), [note, forNote].filter(Boolean).join(' — '), vanId, by);
    const movementId = mv;
    for (const [id, r] of await held()) {
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
      const vId = (await get('SELECT van_id FROM van_lines WHERE id = ?', lineId))?.van_id;
      if (vId != null) perVan.set(vId, (perVan.get(vId) || 0) + d);
    }
    const got = [...perVan].filter(([, n]) => n > 1e-9);
    const rank = got.length > 1 ? new Map((await all(`SELECT v.id FROM vans v WHERE v.id IN (${got.map(() => '?').join(',')}) ORDER BY ${PRIORITY}`,
      ...got.map(([v]) => v))).map((r, i) => [r.id, i])) : new Map();
    const to = [];
    for (const [v, n] of got.sort(([a], [b]) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))) { // in build order
      to.push({ van_id: v, chassis: await chassisOf(v), qty: Math.min(n, qty) });
    }
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
    if (!Number.isFinite(Number(qty))) throw httpError(400, 'Type a quantity');
    const kind = type || (mode === 'set' ? 'count' : 'adjust');
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
  return { item, movements, usage, pos, rules, history, reorder, unassigned, spare: unassigned ? await spareAck(Number(id)) : 0 };
}

// ───────────────────────── purchasing ─────────────────────────

// ── dates and lead times ──

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
// When a van needs its parts: in production → today; otherwise due date − build weeks.
// '' = no date (blank, or a planned van whose date has passed: "No date – check").
// (`buildWeeks` left out: the setting.)
export async function vanNeededBy(v, buildWeeks) {
  if (buildWeeks === undefined) buildWeeks = (await purchasingSettings()).build_weeks;
  return neededByFor(v, buildWeeks);
}
function neededByFor(v, buildWeeks) {
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
  await syncSuppliers();
  const key = `${await dataVersion()}|${today()}`;
  if (shortMemo?.key !== key) {
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

// Different parts in "Order now" (kept for older callers; same as orderNowCount().parts).
export async function orderNowItems(sh) {
  if (sh === undefined) sh = await shortages();
  return sh.orderNow ? sh.orderNow.parts : orderNowCount(sh.rows).parts;
}

// ── "Check: already ordered?" — plan order numbers nobody has confirmed ──

// Which supplier's order a plan order number belongs to, and the group it is answered in.
// The part's own supplier — unless the plan text puts another supplier's name right before the number
// ("KO Jack E time 29" → E time; "Dometic Freshjet Pro Order 17" stays with the part's supplier, Dometic is
// only the brand). A part with no supplier takes the one named anywhere in the text ("Vinguard Antenna /
// Butterfly /coast to Coast 141" → Coast to Coast). With neither, the number is grouped per kind of part
// (plan column, else part name): "Double Axel 141" (wheel box) and "Grey telescopic 141" (table leg) are
// not lumped together just because they share a number.
// `l` needs po_ref, spec, plan_column, name and the part's supplier (`item_supplier` or `supplier`).
// `supOf`: the matcher from `await supplierMatcher()` — required now (making one reads the database).
export function orderGroupOf(l, supOf) {
  if (typeof supOf !== 'function') throw new TypeError('orderGroupOf(l, supOf): pass await supplierMatcher()');
  const ref = String(l.po_ref || '').trim();
  const own = String(l.item_supplier ?? l.supplier ?? '').trim();
  const named = supOf(l.spec);
  const n = ref.replace(/^0+(?=\d)/, '');
  const rightBefore = named && /^\d+$/.test(n) && new RegExp(`${reEsc(named).replace(/\s+/g, '[\\s-]*')}[\\s/,-]*(?:order(?:ed)?\\s*(?:no\\.?\\s*)?#?\\s*)?0*${n}(?!\\d)`, 'i').test(String(l.spec || ''));
  const fromText = rightBefore || !own ? named : '';
  const supplier = fromText || own;
  if (supplier) return { key: `${supplier.toLowerCase()}|${ref}`, supplier, po_ref: ref, from_text: fromText && fromText.toLowerCase() !== own.toLowerCase() ? 1 : 0,
    label: `${supplier} ${ref}` };
  const part = String(l.plan_column || l.name || '').replace(/\s*\(as per plan\)\s*$/i, '').trim();
  return { key: `|${ref}|${part.toLowerCase()}`, supplier: '', po_ref: ref, from_text: 0, part,
    label: `Order ${ref}${part ? ` – ${part}` : ''} (no supplier)` };
}

// One group per supplier AND order number ("Battery Stop 200", "Coast to Coast 137"): the plan's
// order numbers run per supplier, so "11" for White Vision and "11" for Nikpol are different orders
// (round 2, user-r1-1). The supplier comes from orderGroupOf (named in the plan text, else the part's).
// Each group: needed_by = the earliest "needed by" of its lines (today for vans in production), near =
// some line is for a van in production or due within the "coming up" weeks; near groups come first
// (earliest needed by first), the rest are "later vans". `target` says which PO a "Yes" adds to:
// the open PO with that number for that supplier, or a new one.
// Display only: nothing is changed until someone answers.
export async function checkOrdered() {
  const rows = await all(`
    WITH op AS (${OPEN_PO_BY_VAN})
    SELECT l.id, l.van_id, l.item_id, trim(l.po_ref) AS po_ref, l.qty - l.reserved - l.issued AS short, l.spec, l.plan_column,
      v.chassis, v.eta, v.status AS van_status, i.sku, i.name, i.unit, trim(i.supplier) AS supplier, i.trade,
      CASE WHEN ${await nearVanSql('v')} THEN 1 ELSE 0 END AS near
    FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
      LEFT JOIN op ON op.item_id = l.item_id AND op.van_id = l.van_id
    WHERE ${ACTIVE_VAN} AND ${UNANSWERED('l', 'op')}
    ORDER BY l.id`);
  const ranks = await vanRanks();
  const set = await purchasingSettings();
  const supOf = await supplierMatcher();
  const groups = new Map();
  for (const r of rows) {
    const og = orderGroupOf(r, supOf);
    if (!groups.has(og.key)) groups.set(og.key, { key: og.key, po_ref: og.po_ref, supplier: og.supplier, label: og.label, part: og.part || '',
      lines: [], near: 0, needed_by: '', from_text: 0 });
    const g = groups.get(og.key);
    const neededBy = neededByFor({ status: r.van_status, eta: r.eta }, set.build_weeks);
    g.lines.push({ ...r, needed_by: neededBy, placeholder: isPlaceholder(r) ? 1 : 0, from_text: og.from_text });
    if (og.from_text) g.from_text = 1;
    if (r.near) g.near = 1;
    if (neededBy && (!g.needed_by || neededBy < g.needed_by)) g.needed_by = neededBy;
  }
  const t = today();
  for (const g of groups.values()) {
    g.lines.sort((a, b) => (ranks.get(a.van_id) ?? 1e9) - (ranks.get(b.van_id) ?? 1e9) || a.name.localeCompare(b.name));
    // Round 4 (user-r3-1): each line says its van's place in the build order and how late it is; the group
    // says its FIRST van ("#1 ST0367 – 26 days late") and the groups are sorted by that van.
    for (const l of g.lines) {
      l.build_pos = ranks.has(l.van_id) ? ranks.get(l.van_id) + 1 : null;
      Object.assign(l, timingFor({ status: l.van_status, eta: l.eta }, t, set.build_weeks));
    }
    const f = g.lines[0];
    g.first = { van_id: f.van_id, chassis: f.chassis, build_pos: f.build_pos, van_status: f.van_status, eta: f.eta,
      late_days: f.late_days, needed_now: f.needed_now, when: f.when,
      label: `${f.build_pos ? `#${f.build_pos} ` : ''}${f.chassis} – ${f.when}` };
    g.suppliers = [g.supplier]; // older screens read this
    // Which PO a "Yes" adds to.
    const po = g.supplier ? await get(`SELECT id, po_no, supplier, ordered_at, expected FROM purchase_orders WHERE status = 'open' AND lower(trim(po_no)) = lower(?)
                                 AND lower(trim(supplier)) = lower(?) ORDER BY id LIMIT 1`, g.po_ref, g.supplier) : null;
    g.target = po ? { po_id: po.id, po_no: po.po_no, supplier: po.supplier, exists: 1, ordered_at: po.ordered_at || '', expected: po.expected || '' } : { po_id: null, po_no: g.po_ref, supplier: g.supplier, exists: 0 };
    // Other open POs with this number (another supplier, or none): shown so nobody is surprised.
    g.open_pos = await all(`SELECT id, po_no, supplier FROM purchase_orders WHERE status = 'open' AND lower(trim(po_no)) = lower(?) ORDER BY id`, g.po_ref);
  }
  // Vans due soon first, then by the first van's place in the build order (#1 first), then the most parts.
  return [...groups.values()].sort((a, b) => b.near - a.near || (a.first.build_pos ?? 1e9) - (b.first.build_pos ?? 1e9)
    || (a.needed_by || '9999').localeCompare(b.needed_by || '9999')
    || b.lines.length - a.lines.length || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

// How late a van is, in plain words (round 4, user-r3-1). late_days = days past the due date (vans in
// production); needed_now = its parts are needed now (in production, or a planned van due within the build
// weeks). when: "26 days late" / "in production, due 19/11" / "in production, no due date" /
// "due 3/11 – parts needed now" / "due 3/12" / "date passed (8/2) – check" / "no due date".
// (`buildWeeks` left out: the setting.)
export async function vanTiming(v, t = today(), buildWeeks) {
  if (buildWeeks === undefined) buildWeeks = (await purchasingSettings()).build_weeks;
  return timingFor(v, t, buildWeeks);
}
function timingFor(v, t, buildWeeks) {
  const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
  if (v.status === 'in_production') {
    if (v.eta && v.eta < t) { const n = days(t, v.eta); return { late_days: n, needed_now: 1, when: `${n} day${n === 1 ? '' : 's'} late` }; }
    return { late_days: 0, needed_now: 1, when: v.eta ? `in production, due ${dm(v.eta)}` : 'in production, no due date' };
  }
  if (!v.eta) return { late_days: 0, needed_now: 0, when: 'no due date' };
  if (v.eta < t) return { late_days: 0, needed_now: 0, when: `date passed (${dm(v.eta)}) – check` };
  const now = addDays(v.eta, -7 * buildWeeks) <= t;
  return { late_days: 0, needed_now: now ? 1 : 0, when: `due ${dm(v.eta)}${now ? ' – parts needed now' : ''}` };
}

export async function checkOrderedCount() {
  return (await get(`WITH op AS (${OPEN_PO_BY_VAN}) SELECT COUNT(*) AS c FROM van_lines l JOIN vans v ON v.id = l.van_id
              LEFT JOIN op ON op.item_id = l.item_id AND op.van_id = l.van_id WHERE ${ACTIVE_VAN} AND ${UNANSWERED('l', 'op')}`)).c;
}

// Answer for one order number. answer 'yes': it is on order — creates or joins the open PO with that
// number for each part's supplier (`supplier` is used for parts with none) and adds the short quantity
// for the van with its spec. answer 'no': still to order (state 'not_ordered'), so the lines show up in
// the order list straight away. `lineIds`: only these lines (default: every unanswered line with that number).
// `key`: the group answered (checkOrdered's g.key — one answer per supplier + number, round 2); only
// lines in that group are answered. `group` (older screens): the group's supplier ('' = no supplier).
// Each line goes on the PO of its group's supplier (the one the plan text names, else the part's).
// `dates` (Small fixes & phone round 1, check-r4-2): { ordered_at, expected, yesAll } — written on every PO this
// answer CREATES ('' = not known). A new PO with no expected date from "Yes, all on order" is put on "POs to check"
// as "no delivery date". A PO that already exists keeps the dates it has; a BLANK ordered / expected date on it is
// filled with the date typed (Small fixes & phone round 2, sp-r1-4), and with "Yes, all on order" an existing PO
// that still has no expected date is flagged "no delivery date" too (POs to check), like a new one.
// `stillOpen`: line ids that were waiting for an answer when a "Yes, all on order" batch started — still answered
// here although an earlier order number in the same batch already put that van's part on order (one van with
// two service doors on Coast to Coast 137 and 143 used to stop the whole batch with "Nothing left to answer").
export async function answerOrdered(poRef, answer, { lineIds = null, supplier = '', group, key, by = '', dates = null, stillOpen = null } = {}) {
  const ref = String(poRef || '').trim();
  if (!ref) throw httpError(400, 'Which order number?');
  if (!['yes', 'no'].includes(answer)) throw httpError(400, 'Answer "Yes, on order" or "No, still to order"');
  return writeTx(async () => {
    const supOf = await supplierMatcher();
    let lines = (await all(`
      WITH op AS (${OPEN_PO_BY_VAN})
      SELECT l.*, v.chassis, i.supplier AS item_supplier, i.sku, i.name FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
        LEFT JOIN op ON op.item_id = l.item_id AND op.van_id = l.van_id
      WHERE ${ACTIVE_VAN} AND trim(l.po_ref) = ? AND (${UNANSWERED('l', 'op')}${stillOpen?.size ? ` OR (l.state = '' AND l.qty > l.reserved + l.issued + 1e-9
        AND l.id IN (${[...stillOpen].map(Number).filter(Number.isFinite).join(',')}))` : ''}) ORDER BY l.id`, ref))
      .map(l => ({ ...l, og: orderGroupOf(l, supOf) }));
    if (typeof key === 'string' && key) lines = lines.filter(l => l.og.key === key);
    else if (typeof group === 'string') lines = lines.filter(l => l.og.supplier.toLowerCase() === group.trim().toLowerCase());
    if (Array.isArray(lineIds)) { const want = new Set(lineIds.map(Number)); lines = lines.filter(l => want.has(l.id)); }
    if (!lines.length) throw httpError(409, 'Nothing left to answer for that order number — refresh');
    const sup = String(supplier || '').trim();
    if (answer === 'no') {
      for (const l of lines) {
        await run(`UPDATE van_lines SET state = 'not_ordered' WHERE id = ?`, l.id);
        await logAlloc('check ordered', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'state', before: '', after: 'not_ordered', worker: by, note: `Plan said order ${ref}: still to order` });
      }
      return { lines: lines.length, pos: [] };
    }
    const missing = lines.filter(l => !l.og.supplier);
    if (missing.length && !sup) {
      throw Object.assign(httpError(409, `Which supplier is order ${ref} with? (${missing.length} part(s) have no supplier)`), {
        confirm: { needSupplier: true, parts: [...new Set(missing.map(l => l.sku))] } });
    }
    const pos = new Map();
    const made = [];
    const joined = new Map(); // existing PO id → what this answer did to its dates
    const poFor = async s => {
      if (pos.has(s)) return pos.get(s);
      let po = await get(`SELECT id, ordered_at, expected, notes, needs_check FROM purchase_orders WHERE status = 'open' AND lower(trim(po_no)) = lower(?) AND lower(trim(supplier)) = lower(?) ORDER BY id LIMIT 1`, ref, s);
      if (po && dates) {
        // Already in the system: fill only what is blank, never overwrite a date already there.
        const ordered = validDate(dates.ordered_at), expected = validDate(dates.expected);
        const setOrd = !!(ordered && !String(po.ordered_at || '').trim()), setExp = !!(expected && !String(po.expected || '').trim());
        if (setOrd) await run('UPDATE purchase_orders SET ordered_at = ? WHERE id = ?', ordered, po.id);
        if (setExp) await run('UPDATE purchase_orders SET expected = ? WHERE id = ?', expected, po.id);
        const hasExp = setExp || !!String(po.expected || '').trim();
        // No delivery date after "Yes, all on order": on "POs to check" as "no delivery date" (poProblems needs the mark).
        let flagged = false;
        if (dates.yesAll && !hasExp) {
          const stamp = `Parts added from the production plan${by ? ` by ${by}` : ''} on ${today()} (${YES_ALL_MARK})`;
          if (!String(po.notes || '').includes(`(${YES_ALL_MARK})`) || !po.needs_check) {
            await run(`UPDATE purchase_orders SET notes = btrim(COALESCE(notes, '') || chr(10) || ?::text, chr(10) || ' '), needs_check = 1 WHERE id = ?`, stamp, po.id);
          }
          flagged = true;
        }
        joined.set(po.id, { set_ordered: setOrd ? ordered : '', set_expected: setExp ? expected : '', kept_ordered: setOrd ? '' : String(po.ordered_at || ''),
          kept_expected: setExp ? '' : String(po.expected || ''), no_date: flagged ? 1 : 0 });
      }
      if (!po) {
        // The plan's order numbers are per supplier ("White Vision 11", "Onex 08"), so the same number
        // for another supplier is normal here and not flagged. Ordered date unknown (set it on the PO).
        const ordered = validDate(dates?.ordered_at), expected = validDate(dates?.expected);
        po = { id: await insert(`INSERT INTO purchase_orders(po_no, supplier, notes, ordered_at, expected, needs_check) VALUES(?,?,?,?,?,?)`, ref, s,
          `Order number from the production plan, confirmed on order${by ? ` by ${by}` : ''}${dates?.yesAll ? ` (${YES_ALL_MARK})` : ''}`,
          ordered, expected, !s || (dates?.yesAll && !expected) ? 1 : 0) };
        made.push(po.id);
      }
      pos.set(s, po.id);
      return po.id;
    };
    for (const l of lines) {
      const s = l.og.supplier || sup;
      const poId = await poFor(s);
      const short = Math.max(0, l.qty - l.reserved - l.issued);
      await run('INSERT INTO po_lines(po_id, item_id, qty, van_id, spec) VALUES(?,?,?,?,?)', poId, l.item_id, short, l.van_id, specForPo(l.spec, l.po_ref));
      await logAlloc('check ordered', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'po_lines', before: '', after: `PO ${ref} (${s || 'no supplier'}) +${q(short)}`, worker: by, note: `Plan said order ${ref}: on order` });
    }
    await syncSuppliers();
    return { lines: lines.length, pos: [...pos.values()],
      po_list: [...pos.entries()].map(([s, id]) => ({ id, po_no: ref, supplier: s, new: made.includes(id) ? 1 : 0, ...(joined.get(id) || {}) })) };
  });
}

// "Yes, all on order" for ONE supplier (round 4, user-r3-1): several order numbers of that supplier answered
// "Yes" together, all or nothing (one transaction). groups = [{ key, po_ref, line_ids }] as shown on the
// screen (unticked parts are left out). Every group must belong to `supplier` — groups with no supplier are
// refused (they need their supplier typed one by one). Each group goes through answerOrdered, so each part
// lands on that supplier's PO with its own number, logged as before.
// `ordered_at` / `expected` (check-r4-2): one "ordered on" and "expected by" date for every PO it creates
// ('' = not known; a PO with no expected date goes on "POs to check" as "no delivery date").
export async function answerOrderedMany(groups, { supplier = '', by = '', ordered_at = '', expected = '' } = {}) {
  const sup = String(supplier || '').trim();
  for (const d of [ordered_at, expected]) if (d && !validDate(d)) throw httpError(400, 'Pick a date, or tick "not known"');
  if (!sup) throw httpError(400, 'Pick one supplier first');
  if (!Array.isArray(groups) || !groups.length) throw httpError(400, 'Nothing to answer');
  const want = sup.toLowerCase();
  for (const g of groups) {
    const k = String(g?.key || '');
    if (!k || k.slice(0, k.indexOf('|')) !== want) throw httpError(400, `Order ${g?.po_ref || '?'} is not ${sup}'s — refresh`);
  }
  return writeTx(async () => {
    const out = { lines: 0, groups: 0, po_list: [] };
    // Every line waiting for an answer right now (before this batch puts anything on order).
    const stillOpen = new Set((await all(`WITH op AS (${OPEN_PO_BY_VAN}) SELECT l.id FROM van_lines l JOIN vans v ON v.id = l.van_id
      LEFT JOIN op ON op.item_id = l.item_id AND op.van_id = l.van_id WHERE ${ACTIVE_VAN} AND ${UNANSWERED('l', 'op')}`)).map(r => r.id));
    for (const g of groups) {
      const r = await answerOrdered(g.po_ref, 'yes', { key: String(g.key), lineIds: Array.isArray(g.line_ids) ? g.line_ids : null, by,
        dates: { ordered_at: validDate(ordered_at), expected: validDate(expected), yesAll: true }, stillOpen });
      out.lines += r.lines; out.groups++;
      out.po_list.push(...(r.po_list || []));
    }
    return out;
  });
}

// ── customer supplies / to be decided ──

// Set or clear a line's status by hand. Setting Customer supplies / To be decided releases the shelf
// stock held for it; stock received for this van (locked) needs an answer: stock 'keep' (stays with the
// van) or 'shelf' (goes back to free stock). Without one the reply asks (409 with confirm).
export async function setLineState(lineId, state, { stock = '', by = '' } = {}) {
  if (!STATES.includes(state)) throw httpError(400, 'Pick Customer supplies, To be decided or normal');
  return writeTx(async () => {
    const l = await get('SELECT l.*, v.chassis FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.id = ?', lineId);
    if (!l) throw httpError(404, 'That part line no longer exists — refresh');
    if (l.state === state) return { ok: true };
    const reminder = REMINDER_STATES.includes(state);
    if (reminder && l.issued >= l.qty) throw httpError(400, 'This part is already fitted');
    if (reminder && l.reserved_firm > 0 && !['keep', 'shelf'].includes(stock)) {
      throw Object.assign(httpError(409, `${q(l.reserved_firm)} received for ${l.chassis} are on the shelf for this line`), {
        confirm: { stock: true, qty: l.reserved_firm, message: `${q(l.reserved_firm)} of this part were received for ${l.chassis}. Keep them for the van, or put them on the shelf?` } });
    }
    await run('UPDATE van_lines SET state = ? WHERE id = ?', state, lineId);
    await logAlloc('state', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'state', before: STATE_LABEL[l.state] || l.state, after: STATE_LABEL[state] || state, worker: by });
    if (reminder) {
      const keep = stock === 'keep' ? Math.min(l.reserved, l.reserved_firm) : 0;
      if (l.reserved > keep + 1e-9) {
        await run('UPDATE van_lines SET reserved = ?, reserved_firm = LEAST(reserved_firm, ?::double precision) WHERE id = ?', keep, keep, lineId);
        await logAlloc('state', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: keep, worker: by,
          note: `${STATE_LABEL[state]}: ${q(l.reserved - keep)} back on the shelf${stock === 'shelf' ? ' (received for the van, office chose the shelf)' : ''}` });
        await allocateItem(l.item_id, null, { reason: 'state', worker: by }); // the freed stock goes to the next van waiting
      }
    } else {
      await allocateItem(l.item_id, l.van_id, { reason: 'state', worker: by }); // needs stock again
    }
    return { ok: true };
  });
}

// "Waiting on a decision": customer supplies / to be decided lines, by trade. `vanId`: one van only.
export async function decisionLines({ vanId = null } = {}) {
  return all(`SELECT l.id, l.van_id, l.item_id, l.qty, l.reserved, l.reserved_firm, l.issued, l.spec, l.state, l.plan_column, l.note,
                v.chassis, v.eta, v.status, i.sku, i.name, i.unit, i.trade
              FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
              WHERE ${ACTIVE_VAN} AND l.state IN ('customer','tbd') AND l.issued < l.qty AND (?::integer IS NULL OR v.id = ?::integer)
              ORDER BY i.trade = '', i.trade, ${PRIORITY}, i.name`, vanId, vanId);
}

// Special parts "still to order" (Small fixes & phone round 2, sp-r1-1): a real shortage (not customer supplies /
// to be decided, not waiting on "Check: already ordered?") that its van's own open PO does not already cover
// (on order for this van >= needed − set aside − fitted). A covered line is "on order" (SPECIAL_ON_ORDER), as the
// Stock "Still to order" column counts it, so answering "Yes, on order" never makes the number go up.
const VAN_PO_QTY = (l = 'l') => `COALESCE((SELECT SUM(${PO_OPEN}) FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
  WHERE ${PO_IS_OPEN} AND pl.item_id = ${l}.item_id AND pl.van_id = ${l}.van_id), 0)`;
const SPECIAL_SHORT = (l = 'l') => `(${COUNTS_SHORT_CORR(l)} AND ${l}.qty > ${l}.reserved + ${l}.issued + 1e-9)`;
const SPECIAL_COVERED = (l = 'l') => `(${VAN_PO_QTY(l)} >= ${l}.qty - ${l}.reserved - ${l}.issued - 1e-9)`;
const SPECIAL_TO_ORDER = (l = 'l') => `(${SPECIAL_SHORT(l)} AND NOT ${SPECIAL_COVERED(l)})`;
const SPECIAL_ON_ORDER = (l = 'l') => `(${SPECIAL_SHORT(l)} AND ${SPECIAL_COVERED(l)})`;

// Special parts ("as per plan" lines) still to confirm / order, grouped by van in build order.
// `vanId`: one van only. `all`: include lines already set aside (not only short ones).
// Round 3 (user-r2-3): also `already` (the van's own line for the part it most likely is: "This van already
// has … – same thing?") and `clash` (the part fits two lines of this van, so neither gets it suggested).
// Each line carries (round 2, user-r1-2): `suggest` (the real part it most likely is — `sure` when it is
// on the reviewed list, was linked the same way before, or its model number is in exactly one part's
// name), `same` (every other line still to confirm with the same catch-all and the same text, on any
// van: "Link all N lines with this same text") and `supplier_guess` (a supplier named in the text).
export async function placeholderLines({ vanId = null, onlyShort = false } = {}) {
  const allRows = await all(`
    SELECT l.id, l.van_id, l.item_id, l.qty, l.reserved, l.reserved_firm, l.issued, l.spec, l.note, l.plan_column, l.po_ref, l.urgent,
      v.chassis, v.eta, v.status, i.sku, i.name, i.unit,
      l.state, COALESCE((SELECT SUM(${PO_OPEN}) FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                WHERE ${PO_IS_OPEN} AND pl.item_id = l.item_id AND pl.van_id = l.van_id), 0) AS on_order,
      CASE WHEN ${SPECIAL_TO_ORDER('l')} THEN 1 ELSE 0 END AS is_short,
      CASE WHEN ${SPECIAL_ON_ORDER('l')} THEN 1 ELSE 0 END AS is_on_order,
      CASE WHEN ${UNANSWERED_CORR('l')} THEN 1 ELSE 0 END AS is_check
    FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
    WHERE ${ACTIVE_VAN} AND (i.placeholder = 1 OR i.sku ILIKE 'PLAN-%') AND l.issued < l.qty
    ORDER BY ${PRIORITY}, i.name, l.id`);
  // A cell that only holds the dealer's name ("CHASSIS: Caravan Treading Center") is not a part: marked
  // `not_part` and never "still to order" (Small fixes & phone round 1, user-r4-6).
  const dealers = await dealerNames();
  for (const r of allRows) { r.not_part = notAPart(r.spec, dealers); if (r.not_part) r.is_short = r.is_on_order = r.is_check = 0; }
  const rows = onlyShort ? allRows.filter(r => r.is_short) : allRows;
  const byKey = new Map();
  for (const r of rows) {
    const k = sameTextKey(r.sku, r.spec);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ id: r.id, van_id: r.van_id, chassis: r.chassis });
  }
  const mine = rows.filter(r => vanId == null || r.van_id === vanId);
  // Suggestions for every catch-all line of these vans together (set-aside ones too, so "one part for two
  // lines of one van" is always seen): a part the van already has is never suggested — it says "This van
  // already has … – same thing?" instead — nor one part for two lines of one van (round 3, user-r2-3).
  const vanSet = new Set(mine.map(r => r.van_id));
  const cache = await linkableItemsCache();
  const sugg = mine.length ? await suggestionsFor(allRows.filter(r => vanSet.has(r.van_id)), cache) : new Map();
  // A text that names 2+ parts: each part with its own suggestion (user-r4-6), and the ones already on the van.
  const onVan = mine.some(r => textParts(r.spec).length) ? await vanParts([...vanSet]) : new Map();
  const supOf = await supplierMatcher(); // (supplierFromText for each line, reading the supplier list once)
  const vans = new Map();
  for (const r of mine) {
    if (!vans.has(r.van_id)) vans.set(r.van_id, { van_id: r.van_id, chassis: r.chassis, eta: r.eta, status: r.status, lines: [] });
    const sg = sugg.get(r.id) || {};
    vans.get(r.van_id).lines.push({ ...r, duplicate: LINK_FLAG_RE.test(r.note),
      suggest: sg.suggest || null, already: sg.already || null, clash: sg.clash || null, different: sg.different || null,
      same: (byKey.get(sameTextKey(r.sku, r.spec)) || []).filter(x => x.id !== r.id),
      supplier_guess: supOf(`${r.plan_column} ${r.name} ${r.spec}`),
      parts: r.not_part ? null : await partsFor(r, { items: cache.items, onVan: onVan.get(r.van_id) || null }) });
  }
  return [...vans.values()];
}
// How many special-part lines there are, in clear numbers (Small fixes & phone round 1, user-r4-3):
// `short` = still to order (the Purchasing → Special parts list), `all` = still to confirm in all (the Stock
// tab and the van page, which also list lines already set aside / on order / waiting on an answer), and
// (round 2, sp-r1-1) `on_order` = lines whose van PO already covers what is still needed — left off
// "still to order", as the Stock "Still to order" column does; `check` = waiting on "Check: already ordered?".
// Same filters as placeholderLines, so the numbers always match the lists.
// `not_part`: the lines left off "still to order" because the text is only the dealer's name (user-r4-6) —
// Purchasing → Special parts says which ones.
export async function placeholderCounts({ vanId = null } = {}) {
  const rows = await all(`
    SELECT l.id, l.van_id, l.spec, l.plan_column, v.chassis, CASE WHEN ${SPECIAL_TO_ORDER('l')} THEN 1 ELSE 0 END AS s,
      CASE WHEN ${SPECIAL_ON_ORDER('l')} THEN 1 ELSE 0 END AS o, CASE WHEN ${UNANSWERED_CORR('l')} THEN 1 ELSE 0 END AS c
    FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
    WHERE ${ACTIVE_VAN} AND (i.placeholder = 1 OR i.sku ILIKE 'PLAN-%') AND l.issued < l.qty AND (?::integer IS NULL OR v.id = ?::integer)
    ORDER BY ${PRIORITY}, l.id`, vanId, vanId);
  const dealers = await dealerNames();
  const notPart = rows.filter(r => notAPart(r.spec, dealers));
  const np = new Set(notPart.map(r => r.id));
  return { short: rows.filter(r => r.s && !np.has(r.id)).length, on_order: rows.filter(r => r.o && !np.has(r.id)).length,
    check: rows.filter(r => r.c && !np.has(r.id)).length, all: rows.length,
    not_part: notPart.map(r => ({ id: r.id, van_id: r.van_id, chassis: r.chassis, plan_column: r.plan_column, spec: r.spec, why: notAPart(r.spec, dealers) })) };
}

// Per part: how many are STILL TO ORDER for the vans counted as "short" (in production, or due within the
// coming-up weeks), after what is set aside, on order for that van, free on the shelf and on order for the
// shelf — the same netting as Purchasing → To order (shortages()), so Stock and Purchasing agree. Never more
// than "Short". Lines waiting on "Check: already ordered?" are left out, as they are there.
// Small fixes & phone round 1, user-r4-3 ("Short 10 · On order 3" now also says "Still to order 7").
export async function stillToOrderByItem() {
  const { rows, settings } = await shortages();
  const t = today(), soon = addDays(t, 7 * settings.short_weeks);
  const near = r => r.van_status === 'in_production' || (r.van_status === 'planned' && r.eta && r.eta >= t && r.eta <= soon);
  const out = {};
  for (const r of rows) if (!r.check && !r.topup && r.van_id != null && near(r) && r.suggest > 1e-9) out[r.item_id] = (out[r.item_id] || 0) + r.suggest;
  return out;
}

// A special-part line the office should look at before linking it: "possible duplicate of …", (round 4)
// "two deliveries were received for this van – probably not the same part …" and "to check: 1 received for
// this van stays on this line …" (left on the plan line by a merge), "to check: merge with … asked, but nothing
// moved" (Small fixes & phone round 1, check-r4-1).
export const LINK_FLAG_RE = /possible duplicate of|two deliveries were received for this van|to check: [\d.]+ (?:received|set aside)|to check: merge with/i;
async function linkableItemsCache() {
  return { items: await linkableItems(), learned: await learnedLinks() };
}

// A supplier named in a piece of text ('' = none): the reviewed words, then any supplier name of 4+
// letters that isn't an ordinary word ("Gold"), e.g. "L&S Doors" → "L & S".
export async function supplierFromText(text) {
  return (await supplierMatcher())(text);
}
// Same, as a function that reads the supplier list once (for checking many lines in one go).
export async function supplierMatcher() {
  const list = [...SUPPLIER_WORDS];
  for (const { name } of await all(`SELECT name FROM suppliers ORDER BY length(name) DESC, name`)) {
    if (NOT_A_BRAND.test(name)) continue;
    const short = name.length < 4;
    if (short && !/^[A-Z0-9&]{2,3}$/.test(name)) continue; // short names only as capitals: "NCE", "HTP", "AZQ"
    list.push([name, new RegExp(`(?:^|[^a-z0-9])${reEsc(name).replace(/\s+/g, '\\s*')}(?![a-z0-9])`, short ? '' : 'i')]);
  }
  return text => {
    const s = String(text || '');
    for (const [sup, re] of list) if (re.test(s)) return sup;
    return '';
  };
}

// Items asked for with 5 or more different plan texts on vans still to build (a sign one item is
// standing in for several real parts).
export async function manySpecs(min = 5) {
  const by = new Map();
  for (const r of await all(`SELECT i.id, i.sku, i.name, i.placeholder, trim(l.spec) AS spec
                       FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
                       WHERE ${ACTIVE_VAN} AND trim(l.spec) <> '' ORDER BY l.id`)) {
    if (!by.has(r.id)) by.set(r.id, { id: r.id, sku: r.sku, name: r.name, placeholder: isPlaceholder(r) ? 1 : 0, lines: 0, seen: new Map() });
    const e = by.get(r.id);
    e.lines++;
    // Order numbers and supplier references aren't a different spec: "Capral 36" = "Capral 38".
    const k = r.spec.toLowerCase().replace(/\border(?:ed)?\s*(?:no\.?)?\s*#?\s*\d+/g, ' ').replace(/[\s/-]*\d+\W*$/, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k) continue;
    if (!e.seen.has(k)) e.seen.set(k, r.spec);
  }
  return [...by.values()].filter(e => e.seen.size >= min)
    .map(({ seen, ...e }) => ({ ...e, specs: seen.size, examples: [...seen.values()].slice(0, 8) }))
    .sort((a, b) => b.specs - a.specs || a.name.localeCompare(b.name));
}

// Every open PO line's expected date: its own backorder date, else the PO's.
const LINE_EXPECTED = `COALESCE(NULLIF(pl.expected, ''), p.expected)`;

// POs made from the production plan (the import's pink cells, or "Yes, on order" on Check: already
// ordered?). The plan never says when they were ordered: a blank ordered date on these shows as
// "unknown (from plan)" until someone types it (Small fixes & phone round 1, user-r4-5).
export const PLAN_PO_SQL = `(notes ILIKE '%Imported from the production plan%' OR notes ILIKE '%Order number from the production plan%')`;
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
  const inactive = await inactiveVanProblem(po);
  return { po: withPlanFlag({ ...po, problems: [...await poProblems(po), ...inactive], to_check: po.status === 'open' && (po.needs_check || inactive.length) ? 1 : 0 }), lines, vans };
}

// "Yes, all on order" marks the POs it creates (in the notes) so a missing delivery date can be flagged.
const YES_ALL_MARK = 'Yes, all on order';
// Why a PO needs a look: no real number, no supplier, the same number used on another PO, or (check-r4-2) made
// by "Yes, all on order" with no delivery date.
export async function poProblems(po) {
  const out = [];
  if (po.status === 'open' && !String(po.expected || '').trim() && String(po.notes || '').includes(`(${YES_ALL_MARK})`)
      // an open line with no date of its own (round 2, sp-r1-4: parts added to a PO already in the system count too)
      && await get(`SELECT 1 FROM po_lines pl WHERE pl.po_id = ? AND trim(pl.expected) = '' AND ${PO_OPEN} > 1e-9 LIMIT 1`, po.id)) out.push('no delivery date');
  const no = String(po.po_no || '').trim();
  if (!/\d/.test(no) || /\(no number\)\s*$/i.test(no)) out.push('no PO number');
  if (!String(po.supplier || '').trim()) out.push('no supplier');
  if (/\d/.test(no)) {
    // Order numbers on the plan run per supplier ("White Vision 11", "Onex 08"): the same number is only
    // a problem for the same supplier, or when one of them has no supplier (can't tell them apart).
    const dup = await all(`SELECT po_no, supplier FROM purchase_orders WHERE id <> ? AND lower(trim(po_no)) = lower(?)
                       AND (lower(trim(supplier)) = lower(trim(?)) OR trim(supplier) = '' OR trim(?) = '') ORDER BY id`, po.id, no, po.supplier || '', po.supplier || '');
    if (dup.length) out.push(`number ${no} also used on ${dup.map(d => d.supplier || 'a PO with no supplier').join(', ')}`);
  }
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
async function inactiveVanProblem(po) {
  if (po.status !== 'open' || /looks right/.test(po.notes || '')) return [];
  // Shelf stock is counted as spare for the next van short; a part bought for one van is never handed on by
  // itself, so it is only flagged.
  const rows = await all(`SELECT v.chassis, v.status, SUM(${PO_OPEN}) AS q, (i.kind = 'stock')::int AS shelf FROM po_lines pl JOIN vans v ON v.id = pl.van_id JOIN items i ON i.id = pl.item_id
                    WHERE pl.po_id = ? AND ${PO_OPEN} > 1e-9 AND v.status NOT IN ('planned','in_production')
                    GROUP BY v.id, (i.kind = 'stock')::int ORDER BY v.chassis, shelf DESC`, po.id);
  return rows.map(r => `${q(r.q)} still coming for ${r.chassis} (van ${VAN_STATUS_WORD[r.status] || r.status}) – ${r.shelf
    ? 'counted as spare for other vans' : 'bought for that van, no van needs it now'}`);
}

// "POs to check": open POs marked needs_check (or with lines for vans no longer active), with the reasons and
// what is on them.
export async function posToCheck() {
  const out = [];
  for (const po of await all(`SELECT p.* FROM purchase_orders p WHERE ${PO_TO_CHECK_SQL} ORDER BY p.id`)) {
    const lines = await all(`SELECT pl.qty, pl.received, pl.closed, pl.spec, i.name, i.unit, v.chassis, v.status AS van_status FROM po_lines pl JOIN items i ON i.id = pl.item_id
                       LEFT JOIN vans v ON v.id = pl.van_id WHERE pl.po_id = ? ORDER BY i.name`, po.id);
    out.push(withPlanFlag({ ...po, problems: [...(po.needs_check ? await poProblems(po) : []), ...await inactiveVanProblem(po)], lines,
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
  const valid = lines.filter(l => l.item_id && l.qty > 0);
  if (!valid.length) throw httpError(400, 'Add at least one line');
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

// Dashboard. counts: the "Needs action this month" pieces (vans in production or due within the
// "coming up" weeks for the per-van lists; POs, deliveries and dates for everything).
export async function summary() {
  const items = (await listItems()).filter(i => !i.placeholder); // "as per plan" catch-alls aren't counted as parts
  const vans = await listVans({ status: 'active' });
  const sh = await shortagesCached(); // listVans just worked it out for the "waiting on PO" split (owner-r3-2)
  const now = sh.rows.filter(r => r.group === 'now' && r.suggest > 1e-9 && !r.check);
  const near = await nearVanSql('v');
  const nearIds = new Set(vans.filter(v => v.near).map(v => v.id));
  const checks = await checkOrdered();
  const checksNear = checks.filter(g => g.near);
  const decisions = await decisionLines();
  const received = (await get(`SELECT COUNT(*) AS c FROM van_lines l JOIN vans v ON v.id = l.van_id
                        WHERE ${ACTIVE_VAN} AND l.state IN ('customer','tbd') AND l.reserved_firm > 0 AND l.issued < l.qty`)).c;
  // Waiting on parts: vans in production / due soon, with the names of what is missing.
  const waiting = await all(`SELECT v.id, v.chassis, v.eta, v.status, i.name FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
                       WHERE ${ACTIVE_VAN} AND ${near} AND l.qty > l.reserved + l.issued + 1e-9 AND ${COUNTS_SHORT_CORR('l')}
                         AND i.placeholder = 0 AND i.sku NOT ILIKE 'PLAN-%' ORDER BY ${PRIORITY}, i.name`);
  const wv = new Map();
  for (const r of waiting) {
    if (!wv.has(r.id)) wv.set(r.id, { van_id: r.id, chassis: r.chassis, eta: r.eta, status: r.status, parts: [] });
    if (!wv.get(r.id).parts.includes(r.name)) wv.get(r.id).parts.push(r.name);
  }
  const qc = await qtyChecks();
  const action = {
    // the one "order now" number: different parts (with its van lines alongside, user-r1-3)
    orderNow: sh.orderNow.parts, orderNowLines: sh.orderNow.lines, orderNowText: sh.orderNow.text, orderNowCheck: sh.orderNow.check,
    checkOrdered: checksNear.length, checkOrderedAll: checks.length,
    posToCheck: (await get(`SELECT COUNT(*) AS c FROM purchase_orders p WHERE ${PO_TO_CHECK_SQL}`)).c,
    overdue: (await overdueLines()).length,
    dates: (await datesToCheck()).length,
    decisions: decisions.filter(d => nearIds.has(d.van_id)).length, decisionsAll: decisions.length,
    qtyChecks: qc.length,
    received,
  };
  action.total = action.orderNow + action.checkOrdered + action.posToCheck + action.overdue + action.dates + action.decisions + action.qtyChecks + action.received;
  return {
    vans,
    settings: await purchasingSettings(),
    counts: {
      planned: vans.filter(v => v.status === 'planned').length,
      inProduction: vans.filter(v => v.status === 'in_production').length,
      // waiting on parts: vans in production / due soon only; lines waiting on an answer don't count
      vansShort: vans.filter(v => v.near && v.waiting_count > 0).length,
      vansNear: nearIds.size,
      itemsShort: items.filter(i => i.short > 0).length,
      itemsToOrder: sh.orderNow.parts, orderNow: sh.orderNow, orderNowText: sh.orderNow.text,
      comingUp: new Set(sh.rows.filter(r => r.group === 'soon' && !r.check).map(r => r.item_id)).size,
      toCheck: await checkOrderedCount(),
      lowStock: items.filter(i => i.low).length,
      openPOs: (await get(`SELECT COUNT(*) AS c FROM purchase_orders WHERE status = 'open'`)).c,
      posToCheck: action.posToCheck,
      stockChecks: await stockChecksCount(),
    },
    action,
    qtyChecks: qc.slice(0, 100).map(l => ({ id: l.id, van_id: l.van_id, chassis: l.chassis, name: l.name, plan_column: l.plan_column, qty: l.qty, unit: l.unit, why: l.why })),
    waiting: [...wv.values()],
    // "Order now" rows, most urgent first.
    toOrder: now.slice(0, 12),
    decisions,
    overdue: await overdueLines(),
    recent: await all(`SELECT m.*, i.sku, i.name, v.chassis FROM movements m JOIN items i ON i.id = m.item_id
                 LEFT JOIN vans v ON v.id = m.van_id ORDER BY m.id DESC LIMIT 12`),
  };
}

// ───────────────────────── production plan ─────────────────────────

const RANK = { none: 0, ordered: 1, received: 2, done: 3 };

// The production plan grid: one row per van, one column per plan column, each cell coloured by
// the least-advanced part in it (white not ordered → pink ordered → grey received → blue done).
// `parts` (the plan page only — Small fixes & phone round 3, owner-r2-1): each cell with parts also gets `ps`,
// the status the van page shows for each of its part lines (same order as `ids`: lineStatus + the cover by a shelf
// PO or another van's spare PO line, as in getVan), and `pn` (the part names) when it holds more than one part —
// so the phone's "By van" counts parts the van page's way ("Not ordered 29 · To check 10 · Ordered 18 ·
// Received 58"). The cells' own colours (the spreadsheet's, also used by the Excel export) are unchanged.
export async function planGrid({ includeFinished = false, parts = false } = {}) {
  let columns = [];
  const rawColumns = await getSetting('plan_columns', '[]'); // (a database error is not "none yet")
  try { columns = JSON.parse(rawColumns); } catch { /* none yet */ }
  const where = includeFinished ? '' : `WHERE ${ACTIVE_VAN}`;
  const vans = await all(`SELECT v.id, v.chassis, v.model, v.length, v.customer, v.eta, v.status FROM vans v ${where}
                    ORDER BY CASE v.status WHEN 'in_production' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, ${PRIORITY}`);
  const vanIds = `SELECT v.id FROM vans v ${where}`;
  const onOrder = new Set((await all(`SELECT pl.van_id, pl.item_id FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                               WHERE ${PO_IS_OPEN} AND pl.van_id IN (${vanIds})`))
    .map(r => `${r.van_id}|${r.item_id}`));
  const lines = await all(`SELECT l.id, l.van_id, l.item_id, l.qty, l.reserved, l.issued, l.merged_cols, l.state, l.urgent, l.po_ref, i.name, i.unit,
                       COALESCE(NULLIF(l.plan_column, ''), NULLIF(i.plan_column, ''), i.category) AS col
                     FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.van_id IN (${vanIds}) ORDER BY l.id`);
  const texts = await all(`SELECT van_id, label, value FROM order_fields WHERE section = 'PRODUCTION PLAN' AND van_id IN (${vanIds}) ORDER BY id`);

  const byVan = new Map(vans.map(v => [v.id, { ...v, cells: {} }]));
  const cell = (vanId, col) => {
    const c = byVan.get(vanId).cells;
    return c[col] || (c[col] = { t: '', s: null, ids: [] });
  };
  for (const f of texts) cell(f.van_id, f.label).t = f.value;
  const extra = new Set();
  for (const l of lines) {
    const st = l.issued >= l.qty ? 'done' : l.reserved + l.issued >= l.qty ? 'received'
      : onOrder.has(`${l.van_id}|${l.item_id}`) ? 'ordered' : 'none';
    const c = cell(l.van_id, l.col);
    c.ids.push(l.id);
    c.s = c.s == null || RANK[st] < RANK[c.s] ? st : c.s;
    c._names = (c._names || []).concat(`${q(l.qty)} x ${l.name}`);
    if (!columns.includes(l.col)) extra.add(l.col);
    // Round 4 (check-r3-3): a plan line merged into this line still has its cell on the plan — coloured
    // from this line (with any line still left in that cell, the least advanced wins as usual).
    for (const mc of mergedCols(l.merged_cols)) {
      if (mc === l.col) continue;
      const m = cell(l.van_id, mc);
      if (!m.ids.includes(l.id)) m.ids.push(l.id);
      m.s = m.s == null || RANK[st] < RANK[m.s] ? st : m.s;
      if (!columns.includes(mc)) extra.add(mc);
    }
  }
  for (const v of byVan.values()) {
    for (const c of Object.values(v.cells)) {
      if (!c.t && c._names) c.t = c._names.join('; ');
      delete c._names;
    }
  }
  if (parts) {
    const vanQ = new Map(), shelfQ = new Map();
    for (const r of await all(`SELECT pl.item_id, pl.van_id, ${PO_OPEN} AS q FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                         WHERE ${PO_IS_OPEN} AND (pl.van_id IS NULL OR pl.van_id IN (${vanIds}))`)) {
      if (r.van_id == null) shelfQ.set(r.item_id, (shelfQ.get(r.item_id) || 0) + r.q);
      else { const k = `${r.van_id}|${r.item_id}`; vanQ.set(k, (vanQ.get(k) || 0) + r.q); }
    }
    const cov = await lineCover();
    const byId = new Map();
    for (const l of lines) {
      const mine = vanQ.get(`${l.van_id}|${l.item_id}`) || 0;
      let st = lineStatus({ ...l, on_order_van: mine, on_order: mine + (shelfQ.get(l.item_id) || 0) });
      const c = cov.get(l.id);
      if (st === 'to_order' && c && c.qty >= Math.max(0, l.qty - l.reserved - l.issued) - 1e-9) st = 'on_order';
      byId.set(l.id, { st, name: `${q(l.qty)}${l.unit && l.unit !== 'ea' ? ' ' + l.unit : ''} × ${l.name}` });
    }
    for (const v of byVan.values()) {
      for (const c of Object.values(v.cells)) {
        if (!c.ids.length) continue;
        c.ps = c.ids.map(id => byId.get(id)?.st || 'to_order');
        if (c.ids.length > 1) c.pn = c.ids.map(id => byId.get(id)?.name || '');
      }
    }
  }
  return { columns: [...columns, ...[...extra].sort()], vans: [...byVan.values()] };
}
const q = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

// Book stock in against one particular part line (used when a plan cell is marked received).
async function receiveInto(line, qty, ref, { reason = 'receive', by = '', note = '' } = {}) {
  await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', qty, line.item_id);
  // Received for this van: locked to it.
  await run('UPDATE van_lines SET reserved = reserved + ?, reserved_firm = reserved_firm + ? WHERE id = ?', qty, qty, line.id);
  await logAlloc(reason, { van_id: line.van_id, item_id: line.item_id, line_id: line.id, field: 'reserved (locked)', before: '', after: `+${q(qty)}`, note: ref, worker: by,
    change: qty, firm_change: qty });
  await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'receive', ?, ?, ?, ?)`, line.item_id, qty, line.van_id, ref, note, by);
}

// Stock arrived for one van line (a grey cell on an updated production plan, C12): open PO lines for
// that van and part are ticked off first, the rest is booked straight in. Never more than the line still
// needs (qty − set aside − fitted). Received for the van = locked to it. (Joins the caller's write
// transaction, or runs in its own.)
export async function receiveForLine(lineId, qty, opts = {}) {
  return writeTx(() => receiveForLineNow(lineId, qty, opts));
}
async function receiveForLineNow(lineId, qty, { ref = 'Production plan update', by = '' } = {}) {
  const l = await get('SELECT * FROM van_lines WHERE id = ?', lineId);
  if (!l) return 0;
  let left = Math.min(qty, Math.max(0, l.qty - l.reserved - l.issued));
  const got = left;
  for (const pl of await all(`SELECT pl.*, p.po_no FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                        WHERE ${PO_IS_OPEN} AND pl.van_id = ? AND pl.item_id = ? ORDER BY pl.id`, l.van_id, l.item_id)) {
    if (left <= 1e-9) break;
    const take = Math.min(left, pl.qty - pl.received - pl.closed);
    await run('UPDATE po_lines SET received = received + ? WHERE id = ?', take, pl.id);
    await receiveInto(l, take, `PO ${pl.po_no}`, { reason: 'plan update', by, note: ref });
    await closePoIfDone(pl.po_id);
    left -= take;
  }
  if (left > 1e-9) await receiveInto(l, left, ref, { reason: 'plan update', by, note: ref });
  return got;
}

// Move one part line forward from the plan: 'ordered' (needs po_no), 'received', or 'done'
// (fitted — received if needed, then issued to the van).
export async function setLineStatus(lineId, status, { po_no = '' } = {}) {
  return writeTx(async () => {
    const l = await get(`SELECT l.*, i.supplier FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?`, lineId);
    if (!l) throw httpError(404, 'Part line not found');
    const short = async () => Math.max(0, (await get('SELECT qty - reserved - issued AS s FROM van_lines WHERE id = ?', lineId)).s);
    const openPoLines = async () => all(`SELECT pl.*, p.po_no FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                                   WHERE ${PO_IS_OPEN} AND pl.van_id = ? AND pl.item_id = ?
                                   ORDER BY pl.id`, l.van_id, l.item_id);

    if (status === 'ordered') {
      const ref = String(po_no || '').trim();
      if (!ref) throw httpError(400, 'Enter the order number');
      const need = (await short()) - (await openPoLines()).reduce((s, p) => s + p.qty - p.received - p.closed, 0);
      if (need > 0) {
        const po = await get(`SELECT id FROM purchase_orders WHERE status = 'open' AND po_no = ? AND supplier = ?`, ref, l.supplier || '');
        const poId = po ? po.id : await insert('INSERT INTO purchase_orders(po_no, supplier, ordered_at, needs_check) VALUES(?, ?, ?, ?)', ref, l.supplier || '', today(), l.supplier ? 0 : 1);
        await run('INSERT INTO po_lines(po_id, item_id, qty, van_id, spec) VALUES(?,?,?,?,?)', poId, l.item_id, need, l.van_id, specForPo(l.spec, ref));
        await syncSuppliers();
      }
      await run('UPDATE van_lines SET po_ref = ? WHERE id = ?', ref, lineId);
      return;
    }
    if (status !== 'received' && status !== 'done') throw httpError(400, 'Unknown status');

    // Anything on order for this van arrives first, then the rest is booked in directly.
    for (const pl of await openPoLines()) {
      const s = await short();
      if (s <= 0) break;
      const take = Math.min(s, pl.qty - pl.received - pl.closed);
      await run('UPDATE po_lines SET received = received + ? WHERE id = ?', take, pl.id);
      await receiveInto(l, take, `PO ${pl.po_no}`);
      await closePoIfDone(pl.po_id);
    }
    const rest = await short();
    if (rest > 0) await receiveInto(l, rest, l.po_ref ? `Order ${l.po_ref}` : 'Marked received on plan');
    if (status === 'done') await issueLines(l.van_id, [lineId]);
  });
}

// ───────────────────────── floor screen (workers) ─────────────────────────

// A worker takes parts off the shelf for a van. Whatever the system thought, the parts are in their
// hand, so: use what's set aside for this van, then free stock, then (shelf stock only) stock set
// aside for vans due later; if the system still showed too few, the count was wrong and is
// corrected (and logged). A per-van part is never taken from another van: if the system showed
// none, it has arrived for this van and is ticked off this van's order.
// `extraLine`: the line was just added on the floor, so Undo removes it again.
// `seenIssued` (phone only): how many the phone showed as already taken. If that changed, this take
// was already saved (reply lost on bad Wi-Fi) or a workmate took it, so it isn't done twice.
// `acceptBorrow`: the only parts left are set aside for another van (received for it, or bought
// for it). Then the worker is asked first (an error with `confirm` comes back): true = take that
// van's part (it goes straight onto "Order now" for that van), false = no, these are a new delivery.
// The take is never refused because a part is locked: the books follow the shelf.
export async function takeForVan(lineId, qty, by = '', { extraLine = false, seenIssued, acceptBorrow } = {}) {
  return writeTx(async () => {
    const l = await get(`SELECT l.*, v.chassis, v.status AS van_status, v.area_id AS van_area, i.name, i.kind FROM van_lines l
                   JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id WHERE l.id = ?`, lineId);
    if (!l) throw httpError(404, 'Part not found');
    if (!['planned', 'in_production'].includes(l.van_status)) throw httpError(400, `${l.chassis} is finished — parts can't be taken for it`);
    if (seenIssued != null && Number(seenIssued) !== l.issued) throw httpError(409, 'Someone already took some of this. Check the list.');
    const take = qty == null ? l.qty - l.issued : Number(qty);
    if (!(take > 0)) throw httpError(400, 'How many did you take?');
    // What this take changes, so Undo can put every bit of it back.
    const rec = { line: lineId, own: Math.min(l.reserved, take), ownFirm: l.reserved_firm, corr: 0, corrMv: null, borrowed: [], po: [], reopen: [], extraLine: !!extraLine };
    // Took more than the list said: the list grows to match.
    if (l.issued + take > l.qty) {
      rec.oldQty = l.qty;
      await run('UPDATE van_lines SET qty = ? WHERE id = ?', l.issued + take, lineId);
    }

    let need = Math.max(0, take - l.reserved);
    const donors = []; // chassis this take borrowed locked / bought-for-van parts from
    if (need > 0) {
      const { on_hand } = await get('SELECT on_hand FROM items WHERE id = ?', l.item_id);
      const reservedAll = (await get(`SELECT COALESCE(SUM(x.reserved),0) AS r FROM van_lines x JOIN vans v ON v.id = x.van_id
                               WHERE x.item_id = ? AND ${ACTIVE_VAN}`, l.item_id)).r;
      const free = Math.max(0, on_hand - reservedAll);
      const fromFree = Math.min(free, need);
      need -= fromFree;
      let borrowed = 0;
      const ranks = await vanRanks();
      const myRank = ranks.get(l.van_id) ?? Infinity;
      const others = async () => (await all(`SELECT x.id, x.van_id, x.reserved, x.reserved_firm, x.urgent, x.state, x.po_ref, v.chassis FROM van_lines x JOIN vans v ON v.id = x.van_id
                                WHERE x.item_id = ? AND x.van_id <> ? AND x.reserved > 0 AND ${ACTIVE_VAN}`, l.item_id, l.van_id))
        .sort((a, b) => (ranks.get(b.van_id) ?? 0) - (ranks.get(a.van_id) ?? 0) || b.id - a.id); // built last first
      const borrow = async (o, b, firmCut, urgent) => {
        await run('UPDATE van_lines SET reserved = reserved - ?, reserved_firm = GREATEST(0, reserved_firm - ?::double precision), urgent = CASE WHEN ?::integer = 1 THEN 1 ELSE urgent END WHERE id = ?',
            b, firmCut, urgent ? 1 : 0, o.id);
        // The donor's plan order number was used up when its part arrived: it is now a plain "still to
        // order" line (not "Check: already ordered?"), so it shows under Order now. Undo puts '' back.
        const toNotOrdered = urgent && !o.state && String(o.po_ref || '').trim() !== '';
        if (toNotOrdered) {
          await run(`UPDATE van_lines SET state = 'not_ordered' WHERE id = ? AND state = ''`, o.id);
          await logAlloc('borrow', { van_id: o.van_id, item_id: l.item_id, line_id: o.id, field: 'state', before: '', after: 'not_ordered', worker: by,
            note: `plan order ${String(o.po_ref).trim()} already used — part borrowed for ${l.chassis}, still to order for ${o.chassis}` });
          o.state = 'not_ordered';
        }
        rec.borrowed.push([o.id, b, firmCut, o.urgent, toNotOrdered ? '' : null]);
        await logAlloc('borrow', { van_id: o.van_id, item_id: l.item_id, line_id: o.id, field: 'reserved', before: o.reserved, after: o.reserved - b, worker: by,
          note: `borrowed from ${o.chassis} by ${by || 'a worker'} for ${l.chassis}${urgent ? ' — re-order for ' + o.chassis : ''}` });
        need -= b; borrowed += b;
      };
      // 1. Shelf stock merely held for vans built after this one (not received for them): they'll be
      //    supplied again by orders. Per-van parts are never handed on this way.
      if (need > 0 && l.kind === 'stock') {
        for (const o of await others()) {
          if (need <= 0) break;
          if ((ranks.get(o.van_id) ?? Infinity) <= myRank) continue;
          const flex = Math.max(0, o.reserved - o.reserved_firm);
          if (flex > 0) await borrow(o, Math.min(flex, need), 0, false);
        }
      }
      // 2. What's left is another van's own part (received or bought for it). The worker has it in
      //    their hand, so the books follow — but only after they've been told whose it is.
      if (need > 0) {
        const left = (await others()).filter(o => o.reserved > 0);
        const avail = left.reduce((s, o) => s + o.reserved, 0);
        if (avail > 0 && acceptBorrow == null) {
          // The vans it would actually come from (built last first), just enough to cover the take.
          const from = [];
          let cover = need;
          for (const o of left) {
            if (cover <= 0) break;
            if (!from.includes(o.chassis)) from.push(o.chassis);
            cover -= o.reserved;
          }
          throw Object.assign(httpError(409, `This is ${from[0]}'s – it will be re-ordered for them`), {
            confirm: { borrow: true, from, qty: Math.min(avail, need), message: `This is ${from.join(' / ')}'s – it will be re-ordered for them` },
          });
        }
        if (acceptBorrow === true) {
          for (const o of left) {
            if (need <= 0) break;
            const b = Math.min(o.reserved, need);
            const firmCut = Math.max(0, b - Math.max(0, o.reserved - o.reserved_firm));
            await borrow(o, b, firmCut, true);
            if (!donors.includes(o.chassis)) donors.push(o.chassis);
          }
        }
      }
      await run('UPDATE van_lines SET reserved = reserved + ? WHERE id = ?', fromFree + borrowed, lineId);
      if (need > 0) {
        let ref = l.chassis;
        let note = 'Taken from the shelf but the system showed none — count corrected';
        if (l.kind !== 'stock') {
          // It's in the worker's hand, so it has arrived for this van: tick it off this van's order.
          const pos = [];
          let left = need;
          for (const pl of await all(`SELECT pl.*, p.po_no FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                                WHERE ${PO_IS_OPEN} AND pl.van_id = ? AND pl.item_id = ?
                                ORDER BY pl.id`, l.van_id, l.item_id)) {
            if (left <= 0) break;
            const q = Math.min(left, pl.qty - pl.received - pl.closed);
            if (await bookPoLine(pl, q)) rec.reopen.push(pl.po_id);
            rec.po.push([pl.id, q]);
            left -= q;
            if (!pos.includes(pl.po_no)) pos.push(pl.po_no);
          }
          if (pos.length) ref = `PO ${pos.join(', ')}`;
          note = `Arrived for ${l.chassis} (booked on the floor)`;
        }
        await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', need, l.item_id);
        await run('UPDATE van_lines SET reserved = reserved + ? WHERE id = ?', need, lineId);
        const cm = await insert(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'adjust', ?, ?, ?, ?)`,
                       l.item_id, need, l.van_id, ref, note, by);
        rec.corr = need;
        rec.corrMv = cm;
      }
    }
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', take, l.item_id);
    await run('UPDATE van_lines SET issued = issued + ?, reserved = GREATEST(0, reserved - ?::double precision) WHERE id = ?', take, take, lineId);
    const note = donors.length ? `borrowed from ${donors.join(', ')} by ${by || 'a worker'}` : '';
    // Follow-up round 1 (chk-r3-2): this take starts a planned van (it becomes "in production", moves up
    // the build order and gets first call on shelf stock). Noted in the undo record — with where the van
    // stood and the history mark — so an Undo / Put back can put it back to planned if nothing else
    // happened to it since. Takes saved before this have no note and Undo leaves the status as it is.
    if (l.van_status === 'planned') {
      rec.startedVan = { area: l.van_area ?? null, logMark: (await get('SELECT COALESCE(MAX(id), 0) AS n FROM allocation_log')).n };
    }
    const mv = await insert(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker, undo) VALUES(?, ?, 'issue', ?, ?, ?, ?, ?)`,
                   l.item_id, -take, l.van_id, l.chassis, note, by, JSON.stringify(rec));
    // Set-aside history for this van's line: what the take used up (and where it came from).
    const after = await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', lineId);
    let lentBy = donors;
    if (rec.borrowed.length && !donors.length) {
      lentBy = [];
      for (const [id] of rec.borrowed) lentBy.push((await get('SELECT v.chassis FROM van_lines x JOIN vans v ON v.id = x.van_id WHERE x.id = ?', id))?.chassis);
    }
    const from = [rec.own ? `${q(rec.own)} set aside for it` : '', rec.borrowed.length ? `borrowed from ${[...new Set(lentBy.filter(Boolean))].join(', ')}` : '',
      rec.corr ? `${q(rec.corr)} the system didn't show (count corrected)` : ''].filter(Boolean).join(', ');
    await logAlloc('floor take', { van_id: l.van_id, item_id: l.item_id, line_id: lineId, field: 'issued', before: q(l.issued), after: q(l.issued + take), worker: by,
      change: after.reserved - l.reserved, firm_change: after.reserved_firm - l.reserved_firm,
      note: `taken on floor by ${by || 'a worker'}: ${q(take)}${from ? ` (${from})` : ''}` });
    if (l.van_status === 'planned') {
      await run(`UPDATE vans SET status = 'in_production' WHERE id = ?`, l.van_id);
      await logAlloc('floor take', { van_id: l.van_id, item_id: l.item_id, line_id: lineId, field: 'van status', before: 'planned', after: 'in production', worker: by,
        note: `${l.chassis} started: first part taken on the floor by ${by || 'a worker'}` });
    }
    return { line_id: lineId, qty: take, movement_id: mv, name: l.name, chassis: l.chassis,
             ...(donors.length ? { borrowedFrom: donors.join(', ') } : {}) };
  });
}

// A part taken on the floor that wasn't on the worker's own list. It's often on the van's list under
// another trade: then that line is ticked off. Only if the van has no open line for it is one added
// (and Undo removes it again). `seenTaken` (phone only): how many of this part the phone showed as
// taken for this van — if that changed, the take already went through, so it isn't done twice.
export async function floorExtra(vanId, itemId, qty, by = '', { seenTaken, acceptBorrow } = {}) {
  return writeTx(async () => {
    const van = await get('SELECT chassis, status FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'That van no longer exists — refresh');
    if (!['planned', 'in_production'].includes(van.status)) throw httpError(400, `${van.chassis} is finished — parts can't be taken for it`);
    if (!await get('SELECT 1 FROM items WHERE id = ?', itemId)) throw httpError(404, 'Part not found');
    if (!(qty > 0)) throw httpError(400, 'How many did you take?');
    if (seenTaken != null) {
      const taken = (await get('SELECT COALESCE(SUM(issued),0) AS n FROM van_lines WHERE van_id = ? AND item_id = ?', vanId, itemId)).n;
      if (Number(seenTaken) !== taken) throw httpError(409, 'Someone already took some of this. Check the list.');
    }
    const open = await get(`SELECT id FROM van_lines WHERE van_id = ? AND item_id = ? AND issued < qty
                      ORDER BY CASE WHEN source = 'manual' THEN 1 ELSE 0 END, id LIMIT 1`, vanId, itemId);
    if (open) return takeForVan(open.id, qty, by, { acceptBorrow });
    const line = await addLine(vanId, { item_id: itemId, qty, note: `Added on the floor${by ? ` by ${by}` : ''}` });
    return takeForVan(line.id, qty, by, { extraLine: true, acceptBorrow });
  });
}

// Undo a take within a few minutes (wrong part / wrong van tapped): everything the take changed is
// put back — shelf count, parts borrowed from other vans, the order it was ticked off, the list.
// `sameDay` (phone round 1, C11 "Put back on shelf"): a take from earlier today can be put back too, as long
// as nothing else was booked in or counted for that part since; older ones still go to the office.
// `lineId` / `vanId` (small fixes round 2, sp-r1-5): what the phone thinks it is undoing. When they are
// sent and the movement is for another line or van, nothing is changed ("already undone").
export async function undoTake(movementId, { sameDay = false, lineId = null, vanId = null } = {}) {
  return writeTx(async () => {
    const m = await get(`SELECT * FROM movements WHERE id = ? AND type = 'issue'`, movementId);
    if (!m) throw httpError(404, 'Nothing to undo');
    if (lineId != null || vanId != null) {
      let recLine = null;
      try { recLine = m.undo ? JSON.parse(m.undo)?.line ?? null : null; } catch { recLine = null; }
      const lineOk = lineId == null || (recLine != null ? Number(recLine) === Number(lineId)
        : !!await get('SELECT 1 FROM van_lines WHERE id = ? AND van_id = ? AND item_id = ?', lineId, m.van_id, m.item_id));
      const vanOk = vanId == null || Number(m.van_id) === Number(vanId);
      if (!lineOk || !vanOk) throw httpError(404, 'Nothing to undo — it was already undone');
    }
    // (m.at is Melbourne wall-clock time: its age is worked out in SQL, so the server's own time zone doesn't matter)
    if ((await get(`SELECT ${AGE_SECS('?')} AS s`, m.at)).s > 15 * 60) {
      const isToday = String(m.at).slice(0, 10) === today();
      if (!sameDay || !isToday) throw httpError(400, 'Too late to undo — ask the office');
      if (await get(`SELECT 1 FROM movements WHERE item_id = ? AND id > ? AND type IN ('receive','count','adjust') LIMIT 1`, m.item_id, m.id))
        throw httpError(400, 'That part was booked in or counted since — ask the office');
    }
    const van = await get('SELECT status FROM vans WHERE id = ?', m.van_id);
    if (van && !['planned', 'in_production'].includes(van.status)) throw httpError(400, 'That van is finished — ask the office');
    const q = -m.qty;
    let rec = null;
    try { rec = m.undo ? JSON.parse(m.undo) : null; } catch { rec = null; }
    if (!rec) {
      // Taken before Undo kept a record: just put it back on the shelf for this van.
      const l = await get(`SELECT * FROM van_lines WHERE van_id = ? AND item_id = ? AND issued >= ? ORDER BY id DESC LIMIT 1`, m.van_id, m.item_id, q);
      if (!l) throw httpError(400, 'That part was changed since — ask the office');
      await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', q, m.item_id);
      await run('UPDATE van_lines SET issued = issued - ?, reserved = reserved + ? WHERE id = ?', q, q, l.id);
      await run('DELETE FROM movements WHERE id = ?', movementId);
      return;
    }
    const l = await get('SELECT * FROM van_lines WHERE id = ?', rec.line);
    if (!l || l.issued < q) throw httpError(400, 'That part was changed since — ask the office');
    // Back on the shelf, less anything the take added only to correct the count.
    await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', q - (rec.corr || 0), m.item_id);
    if (rec.corrMv) await run('DELETE FROM movements WHERE id = ?', rec.corrMv);
    for (const [plId, n] of rec.po || []) await run('UPDATE po_lines SET received = GREATEST(0, received - ?::double precision) WHERE id = ?', n, plId);
    for (const poId of rec.reopen || []) await run(`UPDATE purchase_orders SET status = 'open' WHERE id = ?`, poId);
    // Parts borrowed from other vans go back to them (locked part and "order now" mark too).
    for (const [otherId, n, firmCut = 0, wasUrgent, wasState = null] of rec.borrowed || []) {
      await run(`UPDATE van_lines SET reserved = LEAST(reserved + ?::double precision, GREATEST(0, qty - issued)), reserved_firm = reserved_firm + ?,
             urgent = COALESCE(?, urgent) WHERE id = ?`, n, firmCut, wasUrgent ?? null, otherId);
      const o = await get('SELECT van_id, item_id, reserved, state FROM van_lines WHERE id = ?', otherId);
      if (o) await logAlloc('borrow undone', { van_id: o.van_id, item_id: o.item_id, line_id: otherId, field: 'reserved', before: o.reserved - n, after: o.reserved, note: 'take undone on the floor' });
      // The borrow turned the donor's plan order number into "still to order": put it back (only if
      // nobody has answered differently since).
      if (o && wasState != null && o.state === 'not_ordered') {
        await run('UPDATE van_lines SET state = ? WHERE id = ?', wasState, otherId);
        await logAlloc('borrow undone', { van_id: o.van_id, item_id: o.item_id, line_id: otherId, field: 'state', before: 'not_ordered', after: wasState, note: 'take undone on the floor' });
      }
    }
    const issued = l.issued - q;
    if (rec.extraLine && issued <= 0) {
      await run('DELETE FROM van_lines WHERE id = ?', l.id); // added on the floor by mistake
    } else {
      const newQty = rec.oldQty != null ? Math.max(rec.oldQty, issued) : l.qty;
      await run('UPDATE van_lines SET issued = ?, qty = ?, reserved = LEAST(reserved + ?::double precision, GREATEST(0, ?::double precision - ?::double precision)) WHERE id = ?',
          issued, newQty, rec.own || 0, newQty, issued, l.id);
      if (rec.ownFirm != null) await run('UPDATE van_lines SET reserved_firm = GREATEST(reserved_firm, LEAST(?::double precision, reserved)) WHERE id = ?', rec.ownFirm, l.id);
    }
    const now = await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', l.id);
    await logAlloc('floor take undone', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'issued', before: l.issued, after: issued, worker: m.worker,
      change: (now?.reserved ?? 0) - l.reserved, firm_change: (now?.reserved_firm ?? 0) - l.reserved_firm, note: `take of ${q} undone on the floor` });
    // Follow-up round 1 (chk-r3-2): this take is what moved a planned van to "in production". Put it back to
    // planned — so it drops back to its place in the build order and loses first call on shelf stock — but
    // only while nothing else started it since: no other part taken / issued / marked fitted for it, the
    // office hasn't set its status by hand, and it hasn't been moved on the floor map.
    if (rec.startedVan) {
      const v = await get('SELECT chassis, status, area_id FROM vans WHERE id = ?', m.van_id);
      const otherIssue = await get(`SELECT 1 FROM movements WHERE van_id = ? AND type = 'issue' AND id > ? LIMIT 1`, m.van_id, m.id);
      const officeSet = await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'van status' AND id > ? LIMIT 1`, m.van_id, rec.startedVan.logMark ?? 0);
      // "Already fitted" on this van since the take (even with no stock used) also means work has started on it.
      const fittedSince = await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'fitted' AND id > ? LIMIT 1`, m.van_id, rec.startedVan.logMark ?? 0);
      const sameSpot = v && (v.area_id ?? null) === (rec.startedVan.area ?? null);
      if (v && v.status === 'in_production' && !otherIssue && !officeSet && !fittedSince && sameSpot) {
        await run(`UPDATE vans SET status = 'planned' WHERE id = ?`, m.van_id);
        await logAlloc('floor take undone', { van_id: m.van_id, item_id: m.item_id, line_id: l.id, field: 'van status', before: 'in production', after: 'planned', worker: m.worker,
          note: `${v.chassis} back to planned: the take that started it was undone and nothing else was taken for it` });
      } else if (v && v.status === 'in_production' && otherIssue && !officeSet && !fittedSince && sameSpot) {
        // Another floor take came after this one: that take now carries the note, so undoing it as well
        // still puts the van back to planned. (Office issue / "Already fitted" have no undo record: the van stays.)
        const next = await get(`SELECT id, undo FROM movements WHERE van_id = ? AND type = 'issue' AND id > ? ORDER BY id LIMIT 1`, m.van_id, m.id);
        let nrec = null;
        try { nrec = next?.undo ? JSON.parse(next.undo) : null; } catch { nrec = null; }
        if (nrec && typeof nrec === 'object' && nrec.line != null && !nrec.startedVan) {
          nrec.startedVan = rec.startedVan;
          await run('UPDATE movements SET undo = ? WHERE id = ?', JSON.stringify(nrec), next.id);
        }
      }
    }
    await run('DELETE FROM movements WHERE id = ?', movementId);
    await allocateItem(m.item_id, m.van_id); // a per-van part goes back to its own van
  });
}

// Undo a delivery booked on the floor (phone round 1, C11): within 15 minutes, and only while nothing
// else happened to that part since (no take, count or other delivery) — then everything goes back:
// the shelf count, the purchase-order lines it ticked off (and any PO it closed), what it set aside.
// `itemId` (sp-r1-5): the part the phone booked in; a movement for another part is refused.
export async function undoReceive(movementId, by = '', { itemId = null } = {}) {
  return writeTx(async () => {
    const m = await get(`SELECT * FROM movements WHERE id = ? AND type = 'receive'`, movementId);
    if (!m) throw httpError(404, 'Nothing to undo');
    if (itemId != null && Number(m.item_id) !== Number(itemId)) throw httpError(404, 'Nothing to undo — it was already undone');
    if ((await get(`SELECT ${AGE_SECS('?')} AS s`, m.at)).s > 15 * 60) throw httpError(400, 'Too late to undo — ask the office');
    let rec = null;
    try { rec = m.undo ? JSON.parse(m.undo) : null; } catch { rec = null; }
    if (!rec || rec.kind !== 'receive') throw httpError(400, "This delivery can't be undone here — ask the office");
    if (await get('SELECT 1 FROM movements WHERE item_id = ? AND id > ? LIMIT 1', m.item_id, m.id)) throw httpError(400, 'That part was taken or booked since — ask the office');
    const item = await get('SELECT on_hand, name FROM items WHERE id = ?', m.item_id);
    if (!item) throw httpError(404, 'Part not found');
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', m.qty, m.item_id);
    for (const [plId, n] of rec.po || []) await run('UPDATE po_lines SET received = GREATEST(0, received - ?::double precision) WHERE id = ?', n, plId);
    for (const poId of rec.reopen || []) await run(`UPDATE purchase_orders SET status = 'open' WHERE id = ?`, poId);
    for (const [lineId, d, df] of rec.alloc || []) {
      const l = await get('SELECT * FROM van_lines WHERE id = ?', lineId);
      if (!l) continue;
      await run('UPDATE van_lines SET reserved = GREATEST(0, reserved - ?::double precision) WHERE id = ?', d, lineId);
      await run('UPDATE van_lines SET reserved_firm = GREATEST(0, LEAST(reserved_firm - ?::double precision, reserved)) WHERE id = ?', df, lineId);
      const now = await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', lineId);
      await logAlloc('delivery undone', { van_id: l.van_id, item_id: l.item_id, line_id: lineId, field: 'reserved', before: l.reserved, after: now.reserved, worker: by,
        change: now.reserved - l.reserved, firm_change: now.reserved_firm - l.reserved_firm, note: `delivery of ${q(m.qty)} undone on the floor` });
    }
    await run('DELETE FROM movements WHERE id = ?', movementId);
    // The movement goes, so the part's history keeps a line saying a delivery was undone (sp-r1-5).
    await logAlloc('delivery undone', { item_id: m.item_id, field: 'on_hand', before: q(item.on_hand), after: q(item.on_hand - m.qty), worker: by,
      note: `delivery of ${q(m.qty)} booked at ${String(m.at).slice(11, 16)} undone on the floor${m.ref ? ` (${m.ref})` : ''}` });
    await trimReservations(m.item_id, { reason: 'delivery undone', worker: by });
    return { name: item.name, qty: m.qty };
  });
}

// What is still to come on open purchase orders, one row per part (the worker's "Waiting for" list).
export async function floorWaiting() {
  return (await all(`SELECT i.id, i.name, i.sku, i.photo, i.unit, i.unit_size, i.kind, i.on_hand, i.location, i.area_id,
                (SELECT fa.name FROM floor_areas fa WHERE fa.id = i.area_id) AS area_name,
                COALESCE(string_agg(DISTINCT NULLIF(trim(p.supplier), ''), ','), NULLIF(trim(i.supplier), '')) AS supplier,
                SUM(${PO_OPEN}) AS to_come,
                MIN(NULLIF(COALESCE(NULLIF(pl.expected, ''), p.expected), '')) AS expected
              FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id JOIN items i ON i.id = pl.item_id
              WHERE ${PO_IS_OPEN} AND i.active = 1
              GROUP BY i.id ORDER BY i.id`))
    // by supplier (a truck's load together), parts with no supplier known last
    .sort((a, b) => (!a.supplier - !b.supplier) || String(a.supplier || '').localeCompare(String(b.supplier || ''), undefined, { sensitivity: 'base' })
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Where a part is kept, set from the worker screen ("Set place"): a storage rack and an optional shelf / bin.
export async function setItemPlace(itemId, areaId, location, by = '') {
  return writeTx(async () => {
    const it = await get('SELECT id, area_id, location FROM items WHERE id = ?', itemId);
    if (!it) throw httpError(404, 'Part not found');
    const a = areaId ? await get(`SELECT id, name FROM floor_areas WHERE id = ? AND kind = 'storage'`, Number(areaId)) : null;
    if (areaId && !a) throw httpError(404, 'That rack no longer exists — refresh');
    const loc = String(location ?? '').trim().slice(0, 60);
    const oldName = it.area_id ? ((await get('SELECT name FROM floor_areas WHERE id = ?', it.area_id))?.name || '') : '';
    await run('UPDATE items SET area_id = ?, location = ? WHERE id = ?', a?.id ?? null, loc, itemId);
    if ((it.area_id ?? null) !== (a?.id ?? null)) await logAlloc('catalogue', { item_id: itemId, field: 'rack', before: oldName, after: a?.name || '', worker: by, note: 'set on the floor' });
    if ((it.location || '') !== loc) await logAlloc('catalogue', { item_id: itemId, field: 'location', before: it.location || '', after: loc, worker: by, note: 'set on the floor' });
    return { area_name: a?.name || '', location: loc };
  });
}

// Vans for the floor: soonest first, with how far along they are.
export async function floorVans() {
  return all(`
    SELECT v.id, v.chassis, v.model, v.length, v.customer, v.eta, v.status,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id) AS total,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND l.issued >= l.qty) AS done,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND l.issued < l.qty AND l.reserved > 0) AS ready
    FROM vans v WHERE ${ACTIVE_VAN}
    ORDER BY CASE v.status WHEN 'in_production' THEN 0 ELSE 1 END, ${PRIORITY}`);
}

// Follow-up round 1 (worker-r3-3): for each part still short on the worker's van screen, whether it is on order —
// the van page's own rule (lineStatus with this van's and the shelf's open PO lines; a line fully covered by a
// shelf PO or another van's spare PO line counts as ordered too). Sets on each such line:
//   l.order = { qty, suppliers: [...], expected: 'YYYY-MM-DD' | '' }  → "On order" tag + "1 on order from Onex · due 2/11"
//   l.plan_ordered = 'Onex 08'  → the plan gives an order number but the office hasn't confirmed it ("Check: already ordered?")
async function floorOrderInfo(vanId, lines) {
  const short = l => Math.max(0, l.qty - l.reserved - l.issued);
  const open = lines.filter(l => short(l) > 1e-9 && !['customer', 'tbd'].includes(l.state));
  if (!open.length) return;
  const poRows = await all(`SELECT pl.item_id, pl.van_id, ${PO_OPEN} AS q, p.supplier, COALESCE(NULLIF(pl.expected, ''), p.expected) AS expected
                      FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                      WHERE ${PO_IS_OPEN} AND (pl.van_id IS NULL OR pl.van_id = ?) ORDER BY pl.id`, vanId);
  const sum = rs => rs.reduce((s, p) => s + p.q, 0);
  let cov = null;
  const info = (from, need) => {
    const dates = from.map(p => p.expected || '');
    return { qty: Math.min(need, sum(from.map(p => ({ q: p.qty ?? p.q })))),
      suppliers: [...new Set(from.map(p => String(p.supplier || '').trim()).filter(Boolean))],
      // the latest date given; '' when any of them has none ("due date not known")
      expected: dates.some(d => !d) ? '' : dates.sort().pop() || '' };
  };
  for (const l of open) {
    const mine = poRows.filter(p => p.item_id === l.item_id && p.van_id === vanId);
    const shelf = poRows.filter(p => p.item_id === l.item_id && p.van_id == null);
    const st = lineStatus({ ...l, on_order_van: sum(mine), on_order: sum(mine) + sum(shelf) });
    if (st === 'on_order') { l.order = info(mine.length ? mine : shelf, short(l)); continue; }
    if (st === 'to_order') {
      cov ??= await lineCover({ vanId });
      const c = cov.get(l.id);
      if (c && c.qty >= short(l) - 1e-9) { l.order = info(c.from, short(l)); continue; }
    }
    if (st === 'check') l.plan_ordered = String(l.spec || l.po_ref || '').trim().slice(0, 60);
  }
}

export async function floorVan(vanId) {
  const van = await get(`SELECT v.id, v.chassis, v.model, v.length, v.customer, v.eta, v.status, a.name AS area_name,
                     (SELECT COUNT(*) FROM van_notes n WHERE n.van_id = v.id) AS notes
                   FROM vans v LEFT JOIN floor_areas a ON a.id = v.area_id WHERE v.id = ?`, vanId);
  if (!van) throw httpError(404, 'Van not found');
  const lines = await all(`
    SELECT l.id, l.item_id, l.qty, l.reserved, l.issued, l.spec, l.plan_column, l.state, l.urgent, l.po_ref, i.name, i.sku, i.unit, i.unit_size, i.photo, i.location, i.category, i.on_hand, i.trade,
      (SELECT fa.name FROM floor_areas fa WHERE fa.id = i.area_id) AS area_name,
      COALESCE(NULLIF(l.plan_column, ''), NULLIF(i.plan_column, ''), i.category) AS col,
      i.on_hand - COALESCE((SELECT SUM(x.reserved) FROM van_lines x JOIN vans v ON v.id = x.van_id
                            WHERE x.item_id = i.id AND ${ACTIVE_VAN}), 0) AS free
    FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.van_id = ?
    ORDER BY i.category, i.name`, vanId);
  // On the shelf but all set aside for other vans (phone round 1, C9): which vans, so the worker is told
  // "set aside for ST0367, ST0380 — ask before taking" instead of "none on the shelf".
  for (const l of lines) {
    if (l.issued >= l.qty || l.reserved > 0 || !(l.on_hand > 0) || l.free > 0) continue;
    l.held_by = [...new Set((await all(`SELECT v.chassis FROM van_lines x JOIN vans v ON v.id = x.van_id
                                 WHERE x.item_id = ? AND x.van_id <> ? AND x.reserved > 0 AND ${ACTIVE_VAN} ORDER BY ${PRIORITY}`, l.item_id, vanId)).map(r => r.chassis))];
  }
  await floorOrderInfo(vanId, lines);
  const reminders = await all(`SELECT id, text, due, trade, worker FROM reminders WHERE van_id = ? AND done = 0
                         ORDER BY CASE WHEN due = '' THEN 1 ELSE 0 END, due, id`, vanId);
  return { van, lines, reminders };
}

// `by`: a name, or { userId, name } — the login (logins and job roles): its own movements by user id, and only
// movements saved before logins (no user id) by name, so two people with the same name are never mixed up.
export async function floorStats(by = '') {
  const { userId = null, name = '' } = typeof by === 'object' && by ? by : { name: by };
  const today = `substr(at, 1, 10) = ${TODAY_SQL}`;
  const mine = '(user_id = ? OR (user_id IS NULL AND worker = ?))';
  const row = await get(`SELECT
      COUNT(*) FILTER (WHERE ${mine}) AS mine,
      COUNT(*) AS team,
      COUNT(*) FILTER (WHERE ${mine} AND type = 'issue') AS mine_took,
      COUNT(*) FILTER (WHERE type = 'issue') AS team_took,
      COUNT(DISTINCT COALESCE(CAST(user_id AS TEXT), worker)) AS people
    FROM movements WHERE ${today} AND type IN ('issue','receive') AND worker <> ''`, userId ?? -1, name, userId ?? -1, name);
  return row;
}

// ───────────────────────── go-live: already fitted ─────────────────────────

// Parts put in a van before the system was in use. Each ticked line is closed (issued = qty), so it
// is never short and never re-ordered. Only what was set aside for it leaves the shelf figure (that
// stock was in the books); nothing is taken from free stock. One 'issue' movement per item.
// `done`: the office went through the list for this van (go-live checklist step c) — also with
// nothing ticked ("nothing else is fitted").
export async function markFitted(vanId, lineIds, worker = '', { done = false } = {}) {
  if ((!Array.isArray(lineIds) || !lineIds.length) && !done) throw httpError(400, 'Tick the parts that are already fitted');
  lineIds = Array.isArray(lineIds) ? lineIds : [];
  return writeTx(async () => {
    const van = await get('SELECT id, chassis, status FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'Van not found');
    if (done) await logAlloc('fitted: checked', { van_id: vanId, field: 'checked', after: 'yes', worker, note: `${van.chassis}: already-fitted parts checked (${lineIds.length} ticked)` });
    if (!lineIds.length) return { closed: 0, movements: 0 };
    const ids = lineIds.map(Number);
    const lines = await all(`SELECT * FROM van_lines WHERE van_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND issued < qty ORDER BY id`, vanId, ...ids);
    const perItem = new Map();
    let closed = 0;
    for (const l of lines) {
      const fromStock = Math.max(0, Math.min(l.reserved, l.qty - l.issued));
      await run('UPDATE van_lines SET issued = qty, reserved = 0, reserved_firm = 0 WHERE id = ?', l.id);
      closed++;
      if (fromStock > 0) perItem.set(l.item_id, (perItem.get(l.item_id) || 0) + fromStock);
      await logAlloc('fitted', { van_id: vanId, item_id: l.item_id, line_id: l.id, field: 'issued', before: l.issued, after: l.qty, worker,
        change: -l.reserved, firm_change: -l.reserved_firm,
        note: fromStock >= l.qty - l.issued ? 'fitted before go-live, set-aside stock used'
          : fromStock > 0 ? `fitted before go-live: ${q(fromStock)} from set-aside stock, ${q(l.qty - l.issued - fromStock)} not from stock`
          : 'fitted before go-live, not from stock' });
    }
    for (const [itemId, n] of perItem) {
      await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', n, itemId);
      await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'issue', ?, ?, 'Already fitted (set up before go-live)', ?)`,
          itemId, -n, vanId, van.chassis, worker);
    }
    return { closed, movements: perItem.size };
  });
}

// "Already fitted…" quick start (round 2, user-r1-5): which open lines of this van were received FOR this
// van and are still kept for it in full, and when they arrived. The dialog offers "tick everything
// received more than N weeks ago (or before the system started)" so a van that has been in the bays a
// while takes minutes, not an hour. Nothing is ticked or saved here — the office still presses Save.
//   received_at  date of the last delivery booked for this van and part ('' if none)
//   before_start 1 = it came in with the production plan import (arrived before the system was used)
//   covered      1 = what is kept for the van covers everything the line still needs (only these are offered)
const PLAN_IMPORT_NOTE = 'Received for this van (production plan import)';
export async function fittedQuickStart(vanId) {
  const van = await get(`SELECT v.id, v.chassis, v.status, fa.name AS area_name, fa.kind AS area_kind FROM vans v
                   LEFT JOIN floor_areas fa ON fa.id = v.area_id WHERE v.id = ?`, vanId);
  if (!van) throw httpError(404, 'Van not found');
  const rec = new Map((await all(`SELECT item_id, MAX(substr(at, 1, 10)) AS last_at,
                             MAX(CASE WHEN note = ? THEN 0 ELSE 1 END) AS any_real
                           FROM movements WHERE van_id = ? AND type = 'receive' AND qty > 0 GROUP BY item_id`, PLAN_IMPORT_NOTE, vanId))
    .map(r => [r.item_id, r]));
  // A line moved off an "as per plan" catch-all onto the real part brought its received stock with it
  // (an 'adjust' "Re-linked from PLAN-X"): it arrived when the catch-all's delivery did.
  for (const m of await all(`SELECT m.item_id, substr(m.at, 1, 10) AS at, m.note FROM movements m
                       WHERE m.van_id = ? AND m.type = 'adjust' AND m.qty > 0 AND m.note ILIKE 'Re-linked from %' ORDER BY m.id`, vanId)) {
    const from = await get('SELECT id FROM items WHERE sku = ?', skuNow(String(m.note).slice('Re-linked from '.length).trim().split(/\s/)[0]));
    const src = from && rec.get(from.id);
    const cur = rec.get(m.item_id);
    const add = src || { last_at: m.at, any_real: 1 };
    rec.set(m.item_id, cur ? { last_at: cur.last_at > add.last_at ? cur.last_at : add.last_at, any_real: cur.any_real || add.any_real } : { ...add });
  }
  const lines = (await all(`SELECT id, item_id, qty, issued, reserved, reserved_firm, state FROM van_lines WHERE van_id = ? AND issued < qty ORDER BY id`, vanId))
    .map(l => {
      const r = rec.get(l.item_id);
      const open = l.qty - l.issued;
      return { id: l.id, received_at: r?.last_at || '', before_start: r && !r.any_real ? 1 : 0, kept: l.reserved_firm,
        covered: l.reserved_firm > 0 && l.reserved_firm >= open - 1e-9 && !['customer', 'tbd'].includes(l.state) ? 1 : 0 };
    });
  return { van: { ...van, build: (await buildOrderInfo()).get(van.id) || null }, today: today(), lines };
}

// A part the plan says was handed to a worker for this van ("Black Jack Gave to Alex 15/07/2026",
// round 2 user-r1-5): it is no longer on the shelf, so the line is closed as given out (issued = qty).
// Same stock rule as "Already fitted": what was set aside for the line is booked out of the shelf figure
// with one 'issue' movement (worker = the person named, the plan text in the note), so on hand still
// equals the sum of movements. A part never set aside for the line is closed with no movement (it never
// was in the books for this van) and the result says so, for the clean-up report. Returns null when the
// line is already closed or isn't a "given to" line.
export async function closeAsGiven(lineId, { reason = 'given', by = '', text } = {}) {
  return writeTx(async () => {
    const l = await get(`SELECT l.*, v.chassis, v.status AS van_status, i.unit FROM van_lines l JOIN vans v ON v.id = l.van_id
                   JOIN items i ON i.id = l.item_id WHERE l.id = ?`, lineId);
    if (!l || l.issued >= l.qty - 1e-9) return null;
    const said = text ?? l.spec;
    const g = givenTo(said);
    if (!g) return null;
    const open = l.qty - l.issued;
    const fromStock = Math.max(0, Math.min(l.reserved, open));
    const reserved = Math.max(0, l.reserved - fromStock);
    await run('UPDATE van_lines SET issued = qty, reserved = ?, reserved_firm = LEAST(reserved_firm, ?::double precision), urgent = 0 WHERE id = ?', reserved, reserved, l.id);
    const plan = `plan note "${said}"`;
    if (fromStock > 0) {
      await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', fromStock, l.item_id);
      await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'issue', ?, ?, ?, ?)`,
          l.item_id, -fromStock, l.van_id, l.chassis, `Given to ${g.name} for ${l.chassis}${g.date ? ` (plan says ${g.date})` : ''} – ${plan}`, g.name);
    }
    const notFrom = open - fromStock;
    await logAlloc(reason, { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'issued', before: q(l.issued), after: q(l.qty), worker: by,
      change: -fromStock, firm_change: -(l.reserved_firm - Math.min(l.reserved_firm, reserved)),
      note: `given to ${g.name}${g.date ? ` ${g.date}` : ''} (${plan}): ${fromStock > 0 ? `${q(fromStock)} ${l.unit} set aside for ${l.chassis} booked out of the shelf figure` : 'nothing was set aside'}`
        + (notFrom > 1e-9 && fromStock > 0 ? `; ${q(notFrom)} not set aside – shelf figure not changed for those` : '') });
    return { line_id: l.id, chassis: l.chassis, name: g.name, date: g.date, fromStock, notFromStock: notFrom, unit: l.unit };
  });
}

// ───────────────────────── counts (blind, rack by rack) ─────────────────────────

const COUNTABLE = `i.active = 1 AND i.kind = 'stock' AND i.placeholder = 0 AND i.sku NOT ILIKE 'PLAN-%'`;

// Parts set aside and locked for vans (received for them), per item: total and per van.
async function lockedFor(itemId) {
  const rows = await all(`SELECT v.chassis, SUM(l.reserved_firm) AS q FROM van_lines l JOIN vans v ON v.id = l.van_id
                    WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.reserved_firm > 0 GROUP BY v.id ORDER BY ${PRIORITY}`, itemId);
  return { total: rows.reduce((s, r) => s + r.q, 0), vans: rows.map(r => ({ chassis: r.chassis, qty: r.q })) };
}

// What a count covers: one rack / area, items with no rack yet, or a whole trade. Each item has one
// place, so it is counted in exactly one rack. Per-van parts are checked on their own list instead.
async function countScope(scope) {
  const s = String(scope || '');
  if (s === 'norack') return { where: 'i.area_id IS NULL', args: [], label: 'No rack yet' };
  let m = /^area:(\d+)$/.exec(s);
  if (m) {
    const a = await get('SELECT name FROM floor_areas WHERE id = ?', Number(m[1]));
    if (!a) throw httpError(404, 'That rack no longer exists — refresh');
    return { where: 'i.area_id = ?', args: [Number(m[1])], label: a.name };
  }
  m = /^trade:([a-z]+)$/.exec(s);
  if (m) return { where: 'i.trade = ?', args: [m[1]], label: `Trade: ${m[1]}` };
  throw httpError(400, 'Pick a rack, "No rack yet" or a trade');
}

// What can be counted: racks with how many items each.
export async function countChoices() {
  const racks = await all(`SELECT a.id, a.name, a.kind, COUNT(i.id) AS items FROM floor_areas a JOIN items i ON i.area_id = a.id AND ${COUNTABLE}
                     GROUP BY a.id ORDER BY a.sort, a.name`);
  const norack = (await get(`SELECT COUNT(*) AS c FROM items i WHERE ${COUNTABLE} AND i.area_id IS NULL`)).c;
  const trades = await all(`SELECT i.trade, COUNT(*) AS items FROM items i WHERE ${COUNTABLE} AND i.trade <> '' GROUP BY i.trade ORDER BY i.trade`);
  const open = await all(`SELECT id, label, opened_at, opened_by FROM count_sessions WHERE closed_at = '' ORDER BY id DESC LIMIT 10`);
  return { racks, norack, trades, open };
}

// Start a count: the expected figures are written down now but not shown to the counter.
export async function openCount(scope, by = '') {
  return writeTx(async () => {
    const sc = await countScope(scope);
    const items = await all(`SELECT i.id, i.sku, i.name, i.unit, i.location, i.photo, i.on_hand FROM items i
                       WHERE ${COUNTABLE} AND ${sc.where} ORDER BY i.location, i.name`, ...sc.args);
    if (!items.length) throw httpError(400, 'Nothing to count there');
    const expected = Object.fromEntries(items.map(i => [i.id, i.on_hand]));
    const lastMove = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM movements')).m;
    const id = await insert('INSERT INTO count_sessions(scope, label, opened_by, last_move_id, expected) VALUES(?,?,?,?,?)',
      scope, sc.label, by, lastMove, JSON.stringify(expected));
    return { id, label: sc.label, items: items.map(({ on_hand, ...i }) => i) }; // no expected figure: a blind count
  });
}

async function countSession(id) {
  const s = await get('SELECT * FROM count_sessions WHERE id = ?', id);
  if (!s) throw httpError(404, 'That count no longer exists — start again');
  if (s.closed_at) throw httpError(409, 'This count was already saved');
  return { ...s, expected: JSON.parse(s.expected || '{}') };
}

// Big difference: more than 10 % or more than 5 units (any difference when nothing was expected).
const bigDiff = (expected, counted) => {
  const d = Math.abs(counted - expected);
  return d > 1e-9 && (d > 5 || d > Math.abs(expected) * 0.1);
};

// After the counts are typed: what the books said when the count started (expected), what they say
// now (now — only different if stock moved while counting), the count, and what needs a second look.
//
// Stock that moved while counting (a floor take, a delivery…) must not be counted twice, so for such a
// part the office says when the shelf was counted — `timing` {itemId: 'before' | 'after'}:
//   after  (the safe default): the count already shows the movements → books = counted
//          (change = counted − now)
//   before: the movements happened after the shelf was counted → books = counted + what moved since
//          (change = counted − expected)
// The "kept for vans" check runs on that resulting book figure: shortfall = locked − books (never
// less than 0). shortfall_before / shortfall_after / big_before / big_after let the screen show the
// right question for either answer without asking the server again.
export async function checkCount(id, counts = [], { timing = {} } = {}) {
  const s = await countSession(id);
  const seen = new Set();
  const out = [];
  for (const c of counts.filter(c => c.qty !== '' && c.qty != null && Number.isFinite(Number(c.qty)) && s.expected[c.item_id] != null)
    .filter(c => !seen.has(Number(c.item_id)) && seen.add(Number(c.item_id)))) {
      const itemId = Number(c.item_id), counted = Number(c.qty), expected = s.expected[itemId];
      const it = await get('SELECT sku, name, unit, on_hand FROM items WHERE id = ?', itemId);
      const now = it ? it.on_hand : expected;
      const moved = now - expected;
      const locked = await lockedFor(itemId);
      const moves = await all(`SELECT m.at, m.type, m.qty, m.worker, m.note, v.chassis FROM movements m LEFT JOIN vans v ON v.id = m.van_id
                         WHERE m.item_id = ? AND m.id > ? ORDER BY m.id`, itemId, s.last_move_id);
      const changed = moves.length > 0 || Math.abs(moved) > 1e-9;
      const said = ['before', 'after'].includes(timing[itemId]) ? timing[itemId] : '';
      const when = changed ? said || 'after' : 'after';
      const bookFor = w => w === 'before' ? counted + moved : counted;
      const shortFor = w => Math.max(0, locked.total - bookFor(w));
      const book = bookFor(when);
      const shortfall = shortFor(when);
      out.push({ item_id: itemId, sku: it?.sku, name: it?.name, unit: it?.unit, expected, now, moved, counted, moves,
        changed, timing: changed ? said : 'after', // '' = moved while counting and not answered yet
        book, diff: book - now, diff_before: counted - expected, diff_after: counted - now,
        big: when === 'before' ? bigDiff(expected, counted) : bigDiff(now, counted), big_before: bigDiff(expected, counted), big_after: bigDiff(now, counted),
        locked: locked.total, lockedVans: locked.vans,
        shortfall, shortfall_before: shortFor('before'), shortfall_after: shortFor('after'), belowLocked: shortfall > 1e-9 });
  }
  return out;
}

// Save a count. counts: [{item_id, qty, reason, recounted}]
// timing: {itemId: 'before' | 'after'} — only needed for parts that moved while counting (see checkCount).
//   ackMoves (older screens): "I've seen the movements" without a per-part answer = 'after'.
// elsewhere: {itemId: 'yes' | 'no'} — only for parts where the books would hold less than is kept for vans.
// elsewhereQty: {itemId: n} — with 'yes': how many are kept elsewhere (default: the whole shortfall);
//   fewer than the shortfall = the rest are missing and go back to short.
// Nothing is saved (all or nothing) unless every question is answered, and no save may leave more set
// aside for vans than the books hold.
export async function saveCount(id, { counts = [], elsewhere = {}, elsewhereQty = {}, timing = {}, ackMoves = false, by = '' } = {}) {
  return writeTx(async () => {
    const s = await countSession(id);
    const when = { ...timing };
    if (ackMoves) for (const c of counts) if (!['before', 'after'].includes(when[c.item_id])) when[c.item_id] = 'after';
    const rows = await checkCount(id, counts, { timing: when });
    if (!rows.length) throw httpError(400, 'Type at least one count');
    const byId = new Map(counts.map(c => [Number(c.item_id), c]));
    const problems = [];
    const awayOf = new Map();
    for (const r of rows) {
      const c = byId.get(r.item_id);
      const vans = r.lockedVans.map(v => v.chassis).join(', ');
      if (r.counted < 0) { problems.push(`${r.name}: a count can't be below 0`); continue; }
      if (r.changed && !r.timing) { problems.push(`${r.name}: stock moved while counting — was the shelf counted before or after those movements?`); continue; }
      if (r.book < -1e-9) problems.push(`${r.name}: counted before the movements would leave the books below 0 — check the count or pick "after"`);
      if (r.big && !String(c.reason || '').trim() && !c.recounted) problems.push(`${r.name}: recount or give a reason`);
      if (r.belowLocked) {
        const ans = elsewhere[r.item_id];
        if (!['yes', 'no'].includes(ans)) { problems.push(`${r.name}: ${q(r.shortfall)} of the parts kept for ${vans} are not on the shelf — are they kept somewhere else?`); continue; }
        let away = 0;
        if (ans === 'yes') {
          const typed = elsewhereQty[r.item_id];
          away = typed === '' || typed == null ? r.shortfall : Number(typed);
          if (!Number.isFinite(away) || away < 0) { problems.push(`${r.name}: how many are kept elsewhere?`); continue; }
          if (away > r.shortfall + 1e-9) { problems.push(`${r.name}: at most ${q(r.shortfall)} can be kept elsewhere (the shelf count covers the rest)`); continue; }
        }
        awayOf.set(r.item_id, away);
      }
    }
    if (problems.length) throw Object.assign(httpError(400, problems[0]), { problems });
    let saved = 0;
    for (const r of rows) {
      const c = byId.get(r.item_id);
      const away = awayOf.get(r.item_id) || 0;        // kept elsewhere for vans (in the van, kit area)
      const missing = r.belowLocked ? Math.max(0, r.shortfall - away) : 0;
      const target = r.book + away;                   // on the books = shelf (+ what moved after it was counted) + kept elsewhere
      const nowOnHand = (await get('SELECT on_hand FROM items WHERE id = ?', r.item_id)).on_hand;
      const delta = target - nowOnHand;               // against the books right now, so nothing is counted twice
      const vans = r.lockedVans.map(v => v.chassis).join(', ');
      const note = [`Counted ${q(r.counted)} ${r.unit || ''}`.trim()
          + (r.changed ? ` (${r.timing === 'before'
            ? `before ${r.moved < 0 ? `${q(-r.moved)} went out` : r.moved > 0 ? `${q(r.moved)} came in` : 'the movements'} while counting — books = ${q(r.book)}`
            : 'after the stock that moved while counting'})` : '')
          + (away ? ` + ${q(away)} kept elsewhere for ${vans}` : ''),
        missing > 1e-9 ? `${q(missing)} kept for ${vans} missing — back to short` : '',
        String(c.reason || '').trim(), c.recounted ? 'recounted' : '', `(${s.label})`].filter(Boolean).join(' · ');
      await run(`UPDATE items SET on_hand = on_hand + ?, last_counted = ${NOW_SQL} WHERE id = ?`, delta, r.item_id);
      await run(`INSERT INTO movements(item_id, qty, type, ref, note, worker) VALUES(?, ?, 'count', ?, ?, ?)`, r.item_id, delta, `Count #${id}`, note, by);
      saved++;
      // More found than the books said: the extra shelf stock goes to vans waiting for it. Stock added
      // by a "kept elsewhere" answer is never handed out — it only covers what is already kept for vans.
      if (delta > 1e-9 && !away) await allocateItem(r.item_id, null, { reason: 'count', worker: by });
      // Less: shelf stock merely held for the vans built last goes back first (logged)…
      await trimReservations(r.item_id, { reason: 'count', worker: by });
      // …then parts received for vans that aren't on the shelf or anywhere else go back to short.
      if (missing > 1e-9) await cutLocked(r.item_id, { reason: 'count: missing', worker: by });
      const over = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN}`, r.item_id)).r
        - Math.max(0, (await get('SELECT on_hand FROM items WHERE id = ?', r.item_id)).on_hand);
      if (over > 1e-9) {
        const msg = `${r.name}: this count would leave ${q(over)} more set aside for ${vans || 'vans'} than the books hold — say whether they are kept somewhere else`;
        throw Object.assign(httpError(400, msg), { problems: [msg] }); // nothing is saved
      }
    }
    await run(`UPDATE count_sessions SET closed_at = ${NOW_SQL} WHERE id = ?`, id);
    return { saved };
  });
}

// The shelf has less than is locked for vans and the parts are missing: take the set-aside back from
// the vans built last until it fits, so those lines show as short again (logged).
async function cutLocked(itemId, { reason, worker = '' }) {
  const onHand = Math.max(0, (await get('SELECT on_hand FROM items WHERE id = ?', itemId)).on_hand);
  let over = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r - onHand;
  if (over <= 0) return;
  const ranks = await vanRanks();
  const lines = (await all(`SELECT l.* FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.reserved > 0`, itemId))
    .sort((a, b) => (ranks.get(b.van_id) ?? 0) - (ranks.get(a.van_id) ?? 0) || b.id - a.id);
  for (const l of lines) {
    if (over <= 0) break;
    const give = Math.min(over, l.reserved);
    await run('UPDATE van_lines SET reserved = reserved - ?, reserved_firm = GREATEST(0, reserved_firm - ?::double precision) WHERE id = ?', give, give, l.id);
    await logAlloc(reason, { van_id: l.van_id, item_id: itemId, line_id: l.id, field: 'reserved', before: l.reserved, after: l.reserved - give, worker, note: 'not on the shelf when counted — back to short' });
    if (l.reserved_firm > 0) await stillToOrder(l, reason, worker, 'received for it but not found when counted');
    over -= give;
  }
}

// A line whose part had arrived (so the plan's order number was used up) and is now gone again —
// borrowed, or not found in a check: it is a plain "still to order" line, so it shows under Order now
// instead of "Check: already ordered?" (round 2, check-r1-2). Only lines nobody has answered for.
async function stillToOrder(l, reason, worker, why) {
  if (l.state || !String(l.po_ref || '').trim()) return;
  if (!(await run(`UPDATE van_lines SET state = 'not_ordered' WHERE id = ? AND state = ''`, l.id)).changes) return;
  await logAlloc(reason, { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'state', before: '', after: 'not_ordered', worker,
    note: `plan order ${String(l.po_ref).trim()} already used — ${why}, still to order` });
}

// Parts bought for one van (per-van items) that arrived but aren't fitted yet: checked one by one
// ("Is ST0389's fridge here?") instead of in the rack counts.
export async function boughtForVanList() {
  const rows = await all(`SELECT l.id, l.van_id, l.item_id, l.qty, l.reserved, l.issued, l.spec, l.plan_column, v.chassis, i.sku, i.name, i.unit, i.photo, i.location,
                      (SELECT MAX(a.at) FROM allocation_log a WHERE a.line_id = l.id AND a.reason = 'check: here') AS checked_at
                    FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
                    WHERE ${ACTIVE_VAN} AND (i.kind = 'per-van' OR i.placeholder = 1 OR i.sku ILIKE 'PLAN-%') AND l.reserved > 0 AND l.issued < l.qty
                    ORDER BY ${PRIORITY}, i.name, l.id`);
  const vans = new Map();
  for (const r of rows) {
    if (!vans.has(r.van_id)) vans.set(r.van_id, { van_id: r.van_id, chassis: r.chassis, lines: [] });
    vans.get(r.van_id).lines.push(r);
  }
  return [...vans.values()];
}

// answer: 'here' | 'missing' | 'fitted'
export async function checkBoughtLine(lineId, answer, by = '') {
  return writeTx(async () => {
    const l = await get(`SELECT l.*, v.chassis FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.id = ?`, lineId);
    if (!l) throw httpError(404, 'That part line no longer exists — refresh');
    if (answer === 'fitted') return markFitted(l.van_id, [l.id], by);
    if (answer === 'here') {
      await logAlloc('check: here', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'checked', before: '', after: q(l.reserved), worker: by, note: `${l.chassis}'s part is here` });
      return { ok: true };
    }
    if (answer !== 'missing') throw httpError(400, 'Answer Yes, No or Already fitted');
    if (!(l.reserved > 0)) return { ok: true };
    const it = await get('SELECT on_hand FROM items WHERE id = ?', l.item_id);
    const cut = Math.min(l.reserved, Math.max(0, it.on_hand));
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', cut, l.item_id);
    await run('UPDATE van_lines SET reserved = 0, reserved_firm = 0 WHERE id = ?', l.id);
    if (cut > 0) await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'count', ?, ?, ?, ?)`,
        l.item_id, -cut, l.van_id, l.chassis, `Not found when checked (bought for ${l.chassis}) — back to short`, by);
    await logAlloc('check: missing', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0, worker: by, note: `${l.chassis}'s part not found — back to short` });
    await stillToOrder(l, 'check: missing', by, 'bought for it but not found when checked');
    return { ok: true };
  });
}

// ───────────────────────── bought-for-van stock with no van (C9) ─────────────────────────
//
// A per-van part (fridge, aircon…) only ever goes to its own van. Stock of one that is on the shelf
// but not set aside for any van (on hand − set aside) would sit there unseen, so it is listed until
// the office either assigns it to a van or says "keep it on the shelf as a spare".
// The "spare" answer is a log entry (reason 'spare', after = how many were unassigned when answered);
// more stock arriving with no van brings the item back onto the list.

async function spareAck(itemId) {
  const r = await get(`SELECT after FROM allocation_log WHERE reason = 'spare' AND item_id = ? ORDER BY id DESC LIMIT 1`, itemId);
  return r ? Number(r.after) || 0 : 0;
}

export async function unassignedPerVan({ all: everything = false } = {}) {
  const rows = (await all(`SELECT i.id, i.sku, i.name, i.unit, i.unit_size, i.photo, i.supplier, i.placeholder, i.on_hand,
                      i.on_hand - COALESCE((SELECT SUM(l.reserved) FROM van_lines l JOIN vans v ON v.id = l.van_id
                                            WHERE l.item_id = i.id AND ${ACTIVE_VAN}), 0) AS unassigned
                    FROM items i WHERE i.active = 1 AND i.kind = 'per-van' ORDER BY i.id`)).filter(r => r.unassigned > 1e-9);
  const ranks = await vanRanks();
  const out = [];
  for (const r of rows) {
    const spare = await spareAck(r.id);
    const vans = (await all(`SELECT l.van_id, v.chassis, v.eta, v.status, SUM(l.qty - l.reserved - l.issued) AS short
                      FROM van_lines l JOIN vans v ON v.id = l.van_id
                      WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.qty > l.reserved + l.issued + 1e-9 AND ${ALLOCATABLE('l')}
                      GROUP BY l.van_id, v.id`, r.id)).sort((a, b) => (ranks.get(a.van_id) ?? 1e9) - (ranks.get(b.van_id) ?? 1e9));
    out.push({ ...r, placeholder: isPlaceholder(r) ? 1 : 0, spare, needs_answer: r.unassigned > spare + 1e-9 ? 1 : 0, vans });
  }
  return out.filter(r => everything || r.needs_answer).sort((a, b) => a.name.localeCompare(b.name));
}

// Put unassigned bought-for-van stock to a van: set aside and locked to it (logged).
export async function assignToVan(itemId, vanId, qty, by = '') {
  return writeTx(async () => {
    const it = await get('SELECT * FROM items WHERE id = ?', itemId);
    if (!it) throw httpError(404, 'Part not found');
    const free = it.on_hand - (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r;
    const want = qty == null || qty === '' ? free : Math.min(Number(qty), free);
    if (!(want > 1e-9)) throw httpError(409, 'Nothing left to assign — refresh');
    const van = await get('SELECT chassis FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'That van no longer exists — refresh');
    let left = want;
    for (const l of await all(`SELECT * FROM van_lines l WHERE van_id = ? AND item_id = ? AND l.qty > l.reserved + l.issued + 1e-9 AND ${ALLOCATABLE('l')} ORDER BY id`, vanId, itemId)) {
      if (left <= 1e-9) break;
      const take = Math.min(left, l.qty - l.reserved - l.issued);
      await run('UPDATE van_lines SET reserved = reserved + ?, reserved_firm = reserved_firm + ? WHERE id = ?', take, take, l.id);
      await logAlloc('assign to van', { van_id: vanId, item_id: itemId, line_id: l.id, field: 'reserved (locked)', before: l.reserved, after: l.reserved + take, worker: by,
        change: take, firm_change: take, note: `bought-for-van stock with no van – assigned to ${van.chassis}` });
      left -= take;
    }
    if (left >= want - 1e-9) throw httpError(409, `${van.chassis} doesn't need this part any more — pick another van`);
    return { assigned: want - left };
  });
}

// "Keep on the shelf as a spare": the office has seen it; it stays visible as Unassigned.
export async function keepSpare(itemId, by = '') {
  return writeTx(async () => {
    const r = (await unassignedPerVan({ all: true })).find(x => x.id === Number(itemId));
    if (!r) throw httpError(409, 'Nothing unassigned for this part — refresh');
    await logAlloc('spare', { item_id: r.id, field: 'spare', before: q(r.spare), after: q(r.unassigned), worker: by, note: `${q(r.unassigned)} ${r.unit} kept on the shelf as a spare (no van)` });
    return { ok: true };
  });
}

// ───────────────────────── reorder suggestions (C10) ─────────────────────────
//
// Never saved by itself — shown with an "Apply" button. Van demand is already ordered per van (C6), so:
//   - a part that appears on van lines: the level is only a safety buffer of about one van's use
//     (median quantity per van);
//   - a floor consumable not on van lines (screws, silicone, tape): average use per week (from 'issue'
//     movements, once there are 4+ weeks of history) × (supplier lead time + 1 review week).
// Returns Map itemId → { level, why } (level null = no suggestion yet).
const WHOLE_UNITS = /^(ea|set|kit|pair|sheet|length|box|roll|pack|pkt|bag)$/i;
export async function reorderSuggestions(itemIds = null) {
  const items = (await all(`SELECT i.id, i.unit, i.supplier FROM items i WHERE ${COUNTABLE_ITEM} ORDER BY i.id`)).filter(i => !itemIds || itemIds.includes(i.id));
  const out = new Map();
  if (!items.length) return out;
  const onLines = new Set((await all('SELECT DISTINCT item_id FROM van_lines')).map(r => r.item_id));
  const med = await itemMedians(items.filter(i => onLines.has(i.id)).map(i => i.id));
  const lead = new Map((await all('SELECT name, lead_days FROM suppliers')).map(s => [s.name, s.lead_days]));
  const round = (n, unit) => (WHOLE_UNITS.test(unit || '') ? Math.ceil(n - 1e-9) : Math.round(n * 10) / 10);
  for (const i of items) {
    if (onLines.has(i.id)) {
      const m = med.get(i.id) || 0;
      out.set(i.id, m > 0 ? { level: round(m, i.unit), why: `about one van's use (${q(m)} ${i.unit} per van) as a safety buffer — van orders cover the rest` }
        : { level: null, why: 'no van use yet' });
      continue;
    }
    // (days since the first one, worked out in SQL: `at` is Melbourne wall-clock time)
    const h = await get(`SELECT MIN(at) AS first, ${AGE_SECS('MIN(at)')} AS secs FROM movements WHERE item_id = ? AND type = 'issue'`, i.id);
    const days = h?.first ? h.secs / 86400 : 0;
    if (days < 28) { out.set(i.id, { level: null, why: 'not enough history yet (needs 4 weeks of parts taken)' }); continue; }
    const span = Math.min(days, 84);
    const used = -(await get(`SELECT COALESCE(SUM(qty),0) AS s FROM movements WHERE item_id = ? AND type = 'issue' AND at >= to_char(${MELB} + ?::interval, 'YYYY-MM-DD HH24:MI:SS')`, i.id, `-${Math.round(span)} days`)).s;
    const perWeek = used / (span / 7);
    const ld = lead.get(String(i.supplier || '').trim()) ?? 14;
    const level = perWeek > 0 ? round(perWeek * (ld / 7 + 1), i.unit) : null;
    out.set(i.id, { level, why: level ? `${q(Math.round(perWeek * 10) / 10)} ${i.unit} a week × (${ld} days lead time + 1 week)` : 'not used in the last weeks' });
  }
  return out;
}

// ───────────────────────── fix the catalogue (C9) ─────────────────────────

// Supplier names that show up in the plan / order text (reviewed list), plus every supplier already in
// the system whose name is a distinctive word. Suggestions only — nothing is saved without a click.
const SUPPLIER_WORDS = [['E time', /\be[\s-]?time\b/i], ['Battery Stop', /\bbattery\s*stop\b/i], ['Capral', /\bcapral\b/i],
  ['Nikpol', /\bnikpol\b/i], ['Urban Republic', /\burban\s*republic\b/i]];
// Supplier names that are also ordinary words in part names / plan text (a "gold" tap isn't from Gold).
const NOT_A_BRAND = /^(gold|black|white|grey|silver|chrome|custom|plan|order)$/i;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function supplierSuggestions() {
  const out = new Map();
  const words = [...SUPPLIER_WORDS];
  for (const { name } of await all(`SELECT name FROM suppliers ORDER BY name`)) {
    if (name.length < 4 || NOT_A_BRAND.test(name) || words.some(([s]) => s.toLowerCase() === name.toLowerCase())) continue;
    words.push([name, new RegExp(`\\b${reEsc(name).replace(/\s+/g, '\\s*')}\\b`, 'i')]);
  }
  const rows = await all(`SELECT i.id, l.spec FROM items i JOIN van_lines l ON l.item_id = i.id
                    WHERE i.active = 1 AND trim(i.supplier) = '' AND trim(l.spec) <> '' ORDER BY l.id`);
  const blank = await all(`SELECT id, sku, name, category, kind FROM items WHERE active = 1 AND trim(supplier) = '' ORDER BY id`);
  const hits = new Map(); // itemId → Map(supplier → {n, where})
  const add = (id, text, where) => {
    for (const [sup, re] of words) if (re.test(text)) {
      if (!hits.has(id)) hits.set(id, new Map());
      const h = hits.get(id).get(sup) || { n: 0, where };
      h.n += where === 'name' ? 100 : 1; // the part's own name counts most
      hits.get(id).set(sup, h);
    }
  };
  for (const r of rows) add(r.id, r.spec, 'text');
  for (const r of blank) add(r.id, r.name, 'name');
  for (const [id, m] of hits) {
    const [sup, h] = [...m.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    out.set(id, { supplier: sup, why: h.n >= 100 ? `the part's name says "${sup}"` : `"${sup}" appears ${h.n} time(s) in the plan text for this part` });
  }
  // Shelf parts only: sister parts (same code start and category, e.g. TAPS-…) that all have the same
  // supplier. Not for bought-for-van parts — those are brands (an OGO toilet isn't from Thetford).
  const named = await all(`SELECT sku, category, trim(supplier) AS supplier FROM items WHERE active = 1 AND trim(supplier) <> '' AND placeholder = 0 ORDER BY id`);
  for (const b of blank) {
    if (out.has(b.id) || b.kind !== 'stock') continue;
    const stem = String(b.sku).split('-')[0];
    const sis = named.filter(n => n.category === b.category && String(n.sku).split('-')[0] === stem);
    const sups = [...new Set(sis.map(s => s.supplier))];
    if (sis.length >= 2 && sups.length === 1) out.set(b.id, { supplier: sups[0], why: `same supplier as ${sis.slice(0, 3).map(s => s.sku).join(', ')}` });
  }
  return out;
}

// Items with something missing: supplier; for shelf items a rack, a reorder level; a unit size where
// the unit isn't obvious (length, set, m…). With suggestions to accept.
export async function catalogueGaps() {
  const items = (await listItems()).filter(i => !i.placeholder);
  const sups = await supplierSuggestions();
  const reo = await reorderSuggestions();
  const needsSize = i => !/^(ea|pair)$/i.test(String(i.unit || '').trim()) && !String(i.unit_size || '').trim();
  const rows = items.map(i => {
    const shelf = i.kind === 'stock';
    const missing = [];
    if (!String(i.supplier || '').trim()) missing.push('supplier');
    if (shelf && !i.area_id) missing.push('rack');
    if (needsSize(i)) missing.push('unit size');
    if (shelf && !(i.reorder_level > 0)) missing.push('reorder level');
    return { id: i.id, sku: i.sku, name: i.name, category: i.category, trade: i.trade, kind: i.kind, supplier: i.supplier, unit: i.unit,
      unit_size: i.unit_size, area_id: i.area_id, area_name: i.area_name, location: i.location, reorder_level: i.reorder_level,
      order_up_to: i.order_up_to, on_hand: i.on_hand, not_counted: i.not_counted, last_counted: i.last_counted, photo: i.photo, missing,
      suggest_supplier: sups.get(i.id) || null, suggest_reorder: shelf ? (reo.get(i.id) || null) : null };
  });
  return {
    rows: rows.filter(r => r.missing.length),
    counts: ['supplier', 'rack', 'unit size', 'reorder level'].reduce((o, k) => ({ ...o, [k]: rows.filter(r => r.missing.includes(k)).length }), {}),
    racks: await all(`SELECT id, name FROM floor_areas WHERE kind = 'storage' ORDER BY sort, name`),
    suppliers: (await all('SELECT name FROM suppliers ORDER BY lower(name), name')).map(s => s.name),
    counted: await firstCountDone(),
  };
}

// Bulk "Put on rack": every ticked item goes to one storage area (logged).
export async function putOnRack(itemIds, areaId, by = '') {
  const ids = (itemIds || []).map(Number).filter(Boolean);
  if (!ids.length) throw httpError(400, 'Tick the parts to put on the rack');
  return writeTx(async () => {
    const a = areaId ? await get(`SELECT id, name FROM floor_areas WHERE id = ? AND kind = 'storage'`, Number(areaId)) : null;
    if (areaId && !a) throw httpError(404, 'That rack no longer exists — refresh');
    let n = 0;
    for (const id of ids) {
      const it = await get('SELECT id, area_id FROM items WHERE id = ?', id);
      if (!it || it.area_id === (a?.id ?? null)) continue;
      await run('UPDATE items SET area_id = ? WHERE id = ?', a?.id ?? null, id);
      await logAlloc('catalogue', { item_id: id, field: 'rack', before: it.area_id ? ((await get('SELECT name FROM floor_areas WHERE id = ?', it.area_id))?.name || '') : '', after: a?.name || '', worker: by });
      n++;
    }
    return { moved: n };
  });
}

// ───────────────────────── history: "Why?" (C11) ─────────────────────────

const LOG_COLS = `a.id, a.at, a.reason, a.van_id, a.item_id, a.line_id, a.field, a.before, a.after, a.worker, a.note, a.change, a.firm_change, a.ack`;

// One van line: what is set aside for it now, and every change with who / when / why, plus the stock
// movements for that van and part.
export async function lineHistory(lineId) {
  const l = await get(`SELECT l.*, v.chassis, i.sku, i.name, i.unit FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id WHERE l.id = ?`, lineId);
  if (!l) throw httpError(404, 'That part line no longer exists — refresh');
  const log = await all(`SELECT ${LOG_COLS}, v.chassis FROM allocation_log a LEFT JOIN vans v ON v.id = a.van_id WHERE a.line_id = ? ORDER BY a.id`, lineId);
  // Borrows *for* this line are logged on the donor's line; show them here too.
  const borrowedFor = await all(`SELECT ${LOG_COLS}, v.chassis FROM allocation_log a LEFT JOIN vans v ON v.id = a.van_id
                           WHERE a.reason = 'borrow' AND a.item_id = ? AND a.van_id <> ? AND a.note ILIKE ? ORDER BY a.id`, l.item_id, l.van_id, `% for ${l.chassis}%`);
  const moves = await all(`SELECT m.id, m.at, m.type, m.qty, m.ref, m.note, m.worker FROM movements m WHERE m.van_id = ? AND m.item_id = ? ORDER BY m.id`, l.van_id, l.item_id);
  return { line: l, log, borrowedFor, moves };
}

export async function itemHistory(itemId) {
  return all(`SELECT ${LOG_COLS}, v.chassis FROM allocation_log a LEFT JOIN vans v ON v.id = a.van_id
              WHERE a.item_id = ? ORDER BY a.id DESC LIMIT 200`, itemId);
}

// ───────────────────────── weekly "Stock checks" (C11) ─────────────────────────
//
// Everything that changed the books outside the normal flow, for the office to look at once a week:
// floor / office corrections, borrowings between vans, count differences, over deliveries and the
// "is the bought-for-van part here?" answers. Shown: everything not yet ticked, plus what was ticked
// in the last 7 days.
export async function stockChecks() {
  const recent = `(x.ack = 0 OR x.at >= to_char(${MELB} - interval '7 days', 'YYYY-MM-DD HH24:MI:SS'))`;
  const corrections = await all(`SELECT x.id, x.at, x.qty, x.note, x.ref, x.worker, x.ack, i.name, i.unit, v.chassis FROM movements x
                             JOIN items i ON i.id = x.item_id LEFT JOIN vans v ON v.id = x.van_id
                           WHERE x.type = 'adjust' AND ${recent} AND x.note NOT ILIKE 'Re-linked%' AND x.note NOT ILIKE 'Plan quantity corrected%'
                             AND x.note <> 'Demo stock level' ORDER BY x.id DESC`);
  const ranks = await vanRanks();
  const borrows = [];
  for (const b of await all(`SELECT x.id, x.at, x.worker, x.note, x.ack, x.before, x.after, x.line_id, x.van_id, x.item_id, v.chassis, i.name, i.unit,
                         l.qty, l.reserved, l.issued, l.urgent
                       FROM allocation_log x JOIN items i ON i.id = x.item_id LEFT JOIN vans v ON v.id = x.van_id LEFT JOIN van_lines l ON l.id = x.line_id
                       WHERE x.reason = 'borrow' AND ${recent} ORDER BY x.id DESC`)) {
    const to = /\bfor (\S+)/.exec(b.note || '')?.[1] || '';
    const onOrder = b.van_id ? (await get(`SELECT COALESCE(SUM(${PO_OPEN}),0) AS q FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                                    WHERE ${PO_IS_OPEN} AND pl.van_id = ? AND pl.item_id = ?`, b.van_id, b.item_id)).q : 0;
    const short = b.qty != null ? Math.max(0, b.qty - b.reserved - b.issued) : 0;
    const reordered = b.qty == null ? 'line gone' : short <= 1e-9 ? 'covered again' : onOrder >= short - 1e-9 ? `re-ordered (${q(onOrder)} on order)` : '';
    borrows.push({ ...b, to, qty_moved: Number(b.before) - Number(b.after), reordered, rank: ranks.get(b.van_id) ?? null });
  }
  const counts = await all(`SELECT x.id, x.at, x.qty, x.note, x.ref, x.worker, x.ack, i.name, i.unit, i.area_id FROM movements x JOIN items i ON i.id = x.item_id
                      WHERE x.type = 'count' AND abs(x.qty) > 1e-9 AND ${recent} ORDER BY x.id DESC`);
  const over = await all(`SELECT x.id, x.at, x.qty, x.note, x.ref, x.worker, x.ack, i.name, i.unit FROM movements x JOIN items i ON i.id = x.item_id
                    WHERE x.type = 'receive' AND x.note ILIKE '%more than ordered%' AND ${recent} ORDER BY x.id DESC`);
  const bought = await all(`SELECT x.id, x.at, x.reason, x.worker, x.note, x.ack, x.before, i.name, i.unit, v.chassis FROM allocation_log x
                        JOIN items i ON i.id = x.item_id LEFT JOIN vans v ON v.id = x.van_id
                      WHERE x.reason IN ('check: here','check: missing') AND ${recent} ORDER BY x.id DESC`);
  // Racks counted longest ago (never counted first): "Count these next".
  const areas = await all(`SELECT a.id, a.name, COUNT(i.id) AS items, SUM(CASE WHEN i.last_counted = '' THEN 1 ELSE 0 END) AS never,
                       MIN(NULLIF(i.last_counted, '')) AS oldest
                     FROM floor_areas a JOIN items i ON i.area_id = a.id AND ${COUNTABLE_ITEM}
                     GROUP BY a.id ORDER BY a.id`);
  const norack = await get(`SELECT COUNT(*) AS items, SUM(CASE WHEN i.last_counted = '' THEN 1 ELSE 0 END) AS never, MIN(NULLIF(i.last_counted, '')) AS oldest
                      FROM items i WHERE ${COUNTABLE_ITEM} AND i.area_id IS NULL`);
  const next = [...areas.map(a => ({ scope: `area:${a.id}`, name: a.name, items: a.items, never: a.never || 0, oldest: a.oldest || '' })),
    ...(norack.items ? [{ scope: 'norack', name: 'No rack yet', items: norack.items, never: norack.never || 0, oldest: norack.oldest || '' }] : [])]
    .sort((a, b) => (b.never > 0) - (a.never > 0) || (a.oldest || '').localeCompare(b.oldest || ''));
  return { corrections, borrows, counts, over, bought, next };
}

// How many rows on the Stock checks page nobody has ticked yet (nav badge).
export async function stockChecksCount() {
  return (await get(`SELECT
    (SELECT COUNT(*) FROM movements x WHERE x.ack = 0 AND ((x.type = 'adjust' AND x.note NOT ILIKE 'Re-linked%' AND x.note NOT ILIKE 'Plan quantity corrected%'
       AND x.note <> 'Demo stock level') OR (x.type = 'count' AND abs(x.qty) > 1e-9) OR (x.type = 'receive' AND x.note ILIKE '%more than ordered%')))
    + (SELECT COUNT(*) FROM allocation_log x WHERE x.ack = 0 AND x.reason IN ('borrow', 'check: here', 'check: missing')) AS n`)).n;
}

// Tick (or untick) one row of the Stock checks page. kind 'm' = a stock movement, 'a' = a log entry.
export async function ackCheck(kind, id, ack = true) {
  const table = kind === 'm' ? 'movements' : kind === 'a' ? 'allocation_log' : null;
  if (!table) throw httpError(400, 'Unknown row');
  // (Postgres refuses a non-number id outright; SQLite just found no row)
  if (!Number.isSafeInteger(Number(id))) throw httpError(404, 'That row no longer exists — refresh');
  return writeTx(async () => {
    if (!(await run(`UPDATE ${table} SET ack = ? WHERE id = ?`, ack ? 1 : 0, Number(id))).changes) throw httpError(404, 'That row no longer exists — refresh');
    return { ok: true };
  });
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
