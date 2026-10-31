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

