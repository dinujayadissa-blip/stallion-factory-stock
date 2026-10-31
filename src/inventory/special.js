// Customer supplies / to be decided, the "as per plan" special parts still to confirm, and reading a
// supplier name out of free text.
import { all, get, logAlloc, run, writeTx } from '../db.js';
import { COUNTS_SHORT_CORR, PO_IS_OPEN, PO_OPEN, REMINDER_STATES, STATES, STATE_LABEL, UNANSWERED_CORR, addDays, today } from '../lineState.js';
import { dealerNames, learnedLinks, linkableItems, notAPart, partsForMany, sameTextKey, suggestionsFor, textParts, vanParts } from '../relink.js';
import { ACTIVE_VAN, PRIORITY, httpError, isPlaceholder, q } from './shared.js';
import { allocateItem } from './allocation.js';
import { shortages } from './shortages.js';

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
  const parts = await partsForMany(mine.filter(r => !r.not_part), { items: cache.items, onVanOf: v => onVan.get(v) || null });
  const supOf = await supplierMatcher(); // (supplierFromText for each line, reading the supplier list once)
  const vans = new Map();
  for (const r of mine) {
    if (!vans.has(r.van_id)) vans.set(r.van_id, { van_id: r.van_id, chassis: r.chassis, eta: r.eta, status: r.status, lines: [] });
    const sg = sugg.get(r.id) || {};
    vans.get(r.van_id).lines.push({ ...r, duplicate: LINK_FLAG_RE.test(r.note),
      suggest: sg.suggest || null, already: sg.already || null, clash: sg.clash || null, different: sg.different || null,
      same: (byKey.get(sameTextKey(r.sku, r.spec)) || []).filter(x => x.id !== r.id),
      supplier_guess: supOf(`${r.plan_column} ${r.name} ${r.spec}`),
      parts: parts.get(r.id) ?? null });
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

// Supplier names that show up in the plan / order text (reviewed list), plus every supplier already in
// the system whose name is a distinctive word. Suggestions only — nothing is saved without a click.
export const SUPPLIER_WORDS = [['E time', /\be[\s-]?time\b/i], ['Battery Stop', /\bbattery\s*stop\b/i], ['Capral', /\bcapral\b/i],
  ['Nikpol', /\bnikpol\b/i], ['Urban Republic', /\burban\s*republic\b/i]];
// Supplier names that are also ordinary words in part names / plan text (a "gold" tap isn't from Gold).
export const NOT_A_BRAND = /^(gold|black|white|grey|silver|chrome|custom|plan|order)$/i;
export const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
