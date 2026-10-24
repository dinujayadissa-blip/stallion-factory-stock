// relink, trades, layout, golive and the Excel export over the async database layer (PGlite in memory, real migrations).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { get, all, run, insert, writeTx, closeDb } from '../src/db.js';
import { suggestionsFor, partsFor, vanParts, addTextParts, linkLine, linkPreview, makeOneOff, dealerNames, notAPart, ensureNewItems } from '../src/relink.js';
import { assignMissingTrades } from '../src/trades.js';
import * as layout from '../src/layout.js';

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

// ── Task 4b: layout, golive, exportXlsx ──

test('layout save and load round-trip', async () => {
  await layout.seedLayout();
  const first = await layout.getLayout();
  assert.ok(first.areas.length > 10);
  assert.equal(await getSettingValue('layout_seeded'), '2');
  await layout.seedLayout(); // seeding twice adds nothing
  assert.equal((await layout.getLayout()).areas.length, first.areas.length);

  // add, change and read an area back (sizes are rounded to 2 places)
  const { id } = await layout.saveArea(null, { kind: 'bay', name: 'Bay 9', x: 1.234, y: 2, w: 3.2, h: 9.2 });
  assert.equal(typeof id, 'number');
  await layout.saveArea(id, { name: 'Bay Nine', x: 5 });
  const saved = (await layout.getLayout()).areas.find(a => a.id === id);
  assert.deepEqual([saved.kind, saved.name, saved.x, saved.y, saved.w, saved.h], ['bay', 'Bay Nine', 5, 2, 3.2, 9.2]);
  await assert.rejects(() => layout.saveArea(id, { w: 0.1 }), /Too small/);
  await assert.rejects(() => layout.saveArea(999999, { name: 'x' }), /not found/);

  // park a van, swap with another, move the line along, leave the factory
  const a = await newVan('ST0101'); const b = await newVan('ST0102');
  const bay = (await all(`SELECT id FROM floor_areas WHERE name = 'Bay 1'`))[0].id;
  const bay2 = (await all(`SELECT id FROM floor_areas WHERE name = 'Bay 2'`))[0].id;
  assert.deepEqual(await layout.moveVan(a, bay), { swapped: null });
  assert.equal((await get('SELECT status FROM vans WHERE id = ?', a)).status, 'in_production');
  assert.deepEqual(await layout.moveVan(b, bay), { swapped: 'ST0101' });
  assert.equal((await get('SELECT area_id FROM vans WHERE id = ?', a)).area_id, null);
  const dry = await layout.advanceLine({ dryRun: true });
  assert.deepEqual(dry.moves, [{ chassis: 'ST0102', from: 'Bay 1', to: 'Bay 2' }]);
  assert.equal((await get('SELECT area_id FROM vans WHERE id = ?', b)).area_id, bay);
  await assert.rejects(() => layout.advanceLine({ expect: [] }), /already moved/);
  assert.equal((await get('SELECT area_id FROM vans WHERE id = ?', b)).area_id, bay); // rolled back
  await layout.advanceLine({ nextVanId: a, expect: dry.moves.concat([{ chassis: 'ST0101', from: null, to: 'Bay 1' }]) });
  assert.equal((await get('SELECT area_id FROM vans WHERE id = ?', b)).area_id, bay2);
  assert.equal((await get('SELECT area_id FROM vans WHERE id = ?', a)).area_id, bay);

  // notes and reminders
  await layout.addNote(a, 'Check the window', 'Sam');
  const due = (await layout.addReminder({ van_id: a, text: 'Call the dealer', due: '2000-01-01' }, 'Sam')).id;
  await layout.addReminder({ van_id: b, text: 'Order paint' });
  const info = await layout.vanFloorInfo(a);
  assert.equal(info.notes.length, 1);
  assert.equal(info.reminders[0].text, 'Call the dealer');
  const map = await layout.getLayout();
  const va = map.vans.find(v => v.id === a);
  assert.deepEqual([va.notes, va.reminders, va.due], [1, 1, 1]);
  assert.equal((await layout.openReminders()).length, 2);
  await layout.setReminderDone(due, true);
  assert.match((await get('SELECT done_at FROM reminders WHERE id = ?', due)).done_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal((await layout.floorMap('all')).vans.find(v => v.id === a).reminders, 0);

  await layout.leaveFactory(a);
  const gone = await get('SELECT status, area_id FROM vans WHERE id = ?', a);
  assert.deepEqual([gone.status, gone.area_id], ['completed', null]);

  // an area that stops being a parking spot empties; deleting an area frees its vans and items
  await layout.saveArea(bay2, { kind: 'work' });
  assert.equal((await get('SELECT area_id FROM vans WHERE id = ?', b)).area_id, null);
  await layout.deleteArea(id);
  assert.equal((await layout.getLayout()).areas.find(x => x.id === id), undefined);
});

test('drawing reminders are added once per order line', async () => {
  const van = await newVan('ST0103');
  await run(`INSERT INTO order_fields(van_id, section, label, value, sort) VALUES(?, 'EXTRAS', 'AWNING', 'as per drawing 12', 1)`, van);
  assert.equal(await layout.drawingReminders(van), 1);
  assert.equal(await layout.drawingReminders(van), 0);
  assert.equal((await get('SELECT source, text FROM reminders WHERE van_id = ?', van)).source, 'drawing:AWNING');
  assert.equal(await layout.drawingRemindersAll(), 0);
  const id = (await get('SELECT id FROM reminders WHERE van_id = ?', van)).id;
  await layout.deleteReminder(id); // an automatic one is ticked off, not deleted
  assert.equal((await get('SELECT done FROM reminders WHERE id = ?', id)).done, 1);
  // a customer-supplies reminder: once per option, updated if the wording changes
  await run(`INSERT INTO order_fields(van_id, section, label, value, sort) VALUES(?, 'EXTRAS', 'JOCKEY WHEEL', 'customer sending one', 2)`, van);
  const pick = [{ label: 'JOCKEY WHEEL', value: 'customer sending one' }];
  assert.equal(await layout.customerReminders(van, pick), 1);
  assert.equal(await layout.customerReminders(van, pick), 0);
});

test('go-live checklist reads the database and does not need tidy or importPlan', async () => {
  const { goLive } = await import('../src/golive.js');
  const g = await goLive();
  assert.deepEqual(g.steps.map(s => s.key), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(g.steps[0].done, true);   // clean-up and plan import are done on the sqlite-final checkout
  assert.equal(g.conflicts, 0);
  assert.equal(g.steps[1].done, true);   // no vans, so no due dates to check
});

test('excel export has one row per van', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const { exportWorkbook } = await import('../src/exportXlsx.js');
  const v1 = await newVan('ST0201'); const v2 = await newVan('ST0202');
  await run(`UPDATE vans SET eta = '2026-11-05', length = '17', model = 'Tourer' WHERE id = ?`, v1);
  const part = await newItem('SKU-X', 'Test part', { supplier: 'Acme Supply', on_hand: 3 });
  await newLine(v1, part, { qty: 2, reserved: 2 });
  await newLine(v2, part, { qty: 1 });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await exportWorkbook());
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Production Plan', 'Van Parts', 'To Order', 'Open POs', 'Stock']);
  const plan = wb.getWorksheet('Production Plan');
  assert.equal(plan.rowCount, 2 + 2); // legend row, header row, one row per van
  assert.deepEqual([plan.getCell(3, 1).value, plan.getCell(4, 1).value].sort(), ['ST0201', 'ST0202']);
  const row1 = [3, 4].map(r => plan.getRow(r)).find(r => r.getCell(1).value === 'ST0201');
  assert.equal(row1.getCell(2).value, '17 Tourer');
  assert.equal(row1.getCell(3).value.toISOString().slice(0, 10), '2026-11-05');
  assert.equal(wb.getWorksheet('Van Parts').rowCount, 1 + 2);
  const stock = wb.getWorksheet('Stock');
  assert.equal(stock.rowCount, 1 + 1);
  assert.equal(stock.getCell(2, 1).value, 'SKU-X');
});

async function getSettingValue(k) { return (await get('SELECT value FROM settings WHERE key = ?', k))?.value; }

test('van panel and trade map: counts are numbers, the casts resolve', async () => {
  await layout.seedLayout();
  const van = await newVan('ST0301');
  const part = await newItem('LED-9', 'LED strip light', { on_hand: 0 });
  await run(`UPDATE items SET trade = 'electrician' WHERE id = ?`, part);
  await newLine(van, part, { qty: 2 });
  await run(`INSERT INTO purchase_orders(po_no, status) VALUES('PO-1', 'open')`);
  const po = (await get(`SELECT id FROM purchase_orders WHERE po_no = 'PO-1'`)).id;
  await run('INSERT INTO po_lines(po_id, item_id, qty, van_id) VALUES(?, ?, 2, ?)', po, part, van);
  const info = await layout.vanFloorInfo(van);
  assert.deepEqual([info.total, info.done, info.reminderLines], [1, 0, 0]);
  assert.equal(info.notInFactory.length, 1);
  assert.equal(info.notInFactory[0].on_order, 1);
  const all_ = (await layout.floorMap('all')).vans.find(v => v.id === van);
  const elec = (await layout.floorMap('electrician')).vans.find(v => v.id === van);
  const plumb = (await layout.floorMap('plumber')).vans.find(v => v.id === van);
  assert.deepEqual([all_.missing, elec.missing, plumb.missing], [1, 1, 0]);
  assert.equal(typeof all_.still.missing, 'number');
  // the export reads the open order too
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await (await import('../src/exportXlsx.js')).exportWorkbook());
  assert.equal(wb.getWorksheet('Open POs').rowCount, 2);
  assert.equal(wb.getWorksheet('Open POs').getCell(2, 1).value, 'PO-1');
  assert.equal((await layout.areaItems((await all('SELECT id FROM floor_areas'))[0].id)).items.length, 0);
});

test('go-live checklist counts bays, racks and open order questions', async () => {
  const { goLive } = await import('../src/golive.js');
  await layout.seedLayout();
  const van = await newVan('ST0302');
  await run(`UPDATE vans SET status = 'in_production' WHERE id = ?`, van);
  const bay = (await get(`SELECT id FROM floor_areas WHERE name = 'Bay 1'`)).id;
  await layout.moveVan(van, bay);
  const rack = (await get(`SELECT id FROM floor_areas WHERE name = 'Rack A'`)).id;
  const part = await newItem('SCREW-1', 'Screws', { on_hand: 10 });
  await run(`UPDATE items SET area_id = ?, kind = 'stock' WHERE id = ?`, rack, part);
  const g = await goLive();
  const c = g.steps.find(s => s.key === 'c');
  assert.deepEqual(c.vans.map(v => [v.chassis, v.bay, v.checked]), [['ST0302', 'Bay 1', false]]);
  assert.equal(c.done, false);
  const e = g.steps.find(s => s.key === 'e');
  assert.deepEqual(e.places.map(p => [p.name, p.items, p.left]), [['Rack A', 1, 1]]);
  assert.equal(g.counted, false);
  assert.equal(g.done, false);
});
