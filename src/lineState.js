// One plain status per part line (C5) and the shared bits purchasing needs (C6–C8).
//
// van_lines.state:
//   ''            normal
//   'customer'    the customer supplies it — a reminder, not stock and not an order
//   'tbd'         to be decided ("TBA", "????", "do we supply…") — a reminder too
//   'not_ordered' the office answered "No, still to order" for the plan's order number: a normal shortage
//
// "Check: already ordered?" is never stored: a line is unanswered when the plan gave it an order number
// (po_ref), nobody has answered for it (state ''), it is short, and no open PO line exists for that van
// and part. Such lines, 'customer' and 'tbd' lines are the ONLY ones left out of the short / to-order /
// waiting-on-parts counts.

export const STATES = ['', 'customer', 'tbd', 'not_ordered'];
export const STATE_LABEL = { '': 'Normal', customer: 'Customer supplies', tbd: 'To be decided', not_ordered: 'Not ordered' };
export const REMINDER_STATES = ['customer', 'tbd'];

const CUSTOMER_RE = /customer\s*s(u|y)p+ly|supplied by customer|cust supply/i;
const TBD_RE = /\bTBA\b|\?\?|do we supply/i;
// "...." on the plan means "not decided yet" ONLY when the cell has nothing else in it (round 2,
// check-r1-5). "2 ......." (a count) or "Straight / Driver side / ....../1380.5" (a description) are
// real parts: the line stays normal and the van page asks to check the text (dotsCheck).
const DOTS_RE = /\.{4,}/;
const onlyDots = s => DOTS_RE.test(s) && !s.replace(/[.\s\-_/\\,;:|]+/g, '');

// What the plan / order text says about who supplies it: 'customer', 'tbd' or ''.
export function detectState(text) {
  const s = String(text || '');
  if (CUSTOMER_RE.test(s)) return 'customer';
  if (TBD_RE.test(s) || onlyDots(s)) return 'tbd';
  return '';
}
// Small fixes & phone round 1 (user-r4-9): dealer-order wording that the customer brings the part —
// "customer sending black Jack maxi", "wpc supplied by customer", "customer supply", "customer to supply",
// "customer will send". Only SUGGESTED on the New dealer order screen (the office accepts it with one click);
// "customer will pay extra", "as per customers request", "customers bbq" do not match.
const CUSTOMER_SUGGEST_RE = /\bcustomers?'?s?\s+(?:is\s+|are\s+|will\s+|to\s+|has\s+|have\s+)?(?:send(?:s|ing)?|sent|suppl(?:y|ies|ying|ied)|suply(?:ing)?|provid(?:e|es|ing|ed)|bring(?:s|ing)?)\b|\b(?:supplied|provided|sent|brought)\s+by\s+(?:the\s+)?customers?\b|\bcust\.?\s+suppl/i;
// 'auto' = the text says it plainly (detectState → 'customer': the line is made "Customer supplies" as before);
// 'suggest' = only the wider wording matches; '' = nothing.
export function customerSays(text) {
  const s = String(text || '');
  if (CUSTOMER_RE.test(s)) return 'auto';
  return CUSTOMER_SUGGEST_RE.test(s) ? 'suggest' : '';
}
// "...." next to a count or description: not "to be decided", but worth a look ('' = nothing to say).
export function dotsCheck(text) {
  const s = String(text || '');
  return DOTS_RE.test(s) && !onlyDots(s) && !TBD_RE.test(s) && !CUSTOMER_RE.test(s) ? 'the plan text has "...." in it – check what is needed' : '';
}

// Open quantity of a PO line: ordered - received - balance the supplier cancelled.
export const PO_OPEN = '(pl.qty - pl.received - pl.closed)';
export const PO_IS_OPEN = `p.status = 'open' AND ${PO_OPEN} > 1e-9`;

// Per item and van (van_id NULL = shelf stock), how much is still on order. Use as a sub-query.
export const OPEN_PO_BY_VAN = `SELECT pl.item_id, pl.van_id, SUM(${PO_OPEN}) AS q
  FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id WHERE ${PO_IS_OPEN} GROUP BY pl.item_id, pl.van_id`;

// SQL: line `l` is short, has a plan order number nobody answered for, and nothing on order for its van.
// `op` = a LEFT JOIN of OPEN_PO_BY_VAN on (item_id, van_id) — NULL when nothing is on order for the van.
// A line whose part was borrowed on the floor (urgent = 1) is never "unanswered": the plan's order
// number was used up when its part arrived, so it is a real shortage to order now (round 2, check-r1-2).
export const UNANSWERED = (l = 'l', op = 'op') =>
  `(trim(${l}.po_ref) <> '' AND ${l}.state = '' AND ${l}.urgent = 0 AND ${l}.qty > ${l}.reserved + ${l}.issued + 1e-9 AND ${op}.q IS NULL)`;
// Same, when no `op` join is at hand (correlated; fine for one van).
export const UNANSWERED_CORR = (l = 'l') =>
  `(trim(${l}.po_ref) <> '' AND ${l}.state = '' AND ${l}.urgent = 0 AND ${l}.qty > ${l}.reserved + ${l}.issued + 1e-9 AND NOT EXISTS (
     SELECT 1 FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
     WHERE pl.van_id = ${l}.van_id AND pl.item_id = ${l}.item_id AND ${PO_IS_OPEN}))`;
// Counts as a real shortage (short / to-order / waiting on parts).
export const COUNTS_SHORT = (l = 'l', op = 'op') => `(${l}.state NOT IN ('customer','tbd') AND NOT ${UNANSWERED(l, op)})`;
export const COUNTS_SHORT_CORR = (l = 'l') => `(${l}.state NOT IN ('customer','tbd') AND NOT ${UNANSWERED_CORR(l)})`;
// "Still missing" (Small fixes & phone round 1, phone batch 1): ONE rule for every screen that says how many
// parts a van is missing — the Dashboard, the Vans list, the van page, the factory map badge and the worker
// screen's van cards. A line is still missing when needed − set aside − issued > 0; customer supplies / to be
// decided lines are reminders, not parts, and never count. inventory.js stillMissingByVan() splits it into
// special parts / to check / to order or on order.
export const STILL_MISSING = (l = 'l') => `(${l}.state NOT IN ('customer','tbd') AND ${l}.qty > ${l}.reserved + ${l}.issued + 1e-9)`;
// "As per plan" catch-alls (special parts to confirm).
export const SPECIAL_ITEM = (i = 'i') => `(${i}.placeholder = 1 OR ${i}.sku ILIKE 'PLAN-%')`; // (ILIKE: SQLite's LIKE ignored case)
// Lines stock may be set aside for (allocation never reserves for a reminder line).
export const ALLOCATABLE = (l = 'l') => `${l}.state NOT IN ('customer','tbd')`;

// ── dates (YYYY-MM-DD) ──
const p2 = n => String(n).padStart(2, '0');
export const isoDate = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
// Today in Melbourne (the factory), whatever time zone the server runs in — the cloud runs in UTC, where
// 9 am in Melbourne is still "yesterday".
const MELBOURNE_DAY = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' });
export const today = () => {
  const p = Object.fromEntries(MELBOURNE_DAY.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
export function addDays(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  return isoDate(new Date(+m[1], +m[2] - 1, +m[3] + days));
}
export const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '';

// The plan text without its order number, for the purchase order ("eurolux wild oak 7.2 m 39" with
// order 39 → "eurolux wild oak 7.2 m"; "Black / Razor Order 42" → "Black / Razor"). The van line keeps the full text.
export function specForPo(spec, poRef = '') {
  let s = String(spec || '').replace(/\s+/g, ' ').trim();
  // "Urban republic Order 29/06/2026" (follow-up round 1, owner-r3-7): an order DATE goes as a whole — before, only
  // "Order 29" was taken out as if it were an order number, leaving "Urban republic /06/2026" on the PO.
  s = s.replace(/[\s,/-]*\border(?:ed)?\s*(?:on\s+)?(\d{1,2})[/.-](\d{1,2})(?:[/.-](?:\d{4}|\d{2}))?\b/gi,
    (all, d, m) => (+d >= 1 && +d <= 31 && +m >= 1 && +m <= 12 ? ' ' : all));
  s = s.replace(/[\s,/-]*\border(?:ed)?\s*(?:no\.?\s*)?#?\s*\/?\s*\d{1,4}\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const ref = String(poRef || '').trim().replace(/^0+/, '');
  if (/^\d+$/.test(ref)) s = s.replace(new RegExp(`[\\s,/-]+0*${ref}\\s*$`), '');
  s = s.trim().replace(/[\s,/-]+$/, '');
  return /^(yes|y|ok)$/i.test(s) ? '' : s; // "Yes" on the plan isn't a description
}
