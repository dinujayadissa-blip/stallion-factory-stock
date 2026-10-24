// Follow-up round 1, planner batch (planner-r3-4, planner-r3-5). Runs on a new, empty in-memory database
// (PGlite) — never on the real data.   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { run, get, insert, closeDb } from '../src/db.js';
import * as inv from '../src/inventory.js';
import { textParts, skuNow, skuNames } from '../src/relink.js';

before(freshDb);
after(closeDb);

// src/tidy.js (the one-off clean-up steps) stays on SQLite: it runs on the home PC copy before the move
// (tag sqlite-final) and is never ported to Postgres, so its step tests can't run here.
const TIDY_SQLITE_ONLY = 'src/tidy.js is SQLite-only (sqlite-final tag), not ported to Postgres';

test('planner-r3-5: two model numbers with no separator are two parts, even when one is stuck to a word', () => {
  assert.deepEqual(textParts('kitchen pr7350 vanitypr7155'), ['kitchen pr7350', 'vanity pr7155']);
  assert.deepEqual(textParts('brushed stainless kitchen pr7350 vanitypr7155'), ['brushed stainless kitchen pr7350', 'vanity pr7155']);
  assert.deepEqual(textParts('Gold kitchen pr7830 vanity pr7820'), ['Gold kitchen pr7830', 'vanity pr7820']);
  // as before
  assert.deepEqual(textParts('pr7350 and pr7320'), ['pr7350', 'pr7320']);
  assert.deepEqual(textParts('induction cooker + CAMEC MICROWAVE 28LTR'), ['induction cooker', 'CAMEC MICROWAVE 28LTR']);
  // not two parts: the same number twice, sizes, a van number, an order number, a supplier
  for (const t of ['pr7350 pr7350', '345 H x 645 W - 3/ 345 H x 1015 W', 'LED 450 x450MM Ranger102', 'AS PER ST0339 STAINLESS STEEL 440MM X 380MM WIDE Nikpol order 08',
    'Smooth Single slide on awning side Gcc2404 Order141', 'Aussies( 2 x 1000 x 800, 1 x 1200 x 500) Gold', 'L & S 150', 'Double Axel 141'])
    assert.deepEqual(textParts(t), [], t);
});

test('planner-r3-4: PLAN-ROOF-BAW becomes PLAN-ROOF-BOW, keeps its lines, and the old code still finds it', { skip: TIDY_SQLITE_ONLY }, async () => {
  const { STEPS } = await import('../src/tidy.js');
  assert.equal(skuNow('plan-roof-baw'), 'PLAN-ROOF-BOW');
  assert.equal(skuNow('PLAN-FRIDGE'), 'PLAN-FRIDGE');
  assert.deepEqual(skuNames('PLAN-ROOF-BOW'), ['PLAN-ROOF-BOW', 'PLAN-ROOF-BAW']);
  const id = await insert(`INSERT INTO items(sku, name, category, kind, plan_column, placeholder, notes) VALUES('PLAN-ROOF-BAW', 'Roof Baw (as per plan)', 'As per plan', 'per-van', 'Roof Baw', 1, 'Created by the import')`);
  const vanId = await insert(`INSERT INTO vans(chassis, status) VALUES('ST9001', 'planned')`);
  const ln = await insert(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, plan_column) VALUES(?, ?, 4, 'Nce 121', 'plan', 'Roof Baw')`, vanId, id);
  const step = STEPS.find(s => s.key === 'sku_fix');
  assert.equal(await step.run(), 1);
  const it = await get('SELECT * FROM items WHERE id = ?', id);
  assert.equal(it.sku, 'PLAN-ROOF-BOW');
  assert.equal(it.name, 'Roof Bow (as per plan)');
  assert.match(it.notes, /^Created by the import · part code was PLAN-ROOF-BAW \(typo fixed\)$/);
  assert.equal((await get('SELECT item_id FROM van_lines WHERE id = ?', ln)).item_id, id);
  assert.ok(await get(`SELECT 1 FROM allocation_log WHERE reason = 'tidy:sku_fix' AND before = 'PLAN-ROOF-BAW' AND after = 'PLAN-ROOF-BOW'`));
  assert.equal(await step.run(), 0, 'safe to run twice');
  // a stock count sheet with the old code still finds the part
  assert.deepEqual(await inv.stocktake([{ sku: 'plan-roof-baw', qty: 0 }]), { updated: 1, unknown: [] });
});

// The part of planner-r3-4 that is the stock logic's own (inventory.js), without the SQLite-only tidy step:
// the part already has its new code, and a count sheet with the OLD code still finds it.
test('planner-r3-4: a stock count sheet with the old code PLAN-ROOF-BAW still finds PLAN-ROOF-BOW', async () => {
  assert.equal(skuNow('plan-roof-baw'), 'PLAN-ROOF-BOW');
  assert.equal(skuNow('PLAN-FRIDGE'), 'PLAN-FRIDGE');
  assert.deepEqual(skuNames('PLAN-ROOF-BOW'), ['PLAN-ROOF-BOW', 'PLAN-ROOF-BAW']);
  const id = await insert(`INSERT INTO items(sku, name, category, kind, plan_column, placeholder) VALUES('PLAN-ROOF-BOW', 'Roof Bow (as per plan)', 'As per plan', 'per-van', 'Roof Bow', 1)`);
  await run(`UPDATE items SET on_hand = 2 WHERE id = ?`, id);
  assert.deepEqual(await inv.stocktake([{ sku: 'plan-roof-baw', qty: 0 }]), { updated: 1, unknown: [] });
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', id)).on_hand, 0);
  assert.deepEqual(await inv.stocktake([{ sku: 'NO-SUCH-PART', qty: 1 }]), { updated: 0, unknown: ['NO-SUCH-PART'] });
});

test('planner-r3-4: when the new code is already taken, nothing is renamed and the report says so', { skip: TIDY_SQLITE_ONLY }, async () => {
  const { STEPS } = await import('../src/tidy.js');
  await run(`UPDATE items SET sku = 'PLAN-ROOF-BAW' WHERE sku = 'PLAN-ROOF-BOW'`);
  const other = await insert(`INSERT INTO items(sku, name, category, kind, placeholder) VALUES('PLAN-ROOF-BOW', 'Someone else', 'As per plan', 'per-van', 1)`);
  assert.equal(await STEPS.find(s => s.key === 'sku_fix').run(), 0);
  assert.ok(await get(`SELECT 1 FROM items WHERE sku = 'PLAN-ROOF-BAW'`));
  assert.equal((await get('SELECT name FROM items WHERE id = ?', other)).name, 'Someone else');
  assert.ok(await get(`SELECT 1 FROM allocation_log WHERE reason = 'tidy:sku_fix' AND field = 'flag'`));
});
