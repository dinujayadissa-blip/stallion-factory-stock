// supabase/migrations/0003_links_and_checks.sql on a database with old, untidy data, and migrate() on a
// local database made before it. Runs on new, empty in-memory databases (PGlite) — never on the real data.
//   node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, run, get, all, insert, migrate, getSetting } from '../src/db.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const sql = f => fs.readFileSync(path.join(DIR, f), 'utf8');
const constraints = async () => new Set((await all(`SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`)).map(r => r.conname));
after(closeDb);

// A database as it was before 0003: the first two files only.
async function before0003() {
  await openDb({ pgliteDir: 'memory://' });
  await run(sql('0001_schema.sql'));
  await run(sql('0002_lock_down.sql'));
}

test('0003 on old data: ids pointing at nothing become none, a check old rows break is left out, the rest are in', async () => {
  await before0003();
  const area = await insert(`INSERT INTO floor_areas(kind, name, x, y, w, h) VALUES('bay', 'Bay 1', 0, 0, 4, 12)`);
  const part = await insert(`INSERT INTO items(sku, name, area_id) VALUES('M-1', 'Part', ?)`, area);
  const gone = await insert(`INSERT INTO items(sku, name, area_id) VALUES('M-2', 'Part on a removed rack', 999)`);
  const rule = await insert(`INSERT INTO rules(conditions, item_id) VALUES('*', ?)`, part);
  const van = await insert(`INSERT INTO vans(chassis, status, area_id) VALUES('M-VAN', 'done', 998)`); // an old word for finished
  const kept = await insert(`INSERT INTO van_lines(van_id, item_id, qty, rule_id) VALUES(?, ?, 1, ?)`, van, part, rule);
  const lost = await insert(`INSERT INTO van_lines(van_id, item_id, qty, rule_id) VALUES(?, ?, 1, 4242)`, van, part);
  const move = await insert(`INSERT INTO movements(item_id, qty, type, user_id) VALUES(?, 1, 'receive', 77)`, part);

  await run(sql('0003_links_and_checks.sql'));
  assert.equal((await get('SELECT area_id FROM items WHERE id = ?', part)).area_id, area);
  assert.equal((await get('SELECT area_id FROM items WHERE id = ?', gone)).area_id, null);
  assert.equal((await get('SELECT area_id FROM vans WHERE id = ?', van)).area_id, null);
  assert.equal((await get('SELECT rule_id FROM van_lines WHERE id = ?', kept)).rule_id, rule);
  assert.equal((await get('SELECT rule_id FROM van_lines WHERE id = ?', lost)).rule_id, null);
  assert.equal((await get('SELECT user_id FROM movements WHERE id = ?', move)).user_id, null);

  const have = await constraints();
  for (const c of ['van_lines_rule_id_fkey', 'items_area_id_fkey', 'vans_area_id_fkey', 'movements_user_id_fkey',
    'movements_type_check', 'van_lines_state_check', 'items_flags_check']) assert.ok(have.has(c), c);
  assert.ok(!have.has('vans_status_check'), 'the van with an old status keeps working');
  await run(`UPDATE vans SET notes = 'still saves' WHERE id = ?`, van);

  // the links and checks at work
  await run('DELETE FROM rules WHERE id = ?', rule);
  assert.equal((await get('SELECT rule_id FROM van_lines WHERE id = ?', kept)).rule_id, null);
  await run('DELETE FROM floor_areas WHERE id = ?', area);
  assert.equal((await get('SELECT area_id FROM items WHERE id = ?', part)).area_id, null);
  await assert.rejects(run(`UPDATE items SET area_id = 12345 WHERE id = ?`, part), /foreign key/);
  await assert.rejects(run(`INSERT INTO movements(item_id, qty, type) VALUES(?, 1, 'take')`, part), /movements_type_check/);
  await assert.rejects(run(`UPDATE van_lines SET state = 'maybe' WHERE id = ?`, kept), /van_lines_state_check/);
  await assert.rejects(run(`UPDATE items SET active = 2 WHERE id = ?`, part), /items_flags_check/);

  // safe to run again
  await run(sql('0003_links_and_checks.sql'));
  assert.equal((await constraints()).size, have.size);
});

test('migrate(): a local database made before 0003 gets it, once, and keeps a list of what ran', async () => {
  await before0003();
  await insert(`INSERT INTO vans(chassis) VALUES('M-LOCAL')`);
  assert.equal(await migrate(), false, 'not a new database');
  assert.ok((await constraints()).has('vans_status_check'));
  assert.deepEqual(JSON.parse(await getSetting('migrations')), fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort());
  assert.equal(await migrate(), false);
  assert.equal((await get('SELECT COUNT(*) AS c FROM vans')).c, 1, 'nothing lost');

  // a brand-new one: everything, and the same list
  await openDb({ pgliteDir: 'memory://' });
  assert.equal(await migrate(), true);
  assert.deepEqual(JSON.parse(await getSetting('migrations')), fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort());
});

test('migrate(): a database the Supabase CLI keeps is left alone', async () => {
  await before0003();
  await run(`CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY)`);
  assert.equal(await migrate(), false);
  assert.ok(!(await constraints()).has('vans_status_check'), 'the CLI runs 0003 there, not the app');
  assert.equal(await getSetting('migrations', 'none'), 'none');
});
