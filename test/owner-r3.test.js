// Follow-up round 1, owner batch (owner-r3-2, owner-r3-7). Runs on a new, empty database in a temp folder —
// never on the real data.   node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
process.env.DATA_DIR = dir;
const { db, run } = await import('../src/db.js');
const inv = await import('../src/inventory.js');
const { specForPo } = await import('../src/lineState.js');
after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });

test('owner-r3-7: an order DATE in the plan text is taken out of the PO text as a whole', () => {
  assert.equal(specForPo('Urban republic Order 29/06/2026'), 'Urban republic');
  assert.equal(specForPo('Urban republic Ordered 3/6'), 'Urban republic');
  // order numbers as before
  assert.equal(specForPo('Black / Razor Order 42', '42'), 'Black / Razor');
  assert.equal(specForPo('Probond Order 101', '101'), 'Probond');
  assert.equal(specForPo('Urban republic Order 34 16/04/2026', '34'), 'Urban republic 16/04/2026');
  assert.equal(specForPo('eurolux wild oak 7.2 m 39', '39'), 'eurolux wild oak 7.2 m');
  // "86/88" is not a date: left as before
  assert.equal(specForPo('Yes Order 86/88 9 Doors', '86'), 'Yes /88 9 Doors');
});

test('owner-r3-2: still missing split the van page\'s way — waiting on PO / still to order / to check', () => {
  const item = sku => Number(run(`INSERT INTO items(sku, name, supplier, kind) VALUES(?, ?, 'Acme', 'per-van')`, sku, sku).lastInsertRowid);
  const van = Number(run(`INSERT INTO vans(chassis, status, eta) VALUES('ST9101', 'in_production', '2026-01-10')`).lastInsertRowid);
  const [a, b, c, d, e] = ['OW-A', 'OW-B', 'OW-C', 'OW-D', 'OW-E'].map(item);
  run(`INSERT INTO van_lines(van_id, item_id, qty) VALUES(?, ?, 2)`, van, a);                                  // on a PO for the van
  run(`INSERT INTO van_lines(van_id, item_id, qty, spec, po_ref) VALUES(?, ?, 1, 'Acme Order 77', '77')`, van, b); // plan order number: to check
  run(`INSERT INTO van_lines(van_id, item_id, qty, spec) VALUES(?, ?, 1, 'Acme Order 29/06/2026')`, van, c);        // a date, not a number: to order
  run(`INSERT INTO van_lines(van_id, item_id, qty, reserved) VALUES(?, ?, 1, 1)`, van, d);                      // set aside: not missing
  run(`INSERT INTO van_lines(van_id, item_id, qty, state) VALUES(?, ?, 1, 'customer')`, van, e);               // customer supplies: never counted
  const po = Number(run(`INSERT INTO purchase_orders(po_no, supplier) VALUES('500', 'Acme')`).lastInsertRowid);
  run(`INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?, ?, 2, ?)`, po, a, van);

  const split = inv.missingSplitByVan([van]).get(van);
  assert.deepEqual(split, { on_order: 1, to_order: 1, check: 1 });
  // adds up to the "still missing" number every screen shows
  assert.equal(split.on_order + split.to_order + split.check, inv.stillMissingByVan({ vanId: van }).get(van).missing);
  // the same as the van page's own statuses
  const page = inv.getVan(van).lines.reduce((m, l) => (l.status in split ? { ...m, [l.status]: (m[l.status] || 0) + 1 } : m), {});
  assert.deepEqual(page, split);
  // and listVans / the Dashboard carry it
  assert.deepEqual(inv.listVans({ status: 'active' }).find(v => v.id === van).split, split);
});
