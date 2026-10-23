// relink.js and trades.js over the async database layer (PGlite in memory, real migrations).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { get, all, run, insert, writeTx, closeDb } from '../src/db.js';
import { suggestionsFor, partsFor, vanParts, addTextParts, linkLine, linkPreview, makeOneOff, dealerNames, notAPart, ensureNewItems } from '../src/relink.js';
import { assignMissingTrades } from '../src/trades.js';

beforeEach(freshDb);
after(closeDb);

const newVan = chassis => insert('INSERT INTO vans(chassis, dealer) VALUES(?, ?)', chassis, 'Example Trading Centre');
const newItem = (sku, name, extra = {}) => insert(
  'INSERT INTO items(sku, name, supplier, plan_column, placeholder, on_hand) VALUES(?, ?, ?, ?, ?, ?)',
  sku, name, extra.supplier || '', extra.plan_column || '', extra.placeholder || 0, extra.on_hand || 0);
const newLine = (van, item, extra = {}) => insert(
  'INSERT INTO van_lines(van_id, item_id, qty, reserved, spec, plan_column) VALUES(?, ?, ?, ?, ?, ?)',
  van, item, extra.qty ?? 1, extra.reserved ?? 0, extra.spec || '', extra.plan_column || '');

test('relink suggestions refresh after a supplier change', async () => {
  const van = await newVan('ST0001');
  const ph = await newItem('PLAN-PELMET', 'Pelmet (as per plan)', { placeholder: 1, plan_column: 'Pelmet' });
  const real = await newItem('NIK-RAIL', 'Nikpol sliding rail', { plan_column: 'Pelmet' });
  const lineId = await newLine(van, ph, { spec: 'Nikpol 13', plan_column: 'Pelmet' });
  const line = { id: lineId, van_id: van, sku: 'PLAN-PELMET', name: 'Pelmet (as per plan)', spec: 'Nikpol 13', plan_column: 'Pelmet' };

  // No supplier is called Nikpol yet, so "Nikpol" is an ordinary word of the part's name.
  const before = (await suggestionsFor([line])).get(lineId);
  assert.equal(before.suggest?.item_id, real);

  // The office adds the supplier (as the app does, inside writeTx). A brand name alone is never a match,
  // and the next call must see that without any restart.
  await writeTx(() => run(`INSERT INTO suppliers(name) VALUES('Nikpol')`));
  const after = (await suggestionsFor([line])).get(lineId);
  assert.equal(after.suggest, null);
});

test('linkLine moves a placeholder line onto a real part and logs it', async () => {
  const van = await newVan('ST0002');
  const ph = await newItem('PLAN-FRIDGE', 'Fridge (as per plan)', { placeholder: 1, on_hand: 5 });
  const real = await newItem('FRIDGE-DOM-220', 'Dometic 220L fridge');
  const lineId = await newLine(van, ph, { qty: 2, reserved: 2, spec: 'dometic 220' });
  const prev = await linkPreview([lineId], real);
  assert.equal(prev[0].result, 'link');
  const r = await linkLine(lineId, real, { worker: 'Test' });
  assert.deepEqual([r.result, r.moved], ['linked', 2]);
  const l = await get('SELECT item_id, reserved, note FROM van_lines WHERE id = ?', lineId);
  assert.equal(l.item_id, real);
  assert.match(l.note, /was PLAN-FRIDGE/);
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', ph)).on_hand, 3);
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', real)).on_hand, 2);
  assert.equal((await all(`SELECT 1 FROM movements WHERE type = 'adjust'`)).length, 2);
});

test('linkLine merges into the van\'s existing line (UPDATE with GREATEST/LEAST/strpos)', async () => {
  const van = await newVan('ST0003');
  const ph = await newItem('PLAN-FRIDGE', 'Fridge (as per plan)', { placeholder: 1, on_hand: 5 });
  const real = await newItem('FRIDGE-DOM-190', 'Dometic 190L fridge');
  const plan = await newLine(van, ph, { qty: 1, reserved: 1, spec: 'dometic 190' });
  const own = await newLine(van, real, { qty: 1 });
  await run(`UPDATE van_lines SET po_ref = 'Order 7' WHERE id = ?`, plan);
  await run(`UPDATE van_lines SET po_ref = 'Order 3' WHERE id = ?`, own);
  const r = await linkLine(plan, real, { reason: 'link' });
  assert.equal(r.result, 'merged');
  assert.equal(await get('SELECT 1 AS x FROM van_lines WHERE id = ?', plan), undefined);
  const m = await get('SELECT qty, reserved, reserved_firm, po_ref, note FROM van_lines WHERE id = ?', own);
  assert.equal(m.reserved, 1);
  assert.equal(m.po_ref, 'Order 3, Order 7'); // the plan line's order reference is added
  assert.match(m.note, /merged from the plan line/);
});

test('makeOneOff creates a one-off part and links the line to it', async () => {
  const van = await newVan('ST0004');
  const ph = await newItem('PLAN-TOOL-BOX', 'Tool box (as per plan)', { placeholder: 1, plan_column: 'Tool box' });
  const lineId = await newLine(van, ph, { spec: 'special box', plan_column: 'Tool box' });
  const r = await makeOneOff(lineId, { supplier: 'Acme', worker: 'Test' });
  assert.equal(r.result, 'linked');
  assert.match(r.sku, /^ONEOFF-ST0004-/);
  assert.equal((await get('SELECT item_id FROM van_lines WHERE id = ?', lineId)).item_id, r.item_id);
});

test('ensureNewItems creates missing recurring parts once; dealerNames / notAPart', async () => {
  await newItem('PLAN-COOKER', 'Cooker (as per plan)', { placeholder: 1, plan_column: 'Cooker' });
  const made = await ensureNewItems();
  assert.ok(made.includes('OVEN-SWIFT-FULL'));
  assert.deepEqual(await ensureNewItems().then(m => m.includes('OVEN-SWIFT-FULL')), false);
  await newVan('ST0005');
  const dealers = await dealerNames();
  assert.ok(dealers.has('example trading centre'));
  assert.equal(notAPart('Example Trading Centre', dealers), "the dealer's name, not a part");
  assert.equal(notAPart('Fridge', dealers), '');
});

test('assignMissingTrades guesses a trade for items without one', async () => {
  await newItem('LED-1', 'LED strip light');
  await newItem('TAP-1', 'Kitchen tap');
  assert.equal(await assignMissingTrades(), 2);
  assert.equal((await get(`SELECT trade FROM items WHERE sku = 'LED-1'`)).trade, 'electrician');
  assert.equal((await get(`SELECT trade FROM items WHERE sku = 'TAP-1'`)).trade, 'plumber');
  assert.equal(await assignMissingTrades(), 0);
});

test('a plan text that names several parts: partsFor suggests each, addTextParts adds them', async () => {
  const van = await newVan('ST0006');
  const ph = await newItem('PLAN-COOKER', 'Cooker (as per plan)', { placeholder: 1, plan_column: 'Cooker' });
  const hob = await newItem('COOKER-INDUCTION', 'Induction cooker', { plan_column: 'Cooker' });
  const mw = await newItem('MW-CAMEC-28', 'Camec microwave 28L', { plan_column: 'Cooker' });
  const spec = 'induction cooker + CAMEC MICROWAVE 28LTR';
  const lineId = await newLine(van, ph, { spec, plan_column: 'Cooker' });
  const line = { id: lineId, van_id: van, sku: 'PLAN-COOKER', name: 'Cooker (as per plan)', spec, plan_column: 'Cooker', qty: 1, reserved: 0, reserved_firm: 0, issued: 0, note: '' };
  const bits = await partsFor(line);
  assert.equal(bits.length, 2);
  assert.deepEqual(bits.map(b => b.suggest?.item_id), [hob, mw]);
  const r = await addTextParts(lineId, bits.map(b => ({ text: b.text, item_id: b.suggest.item_id })), { worker: 'Test' });
  assert.deepEqual([r.added, r.linked, r.result], [1, 1, 'linked']);
  assert.equal((await all('SELECT item_id FROM van_lines WHERE van_id = ? ORDER BY item_id', van)).length, 2);
  // done now: both parts are on the van
  const again = await partsFor({ ...line, id: null }, { onVan: (await vanParts([van])).get(van) });
  assert.ok(again === null || again.every(b => b.on_van));
});
