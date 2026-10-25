// Fewer database round trips (speed report F1–F9): each rewrite gives the same answer as the query-per-row
// code it replaced. The old code is kept here as the reference and both are run on the same small fixture.
// Runs on a new, empty in-memory database (PGlite) — never on the real data.   node --test test/
// The tests share ONE database and build on each other, top to bottom.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { run, get, all, insert, writeTx, closeDb } from '../src/db.js';
import * as inv from '../src/inventory.js';

before(freshDb);
after(closeDb);

// ── tiny fixtures ──
let n = 0;
const item = f => insert(`INSERT INTO items(sku, name, category, supplier, kind, plan_column, on_hand) VALUES(?,?,?,?,?,?,?)`,
  f.sku || `SP-${++n}`, f.name, f.category || 'General', f.supplier || '', f.kind || 'stock', f.plan_column || '', f.on_hand || 0);
const van = (chassis, status = 'planned', eta = '') => insert(`INSERT INTO vans(chassis, status, eta) VALUES(?,?,?)`, chassis, status, eta);
const line = (vanId, itemId, f = {}) => insert(`INSERT INTO van_lines(van_id, item_id, qty, reserved, reserved_firm, issued, spec, source, po_ref)
  VALUES(?,?,?,?,?,?,?, 'plan', ?)`, vanId, itemId, f.qty ?? 1, f.reserved || 0, f.firm || 0, f.issued || 0, f.spec || '', f.po_ref || '');
const po = (no, supplier, status = 'open') => insert(`INSERT INTO purchase_orders(po_no, supplier, status, ordered_at, expected) VALUES(?,?,?, '2026-10-01', '2026-11-01')`,
  no, supplier, status);

// F1: the PO look-ups of "Check: already ordered?" — one query for every group instead of two per group.
test('F1 checkOrdered: the target PO and the other open POs are the same as with one look-up per group', async () => {
  const part = await item({ name: 'F1 hinge', supplier: 'AcmeF1', kind: 'per-van' });
  const loose = await item({ name: 'F1 widget', supplier: '', kind: 'per-van', plan_column: 'Widget' });
  const v = await van('SP-F1', 'in_production', '');
  await line(v, part, { spec: 'AcmeF1 301', po_ref: '301' });
  await line(v, part, { spec: 'AcmeF1 ab7', po_ref: 'ab7' });
  await line(v, part, { spec: 'AcmeF1 999', po_ref: '999' }); // no PO with this number
  await line(v, loose, { spec: 'Order 77', po_ref: '77' }); // no supplier: never a target, other POs still shown
  // the same number for several suppliers, spaces and capitals that differ, a closed one
  const other = await po(' 301 ', 'OtherF1');
  const blank = await po('301', '');
  const mine = await po('301', 'AcmeF1');
  const mine2 = await po('301', ' acmef1 ');
  await po('301', 'AcmeF1', 'closed');
  const ab = await po('AB7', 'ACMEF1 ');
  const seven = await po('77', 'AcmeF1');

  // The code before (inventory.js, cloud @ 4585471): two queries per group.
  const oneByOne = async g => {
    const p = g.supplier ? await get(`SELECT id, po_no, supplier, ordered_at, expected FROM purchase_orders WHERE status = 'open' AND lower(trim(po_no)) = lower(?)
                                 AND lower(trim(supplier)) = lower(?) ORDER BY id LIMIT 1`, g.po_ref, g.supplier) : null;
    return {
      target: p ? { po_id: p.id, po_no: p.po_no, supplier: p.supplier, exists: 1, ordered_at: p.ordered_at || '', expected: p.expected || '' } : { po_id: null, po_no: g.po_ref, supplier: g.supplier, exists: 0 },
      open_pos: await all(`SELECT id, po_no, supplier FROM purchase_orders WHERE status = 'open' AND lower(trim(po_no)) = lower(?) ORDER BY id`, g.po_ref),
    };
  };
  const groups = await inv.checkOrdered();
  assert.ok(groups.length >= 4);
  for (const g of groups) assert.deepEqual({ target: g.target, open_pos: g.open_pos }, await oneByOne(g), g.label);

  // and what that means, so the comparison above is not about nothing
  const by = ref => groups.find(g => g.po_ref === ref);
  assert.equal(by('301').target.po_id, mine, 'the first open PO for that supplier');
  assert.deepEqual(by('301').open_pos.map(p => p.id), [other, blank, mine, mine2]);
  assert.equal(by('ab7').target.po_id, ab);
  assert.deepEqual(by('999').target, { po_id: null, po_no: '999', supplier: 'AcmeF1', exists: 0 });
  assert.deepEqual(by('999').open_pos, []);
  assert.equal(by('77').supplier, '');
  assert.equal(by('77').target.exists, 0);
  assert.deepEqual(by('77').open_pos.map(p => p.id), [seven]);
});

// F2: re-prioritise asks for free stock once for every item, and hands out only the items that have some.
test('F2 re-prioritise: the same set-asides as calling allocate for every stock item', async () => {
  const later = await van('SP-F2-LATE', 'planned', '2099-06-01');
  const first = await van('SP-F2-FIRST', 'in_production', '2026-01-10');
  const done = await van('SP-F2-DONE', 'done', '');
  const a = await item({ name: 'F2 bracket', on_hand: 3 });   // held by the later van: moves to the first
  const b = await item({ name: 'F2 screw', on_hand: 0 });     // nothing on the shelf
  const c = await item({ name: 'F2 fridge', on_hand: 2, kind: 'per-van' }); // never moved
  const d = await item({ name: 'F2 seal', on_hand: 5 });      // locked for the later van: stays, the rest is handed out
  const e = await item({ name: 'F2 rail', on_hand: 4 });      // a finished van's set-aside isn't counted: free
  await line(later, a, { qty: 2, reserved: 2 });
  await line(first, a, { qty: 2 });
  await line(first, b, { qty: 1 });
  await line(later, c, { qty: 1, reserved: 1 });
  await line(first, c, { qty: 1 });
  await line(later, d, { qty: 3, reserved: 3, firm: 2 });
  await line(first, d, { qty: 4 });
  await line(done, e, { qty: 4, reserved: 4 });
  await line(first, e, { qty: 1 });

  // The code before (inventory.js, cloud @ 4585471): allocate for every stock item; then rolled back.
  const ROLL = Symbol('roll back');
  const snapshot = () => all('SELECT id, reserved, reserved_firm FROM van_lines ORDER BY id');
  let expected;
  await writeTx(async () => {
    await run(`UPDATE van_lines SET reserved = reserved_firm
         WHERE reserved > reserved_firm AND van_id IN (SELECT id FROM vans v WHERE v.status IN ('planned','in_production'))
           AND item_id IN (SELECT id FROM items WHERE kind = 'stock')`);
    for (const { id } of await all(`SELECT id FROM items WHERE kind = 'stock' ORDER BY id`)) await inv.allocateItem(id, null, { reason: '' });
    expected = await snapshot();
    throw ROLL;
  }).catch(err => { if (err !== ROLL) throw err; });

  const before = await snapshot();
  assert.notDeepEqual(expected, before, 'the fixture has something to move');
  const preview = await inv.reprioritisePreview();
  assert.deepEqual(await snapshot(), before, 'the preview keeps nothing');
  const done1 = await inv.reprioritiseAll({ by: 'Test' });
  assert.deepEqual(done1, preview);
  assert.deepEqual(await snapshot(), expected);
  // and what that means
  const held = async (vanId, itemId) => (await get('SELECT reserved FROM van_lines WHERE van_id = ? AND item_id = ?', vanId, itemId)).reserved;
  assert.equal(await held(first, a), 2);
  assert.equal(await held(later, a), 1);
  assert.equal(await held(later, c), 1);
  assert.equal(await held(later, d), 2);
  assert.equal(await held(first, d), 3);
  assert.equal(await held(first, e), 1);
});
