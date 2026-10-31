// Vans and their parts lists: a dealer order becomes a van and its lines (rules), what each van is still
// missing, editing / finishing / deleting a van and its lines, fitting and returning parts.
import { ID_LIST, all, get, ids, insert, logAlloc, logAllocMany, run, writeTx } from '../db.js';
import { ALLOCATABLE, COUNTS_SHORT_CORR, PO_IS_OPEN, PO_OPEN, REMINDER_STATES, SPECIAL_ITEM, STATE_LABEL, STILL_MISSING, UNANSWERED_CORR, customerSays, detectState, dotsCheck, today } from '../lineState.js';
import { capFor, leadInfo } from '../planMap.js';
import { buildPartsList } from '../rules.js';
import { ACTIVE_VAN, MAX_QTY, PRIORITY, activeRules, buildOrderInfo, checkQty, httpError, ignoreList, isPlaceholder, lineStatus, listItems, nearVanSql, q } from './shared.js';
import { allocateItem } from './allocation.js';
import { lineCover, vanNeededBy } from './shortages.js';

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
    // every field of the order form in one statement, in form order (sort = 0, 1, 2…)
    if (fields.length) await run(`INSERT INTO order_fields(van_id, section, label, value, note, sort)
        SELECT ?, x->>'section', x->>'label', x->>'value', x->>'note', (n - 1)::integer FROM json_array_elements(?::text::json) WITH ORDINALITY AS g(x, n)
        ORDER BY n`, vanId, JSON.stringify(fields.map(f => ({ section: f.section || '', label: f.label, value: f.value || '', note: f.note || '' }))));
    const idSet = a => new Set((Array.isArray(a) ? a : []).map(Number).filter(Boolean));
    await applyRules(vanId, { customer: idSet(customer_items), normal: idSet(normal_items), by });
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

// Every active van with its order form fields (in form order), vans in listVans order — for trying a rule
// against the vans being built. Two statements, whatever the number of vans.
export async function activeVanFields() {
  const vans = await all(`SELECT v.id, v.chassis FROM vans v WHERE ${ACTIVE_VAN}
                          ORDER BY CASE v.status WHEN 'in_production' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, ${PRIORITY}`);
  const fieldsOf = new Map(vans.map(v => [v.id, []]));
  for (const f of await all(`SELECT * FROM order_fields WHERE van_id IN ${ID_LIST} ORDER BY van_id, sort`, ids(fieldsOf.keys()))) fieldsOf.get(f.van_id).push(f);
  return vans.map(v => ({ ...v, fields: fieldsOf.get(v.id) }));
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

// `by`: the login that made the change (written on the status history row).
export async function updateVan(id, patch, { by = '' } = {}) {
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
      await logAlloc('van status', { van_id: id, field: 'van status', before: word(before.status), after: word(patch.status), worker: by, note: 'status set by the office' });
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
  const held = await all('SELECT * FROM van_lines WHERE van_id = ? AND reserved > 0 ORDER BY id', id);
  await logAllocMany(held.map(l => ['van finished', { van_id: id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0,
    firm_change: -l.reserved_firm, note: 'van cancelled – set-aside back to the shelf' }]));
  await run('UPDATE van_lines SET reserved = 0, reserved_firm = 0 WHERE van_id = ?', id);
  await run('UPDATE vans SET area_id = NULL WHERE id = ?', id); // a finished van frees its bay
  for (const itemId of new Set(held.map(l => l.item_id))) await allocateItem(itemId);
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
  const held = await all('SELECT * FROM van_lines WHERE van_id = ? AND reserved > 0 ORDER BY id', vanId);
  const isShort = l => l.qty > l.reserved + l.issued;
  const short = held.filter(isShort), used = held.filter(l => !isShort(l));
  // Every line at once (the same changes as line by line): short lines give their set-aside back, the rest
  // are booked out of the shelf figure with one 'issue' movement each.
  if (short.length) await run(`UPDATE van_lines SET reserved = 0, reserved_firm = 0 WHERE id IN ${ID_LIST}`, ids(short.map(l => l.id)));
  if (used.length) {
    const list = ids(used.map(l => l.id));
    await run(`UPDATE items i SET on_hand = i.on_hand - u.q
               FROM (SELECT item_id, SUM(reserved) AS q FROM van_lines WHERE id IN ${ID_LIST} GROUP BY item_id) u WHERE i.id = u.item_id`, list);
    await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note)
               SELECT item_id, -reserved, 'issue', van_id, ?, 'Used — van finished' FROM van_lines WHERE id IN ${ID_LIST} ORDER BY id`, van.chassis, list);
    await run(`UPDATE van_lines SET issued = issued + reserved, reserved = 0, reserved_firm = 0 WHERE id IN ${ID_LIST}`, list);
  }
  await logAllocMany(held.map(l => ['van finished', { van_id: vanId, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0,
    firm_change: -l.reserved_firm, note: isShort(l) ? `${van.chassis} finished while still short – set-aside back to the shelf`
      : `${van.chassis} finished – set-aside counted as used` }]));
  for (const itemId of new Set(short.map(l => l.item_id))) await allocateItem(itemId);
}

export async function deleteVan(id) {
  await writeTx(async () => {
    const items = await all('SELECT DISTINCT item_id FROM van_lines WHERE van_id = ?', id);
    await run('DELETE FROM vans WHERE id = ?', id);
    for (const { item_id } of items) await allocateItem(item_id);
  });
}

export async function addLine(vanId, { item_id, qty, spec = '', note = '' }) {
  checkQty(qty);
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
    // 0 is fine here (nothing needed any more), but never Infinity / NaN / an absurd amount.
    if (!(Number.isFinite(newQty) && newQty >= 0 && newQty <= MAX_QTY)) throw httpError(400, `Type a quantity from 0 to ${MAX_QTY}`);
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

export async function issueLines(vanId, lineIds = null) {
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
