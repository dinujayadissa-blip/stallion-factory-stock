// scripts/fresh-start.js: no vans, every stock figure 0, the parts list and everything else kept — with a copy of
// what went. Runs on a new, empty in-memory database (PGlite) — never on the real data.   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDb } from './helpers.js';
import { run, get, insert, closeDb, dataVersion, setSetting, getSetting } from '../src/db.js';
import * as inv from '../src/inventory.js';
import { freshStart, WIPED } from '../scripts/fresh-start.js';

before(freshDb);
after(closeDb);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-fresh-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const n = async t => (await get(`SELECT COUNT(*) AS n FROM ${t}`)).n;

let part, other, rack, rule, user;
test('set-up: parts with stock, vans with lines, a PO, movements, notes, reminders, a count', async () => {
  rack = await insert(`INSERT INTO floor_areas(kind, name, x, y, w, h) VALUES('storage', 'Rack A', 0, 0, 2, 1)`);
  part = await insert(`INSERT INTO items(sku, name, supplier, area_id, photo) VALUES('FS-1', 'Tap', 'Taps Co', ?, '1-1.jpg')`, rack);
  other = await insert(`INSERT INTO items(sku, name, kind) VALUES('FS-2', 'Fridge', 'per-van')`);
  rule = await insert(`INSERT INTO rules(name, conditions, item_id) VALUES('Tap on every van', '*', ?)`, part);
  user = await insert(`INSERT INTO users(username, name, role, pass_hash) VALUES('boss', 'Boss', 'owner', 'x')`);
  await inv.receive(part, 10, { note: 'opening' });
  const v = await insert(`INSERT INTO vans(chassis, customer, area_id) VALUES('FS-CH-1', 'A Customer', ?)`, rack);
  await insert(`INSERT INTO order_fields(van_id, label, value) VALUES(?, 'FRIDGE', 'yes')`, v);
  await inv.addLine(v, { item_id: other, qty: 1 });
  await inv.createPO({ po_no: 'FS-PO', supplier: 'Taps Co', lines: [{ item_id: other, qty: 1, van_id: v }] });
  await insert(`INSERT INTO van_notes(van_id, text) VALUES(?, 'note')`, v);
  await insert(`INSERT INTO reminders(van_id, text) VALUES(?, 'ring the customer')`, v);
  await inv.openCount(`area:${rack}`, 'Boss');
  await setSetting('plan_imported_at', '2026-10-01');
  await setSetting('dealer', 'Kept dealer name');
  assert.ok(await n('vans') && await n('van_lines') && await n('movements') && await n('purchase_orders'));
});

test('without --yes: says what would go and changes nothing', async () => {
  const v0 = await dataVersion();
  const r = await freshStart({ backupDir: tmp });
  assert.equal(r.done, false);
  assert.equal(r.before.vans, 1);
  assert.equal(r.before.items_with_stock, 1);
  assert.equal(await n('vans'), 1);
  assert.equal(await dataVersion(), v0);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('a copy that cannot be written: nothing is changed', async () => {
  const notAFolder = path.join(tmp, 'a-file');
  fs.writeFileSync(notAFolder, 'x');
  await assert.rejects(freshStart({ yes: true, backupDir: notAFolder }));
  assert.equal(await n('vans'), 1);
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', part)).on_hand, 10);
  fs.rmSync(notAFolder);
});

test('with --yes: the copy first, then no vans, every figure 0, the parts list and the rest kept', async () => {
  const v0 = Number(await dataVersion());
  const r = await freshStart({ yes: true, backupDir: tmp });
  assert.equal(r.done, true);
  for (const t of WIPED) assert.equal(await n(t), 0, t);
  assert.equal(r.after.items_with_stock, 0);
  assert.deepEqual(await get('SELECT sku, name, supplier, area_id, photo, on_hand, last_counted FROM items WHERE id = ?', part),
    { sku: 'FS-1', name: 'Tap', supplier: 'Taps Co', area_id: rack, photo: '1-1.jpg', on_hand: 0, last_counted: '' });
  assert.equal(await n('items'), 2);
  assert.ok(await get('SELECT 1 FROM rules WHERE id = ?', rule), 'rules kept');
  assert.ok(await get('SELECT 1 FROM floor_areas WHERE id = ?', rack), 'layout kept');
  assert.ok(await get('SELECT 1 FROM users WHERE id = ?', user), 'logins kept');
  assert.ok(await get(`SELECT 1 FROM suppliers WHERE name = 'Taps Co'`), 'suppliers kept');
  assert.equal(await getSetting('dealer'), 'Kept dealer name');
  assert.equal(await getSetting('plan_imported_at', 'none'), 'none');
  assert.equal(Number(await dataVersion()), v0 + 1, 'the screens see the change');
  // the copy holds every row that went
  const copy = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(copy.tables.vans[0].chassis, 'FS-CH-1');
  assert.equal(copy.tables.van_lines.length, 1);
  assert.ok(copy.tables.movements.length >= 1);
  assert.equal(copy.tables.items_stock.find(i => i.id === part).on_hand, 10);
  // and the app carries on: a new van, new stock, new movement ids above the old ones
  const v = await insert(`INSERT INTO vans(chassis) VALUES('FS-CH-1')`);
  assert.ok(v > copy.tables.vans[0].id);
  await inv.receive(part, 2, { note: 'new' });
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', part)).on_hand, 2);
});
