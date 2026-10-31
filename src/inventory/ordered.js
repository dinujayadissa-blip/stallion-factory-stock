// "Check: already ordered?" — production-plan order numbers nobody has confirmed, and the answers.
import { ID_LIST, all, get, ids, insert, logAllocMany, run, syncSuppliers, writeTx } from '../db.js';
import { OPEN_PO_BY_VAN, UNANSWERED, addDays, specForPo, today, validDate } from '../lineState.js';
import { ACTIVE_VAN, dm, httpError, isPlaceholder, nearVanSql, purchasingSettings, q, vanRanks } from './shared.js';
import { neededByFor } from './shortages.js';
import { reEsc, supplierMatcher } from './special.js';
import { YES_ALL_MARK } from './pos.js';

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
  // The open POs with each group's number, for every group in one query (one look-up per group was two round
  // trips each — about 270 on the real data, the most of any screen). The matching stays in SQL, the same
  // lower(trim()) comparisons as before, so no PO can match differently. Rows come by group, then by PO id.
  const list = [...groups.values()];
  const posOf = new Map(list.map((g, i) => [i + 1, []]));
  if (list.length) {
    for (const p of await all(`SELECT g.n, p.id, p.po_no, p.supplier, p.ordered_at, p.expected,
          (g.x->>'sup' <> '' AND lower(trim(p.supplier)) = lower(g.x->>'sup')) AS same_supplier
        FROM json_array_elements(?::text::json) WITH ORDINALITY AS g(x, n)
          JOIN purchase_orders p ON p.status = 'open' AND lower(trim(p.po_no)) = lower(g.x->>'ref')
        ORDER BY g.n, p.id`, JSON.stringify(list.map(g => ({ ref: g.po_ref, sup: g.supplier }))))) posOf.get(p.n).push(p);
  }
  for (const [gi, g] of list.entries()) {
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
    // Which PO a "Yes" adds to: the first open one with this number for this supplier (none without a supplier).
    const pos = posOf.get(gi + 1);
    const po = g.supplier ? pos.find(p => p.same_supplier) : null;
    g.target = po ? { po_id: po.id, po_no: po.po_no, supplier: po.supplier, exists: 1, ordered_at: po.ordered_at || '', expected: po.expected || '' } : { po_id: null, po_no: g.po_ref, supplier: g.supplier, exists: 0 };
    // Other open POs with this number (another supplier, or none): shown so nobody is surprised.
    g.open_pos = pos.map(p => ({ id: p.id, po_no: p.po_no, supplier: p.supplier }));
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
      await run(`UPDATE van_lines SET state = 'not_ordered' WHERE id IN ${ID_LIST}`, ids(lines.map(l => l.id)));
      await logAllocMany(lines.map(l => ['check ordered', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'state', before: '', after: 'not_ordered',
        worker: by, note: `Plan said order ${ref}: still to order` }]));
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
    // (one PO per supplier first, then every PO line and log line in one statement each)
    const add = [], log = [];
    for (const l of lines) {
      const s = l.og.supplier || sup;
      const short = Math.max(0, l.qty - l.reserved - l.issued);
      add.push({ po_id: await poFor(s), item_id: l.item_id, qty: short, van_id: l.van_id, spec: specForPo(l.spec, l.po_ref) });
      log.push(['check ordered', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'po_lines', before: '', after: `PO ${ref} (${s || 'no supplier'}) +${q(short)}`, worker: by, note: `Plan said order ${ref}: on order` }]);
    }
    await run(`INSERT INTO po_lines(po_id, item_id, qty, van_id, spec)
               SELECT (x->>'po_id')::integer, (x->>'item_id')::integer, (x->>'qty')::double precision, (x->>'van_id')::integer, x->>'spec'
               FROM json_array_elements(?::text::json) WITH ORDINALITY AS g(x, n) ORDER BY n`, JSON.stringify(add));
    await logAllocMany(log);
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
