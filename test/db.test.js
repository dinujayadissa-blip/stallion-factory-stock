// The async database layer (src/db.js) over an in-memory PGlite with the real migrations applied.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, all, run, insert, tx, writeTx, inTx, dataVersion, closeDb } from '../src/db.js';

beforeEach(freshDb);
after(closeDb);

const count = async (table) => (await get(`SELECT COUNT(*) AS n FROM ${table}`)).n;
const newItem = (sku) => insert('INSERT INTO items(sku, name) VALUES(?, ?)', sku, `Part ${sku}`);

test('insert returns the new id', async () => {
  const a = await newItem('A1');
  const b = await newItem('B1');
  assert.equal(typeof a, 'number');
  assert.equal(b, a + 1);
  assert.equal((await get('SELECT sku FROM items WHERE id = ?', b)).sku, 'B1');
});

test('tx rolls back everything when fn throws', async () => {
  await assert.rejects(tx(async () => {
    await newItem('A1');
    throw new Error('boom');
  }), /boom/);
  assert.equal(await count('items'), 0);
});

test('tx is re-entrant', async () => {
  await assert.rejects(tx(async () => {
    await newItem('A1');
    await tx(async () => {
      // Joined the outer transaction: it sees the outer insert (a separate connection would not).
      assert.equal(await count('items'), 1);
      await newItem('B1');
    });
    throw new Error('boom');
  }), /boom/);
  assert.equal(await count('items'), 0);
});

test('bigint and numeric results are JS numbers', async () => {
  await newItem('A1');
  assert.equal(typeof (await get('SELECT COUNT(*) AS n FROM items')).n, 'number');
  const r = await get('SELECT SUM(id) AS s, 2.5::numeric AS d, 7::bigint AS b FROM items');
  assert.deepEqual([typeof r.s, typeof r.d, typeof r.b], ['number', 'number', 'number']);
  assert.equal(r.d, 2.5);
});

test('melbourne time defaults with TZ=UTC', async () => {
  const oldTz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const melb = () => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date()).map(x => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    };
    await run(`SET TIME ZONE 'UTC'`); // the database session's own zone must not matter either
    const before = melb();
    const id = await insert(`INSERT INTO users(username, name, role, pass_hash) VALUES(?, ?, 'owner', 'x')`, 'sam', 'Sam');
    const afterwards = melb();
    const { created_at } = await get('SELECT created_at FROM users WHERE id = ?', id);
    assert.match(created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.ok([before, afterwards].includes(created_at.slice(0, 16)), `${created_at} is not Melbourne time (${before})`);
  } finally {
    if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
  }
});

test('first_number', async () => {
  assert.equal((await get(`SELECT first_number('Bay 6') AS n`)).n, 6);
  assert.equal((await get(`SELECT first_number('Yard') AS n`)).n, 9999);
  assert.equal((await get('SELECT first_number(?) AS n', 'Bay 12 (end)')).n, 12);
});

test('firm cap trigger clamps', async () => {
  const item = await newItem('A1');
  const van = await insert(`INSERT INTO vans(chassis) VALUES('C1')`);
  const line = await insert('INSERT INTO van_lines(van_id, item_id, qty, reserved) VALUES(?, ?, 3, 2)', van, item);
  await run('UPDATE van_lines SET reserved_firm = 5 WHERE id = ?', line);
  assert.equal((await get('SELECT reserved_firm FROM van_lines WHERE id = ?', line)).reserved_firm, 2);
  await run('UPDATE van_lines SET reserved_firm = -1 WHERE id = ?', line);
  assert.equal((await get('SELECT reserved_firm FROM van_lines WHERE id = ?', line)).reserved_firm, 0);
});

test('username unique whatever its capitals', async () => {
  const add = (u) => run(`INSERT INTO users(username, name, role, pass_hash) VALUES(?, ?, 'worker', 'x')`, u, u);
  await add('Alex');
  await assert.rejects(add('alex'), e => e.code === '23505' || /duplicate key|unique/i.test(e.message));
  assert.equal((await get('SELECT username FROM users WHERE lower(username) = lower(?)', 'ALEX')).username, 'Alex');
});

test('writeTx bumps data_version', async () => {
  const v0 = Number(await dataVersion());
  await writeTx(async () => {
    await newItem('A1');
    await writeTx(() => newItem('B1')); // nested: joins, no second bump
  });
  assert.equal(Number(await dataVersion()), v0 + 1);
  assert.equal(await count('items'), 2);
  // A failed write leaves the version (and the data) as they were.
  await assert.rejects(writeTx(async () => { await newItem('C1'); throw new Error('boom'); }), /boom/);
  assert.equal(Number(await dataVersion()), v0 + 1);
  assert.equal(await count('items'), 2);
});

test('insert: a statement ending in a comment still returns its id; no row back is an error', async () => {
  const id = await insert(`INSERT INTO items(sku, name) VALUES('A1', 'Part A1') -- trailing comment`);
  assert.equal(typeof id, 'number');
  await assert.rejects(insert(`INSERT INTO items(sku, name) VALUES('A1', 'again') ON CONFLICT DO NOTHING`), /no row/i);
});

test('inTx is true only inside tx / writeTx', async () => {
  assert.equal(inTx(), false);
  await tx(async () => { assert.equal(inTx(), true); });
  await writeTx(async () => { assert.equal(inTx(), true); });
  assert.equal(inTx(), false);
});

test('writeTx { bump: false }: locked and all-or-nothing, but no new data_version (unless a bumping one joins)', async () => {
  const v0 = Number(await dataVersion());
  await writeTx(() => newItem('NB1'), { bump: false });
  assert.equal(Number(await dataVersion()), v0);
  assert.equal(await count('items'), 1);
  await assert.rejects(writeTx(async () => { await newItem('NB2'); throw new Error('stop'); }, { bump: false }), /stop/);
  assert.equal(await count('items'), 1);
  // a bumping writeTx inside a non-bumping one: one bump, at the end
  await writeTx(async () => { await writeTx(() => newItem('NB3')); await writeTx(() => newItem('NB4'), { bump: false }); }, { bump: false });
  assert.equal(Number(await dataVersion()), v0 + 1);
  // a non-bumping one inside a bumping one: still the one bump
  await writeTx(async () => { await writeTx(() => newItem('NB5'), { bump: false }); });
  assert.equal(Number(await dataVersion()), v0 + 2);
  // inside a plain tx(): a non-bumping writeTx takes the lock, a later bumping one still bumps (once)
  await tx(async () => { await writeTx(() => newItem('NB6'), { bump: false }); await writeTx(() => newItem('NB7')); await writeTx(() => newItem('NB8')); });
  assert.equal(Number(await dataVersion()), v0 + 3);
});

test('migrate builds an empty database once, and leaves a built one alone', async () => {
  const { migrate, openDb } = await import('../src/db.js');
  assert.equal(await migrate(), false); // freshDb already applied the migrations
  await openDb({ pgliteDir: 'memory://' }); // brand new, no tables
  assert.equal(await migrate(), true);
  assert.equal(await dataVersion(), '0');
  assert.equal(await count('items'), 0);
  assert.equal(await migrate(), false);
});

// C1: Supabase's Data API (PostgREST / GraphQL) answers as the roles anon / authenticated, which by default get
// every right on every new table in public. 0002_lock_down.sql turns row level security on everywhere (no
// policies: those roles see nothing; the postgres owner the app, the copy and the backup use is not affected)
// and takes their rights away.
test('every public table has row level security on (0002_lock_down)', async () => {
  const off = await all(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1`);
  assert.deepEqual(off.map(r => r.t), []);
  assert.ok((await get(`SELECT COUNT(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`)).n >= 19, 'the tables are there');
  // the app (the owner) still reads and writes
  await newItem('RLS1');
  assert.equal(await count('items'), 1);
});

test('with Supabase\'s roles present, anon / authenticated lose every right (0002_lock_down)', async () => {
  const { openDb } = await import('../src/db.js');
  await openDb({ pgliteDir: 'memory://' });
  // as on a new Supabase project: the roles, and default rights on everything made in public
  await run(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;`);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await run(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const role of ['anon', 'authenticated']) {
    const tables = await all(`SELECT table_name AS t FROM information_schema.role_table_grants
      WHERE grantee = ? AND table_schema = 'public'`, role);
    assert.deepEqual(tables, [], `${role} has no table rights`);
    assert.equal((await get(`SELECT has_table_privilege(?, 'public.users', 'SELECT') AS ok`, role)).ok, false);
    assert.equal((await get(`SELECT has_table_privilege(?, 'public.sessions', 'INSERT') AS ok`, role)).ok, false);
    assert.equal((await get(`SELECT has_sequence_privilege(?, pg_get_serial_sequence('public.items', 'id'), 'USAGE') AS ok`, role)).ok, false);
    // a table made by a later migration gets nothing either
    await run(`CREATE TABLE IF NOT EXISTS later_one (id int)`);
    assert.equal((await get(`SELECT has_table_privilege(?, 'public.later_one', 'SELECT') AS ok`, role)).ok, false);
  }
});

// I3: a transaction never waits for ever: for the write lock (lock_timeout), on a slow statement
// (statement_timeout) or idle in the middle (idle_in_transaction_session_timeout). Those errors are "Busy".
test('tx / writeTx set their time limits, for that transaction only', async () => {
  const limits = () => all(`SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout') ORDER BY name`);
  const want = [
    { name: 'idle_in_transaction_session_timeout', setting: '30000', unit: 'ms' },
    { name: 'lock_timeout', setting: '15000', unit: 'ms' },
    { name: 'statement_timeout', setting: '30000', unit: 'ms' },
  ];
  assert.deepEqual(await tx(limits), want);
  assert.deepEqual(await writeTx(limits), want);
  assert.deepEqual(await writeTx(limits, { bump: false }), want);
  // outside a transaction: the server's own (none here)
  assert.deepEqual((await limits()).map(r => r.setting), ['0', '0', '0']);
});

test('a lock wait or a statement cut short (55P03 / 57014) is "Busy — try again in a moment" (503), and nothing is kept', async () => {
  const { BUSY } = await import('../src/db.js');
  assert.equal(BUSY, 'Busy — try again in a moment');
  for (const code of ['lock_not_available', 'query_canceled']) {
    const raise = `DO $$ BEGIN RAISE EXCEPTION 'canceling statement due to a time limit' USING ERRCODE = '${code}'; END $$`;
    await assert.rejects(writeTx(async () => { await newItem(`BUSY-${code}`); await run(raise); }),
      e => e.status === 503 && e.message === BUSY && ['55P03', '57014'].includes(e.cause?.code), code);
    assert.equal(await count('items'), 0, 'rolled back');
    await assert.rejects(run(raise), e => e.status === 503 && e.message === BUSY, `${code} outside a transaction`);
  }
  // other database errors are left as they are
  await assert.rejects(run(`DO $$ BEGIN RAISE EXCEPTION 'x' USING ERRCODE = 'unique_violation'; END $$`), e => e.code === '23505' && !e.status);
});
