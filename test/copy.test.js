// scripts/copy-to-cloud.js: SQLite factory.db -> Postgres (here an on-disk PGlite in a temp folder).
// Every source is a small synthetic db built with the sqlite-final schema (the SQLite code as it was
// before the cloud move) — never real data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeDriver } from '../src/pg.js';
import { copyAll, formatReport } from '../scripts/copy-to-cloud.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = path.join(ROOT, 'scripts', 'sqlite-final', 'db.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-copy-test-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const tmp = name => fs.mkdtempSync(path.join(tmpRoot, `${name}-${++n}-`));

// The sqlite-final db.js, from the tag when this checkout has it (the vendored copy otherwise).
function sqliteFinalDbJs() {
  try {
    return execFileSync('git', ['show', 'sqlite-final:src/db.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return fs.readFileSync(VENDORED, 'utf8'); }
}

// A factory.db with the sqlite-final schema: its db.js run once with DATA_DIR = dir.
function sqliteFinalDb(dir) {
  fs.writeFileSync(path.join(dir, 'olddb.mjs'), sqliteFinalDbJs());
  fs.writeFileSync(path.join(dir, 'make.mjs'), `const m = await import('./olddb.mjs'); m.db.exec('PRAGMA journal_mode = DELETE'); m.db.close();\n`);
  execFileSync(process.execPath, [path.join(dir, 'make.mjs')], { env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore' });
  return path.join(dir, 'factory.db');
}

// Small synthetic data touching every table the checks look at.
function fill(file) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA foreign_keys = ON');
  d.exec(`
    INSERT INTO floor_areas(id, kind, name, x, y, w, h) VALUES (1, 'bay', 'Bay 1', 0, 0, 4.5, 12.25), (2, 'storage', 'Rack A', 10, 0, 2, 1);
    INSERT INTO items(id, sku, name, supplier, on_hand, reorder_level, area_id, unit_size, order_up_to, photo)
      VALUES (3, 'TST-1', 'Test Part One', 'Test Supplier', 12.5, 2, 2, '1 length = 6.5 m', 10, '3-100.jpg'),
             (7, 'TST-2', 'Test Part Two', '', 0.1, 0, NULL, '', 0, '');
    INSERT INTO rules(id, name, conditions, item_id, qty) VALUES (4, 'Test rule', '*', 3, '2');
    INSERT INTO vans(id, chassis, customer, dealer, status, area_id, build_order)
      VALUES (10, 'TEST-CH-1', 'Test Customer', 'Test Dealer', 'in_production', 1, NULL),
             (11, 'TEST-CH-2', 'Test Customer Two', 'Test Dealer', 'planned', NULL, 2);
    INSERT INTO order_fields(id, van_id, section, label, value) VALUES (20, 10, 'Main', 'Colour', 'White');
    INSERT INTO van_lines(id, van_id, item_id, qty, reserved, reserved_firm, issued, plan_column, merged_cols)
      VALUES (30, 10, 3, 4, 3, 1.5, 1, 'Battery', '["Battery"]'), (31, 10, 7, 1, 0.1, 0, 0, '', ''),
             (32, 11, 3, 2, 2, 2, 0, '', '');
    INSERT INTO purchase_orders(id, po_no, supplier, ordered_at) VALUES (40, 'PO-T1', 'Test Supplier', '2026-10-01');
    INSERT INTO po_lines(id, po_id, item_id, qty, received, closed, van_id, spec) VALUES (41, 40, 3, 10, 4, 1.5, 10, 'Grey'), (42, 40, 7, 3, 0, 0, NULL, '');
    INSERT INTO movements(id, item_id, qty, type, van_id, at, worker, ack) VALUES
      (1, 3, 5, 'receive', NULL, '2026-10-01 09:00:00', 'Test Worker', 1),
      (2, 3, -1, 'issue', 10, '2026-10-02 09:00:00', 'Test Worker', 0),
      (5, 7, 0.1, 'count', NULL, '2026-10-03 09:00:00', '', 0),
      (12, 7, 1, 'issue', 10, '2026-10-04 09:00:00', '', 0);
    DELETE FROM movements WHERE id = 12; -- an undone take: its number must never come back
    INSERT INTO settings(key, value) VALUES ('test_flag', '1'), ('golive_done', '{"a":1}');
    INSERT INTO van_notes(id, van_id, text, worker) VALUES (50, 10, 'Test note', 'Test Worker');
    INSERT INTO reminders(id, van_id, text, source, trade) VALUES (60, 10, 'Test reminder', 'drawing:1', 'builder');
    INSERT INTO allocation_log(id, reason, van_id, item_id, line_id, field, before, after, change, firm_change, ack)
      VALUES (70, 'reprioritise', 10, 3, 30, 'reserved', '2', '3', 1, NULL, 0);
    INSERT INTO count_sessions(id, scope, label, last_move_id, expected) VALUES (80, 'area:2', 'Rack A', 9, '{"3":12.5}');
    INSERT INTO suppliers(name, lead_days, lead_confirmed) VALUES ('Test Supplier', 21, 1) ON CONFLICT(name) DO UPDATE SET lead_days = 21, lead_confirmed = 1;
    INSERT INTO users(id, username, name, role, trade, pass_hash, must_change)
      VALUES (90, 'TestOwner', 'Test Owner', 'owner', '', 'scrypt$16384$8$1$c2FsdA==$aGFzaC1vbmU=', 0),
             (91, 'testworker', 'Test Worker', 'worker', 'builder', 'scrypt$16384$8$1$c2FsdDI=$aGFzaC10d28=', 1);
    INSERT INTO sessions(token_hash, user_id, created_at, last_seen, expires_at, ip, ua)
      VALUES ('ab12', 90, 1761260000000, 1761260000500, 1763852000500, '127.0.0.1', 'test');
  `);
  d.close();
}

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function withTarget(dir, fn) {
  const d = await makeDriver({ pgliteDir: dir });
  try { return await fn(d); } finally { await d.close(); }
}
const rows = async (d, sql, p = []) => (await d.query(sql, p)).rows;

// One source db, built once and shared by the tests (none of them may change it).
const srcDir = tmp('src');
const SRC = sqliteFinalDb(srcDir);
fill(SRC);

test('vendored sqlite-final db.js is the tagged one', () => {
  let tagged;
  try { tagged = execFileSync('git', ['show', 'sqlite-final:src/db.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return; } // a checkout without the (local-only) tag: nothing to compare with
  assert.equal(fs.readFileSync(VENDORED, 'utf8').replace(/\r\n/g, '\n'), tagged.replace(/\r\n/g, '\n'));
});

test('copy matches every check', async () => {
  const before = sha(SRC);
  const to = path.join(tmp('to'), 'pg');
  const report = await copyAll({ from: SRC, prepare: false, to });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)));
  assert.equal(sha(SRC), before, 'the source file is never changed');

  const t = Object.fromEntries(report.tables.map(x => [x.name, x]));
  for (const name of ['items', 'rules', 'vans', 'order_fields', 'van_lines', 'purchase_orders', 'po_lines', 'movements',
    'settings', 'floor_areas', 'van_notes', 'reminders', 'allocation_log', 'count_sessions', 'suppliers', 'users', 'sessions']) {
    assert.ok(t[name], `report lists ${name}`);
    assert.equal(t[name].to, t[name].from, name);
  }
  assert.equal(t.movements.from, 3);
  assert.equal(t.users.from, 2);
  assert.ok(!t.sqlite_sequence, 'sqlite_sequence is not copied');
  for (const name of ['on_hand per item', 'reserved per van', 'reserved_firm per van', 'open qty per PO line', 'users', 'users pass_hash']) {
    assert.ok(report.checks.some(c => c.name === name && c.ok), `check ${name}`);
  }
  assert.ok(report.checks.every(c => c.ok));

  await withTarget(to, async d => {
    assert.deepEqual(await rows(d, 'SELECT id, pass_hash FROM users ORDER BY id'), [
      { id: 90, pass_hash: 'scrypt$16384$8$1$c2FsdA==$aGFzaC1vbmU=' }, { id: 91, pass_hash: 'scrypt$16384$8$1$c2FsdDI=$aGFzaC10d28=' }]);
    assert.deepEqual(await rows(d, 'SELECT id, on_hand FROM items ORDER BY id'), [{ id: 3, on_hand: 12.5 }, { id: 7, on_hand: 0.1 }]);
    const [line] = await rows(d, 'SELECT reserved, reserved_firm, merged_cols FROM van_lines WHERE id = 30');
    assert.deepEqual(line, { reserved: 3, reserved_firm: 1.5, merged_cols: '["Battery"]' });
    const [s] = await rows(d, 'SELECT created_at, expires_at FROM sessions');
    assert.deepEqual(s, { created_at: 1761260000000, expires_at: 1763852000500 });
    assert.equal((await rows(d, `SELECT value FROM settings WHERE key = 'golive_done'`))[0].value, '{"a":1}');
    // the load counts as one write: screens see the data version move
    assert.equal((await rows(d, `SELECT value FROM settings WHERE key = 'data_version'`))[0].value, '1');
    // every identity restarts above the copied ids
    assert.equal((await rows(d, `INSERT INTO items(sku, name) VALUES('TST-NEW', 'New') RETURNING id`))[0].id, 8);
    assert.equal((await rows(d, `INSERT INTO vans(chassis) VALUES('TEST-NEW') RETURNING id`))[0].id, 12);
  });
});

test('refuses a non-empty target without --wipe', async () => {
  const to = path.join(tmp('to'), 'pg');
  assert.equal((await copyAll({ from: SRC, prepare: false, to })).ok, true);
  await assert.rejects(copyAll({ from: SRC, prepare: false, to }), /not empty.*--wipe/s);
  await withTarget(to, async d => {
    assert.equal((await rows(d, 'SELECT COUNT(*) AS n FROM vans'))[0].n, 2, 'left as it was');
    await d.query(`INSERT INTO vans(chassis) VALUES('TEST-EXTRA')`);
  });
  const report = await copyAll({ from: SRC, prepare: false, to, wipe: true });
  assert.equal(report.ok, true);
  assert.equal(report.tables.find(x => x.name === 'vans').to, 2, 'wiped first, not added on top');
  await withTarget(to, async d => {
    assert.equal((await rows(d, `SELECT COUNT(*) AS n FROM vans WHERE chassis = 'TEST-EXTRA'`))[0].n, 0);
    assert.equal((await rows(d, `SELECT value FROM settings WHERE key = 'data_version'`))[0].value, '2', 'the version keeps going up');
  });
});

test('next movement id is above every copied one', async () => {
  // copied ids go up to 5, a count noted movement 9, and the undone movement 12 had been given out
  const to = path.join(tmp('to'), 'pg');
  const report = await copyAll({ from: SRC, prepare: false, to });
  assert.ok(report.checks.some(c => c.name === 'next movement id' && c.ok && c.to === 13));
  await withTarget(to, async d => {
    const [m] = await rows(d, `INSERT INTO movements(item_id, qty, type) VALUES(3, 1, 'receive') RETURNING id`);
    assert.equal(m.id, 13);
  });
});

test('a database behind the code is brought up to date on a temporary copy first', async () => {
  // only the very first tables, as the first release made them: no users, no newer columns
  const dir = tmp('old');
  const from = path.join(dir, 'factory.db');
  const d = new DatabaseSync(from);
  d.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
      supplier TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'ea', kind TEXT NOT NULL DEFAULT 'stock', on_hand REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 0, location TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE vans (id INTEGER PRIMARY KEY, chassis TEXT UNIQUE NOT NULL, customer TEXT NOT NULL DEFAULT '', dealer TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', length TEXT NOT NULL DEFAULT '', floor_plan TEXT NOT NULL DEFAULT '', colour TEXT NOT NULL DEFAULT '',
      atm TEXT NOT NULL DEFAULT '', quote_no TEXT NOT NULL DEFAULT '', order_date TEXT NOT NULL DEFAULT '', eta TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned', reviewed INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE TABLE movements (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL, type TEXT NOT NULL,
      van_id INTEGER, ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '');
    INSERT INTO items(id, sku, name, on_hand) VALUES (1, 'OLD-1', 'Old Part', 4);
    INSERT INTO vans(id, chassis, customer) VALUES (1, 'OLD-CH', 'Test Customer');
    INSERT INTO movements(id, item_id, qty, type) VALUES (3, 1, 4, 'receive');
  `);
  d.close();
  const before = sha(from);
  const to = path.join(tmp('to'), 'pg');
  const report = await copyAll({ from, prepare: false, to });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)));
  assert.equal(sha(from), before, 'the source file is never changed');
  assert.equal(report.tables.find(x => x.name === 'users').from, 0);
  await withTarget(to, async t => {
    assert.deepEqual(await rows(t, 'SELECT id, on_hand, unit_size, order_up_to FROM items'), [{ id: 1, on_hand: 4, unit_size: '', order_up_to: 0 }]);
    assert.equal((await rows(t, `INSERT INTO movements(item_id, qty, type) VALUES(1, 1, 'receive') RETURNING id`))[0].id, 4);
  });
});

test('ids pointing at a deleted rule, rack or login become none on the copy, so the links in the target take them', async () => {
  const from = sqliteFinalDb(tmp('dangling'));
  const d = new DatabaseSync(from);
  d.exec(`INSERT INTO floor_areas(id, kind, name, x, y, w, h) VALUES (1, 'storage', 'Rack A', 0, 0, 2, 1);
          INSERT INTO items(id, sku, name, area_id) VALUES (1, 'D-1', 'Part', 1), (2, 'D-2', 'Part on a removed rack', 55);
          INSERT INTO rules(id, name, conditions, item_id) VALUES (3, 'Rule', '*', 1);
          INSERT INTO vans(id, chassis, area_id) VALUES (1, 'D-CH', 66);
          INSERT INTO van_lines(id, van_id, item_id, qty, rule_id) VALUES (1, 1, 1, 1, 3), (2, 1, 1, 1, 99), (3, 1, 2, 1, 98);
          INSERT INTO movements(id, item_id, qty, type, user_id) VALUES (1, 1, 1, 'receive', 7);`);
  d.close();
  const before = sha(from);
  const to = path.join(tmp('to'), 'pg');
  const report = await copyAll({ from, prepare: false, to });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)));
  assert.deepEqual(report.unlinked, [{ column: 'van_lines.rule_id', rows: 2 }, { column: 'items.area_id', rows: 1 },
    { column: 'vans.area_id', rows: 1 }, { column: 'movements.user_id', rows: 1 }]);
  assert.ok(formatReport(report).includes('set to none on the copy: van_lines.rule_id 2, items.area_id 1, vans.area_id 1, movements.user_id 1'));
  assert.equal(sha(from), before, 'the source file is never changed');
  await withTarget(to, async t => {
    assert.deepEqual(await rows(t, 'SELECT id, rule_id FROM van_lines ORDER BY id'), [{ id: 1, rule_id: 3 }, { id: 2, rule_id: null }, { id: 3, rule_id: null }]);
    assert.deepEqual(await rows(t, 'SELECT id, area_id FROM items ORDER BY id'), [{ id: 1, area_id: 1 }, { id: 2, area_id: null }]);
  });
  // nothing to clear: nothing said
  assert.equal((await copyAll({ from: SRC, prepare: false, to: path.join(tmp('to'), 'pg') })).unlinked, undefined);
});

test('a failed load leaves the target unchanged', async () => {
  const dir = tmp('bad');
  const from = sqliteFinalDb(dir);
  const d = new DatabaseSync(from);
  // SQLite keeps text in an INTEGER column; Postgres can't: the load must stop, all or nothing
  d.exec(`INSERT INTO items(id, sku, name) VALUES (1, 'B-1', 'Part');
          INSERT INTO vans(id, chassis, build_order) VALUES (1, 'B-CH', 'soon');`);
  d.close();
  // a target that already has the schema (as the cloud will, from `supabase db push`)
  const to = path.join(tmp('to'), 'pg');
  await withTarget(to, async t => {
    for (const f of fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
      await t.query(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'));
    }
  });
  await assert.rejects(copyAll({ from, prepare: false, to }), e => /Loading vans failed: .*integer/.test(e.message) && !/soon/.test(e.message));
  await withTarget(to, async t => {
    assert.equal((await rows(t, 'SELECT COUNT(*) AS n FROM items'))[0].n, 0);
    assert.equal((await rows(t, `SELECT value FROM settings WHERE key = 'data_version'`))[0].value, '0');
  });
});

test('photos are copied under the same names (local folder)', async () => {
  const photos = tmp('photos');
  fs.writeFileSync(path.join(photos, '3-100.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  fs.writeFileSync(path.join(photos, '3-100-t.jpg'), Buffer.from([0xff, 0xd8, 0xff, 4]));
  fs.writeFileSync(path.join(photos, 'Thumbs.db'), 'not a photo');
  const base = tmp('to');
  const report = await copyAll({ from: SRC, prepare: false, to: path.join(base, 'pg'), photosDir: photos });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.find(c => c.name === 'photos'), { name: 'photos', from: 2, to: 2, ok: true });
  assert.deepEqual(report.checks.find(c => c.name === 'photos referenced by items: present'),
    { name: 'photos referenced by items: present', from: 2, to: 2, ok: true });
  assert.deepEqual(report.photosSkipped, ['Thumbs.db']);
  assert.match(formatReport(report), /1 file\(s\) skipped \(not \.jpg\): Thumbs\.db/);
  assert.deepEqual(fs.readdirSync(path.join(base, 'photos')).sort(), ['3-100-t.jpg', '3-100.jpg']);
  assert.equal(sha(path.join(base, 'photos', '3-100.jpg')), sha(path.join(photos, '3-100.jpg')));
});

test('photos go to Storage when SUPABASE_URL is set; a missing photo fails the checks', async () => {
  const photos = tmp('photos');
  // item 3 points at 3-100.jpg (and its thumbnail 3-100-t.jpg), which are not in this folder
  fs.writeFileSync(path.join(photos, '7-200.jpg'), Buffer.from([0xff, 0xd8, 0xff, 9]));
  const calls = [];
  const to = path.join(tmp('to'), 'pg');
  const oldFetch = globalThis.fetch;
  const oldEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    // the bucket check (scripts/lib/bucket.mjs): there, private
    if (String(url).endsWith('/storage/v1/bucket/item-photos')) return new Response(JSON.stringify({ id: 'item-photos', public: false }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  try {
    const report = await copyAll({ from: SRC, prepare: false, to, photosDir: photos });
    assert.equal(report.ok, false);
    assert.equal(report.rolledBack, true);
    assert.deepEqual(report.checks.find(c => c.name === 'photos referenced by items: present'),
      { name: 'photos referenced by items: present', from: 2, to: 0, ok: false });
    assert.match(formatReport(report), /CHECKS FAILED — nothing to switch to/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldEnv.url;
    if (oldEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldEnv.key;
  }
  // first the bucket: made private if missing, then checked (never public)
  assert.equal(calls[0].url, 'https://example.test/storage/v1/bucket');
  assert.equal(JSON.parse(calls[0].init.body).public, false);
  assert.equal(calls[1].url, 'https://example.test/storage/v1/bucket/item-photos');
  const uploads = calls.slice(2);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].url, 'https://example.test/storage/v1/object/item-photos/7-200.jpg');
  assert.equal(uploads[0].init.method, 'POST');
  const h = new Headers(uploads[0].init.headers);
  assert.equal(h.get('authorization'), 'Bearer test-key');
  assert.equal(h.get('apikey'), 'test-key');
  assert.equal(h.get('content-type'), 'image/jpeg');
  assert.equal(h.get('x-upsert'), 'true');
  assert.deepEqual(Buffer.from(uploads[0].init.body), Buffer.from([0xff, 0xd8, 0xff, 9]));
  // failed checks keep nothing — here not even the schema the copy put into the new PGlite folder
  await withTarget(to, async d => assert.equal((await rows(d, `SELECT to_regclass('public.vans') IS NULL AS gone`))[0].gone, true));
});

test('a PUBLIC photo bucket stops the copy before any photo is sent, and the target is unchanged', async () => {
  const photos = tmp('photos');
  fs.writeFileSync(path.join(photos, '3-100.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1]));
  const calls = [];
  const to = path.join(tmp('to'), 'pg');
  const oldFetch = globalThis.fetch;
  const oldEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).endsWith('/storage/v1/bucket')) return new Response(JSON.stringify({ error: 'Duplicate', message: 'The resource already exists' }), { status: 400 });
    if (String(url).endsWith('/storage/v1/bucket/item-photos')) return new Response(JSON.stringify({ id: 'item-photos', public: true }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  try {
    await assert.rejects(copyAll({ from: SRC, prepare: false, to, photosDir: photos }), /item-photos is PUBLIC/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldEnv.url;
    if (oldEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldEnv.key;
  }
  assert.equal(calls.filter(c => c.url.includes('/storage/v1/object/')).length, 0, 'no photo was sent');
  await withTarget(to, async d => assert.equal((await rows(d, `SELECT to_regclass('public.vans') IS NULL AS gone`))[0].gone, true));
});

test('prepare: the copy is started once with the sqlite-final app first (stock clean-up and all)', async () => {
  // item 7 (TST-2) has no supplier, but its PO line is on a "Test Supplier" PO: the clean-up step
  // "Blank suppliers filled from the part's purchase orders" fills it in
  const before = sha(SRC);
  const to = path.join(tmp('to'), 'pg');
  const report = await copyAll({ from: SRC, to });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)));
  assert.equal(sha(SRC), before, 'the source file is never changed');
  const step = report.prepare.tidy.find(t => /Blank suppliers filled/.test(t.label));
  assert.ok(step && step.changed >= 1, 'the supplier step ran and changed something');
  assert.equal(report.prepare.tidy.length, report.prepare.tidySteps, 'every clean-up step ran');
  assert.match(formatReport(report), /Blank suppliers filled from the part's purchase orders — \d+ change\(s\)/);
  await withTarget(to, async d => {
    assert.equal((await rows(d, `SELECT supplier FROM items WHERE sku = 'TST-2'`))[0].supplier, 'Test Supplier');
    const flags = (await rows(d, `SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'tidy%v1' AND value <> ''`))[0].n;
    assert.equal(flags, report.prepare.tidySteps, 'every clean-up step is marked done in the target');
    assert.ok((await rows(d, `SELECT COUNT(*) AS n FROM allocation_log WHERE reason = 'tidy:supplier'`))[0].n >= 1);
    assert.ok((await rows(d, `SELECT COUNT(*) AS n FROM items`))[0].n > 2, 'syncCatalog added the starter catalogue parts');
    // I6: the clean-up's backup was made on the temporary copy, which is gone: the target says where the
    // original really is instead (never a temp path)
    const [b] = await rows(d, `SELECT value FROM settings WHERE key = 'tidy_backup'`);
    assert.equal(b.value, 'Backup from before the clean-up: the original data on the home PC (unchanged)');
    // M8: the totals before (the original) and after the start-up, as the target now holds them
    const [t] = await rows(d, `SELECT (SELECT COUNT(*) FROM items) AS items, (SELECT SUM(on_hand) FROM items) AS on_hand,
      (SELECT SUM(reserved) FROM van_lines) AS reserved, (SELECT SUM(reserved_firm) FROM van_lines) AS reserved_firm`);
    const round = x => Math.round(x * 1e6) / 1e6;
    assert.deepEqual(Object.fromEntries(Object.entries(report.prepare.figures.after).map(([k, v]) => [k, round(v)])),
      { items: t.items, on_hand: round(t.on_hand), reserved: round(t.reserved), reserved_firm: round(t.reserved_firm) });
  });
  // the original's totals (fill() above): 2 items, 12.5 + 0.1 on hand, 3 + 0.1 + 2 set aside, 1.5 + 0 + 2 firm
  const f = report.prepare.figures.before;
  assert.deepEqual({ items: f.items, on_hand: Math.round(f.on_hand * 1e6) / 1e6, reserved: Math.round(f.reserved * 1e6) / 1e6, reserved_firm: f.reserved_firm },
    { items: 2, on_hand: 12.6, reserved: 5.1, reserved_firm: 3.5 });
  const text = formatReport(report);
  const head = 'What the start-up and clean-up changed (original -> prepared, totals only):';
  const lines = text.slice(text.indexOf(head)).split('\n').map(l => l.trim().split(/ {2,}/));
  const row = name => lines.find(l => l[0] === name);
  assert.ok(text.includes('What the start-up and clean-up changed (original -> prepared, totals only):'), text);
  const added = report.prepare.figures.after.items - 2;
  assert.deepEqual(row('items'), ['items', '2', String(report.prepare.figures.after.items), `+${added} added`]);
  assert.deepEqual(row('on hand (all items)').slice(0, 2), ['on hand (all items)', '12.6']);
  assert.deepEqual(row('set aside (reserved)').slice(0, 2), ['set aside (reserved)', '5.1']);
  assert.deepEqual(row('firm (reserved_firm)').slice(0, 2), ['firm (reserved_firm)', '3.5']);
  assert.match(row('on hand (all items)')[3], /^(no change|[+-]\d)/);
  assert.doesNotMatch(text, /fs-copy-/, 'no temp path is printed');
  // nothing of the old code is left behind
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'node_modules', '.cache')).filter(n => n.startsWith('fs-sqlite-final-')), []);
});
