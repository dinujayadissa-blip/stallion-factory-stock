// Follow-up round 1, worker batch a (worker-r3-3, worker-r3-4). Runs on a new, empty in-memory database (PGlite) —
// never on the real data.   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { get, insert, closeDb } from '../src/db.js';
import * as inv from '../src/inventory.js';

before(freshDb);
after(closeDb);

let n = 0;
const item = (name, kind = 'stock') => insert(`INSERT INTO items(sku, name, category, supplier, kind) VALUES(?,?,?,?,?)`,
  `W-${++n}`, name, 'General', 'Onex', kind);
const van = (chassis, status, eta) => insert(`INSERT INTO vans(chassis, status, eta) VALUES(?,?,?)`, chassis, status, eta);
const line = (vanId, itemId, qty = 1, extra = {}) => insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, po_ref, source) VALUES(?,?,?,?,?, 'plan')`,
  vanId, itemId, qty, extra.spec || '', extra.po_ref || '');
const po = (no, supplier, expected = '') => insert(`INSERT INTO purchase_orders(po_no, supplier, expected) VALUES(?,?,?)`, no, supplier, expected);
const poLine = (poId, itemId, vanId, qty = 1) => insert('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,?,?)', poId, itemId, qty, vanId);

test('worker-r3-4: a delivery says which van(s) it went to, how many each, and what stays on the shelf', async () => {
  const bp = await item('Battery protect test');
  const v1 = await van('TW-1', 'in_production', '2026-01-02');
  const v2 = await van('TW-2', 'planned', '2099-02-01');
  const v3 = await van('TW-3', 'planned', '2099-03-01');
  await line(v1, bp); await line(v2, bp); await line(v3, bp);
  const p = await po('TW29', 'Arizon');
  await poLine(p, bp, v3); // only TW-3's line is on order

  // 1 on PO for TW-3: goes to TW-3 (locked) — not "set aside for TW-1, TW-2, TW-3"
  const r = await inv.receiveDelivery(bp, 1, { ref: 'Delivery (floor)', by: 'Test' });
  assert.deepEqual(r.to.map(x => [x.chassis, x.qty]), [['TW-3', 1]]);
  assert.equal(r.shelf, 0);
  await inv.undoReceive(r.movement_id, 'Test');

  // 4 arrive: TW-3's PO line, then free stock in build order (TW-1, TW-2), 1 left for no van
  const r2 = await inv.receiveDelivery(bp, 4, { ref: 'Delivery (floor)', by: 'Test' });
  assert.deepEqual(r2.to.map(x => [x.chassis, x.qty]), [['TW-1', 1], ['TW-2', 1], ['TW-3', 1]]);
  assert.equal(r2.shelf, 1);

  // every van has its part now: the next one stays on the shelf
  const r3 = await inv.receiveDelivery(bp, 2, { ref: 'Delivery (floor)', by: 'Test' });
  assert.deepEqual(r3.to, []);
  assert.equal(r3.shelf, 2);
  await inv.undoReceive(r3.movement_id, 'Test');
  await inv.undoReceive(r2.movement_id, 'Test');
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', bp)).on_hand, 0);
});

test('worker-r3-3: the worker van screen says a part is on order (supplier, due date) or that the plan says ordered', async () => {
  const ant = await item('Radio antenna test');
  const tv = await item('TV test');
  const sw = await item('AC switch test');
  const v = await van('TW-9', 'in_production', '2026-01-02');
  const la = await line(v, ant, 1, { spec: 'Onex 08', po_ref: '08' });
  const lt = await line(v, tv);
  const ls = await line(v, sw, 1, { spec: 'Coast' }); // no order number in the plan

  let f = await inv.floorVan(v);
  const by = id => f.lines.find(l => l.id === id);
  assert.equal(by(la).order, undefined);
  assert.equal(by(la).plan_ordered, 'Onex 08'); // the plan gives an order number nobody confirmed yet
  assert.equal(by(lt).order, undefined);
  assert.equal(by(lt).plan_ordered, undefined);

  await poLine(await po('08', 'Onex', '2026-11-02'), ant, v);
  await poLine(await po('S1', 'Coast'), sw, null); // a shelf PO for the switch: the van page counts it as ordered too
  f = await inv.floorVan(v);
  assert.deepEqual(by(la).order, { qty: 1, suppliers: ['Onex'], expected: '2026-11-02' });
  assert.equal(by(la).plan_ordered, undefined);
  assert.deepEqual(by(ls).order, { qty: 1, suppliers: ['Coast'], expected: '' }); // "due date not known"
  assert.equal(by(lt).order, undefined); // nothing ordered: still "Not in stock"
});

// Melbourne's date, whatever time zone the server runs in (the cloud runs in UTC).
test('today() is Melbourne\'s date when TZ=UTC', t => {
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-24T14:30:00Z') });
  try {
    assert.equal(inv.today(), '2026-10-25'); // 14:30 UTC = 01:30 the next morning in Melbourne (daylight time)
  } finally {
    t.mock.timers.reset();
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
