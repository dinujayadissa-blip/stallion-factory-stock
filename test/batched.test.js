// No query per row: pages that list many rows send the same number of statements for 1 row or 20, and
// still give the same answers. Runs on a new, empty in-memory database (PGlite) — never on the real data.
//   node --test test/
// The tests share ONE database and build on each other, top to bottom.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { run, get, all, insert, closeDb, newQueryStats, countQueries, logAlloc, logAllocMany, ID_LIST, ids } from '../src/db.js';
import * as inv from '../src/inventory.js';

before(freshDb);
after(closeDb);

// How many statements fn sends to the database.
async function statements(fn) {
  const stats = newQueryStats();
  const out = await countQueries(stats, fn);
  return { n: stats.queries, out };
}

let n = 0;
const item = f => insert(`INSERT INTO items(sku, name, supplier, kind, on_hand, area_id) VALUES(?,?,?,?,?,?)`,
  `BT-${++n}`, f.name || `Part ${n}`, f.supplier || '', f.kind || 'stock', f.on_hand || 0, f.area_id ?? null);
const van = (chassis, status = 'planned', eta = '2099-01-01') => insert(`INSERT INTO vans(chassis, status, eta) VALUES(?,?,?)`, chassis, status, eta);
const line = (vanId, itemId, f = {}) => insert(`INSERT INTO van_lines(van_id, item_id, qty, reserved, reserved_firm, issued) VALUES(?,?,?,?,?,?)`,
  vanId, itemId, f.qty ?? 1, f.reserved || 0, f.firm || 0, f.issued || 0);
const po = (no, supplier, f = {}) => insert(`INSERT INTO purchase_orders(po_no, supplier, needs_check, notes, expected) VALUES(?,?,?,?,?)`,
  no, supplier, f.check ?? 1, f.notes || '', f.expected || '');
const poLine = (poId, itemId, vanId, qty = 1, expected = '') => insert(`INSERT INTO po_lines(po_id, item_id, van_id, qty, expected) VALUES(?,?,?,?,?)`,
  poId, itemId, vanId, qty, expected);

test('ids() / ID_LIST: one value for a list of ids; anything that is not a whole number matches nothing', async () => {
  const a = await item({}), b = await item({});
  const got = await all(`SELECT id FROM items WHERE id IN ${ID_LIST} ORDER BY id`, ids([b, a, '1.5', 'x', NaN]));
  assert.deepEqual(got.map(r => r.id), [a, b]);
  assert.deepEqual(await all(`SELECT id FROM items WHERE id IN ${ID_LIST}`, ids([])), []);
});

test('logAllocMany: many log lines in one statement, in order, worked out as logAlloc does', async () => {
  const before = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM allocation_log')).m;
  const { n: one } = await statements(() => logAllocMany([['bt', { field: 'reserved', before: 1, after: 3, note: 'first' }],
    ['bt', { field: 'reserved_firm', before: 2, after: 0, note: 'second' }], ['bt', { field: 'flag', after: 'x', note: 'third' }]]));
  assert.equal(one, 1);
  await logAlloc('bt', { field: 'locked', before: '0', after: '2', note: 'fourth' });
  const rows = await all('SELECT note, change, firm_change, before, after FROM allocation_log WHERE id > ? ORDER BY id', before);
  assert.deepEqual(rows.map(r => [r.note, r.change, r.firm_change]), [['first', 2, null], ['second', null, -2], ['third', null, null], ['fourth', null, 2]]);
  assert.deepEqual([rows[0].before, rows[0].after], ['1', '3']);
});

test('POs to check: the same reasons and lines, and the same number of statements for 1 PO or 8', async () => {
  const done = await van('BT-DONE', 'completed');
  const live = await van('BT-LIVE');
  const p1 = await item({ name: 'BT cable' }), p2 = await item({ name: 'BT fridge', kind: 'per-van' });
  const a = await po('77', 'Capral', { notes: 'Order number from the production plan, confirmed on order (Yes, all on order)' });
  await po('77', 'capral ', { check: 0 });               // same number, same supplier: "also used"
  await po('77', 'Onex', { check: 0 });                  // same number, another supplier: fine
  await poLine(a, p1, live, 2);                          // no date of its own: "no delivery date"
  await poLine(a, p2, done, 1);                          // for a finished van: "still coming"
  const { n: few, out } = await statements(() => inv.posToCheck());
  const mine = out.find(p => p.id === a);
  assert.deepEqual(mine.problems, ['no delivery date', 'number 77 also used on capral ', '1 still coming for BT-DONE (van finished) – bought for that van, no van needs it now']);
  assert.deepEqual(mine.lines.map(l => l.name), ['BT cable', 'BT fridge']);
  assert.deepEqual(mine.vans.sort(), ['BT-DONE', 'BT-LIVE']);
  // the PO page says the same
  assert.deepEqual((await inv.getPO(a)).po.problems, mine.problems);
  for (let i = 0; i < 7; i++) await poLine(await po('(no number)', ''), p1, live, 1, '2099-01-01');
  const { n: many, out: more } = await statements(() => inv.posToCheck());
  assert.equal(more.length, out.length + 7);
  assert.equal(many, few);
  assert.deepEqual(more.at(-1).problems, ['no PO number', 'no supplier']);
});

test('Stock checks: a borrow says whether the van it was taken from has it on order again — one statement for all borrows', async () => {
  const from = await van('BT-FROM', 'planned');
  const part = await item({ name: 'BT hinge' });
  const l = await line(from, part, { qty: 3 });            // short 3 after the borrow
  const p = await po('BT-9', 'Hinges Co', { check: 0 });
  await poLine(p, part, from, 2);
  const borrow = () => logAlloc('borrow', { van_id: from, item_id: part, line_id: l, field: 'reserved', before: 1, after: 0, note: 'taken for BT-OTHER' });
  await borrow();
  const { n: few, out } = await statements(() => inv.stockChecks());
  assert.equal(out.borrows[0].reordered, '');               // 2 on order, 3 short
  assert.equal(out.borrows[0].to, 'BT-OTHER');
  assert.equal(out.borrows[0].on_order, undefined, 'not sent to the screen');
  await poLine(p, part, from, 1);
  for (let i = 0; i < 5; i++) await borrow();
  const { n: many, out: more } = await statements(() => inv.stockChecks());
  assert.equal(many, few);
  assert.equal(more.borrows.length, 6);
  assert.ok(more.borrows.every(b => b.reordered === 're-ordered (3 on order)'));
});

test('Rack count check: figures, locks and movements per part — the same statements for 2 parts or 12', async () => {
  const rack = await insert(`INSERT INTO floor_areas(kind, name, x, y, w, h) VALUES('storage', 'BT rack', 0, 0, 1, 1)`);
  const v = await van('BT-COUNT', 'in_production');
  const parts = [];
  for (let i = 0; i < 12; i++) parts.push(await item({ name: `BT screw ${i}`, on_hand: 10, area_id: rack }));
  await line(v, parts[0], { qty: 4, reserved: 4, firm: 4 });
  const s = await inv.openCount(`area:${rack}`, 'tester');
  await run(`UPDATE items SET on_hand = on_hand - 1 WHERE id = ?`, parts[1]);
  await run(`INSERT INTO movements(item_id, qty, type) VALUES(?, -1, 'issue')`, parts[1]);
  const { n: few, out } = await statements(() => inv.checkCount(s.id, parts.slice(0, 2).map(id => ({ item_id: id, qty: 2 }))));
  assert.equal(out[0].locked, 4);
  assert.deepEqual(out[0].lockedVans, [{ chassis: 'BT-COUNT', qty: 4 }]);
  assert.equal(out[0].shortfall, 2);
  assert.equal(out[1].moves.length, 1);
  assert.equal(out[1].now, 9);
  assert.equal(out[1].changed, true);
  const { n: many, out: all12 } = await statements(() => inv.checkCount(s.id, parts.map(id => ({ item_id: id, qty: 10 }))));
  assert.equal(all12.length, 12);
  assert.equal(many, few);
  assert.deepEqual(await inv.checkCount(s.id, []), []);
});

test('Bought-for-van stock with no van: spare answers and vans short, the same statements for 1 part or 6', async () => {
  const short = await van('BT-SHORT', 'planned');
  const parts = [];
  const make = async () => { const p = await item({ name: `BT aircon ${parts.length}`, kind: 'per-van', on_hand: 2 }); parts.push(p); await line(short, p, { qty: 1 }); };
  await make();
  const { n: few, out } = await statements(() => inv.unassignedPerVan({ all: true }));
  assert.deepEqual(out.map(r => [r.name, r.unassigned, r.spare, r.needs_answer, r.vans.map(x => x.chassis)]), [['BT aircon 0', 2, 0, 1, ['BT-SHORT']]]);
  await inv.keepSpare(parts[0], 'tester');
  for (let i = 0; i < 5; i++) await make();
  const { n: many, out: more } = await statements(() => inv.unassignedPerVan({ all: true }));
  assert.equal(many, few);
  assert.equal(more.length, 6);
  assert.deepEqual([more[0].spare, more[0].needs_answer], [2, 0]);
  assert.equal((await inv.unassignedPerVan()).length, 5, 'the one answered "spare" is off the list');
  assert.equal((await inv.itemDetail(parts[0])).spare, 2);
});

test('Try a rule: every active van with its order fields, in build order, in two statements', async () => {
  const a = await van('BT-RULE-A', 'planned'), b = await van('BT-RULE-B', 'in_production');
  await insert(`INSERT INTO order_fields(van_id, label, value, sort) VALUES(?, 'FRIDGE', 'Thetford', 2), (?, 'AWNING', 'yes', 1), (?, 'FRIDGE', 'Dometic', 1)`, a, a, b);
  const { n, out } = await statements(() => inv.activeVanFields());
  assert.equal(n, 2);
  const at = c => out.findIndex(v => v.chassis === c);
  assert.ok(at('BT-RULE-B') < at('BT-RULE-A'), 'in production first');
  assert.deepEqual(out.find(v => v.id === a).fields.map(f => f.label), ['AWNING', 'FRIDGE']);
  assert.ok(!out.some(v => v.chassis === 'BT-DONE'));
});

test('A van finished: set-aside counted as used (one issue movement per line), short lines give theirs back — as line by line', async () => {
  const done = await van('BT-FIN', 'in_production');
  const next = await van('BT-NEXT', 'planned');
  const a = await item({ name: 'BT tap', on_hand: 5 }), b = await item({ name: 'BT pump', on_hand: 2 });
  const full1 = await line(done, a, { qty: 2, reserved: 2, firm: 2 });
  const full2 = await line(done, a, { qty: 1, reserved: 1 });
  const short = await line(done, b, { qty: 3, reserved: 2, firm: 1 });   // still short: its 2 go back
  const waiting = await line(next, b, { qty: 2 });                         // …and the next van gets them
  const fromLog = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM allocation_log')).m;
  const fromMove = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM movements')).m;
  await inv.updateVan(done, { status: 'completed' }, { by: 'tester' });
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', a)).on_hand, 2);
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', b)).on_hand, 2);
  const l = async id => get('SELECT qty, reserved, reserved_firm, issued FROM van_lines WHERE id = ?', id);
  assert.deepEqual(await l(full1), { qty: 2, reserved: 0, reserved_firm: 0, issued: 2 });
  assert.deepEqual(await l(full2), { qty: 1, reserved: 0, reserved_firm: 0, issued: 1 });
  assert.deepEqual(await l(short), { qty: 3, reserved: 0, reserved_firm: 0, issued: 0 });
  assert.equal((await l(waiting)).reserved, 2);
  assert.deepEqual((await all('SELECT item_id, qty, type, van_id, ref, note FROM movements WHERE id > ? ORDER BY id', fromMove)),
    [{ item_id: a, qty: -2, type: 'issue', van_id: done, ref: 'BT-FIN', note: 'Used — van finished' },
     { item_id: a, qty: -1, type: 'issue', van_id: done, ref: 'BT-FIN', note: 'Used — van finished' }]);
  const log = await all(`SELECT line_id, change, firm_change, note FROM allocation_log WHERE id > ? AND reason = 'van finished' ORDER BY id`, fromLog);
  assert.deepEqual(log, [
    { line_id: full1, change: -2, firm_change: -2, note: 'BT-FIN finished – set-aside counted as used' },
    { line_id: full2, change: -1, firm_change: 0, note: 'BT-FIN finished – set-aside counted as used' },
    { line_id: short, change: -2, firm_change: -1, note: 'BT-FIN finished while still short – set-aside back to the shelf' }]);

  // Cancelled: everything set aside goes back, logged per line
  const gone = await van('BT-CANC', 'planned');
  const c = await item({ name: 'BT vent', on_hand: 3 });
  const c1 = await line(gone, c, { qty: 1, reserved: 1 }), c2 = await line(gone, c, { qty: 2, reserved: 2, firm: 2 });
  const fromLog2 = (await get('SELECT MAX(id) AS m FROM allocation_log')).m;
  await inv.updateVan(gone, { status: 'cancelled' });
  assert.deepEqual(await all(`SELECT line_id, change, firm_change FROM allocation_log WHERE id > ? AND reason = 'van finished' ORDER BY id`, fromLog2),
    [{ line_id: c1, change: -1, firm_change: 0 }, { line_id: c2, change: -2, firm_change: -2 }]);
  assert.equal((await get('SELECT SUM(reserved) AS s FROM van_lines WHERE van_id = ?', gone)).s, 0);
});

test('Check: already ordered? — Yes puts every line on one PO per supplier, No marks them all, in order', async () => {
  const v = await van('BT-ORD', 'planned');
  const parts = [await item({ name: 'BT door', supplier: 'Doorco' }), await item({ name: 'BT lock', supplier: 'Doorco' }), await item({ name: 'BT glass', supplier: 'Glassco' })];
  const lineIds = [];
  for (const p of parts) lineIds.push(await insert(`INSERT INTO van_lines(van_id, item_id, qty, reserved, po_ref, spec) VALUES(?, ?, 3, 1, 'BT55', 'from plan')`, v, p));
  const r = await inv.answerOrdered('BT55', 'yes', { by: 'tester' });
  assert.equal(r.lines, 3);
  assert.equal(r.pos.length, 2);
  const pl = await all(`SELECT pl.item_id, pl.qty, pl.van_id, p.supplier, p.po_no FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                        WHERE pl.item_id IN ${ID_LIST} ORDER BY pl.id`, ids(parts));
  assert.deepEqual(pl, [
    { item_id: parts[0], qty: 2, van_id: v, supplier: 'Doorco', po_no: 'BT55' },
    { item_id: parts[1], qty: 2, van_id: v, supplier: 'Doorco', po_no: 'BT55' },
    { item_id: parts[2], qty: 2, van_id: v, supplier: 'Glassco', po_no: 'BT55' }]);
  assert.deepEqual((await all(`SELECT line_id, after FROM allocation_log WHERE reason = 'check ordered' AND line_id IN ${ID_LIST} ORDER BY id`, ids(lineIds))).map(x => x.after),
    ['PO BT55 (Doorco) +2', 'PO BT55 (Doorco) +2', 'PO BT55 (Glassco) +2']);

  const w = await van('BT-ORD2', 'planned');
  const more = [];
  for (const p of parts.slice(0, 2)) more.push(await insert(`INSERT INTO van_lines(van_id, item_id, qty, po_ref) VALUES(?, ?, 1, 'BT56')`, w, p));
  assert.equal((await inv.answerOrdered('BT56', 'no', { by: 'tester' })).lines, 2);
  assert.deepEqual((await all(`SELECT state FROM van_lines WHERE id IN ${ID_LIST}`, ids(more))).map(x => x.state), ['not_ordered', 'not_ordered']);
  assert.equal((await get(`SELECT COUNT(*) AS c FROM allocation_log WHERE reason = 'check ordered' AND after = 'not_ordered' AND line_id IN ${ID_LIST}`, ids(more))).c, 2);
});

test('A new van from a dealer order: its form fields are kept in form order', async () => {
  const fields = [{ section: 'A', label: 'FRIDGE', value: 'Thetford' }, { label: 'AWNING', value: '' }, { section: 'B', label: 'NOTES', value: "it's 2 x", note: 'n' }];
  const id = await inv.createVan({ header: { chassis: 'bt-new-1' }, fields });
  assert.deepEqual(await all('SELECT section, label, value, note, sort FROM order_fields WHERE van_id = ? ORDER BY sort', id), [
    { section: 'A', label: 'FRIDGE', value: 'Thetford', note: '', sort: 0 },
    { section: '', label: 'AWNING', value: '', note: '', sort: 1 },
    { section: 'B', label: 'NOTES', value: "it's 2 x", note: 'n', sort: 2 }]);
  assert.ok(await inv.createVan({ header: { chassis: 'BT-NEW-2' }, fields: [] }));
});
