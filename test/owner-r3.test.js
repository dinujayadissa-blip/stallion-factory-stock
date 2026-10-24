// Follow-up round 1, owner batch (owner-r3-2, owner-r3-7). Runs on a new, empty in-memory database (PGlite) —
// never on the real data.   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { run, insert, closeDb } from '../src/db.js';
import * as inv from '../src/inventory.js';
import { specForPo } from '../src/lineState.js';

before(freshDb);
after(closeDb);

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

test('owner-r3-2: still missing split the van page\'s way — waiting on PO / still to order / to check', async () => {
  const item = sku => insert(`INSERT INTO items(sku, name, supplier, kind) VALUES(?, ?, 'Acme', 'per-van')`, sku, sku);
  const van = await insert(`INSERT INTO vans(chassis, status, eta) VALUES('ST9101', 'in_production', '2026-01-10')`);
  const [a, b, c, d, e] = [await item('OW-A'), await item('OW-B'), await item('OW-C'), await item('OW-D'), await item('OW-E')];
  await run(`INSERT INTO van_lines(van_id, item_id, qty) VALUES(?, ?, 2)`, van, a);                                  // on a PO for the van
  await run(`INSERT INTO van_lines(van_id, item_id, qty, spec, po_ref) VALUES(?, ?, 1, 'Acme Order 77', '77')`, van, b); // plan order number: to check
  await run(`INSERT INTO van_lines(van_id, item_id, qty, spec) VALUES(?, ?, 1, 'Acme Order 29/06/2026')`, van, c);        // a date, not a number: to order
  await run(`INSERT INTO van_lines(van_id, item_id, qty, reserved) VALUES(?, ?, 1, 1)`, van, d);                      // set aside: not missing
  await run(`INSERT INTO van_lines(van_id, item_id, qty, state) VALUES(?, ?, 1, 'customer')`, van, e);               // customer supplies: never counted
  const po = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('500', 'Acme')`);
  await run(`INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?, ?, 2, ?)`, po, a, van);

  const split = (await inv.missingSplitByVan([van])).get(van);
  assert.deepEqual(split, { on_order: 1, to_order: 1, check: 1 });
  // adds up to the "still missing" number every screen shows
  assert.equal(split.on_order + split.to_order + split.check, (await inv.stillMissingByVan({ vanId: van })).get(van).missing);
  // the same as the van page's own statuses
  const page = (await inv.getVan(van)).lines.reduce((m, l) => (l.status in split ? { ...m, [l.status]: (m[l.status] || 0) + 1 } : m), {});
  assert.deepEqual(page, split);
  // and listVans / the Dashboard carry it
  assert.deepEqual((await inv.listVans({ status: 'active' })).find(v => v.id === van).split, split);
});
