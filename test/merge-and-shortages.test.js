// Round 4 checks (check-r3-1 … check-r3-4). Runs on a new, empty in-memory database (PGlite) — never on
// the real data.   node --test test/
// The tests share ONE database and build on each other, top to bottom.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { run, get, all, insert, writeTx, dataVersion, closeDb } from '../src/db.js';
import * as inv from '../src/inventory.js';
import { linkLine, linkPreview, suggestionsFor, linkableItems, learnedLinks } from '../src/relink.js';
import { customerSays } from '../src/lineState.js';

before(freshDb);
after(closeDb);

// ── tiny fixtures ──
let n = 0;
function item(f) {
  const sku = f.sku || `T-${++n}`;
  return insert(`INSERT INTO items(sku, name, category, supplier, kind, plan_column, placeholder) VALUES(?,?,?,?,?,?,?)`,
    sku, f.name, f.category || 'General', f.supplier || '', f.kind || 'stock', f.plan_column || '', f.placeholder ? 1 : 0);
}
function van(chassis, status = 'planned', eta = '') {
  return insert(`INSERT INTO vans(chassis, status, eta) VALUES(?,?,?)`, chassis, status, eta);
}
function line(vanId, itemId, f) {
  return insert(`INSERT INTO van_lines(van_id, item_id, qty, reserved, reserved_firm, issued, spec, source, plan_column)
                 VALUES(?,?,?,?,?,?,?, 'plan', ?)`, vanId, itemId, f.qty, f.reserved || 0, f.firm || 0, f.issued || 0, f.spec || '', f.col || '');
}
// Stock in through a movement, so on hand = sum of movements from the start.
async function receive(itemId, qty, vanId = null) {
  await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', qty, itemId);
  await run(`INSERT INTO movements(item_id, qty, type, van_id, ref) VALUES(?, ?, 'receive', ?, 'test')`, itemId, qty, vanId);
}
const onHand = async id => (await get('SELECT on_hand FROM items WHERE id = ?', id)).on_hand;
const moved = async id => (await get('SELECT COALESCE(SUM(qty),0) AS s FROM movements WHERE item_id = ?', id)).s;
const shortRows = async itemId => (await inv.shortages()).rows.filter(r => r.item_id === itemId)
  .map(r => ({ line: r.line_id, short: r.short, covered: r.covered, suggest: r.suggest })).sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
const cellOf = async (vanId, col) => (await inv.planGrid()).vans.find(v => v.id === vanId)?.cells[col]?.s ?? null;

// ── check-r3-1: two received lines are not "the same thing", and a forced merge loses nothing ──
test('two lines that both had a delivery: not offered as same thing, forced merge keeps every number', async () => {
  const kit = await item({ name: 'Sliding door rail + pelmet', supplier: 'Nikpol', kind: 'stock', plan_column: 'Sliding Door Railing' });
  const ph = await item({ sku: 'PLAN-SLIDING-DOOR-PELMET', name: 'Sliding Door Pelmet (as per plan)', kind: 'per-van', plan_column: 'Sliding Door Pelmet', placeholder: 1 });
  const a = await van('TST-A', 'in_production', '2026-09-01');
  const b = await van('TST-B', 'planned', '2099-01-01');
  await receive(kit, 1, a); await receive(ph, 1, a); await receive(kit, 1);
  const kitLine = await line(a, kit, { qty: 1, reserved: 1, firm: 1, col: 'Sliding Door Railing', spec: 'Nikpol' });
  const planLine = await line(a, ph, { qty: 1, reserved: 1, firm: 1, col: 'Sliding Door Pelmet', spec: 'Nikpol sliding door pelmet' });
  await line(b, kit, { qty: 2, reserved: 1, col: 'Sliding Door Railing' }); // short 1 → on the order list

  // the screens: no "same thing?", but "two deliveries were received …"
  const pl = await get(`SELECT l.*, i.sku, i.name FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?`, planLine);
  const s = (await suggestionsFor([pl], { items: await linkableItems(), learned: await learnedLinks() })).get(planLine);
  assert.equal(s.already, null);
  assert.equal(s.suggest, null);
  assert.equal(s.different?.line_id, kitLine);

  // the warning before merging
  const [pv] = await linkPreview([planLine], kit);
  assert.equal(pv.result, 'duplicate');
  assert.equal(pv.different, 1);
  assert.equal(pv.moved, 0);
  assert.equal(pv.kept, 1);
  assert.equal(pv.qty_after, 1);

  // without "Merge all" nothing is merged
  assert.equal((await linkLine(planLine, kit)).result, 'duplicate');
  assert.match((await get('SELECT note FROM van_lines WHERE id = ?', planLine)).note, /two deliveries were received/);

  const before = { kit: await onHand(kit), ph: await onHand(ph), free: (await inv.getItem(kit)).available, phFree: (await inv.getItem(ph)).available, short: await shortRows(kit),
    cell: await cellOf(a, 'Sliding Door Pelmet'), cellKit: await cellOf(a, 'Sliding Door Railing') };
  const kitBefore = await get('SELECT note, merged_cols, qty, reserved FROM van_lines WHERE id = ?', kitLine);
  const r = await linkLine(planLine, kit, { force: true });
  // Small fixes & phone round 1 (check-r4-1): nothing can move, so it is not a merge at all
  assert.equal(r.result, 'kept');
  assert.equal(r.kept, 1);
  assert.match(r.message, /Nothing moved – both lines already have a part for this van; the plan line stays to check/);
  // the van's own line is untouched: no "merged from" note, no copied warning, no merged column, no "merged" row
  assert.deepEqual(await get('SELECT note, merged_cols, qty, reserved FROM van_lines WHERE id = ?', kitLine), kitBefore);
  assert.equal((await get(`SELECT COUNT(*) AS c FROM allocation_log WHERE field = 'merged' AND line_id = ?`, kitLine)).c, 0);
  // on hand, free and shortages unchanged
  assert.equal(await onHand(kit), before.kit);
  assert.equal(await onHand(ph), before.ph);
  assert.equal((await inv.getItem(kit)).available, before.free);
  assert.equal((await inv.getItem(ph)).available, before.phFree);
  assert.deepEqual(await shortRows(kit), before.short);
  // the received part stays on the plan line, locked, marked to check
  const kept = await get('SELECT * FROM van_lines WHERE id = ?', planLine);
  assert.equal(kept.qty, 1); assert.equal(kept.reserved, 1); assert.equal(kept.reserved_firm, 1);
  assert.match(kept.note, /to check: merge with this van's "Sliding door rail \+ pelmet" line .* asked, but nothing moved/);
  // numbers still explained by movements; plan colours unchanged
  assert.equal(await onHand(kit), await moved(kit));
  assert.equal(await onHand(ph), await moved(ph));
  assert.equal(await cellOf(a, 'Sliding Door Pelmet'), before.cell);
  assert.equal(await cellOf(a, 'Sliding Door Railing'), before.cellKit);
  // re-running allocation does not hand the kept stock out
  await inv.allocateItem(kit); await inv.allocateItem(ph);
  assert.deepEqual(await shortRows(kit), before.short);
  assert.equal((await get('SELECT reserved FROM van_lines WHERE id = ?', planLine)).reserved, 1);
});

test('"same thing?" is not offered on a supplier name alone', async () => {
  const kit = await item({ name: 'Sliding door kit', supplier: 'Nikpolx', kind: 'stock', plan_column: 'Door Railing X' });
  const ph = await item({ sku: 'PLAN-PELMET-X', name: 'Pelmet X (as per plan)', kind: 'per-van', plan_column: 'Door Pelmet X', placeholder: 1 });
  const v = await van('TST-C', 'planned', '2099-02-01');
  await line(v, kit, { qty: 1, col: 'Door Railing X' });
  const planLine = await line(v, ph, { qty: 1, col: 'Door Pelmet X', spec: 'Nikpolx 13' });
  const pl = await get(`SELECT l.*, i.sku, i.name FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?`, planLine);
  const s = (await suggestionsFor([pl], { items: await linkableItems(), learned: await learnedLinks() })).get(planLine);
  assert.equal(s.already, null);
  assert.equal(s.suggest, null);
});

// ── check-r3-2 / check-r3-3: Merge all keeps the larger need; the plan cell keeps its colour ──
test('merge all keeps the larger need and the merged plan cell keeps its colour', async () => {
  const kit = await item({ name: 'Grab handle', kind: 'stock', plan_column: 'Handles' });
  const ph = await item({ sku: 'PLAN-GRAB', name: 'Grab (as per plan)', kind: 'per-van', plan_column: 'Grab', placeholder: 1 });
  const v = await van('TST-D', 'planned', '2099-03-01');
  await receive(kit, 1);
  const kitLine = await line(v, kit, { qty: 1, reserved: 1, col: 'Handles' });
  const planLine = await line(v, ph, { qty: 3, col: 'Grab', spec: 'grab handle x3' });
  const cellBefore = await cellOf(v, 'Grab');
  const [pv] = await linkPreview([planLine], kit);
  assert.equal(pv.result, 'duplicate'); // different amount
  assert.equal(pv.into.qty, 1);
  assert.equal(pv.qty_after, 3);       // "need 1 → need 3"
  const r = await linkLine(planLine, kit, { force: true });
  assert.equal(r.result, 'merged');
  const l = await get('SELECT * FROM van_lines WHERE id = ?', kitLine);
  assert.equal(l.qty, 3);
  assert.equal((await get('SELECT COUNT(*) AS c FROM van_lines WHERE id = ?', planLine)).c, 0);
  const log = await get(`SELECT * FROM allocation_log WHERE field = 'merged' AND line_id = ? ORDER BY id DESC`, kitLine);
  assert.match(log.before, /need 3/);
  assert.match(log.after, /need 1 → 3/);
  assert.deepEqual(JSON.parse(l.merged_cols), ['Grab']);
  assert.equal(await cellOf(v, 'Grab'), cellBefore); // white before (nothing set aside for 3), white after (1 of 3)
  assert.equal(await cellOf(v, 'Grab'), 'none');
  // and it follows the van's line: grey once everything is set aside
  await receive(kit, 2); await inv.allocateItem(kit);
  assert.equal(await cellOf(v, 'Grab'), 'received');
});

// ── check-r3-4: a van PO that its van no longer needs counts for the next van ──
test('spare stock on a van with its own part on order: the order list is not one too many', async () => {
  const hood = await item({ name: 'Rangehood test', kind: 'stock', supplier: 'Swift' });
  const p1 = await van('TST-P1', 'in_production', '');          // got spare shelf stock, its own PO still open (back-ordered)
  const p2 = await van('TST-P2', 'planned', '2099-04-01');
  const p3 = await van('TST-P3', 'planned', '2099-05-01');
  await receive(hood, 1);
  await line(p1, hood, { qty: 1, reserved: 1 });
  const l2 = await line(p2, hood, { qty: 1 });
  const l3 = await line(p3, hood, { qty: 1 });
  const po = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('100', 'Swift')`);
  await run('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,1,?)', po, hood, p1);
  const rows = await shortRows(hood);
  const toOrder = rows.filter(r => r.suggest > 1e-9);
  assert.equal(toOrder.length, 1, JSON.stringify(rows)); // was 2: P1's PO was never counted for anyone
  assert.equal(toOrder[0].line, l3);
  assert.equal(rows.find(r => r.line === l2), undefined); // covered by P1's PO when it arrives
});

// ── Small fixes & phone round 1, batch 3 ──

test('check-r4-1: a real merge never copies the plan line\'s warning onto the line it was about', async () => {
  const kit = await item({ name: 'Towel rail test', kind: 'stock', plan_column: 'Towel' });
  const ph = await item({ sku: 'PLAN-TOWEL', name: 'Towel (as per plan)', kind: 'per-van', plan_column: 'Towel rail', placeholder: 1 });
  const v = await van('TST-M', 'planned', '2099-06-01');
  const kitLine = await line(v, kit, { qty: 1, col: 'Towel', spec: 'chrome' });
  const planLine = await line(v, ph, { qty: 2, col: 'Towel rail', spec: 'black 600' });
  assert.equal((await linkLine(planLine, kit)).result, 'duplicate');
  assert.match((await get('SELECT note FROM van_lines WHERE id = ?', planLine)).note, /possible duplicate of this van's "Towel rail test" line/);
  const r = await linkLine(planLine, kit, { force: true });
  assert.equal(r.result, 'merged');
  const note = (await get('SELECT note FROM van_lines WHERE id = ?', kitLine)).note;
  assert.match(note, /merged from the plan line Towel rail \("black 600"\)/);
  assert.doesNotMatch(note, /possible duplicate|probably not the same part/);
});

test('check-r4-2: "Yes, all on order" writes one ordered / expected date; no expected date → POs to check', async () => {
  const part = await item({ name: 'Yes-all part', supplier: 'YesAllCo', kind: 'per-van' });
  const v = await van('TST-Y', 'in_production', '');
  const mk = ref => insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, po_ref) VALUES(?,?,1,?, 'plan', ?)`, v, part, `YesAllCo ${ref}`, ref);
  await mk('501'); await mk('502');
  const groups = (await inv.checkOrdered()).filter(g => g.supplier === 'YesAllCo');
  assert.equal(groups.length, 2);
  const r = await inv.answerOrderedMany(groups.map(g => ({ key: g.key, po_ref: g.po_ref, line_ids: g.lines.map(l => l.id) })),
    { supplier: 'YesAllCo', ordered_at: '2026-10-12', expected: '' });
  const pos = [];
  for (const p of r.po_list) pos.push(await get('SELECT * FROM purchase_orders WHERE id = ?', p.id));
  assert.equal(pos.length, 2);
  for (const p of pos) { assert.equal(p.ordered_at, '2026-10-12'); assert.equal(p.expected, ''); assert.equal(p.needs_check, 1); }
  const tc = (await inv.posToCheck()).filter(p => pos.some(x => x.id === p.id));
  assert.equal(tc.length, 2);
  assert.ok(tc.every(p => p.problems.includes('no delivery date')));
  // typing the date clears it
  await inv.updatePO(pos[0].id, { expected: '2026-11-01' });
  assert.equal((await get('SELECT needs_check FROM purchase_orders WHERE id = ?', pos[0].id)).needs_check, 0);
  // with an expected date nothing is flagged
  const part2 = await item({ name: 'Yes-all part 2', supplier: 'YesAllTwo', kind: 'per-van' });
  await run(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, po_ref) VALUES(?,?,1,'YesAllTwo 600', 'plan', '600')`, v, part2);
  const g2 = (await inv.checkOrdered()).filter(g => g.supplier === 'YesAllTwo');
  await assert.rejects(() => inv.answerOrderedMany(g2.map(g => ({ key: g.key, po_ref: g.po_ref })), { supplier: 'YesAllTwo', expected: '2/11' }), /Pick a date/);
  const r2 = await inv.answerOrderedMany(g2.map(g => ({ key: g.key, po_ref: g.po_ref, line_ids: g.lines.map(l => l.id) })),
    { supplier: 'YesAllTwo', ordered_at: '2026-10-19', expected: '2026-11-02' });
  const p2 = await get('SELECT * FROM purchase_orders WHERE id = ?', r2.po_list[0].id);
  assert.equal(p2.expected, '2026-11-02'); assert.equal(p2.needs_check, 0);
});

test('check-r4-2: one van with the same part on two order numbers does not stop "Yes, all on order"', async () => {
  const door = await item({ name: 'Service door test', supplier: 'DoorCo', kind: 'per-van' });
  const v = await van('TST-D2', 'in_production', '');
  await run(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, po_ref) VALUES(?,?,1,'DoorCo 137', 'plan', '137')`, v, door);
  await run(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, po_ref) VALUES(?,?,1,'DoorCo 143', 'plan', '143')`, v, door);
  const gs = (await inv.checkOrdered()).filter(g => g.supplier === 'DoorCo');
  assert.equal(gs.length, 2);
  const r = await inv.answerOrderedMany(gs.map(g => ({ key: g.key, po_ref: g.po_ref, line_ids: g.lines.map(l => l.id) })), { supplier: 'DoorCo', expected: '2026-12-01' });
  assert.equal(r.lines, 2);
  assert.equal(r.po_list.length, 2);
});

test('check-r4-3: a line covered by another van\'s spare PO says which PO and van', async () => {
  const brace = await item({ name: 'Brace test', kind: 'stock', supplier: 'C&C' });
  const a = await van('TST-S1', 'in_production', '');
  const b = await van('TST-S2', 'planned', '2099-07-01');
  await receive(brace, 1);
  await line(a, brace, { qty: 1, reserved: 1 });           // A got shelf stock; its own PO is now spare
  const lb = await line(b, brace, { qty: 1 });
  const po = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('950', 'C&C')`);
  await run('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,1,?)', po, brace, a);
  const c = (await inv.shortages()).cover.find(x => x.line_id === lb);
  assert.ok(c, 'B is covered');
  assert.equal(c.from[0].po_no, '950'); assert.equal(c.from[0].chassis, 'TST-S1'); assert.equal(c.from[0].spare, 1);
  const vl = (await inv.getVan(b)).lines.find(l => l.id === lb);
  assert.equal(vl.status, 'on_order');
  assert.match(vl.cover.text, /PO 950 \(C&C\) – TST-S1's, spare/);
  const d = await inv.itemDetail(brace);
  assert.match(d.usage.find(u => u.id === lb).cover.text, /TST-S1's, spare/);
  assert.deepEqual(d.pos.find(p => p.po_id === po).covers, ['TST-S2']);
  // a finished van's open PO line is listed under POs to check
  await run(`UPDATE vans SET status = 'completed' WHERE id = ?`, a);
  const tc = (await inv.posToCheck()).find(p => p.id === po);
  assert.ok(tc, 'listed');
  assert.match(tc.problems.join(' '), /1 still coming for TST-S1 \(van finished\) – counted as spare for other vans/);
  // (A's set-aside part may now count as free stock for B; if a PO still covers B it is marked as a finished van's)
  const cv = (await inv.shortages()).cover.find(x => x.line_id === lb);
  if (cv) assert.equal(cv.from[0].inactive, 1);
});

test('user-r4-9: customer-supplied wording on a dealer order', () => {
  assert.equal(customerSays('customer sending black Jack maxi'), 'suggest');
  assert.equal(customerSays('wpc supplied by customer'), 'auto');
  assert.equal(customerSays('Customer supply'), 'auto');
  assert.equal(customerSays('customer to supply'), 'suggest');
  assert.equal(customerSays('9 if possible customer will pay extra'), '');
  assert.equal(customerSays('as per customers request'), '');
  assert.equal(customerSays('customers bbq'), '');
});

// Small fixes & phone round 3 (check-r2-1): a delivery booked on a phone with no van keeps what it ticks off
// a van's PO line with THAT van, so the van never comes back in "Check: already ordered?".
test('check-r2-1: phone delivery with no van stays with the vans whose PO lines it ticks off', async () => {
  const sw = await item({ name: 'AC switch test', supplier: 'BattCo', kind: 'stock' });
  const a = await van('TST-R1', 'in_production', '2026-01-01'); // first in the build order
  const b = await van('TST-R2', 'planned', '2099-02-01');
  const c = await van('TST-R3', 'planned', '2099-03-01');
  const mk = v => insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, po_ref) VALUES(?,?,1,'BattCo 777', 'plan', '777')`, v, sw);
  const la = await mk(a), lb = await mk(b), lc = await mk(c);
  const po = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('777', 'BattCo')`);
  // PO lines made in a different order from the build order (B, C, then A)
  await run('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,1,?)', po, sw, b);
  await run('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,1,?)', po, sw, c);
  const pa = await insert('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,1,?)', po, sw, a);
  const inCheck = async () => (await inv.checkOrdered()).flatMap(g => g.lines).filter(l => l.item_id === sw).length;
  assert.equal(await inCheck(), 0);
  const snap = async () => JSON.stringify([await onHand(sw), await all('SELECT id, reserved, reserved_firm FROM van_lines WHERE item_id = ? ORDER BY id', sw),
    await all('SELECT id, received FROM po_lines WHERE item_id = ? ORDER BY id', sw), await get('SELECT status FROM purchase_orders WHERE id = ?', po)]);
  const s0 = await snap();
  const r = await inv.receiveDelivery(sw, 2, { ref: 'Delivery (floor)', vanId: null, by: 'Test' });
  const held = async id => ({ ...(await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', id)) });
  // Follow-up round 1 (chk-r3-1): the van PO lines are ticked in build order (A #1, B #2), not line order.
  assert.deepEqual(await held(la), { reserved: 1, reserved_firm: 1 });
  assert.deepEqual(await held(lb), { reserved: 1, reserved_firm: 1 });
  assert.deepEqual(await held(lc), { reserved: 0, reserved_firm: 0 }); // C's own PO line is still open for it
  assert.deepEqual((await all('SELECT id, received FROM po_lines WHERE item_id = ? ORDER BY id', sw)).map(x => x.received), [1, 0, 1]);
  assert.equal((await get('SELECT received FROM po_lines WHERE id = ?', pa)).received, 1);
  assert.equal(await inCheck(), 0);
  assert.match((await get('SELECT note FROM movements WHERE id = ?', r.movement_id)).note, /For TST-R1 \(1\), TST-R2 \(1\)/);
  // one more than is on order: the last PO line is ticked, the extra goes out in build order (nobody else needs it)
  await inv.undoReceive(r.movement_id, 'Test');
  assert.equal(await snap(), s0);
  const r2 = await inv.receiveDelivery(sw, 4, { ref: 'Delivery (floor)', vanId: null, by: 'Test' });
  for (const l of [la, lb, lc]) assert.deepEqual(await held(l), { reserved: 1, reserved_firm: 1 });
  assert.equal(await onHand(sw), 4);
  await inv.undoReceive(r2.movement_id, 'Test');
  assert.equal(await snap(), s0);
});

// Follow-up round 1 (chk-r3-1): a delivery's van PO lines are ticked in build order — the picked van's lines
// first, then lines for the shelf, then other vans' lines by the shared PRIORITY (finished vans last); the
// PO / line number only breaks a tie.
test('chk-r3-1: a delivery with no van ticks van PO lines in build order, across two POs', async () => {
  const ant = await item({ name: 'Radio antenna test', supplier: 'Onex', kind: 'stock' });
  const v1 = await van('TST-B1', 'in_production', '2026-01-02'); // #1 (in production, late)
  const v2 = await van('TST-B2', 'planned', '2099-04-01');       // #2
  const v3 = await van('TST-B3', 'planned', '2099-05-01');       // #3
  const v4 = await van('TST-B4', 'planned', '2099-06-01');       // #4
  const gone = await van('TST-B0', 'completed', '2025-01-01');   // finished, its PO line is still open
  const ln = { v1: await line(v1, ant, { qty: 1 }), v2: await line(v2, ant, { qty: 1 }), v3: await line(v3, ant, { qty: 1 }), v4: await line(v4, ant, { qty: 1 }) };
  const poA = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('T08A', 'Onex')`);
  const poB = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('T08B', 'Onex')`);
  const pl = (po, v) => insert('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,1,?)', po, ant, v);
  // The older PO lists the finished van and the later vans first; the newer PO lists #3 before #1.
  const p0 = await pl(poA, gone), a4 = await pl(poA, v4), a2 = await pl(poA, v2), b3 = await pl(poB, v3), b1 = await pl(poB, v1);
  const rcv = async id => (await get('SELECT received FROM po_lines WHERE id = ?', id)).received;
  const rcvAll = async ids => { const out = []; for (const id of ids) out.push(await rcv(id)); return out; };
  const held = async id => ({ ...(await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', id)) });
  const snap = async () => JSON.stringify([await onHand(ant), await all('SELECT id, reserved, reserved_firm FROM van_lines WHERE item_id = ? ORDER BY id', ant),
    await all('SELECT id, received FROM po_lines WHERE item_id = ? ORDER BY id', ant), await all('SELECT id, status FROM purchase_orders WHERE id IN (?, ?) ORDER BY id', poA, poB)]);
  let s0 = await snap();

  // 2 with no van → #1 and #2 (each locked to its van); #3, #4 and the finished van's lines stay open
  const r = await inv.receiveDelivery(ant, 2, { ref: 'Delivery (floor)', vanId: null, by: 'Test' });
  assert.deepEqual(await rcvAll([p0, a4, a2, b3, b1]), [0, 0, 1, 0, 1]);
  assert.deepEqual(await held(ln.v1), { reserved: 1, reserved_firm: 1 });
  assert.deepEqual(await held(ln.v2), { reserved: 1, reserved_firm: 1 });
  assert.deepEqual(await held(ln.v3), { reserved: 0, reserved_firm: 0 });
  assert.deepEqual(await held(ln.v4), { reserved: 0, reserved_firm: 0 });
  assert.match((await get('SELECT note FROM movements WHERE id = ?', r.movement_id)).note, /For TST-B1 \(1\), TST-B2 \(1\)/);
  await inv.undoReceive(r.movement_id, 'Test');
  assert.equal(await snap(), s0);

  // A van picked on the phone: its own line first, then the others in build order
  const r2 = await inv.receiveDelivery(ant, 2, { ref: 'Delivery (floor)', vanId: v4, by: 'Test' });
  assert.deepEqual(await rcvAll([p0, a4, a2, b3, b1]), [0, 1, 0, 0, 1]);
  assert.deepEqual(await held(ln.v4), { reserved: 1, reserved_firm: 1 });
  assert.deepEqual(await held(ln.v1), { reserved: 1, reserved_firm: 1 });
  await inv.undoReceive(r2.movement_id, 'Test');
  assert.equal(await snap(), s0);

  // A PO line for the shelf (no van) is ticked before other vans' lines; that one goes out in build order
  const sh = await pl(poB, null);
  s0 = await snap();
  const r3 = await inv.receiveDelivery(ant, 2, { ref: 'Delivery (floor)', vanId: null, by: 'Test' });
  assert.deepEqual(await rcvAll([sh, b1, a2]), [1, 1, 0]);
  assert.deepEqual(await held(ln.v1), { reserved: 1, reserved_firm: 1 });
  assert.deepEqual(await held(ln.v2), { reserved: 1, reserved_firm: 0 }); // shelf stock, not locked
  await inv.undoReceive(r3.movement_id, 'Test');
  assert.equal(await snap(), s0);

  // Everything still on order for active vans + the shelf: the finished van's line is ticked last
  const r4 = await inv.receiveDelivery(ant, 5, { ref: 'Delivery (floor)', vanId: null, by: 'Test' });
  assert.deepEqual(await rcvAll([p0, a4, a2, b3, b1, sh]), [0, 1, 1, 1, 1, 1]);
  for (const k of ['v1', 'v2', 'v3', 'v4']) assert.equal((await held(ln[k])).reserved, 1);
  await inv.undoReceive(r4.movement_id, 'Test');
  assert.equal(await snap(), s0);
});

// Follow-up round 1 (found by the chk-r3-1 sweep): a van with the part on two lines — one "Coast Order 137",
// one still to order — gets the delivery of PO 137 on the line that names 137 (floor and PO screen alike).
test('chk-r3-1: a delivery for a van fills the van line that names that order first', async () => {
  const sd = await item({ name: 'Service door test', supplier: 'Coast', kind: 'stock' });
  const v = await van('TST-SD1', 'planned', '2099-08-01');
  const plain = await insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, po_ref) VALUES(?,?,1,'', 'plan', '')`, v, sd);
  const named = await insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, po_ref) VALUES(?,?,2,'2 Coast Order 9137', 'plan', '9137')`, v, sd);
  const po = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('9137', 'Coast')`);
  const pl = await insert('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,2,?)', po, sd, v);
  const held = id => get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', id);
  const inCheck = async () => (await inv.checkOrdered()).flatMap(g => g.lines).filter(l => l.item_id === sd).length;
  const r = await inv.receiveDelivery(sd, 2, { ref: 'Delivery (floor)', vanId: null, by: 'Test' });
  assert.deepEqual({ ...(await held(named)) }, { reserved: 2, reserved_firm: 2 });
  assert.deepEqual({ ...(await held(plain)) }, { reserved: 0, reserved_firm: 0 }); // still to order
  assert.equal(await inCheck(), 0);
  await inv.undoReceive(r.movement_id, 'Test');
  // the PO screen does the same
  await inv.receivePO(po, [{ id: pl, qty: 2 }], { by: 'Test' });
  assert.deepEqual({ ...(await held(named)) }, { reserved: 2, reserved_firm: 2 });
  assert.deepEqual({ ...(await held(plain)) }, { reserved: 0, reserved_firm: 0 });
  assert.equal(await inCheck(), 0);
});

// Follow-up round 1 (chk-r3-2): the take that moved a planned van to "in production" puts it back to planned
// when it is undone — unless something else started the van since, or the office set its status by hand.
test('chk-r3-2: undoing the floor take that started a planned van puts it back to planned', async () => {
  const it = await item({ name: 'Annex light test', kind: 'stock' });
  await receive(it, 5);
  const pv = await van('TST-UNDO1', 'planned', '2099-07-01');
  const ln = await line(pv, it, { qty: 3 });
  await inv.allocateItem(it);
  const status = async () => (await get('SELECT status FROM vans WHERE id = ?', pv)).status;
  const undoRec = async id => JSON.parse((await get('SELECT undo FROM movements WHERE id = ?', id)).undo);
  const state = async () => JSON.stringify([await onHand(it), await get('SELECT qty, reserved, reserved_firm, issued FROM van_lines WHERE id = ?', ln)]);
  const start = await state();
  const now = state;

  // 1. one take, undone: planned again, and the history says so
  const t1 = await inv.takeForVan(ln, 1, 'Ben Builder');
  assert.equal(await status(), 'in_production');
  assert.ok((await undoRec(t1.movement_id)).startedVan, 'the take notes that it started the van');
  assert.ok(await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'floor take' AND field = 'van status'`, pv));
  await inv.undoTake(t1.movement_id);
  assert.equal(await status(), 'planned');
  assert.ok(await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'floor take undone' AND field = 'van status' AND after = 'planned'`, pv));
  assert.equal(await now(), start);

  // 2. two takes: undoing the first leaves it in production (the second is still there); undoing the second too → planned
  const a = await inv.takeForVan(ln, 1, 'Ben Builder');
  const b = await inv.takeForVan(ln, 1, 'Ben Builder');
  assert.equal((await undoRec(b.movement_id)).startedVan, undefined); // the van was already in production
  await inv.undoTake(a.movement_id);
  assert.equal(await status(), 'in_production');
  await inv.undoTake(b.movement_id);
  assert.equal(await status(), 'planned');
  assert.equal(await now(), start);
  // … and in the other order
  const c = await inv.takeForVan(ln, 1, 'Ben Builder');
  const d = await inv.takeForVan(ln, 1, 'Ben Builder');
  await inv.undoTake(d.movement_id);
  assert.equal(await status(), 'in_production');
  await inv.undoTake(c.movement_id);
  assert.equal(await status(), 'planned');

  // 3. the office set the status by hand after the take: left alone
  const e = await inv.takeForVan(ln, 1, 'Ben Builder');
  await inv.updateVan(pv, { status: 'planned' });
  await inv.updateVan(pv, { status: 'in_production' });
  assert.ok(await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'van status'`, pv));
  await inv.undoTake(e.movement_id);
  assert.equal(await status(), 'in_production');
  await inv.updateVan(pv, { status: 'planned' });

  // 4. a take saved before this round (no note in its undo record): Undo leaves the status as it is
  const f = await inv.takeForVan(ln, 1, 'Ben Builder');
  await run(`UPDATE movements SET undo = (undo::jsonb - 'startedVan')::text WHERE id = ?`, f.movement_id);
  await inv.undoTake(f.movement_id);
  assert.equal(await status(), 'in_production');

  // 5. a take for a van already in production carries no note and never changes the status
  const g = await inv.takeForVan(ln, 1, 'Ben Builder');
  assert.equal((await undoRec(g.movement_id)).startedVan, undefined);
  await inv.undoTake(g.movement_id);
  assert.equal(await status(), 'in_production');
  assert.equal(await now(), start);
});

// Stock check f1: "Already fitted" on the van after the take — even with no stock used — means work has
// started, so undoing the take that started the van leaves it in production.
test('f1: undo after "Already fitted" (no stock used) leaves the van in production', async () => {
  const it = await item({ name: 'Undo-fitted test part', kind: 'stock' });
  const other = await item({ name: 'Undo-fitted other part', kind: 'stock' });
  await receive(it, 2);
  const pv = await van('TST-UNDO-FIT', 'planned', '2099-08-01');
  const ln = await line(pv, it, { qty: 1 });
  const ln2 = await line(pv, other, { qty: 1 }); // nothing on the shelf, nothing set aside
  await inv.allocateItem(it);
  const status = async () => (await get('SELECT status FROM vans WHERE id = ?', pv)).status;

  const t = await inv.takeForVan(ln, 1, 'Ben Builder');
  assert.equal(await status(), 'in_production');
  await inv.markFitted(pv, [ln2], 'Office');
  assert.ok(await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'fitted'`, pv));
  assert.equal(await moved(other), 0, 'no stock was used for the fitted part');
  await inv.undoTake(t.movement_id);
  assert.equal(await status(), 'in_production');
  assert.equal(await onHand(it), await moved(it), 'on hand still equals the movement history');
});

// ── Postgres: the shortages memo and "Busy" ──

test('shortagesCached is worked out again once a change is committed (data_version), never reused inside a transaction', async () => {
  const part = await item({ name: 'Memo test part', kind: 'stock', supplier: 'MemoCo' });
  const v = await van('TST-MEMO', 'in_production', '');
  const rowsFor = sh => sh.rows.filter(r => r.item_id === part);
  const first = await inv.shortagesCached();
  assert.equal(await inv.shortagesCached(), first, 'nothing changed: the same answer');
  assert.deepEqual(rowsFor(first), []);
  // a change made in a write transaction: inside it the memo is not used (data_version is bumped only at commit)…
  await writeTx(async () => {
    await run('INSERT INTO van_lines(van_id, item_id, qty) VALUES(?, ?, 2)', v, part);
    const inside = await inv.shortagesCached();
    assert.notEqual(inside, first);
    assert.equal(rowsFor(inside)[0]?.suggest, 2);
  });
  // …and after it, the new data_version means a fresh answer
  const after = await inv.shortagesCached();
  assert.notEqual(after, first);
  assert.equal(rowsFor(after)[0]?.suggest, 2);
  assert.equal(await inv.shortagesCached(), after);
});

test('re-prioritise preview: changes nothing, and says "Busy" inside another transaction', async () => {
  const before = await all('SELECT id, reserved, reserved_firm FROM van_lines ORDER BY id');
  const ver = await dataVersion();
  assert.ok(Array.isArray(await inv.reprioritisePreview()));
  assert.deepEqual(await all('SELECT id, reserved, reserved_firm FROM van_lines ORDER BY id'), before);
  assert.equal(await dataVersion(), ver, 'rolled back: no data_version bump');
  await assert.rejects(writeTx(() => inv.reprioritisePreview()), { status: 409, message: 'Busy — try again' });
});
