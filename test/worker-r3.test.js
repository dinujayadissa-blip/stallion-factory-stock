// Follow-up round 1, worker batch a (worker-r3-3, worker-r3-4). Runs on a new, empty database in a temp folder —
// never on the real data.   node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
process.env.DATA_DIR = dir;
const { db, run, get } = await import('../src/db.js');
const inv = await import('../src/inventory.js');
after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
const item = (name, kind = 'stock') => Number(run(`INSERT INTO items(sku, name, category, supplier, kind) VALUES(?,?,?,?,?)`,
  `W-${++n}`, name, 'General', 'Onex', kind).lastInsertRowid);
const van = (chassis, status, eta) => Number(run(`INSERT INTO vans(chassis, status, eta) VALUES(?,?,?)`, chassis, status, eta).lastInsertRowid);
const line = (vanId, itemId, qty = 1, extra = {}) => Number(run(`INSERT INTO van_lines(van_id, item_id, qty, spec, po_ref, source) VALUES(?,?,?,?,?, 'plan')`,
  vanId, itemId, qty, extra.spec || '', extra.po_ref || '').lastInsertRowid);
const po = (no, supplier, expected = '') => Number(run(`INSERT INTO purchase_orders(po_no, supplier, expected) VALUES(?,?,?)`, no, supplier, expected).lastInsertRowid);
const poLine = (poId, itemId, vanId, qty = 1) => Number(run('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?,?,?,?)', poId, itemId, qty, vanId).lastInsertRowid);

test('worker-r3-4: a delivery says which van(s) it went to, how many each, and what stays on the shelf', () => {
  const bp = item('Battery protect test');
  const v1 = van('TW-1', 'in_production', '2026-01-02');
  const v2 = van('TW-2', 'planned', '2099-02-01');
  const v3 = van('TW-3', 'planned', '2099-03-01');
  line(v1, bp); line(v2, bp); line(v3, bp);
  const p = po('TW29', 'Arizon');
  poLine(p, bp, v3); // only TW-3's line is on order

  // 1 on PO for TW-3: goes to TW-3 (locked) — not "set aside for TW-1, TW-2, TW-3"
  const r = inv.receiveDelivery(bp, 1, { ref: 'Delivery (floor)', by: 'Test' });
  assert.deepEqual(r.to.map(x => [x.chassis, x.qty]), [['TW-3', 1]]);
  assert.equal(r.shelf, 0);
  inv.undoReceive(r.movement_id, 'Test');

  // 4 arrive: TW-3's PO line, then free stock in build order (TW-1, TW-2), 1 left for no van
  const r2 = inv.receiveDelivery(bp, 4, { ref: 'Delivery (floor)', by: 'Test' });
  assert.deepEqual(r2.to.map(x => [x.chassis, x.qty]), [['TW-1', 1], ['TW-2', 1], ['TW-3', 1]]);
  assert.equal(r2.shelf, 1);

  // every van has its part now: the next one stays on the shelf
  const r3 = inv.receiveDelivery(bp, 2, { ref: 'Delivery (floor)', by: 'Test' });
  assert.deepEqual(r3.to, []);
  assert.equal(r3.shelf, 2);
  inv.undoReceive(r3.movement_id, 'Test');
  inv.undoReceive(r2.movement_id, 'Test');
  assert.equal(get('SELECT on_hand FROM items WHERE id = ?', bp).on_hand, 0);
});

test('worker-r3-3: the worker van screen says a part is on order (supplier, due date) or that the plan says ordered', () => {
  const ant = item('Radio antenna test');
  const tv = item('TV test');
  const sw = item('AC switch test');
  const v = van('TW-9', 'in_production', '2026-01-02');
  const la = line(v, ant, 1, { spec: 'Onex 08', po_ref: '08' });
  const lt = line(v, tv);
  const ls = line(v, sw, 1, { spec: 'Coast' }); // no order number in the plan

  let f = inv.floorVan(v);
  const by = id => f.lines.find(l => l.id === id);
  assert.equal(by(la).order, undefined);
  assert.equal(by(la).plan_ordered, 'Onex 08'); // the plan gives an order number nobody confirmed yet
  assert.equal(by(lt).order, undefined);
  assert.equal(by(lt).plan_ordered, undefined);

  poLine(po('08', 'Onex', '2026-11-02'), ant, v);
  poLine(po('S1', 'Coast'), sw, null); // a shelf PO for the switch: the van page counts it as ordered too
  f = inv.floorVan(v);
  assert.deepEqual(by(la).order, { qty: 1, suppliers: ['Onex'], expected: '2026-11-02' });
  assert.equal(by(la).plan_ordered, undefined);
  assert.deepEqual(by(ls).order, { qty: 1, suppliers: ['Coast'], expected: '' }); // "due date not known"
  assert.equal(by(lt).order, undefined); // nothing ordered: still "Not in stock"
});
