// The Express app (src/app.js) on Postgres: one writer at a time, the floor delivery receipts table, the
// Excel file name, the cloud switches. Started in this process on a new, empty in-memory database
// (PGlite) and a free port — never on real data.   node --test test/server.test.js
// DATA_DIR points at a throwaway folder before src/db.js loads (photos are kept on disk there).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-server-'));
process.env.DATA_DIR = tmp;
process.env.ALLOWED_HOSTS = '';
delete process.env.TRUST_PROXY;
delete process.env.CLOUD;
delete process.env.SUPABASE_URL;
const { freshDb } = await import('./helpers.js');
const { get, all, insert, closeDb, dataVersion } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { createApp } = await import('../src/app.js');

const listen = app => new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
let local, cloud, owner;

// One request to one of the two servers; `as` = a session token (sent under the cookie name in use).
// The cloud one is called as the Pages pass-through calls it (the pass secret, the host the visitor used).
const PASS = 'server-test-pass-secret';
const viaPages = { 'x-pass-secret': PASS, 'x-fs-host': '127.0.0.1', 'x-fs-client-ip': '192.0.2.10' };
async function call(server, method, p, { body, as, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
    method, redirect: 'manual',
    headers: { ...(server === cloud ? viaPages : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(as ? { Cookie: `${auth.COOKIE}=${as}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  const cookie = res.headers.getSetCookie().map(c => new RegExp(`^${auth.COOKIE}=([^;]*)`).exec(c)?.[1]).filter(Boolean).pop();
  return { status: res.status, headers: res.headers, json, buf, cookie };
}

before(async () => {
  await freshDb();
  local = await listen(createApp({ cloud: false }));
  cloud = await listen(createApp({ cloud: true, passSecret: PASS }));
  auth.setCookiePort(local.address().port);
  await auth.createUser({ username: 'boss', name: 'Bea Boss', role: 'owner', password: 'owner-pass-1', mustChange: false });
  const r = await call(local, 'POST', '/api/login', { body: { username: 'boss', password: 'owner-pass-1' } });
  assert.equal(r.status, 200, r.buf.toString());
  owner = r.cookie;
});
after(async () => {
  for (const s of [local, cloud]) if (s) await new Promise(r => s.close(r));
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const vanWithLine = async (chassis, itemId, reserved) => {
  const van = await insert(`INSERT INTO vans(chassis, status, eta) VALUES(?, 'in_production', '2027-01-01')`, chassis);
  const line = await insert(`INSERT INTO van_lines(van_id, item_id, qty, reserved, source) VALUES(?, ?, 1, ?, 'manual')`, van, itemId, reserved);
  return { van, line };
};

test('two simultaneous takes of the last unit: one succeeds, one is refused', async () => {
  // One part on the shelf, set aside for van A; van B wants one too. Two phones both show A's part as not
  // taken yet (seen_issued 0) and both tap "Took it" at the same moment.
  const item = await insert(`INSERT INTO items(sku, name, category, kind, on_hand) VALUES('T-LAST', 'Last one', 'General', 'stock', 1)`);
  const a = await vanWithLine('RACE-A', item, 1);
  const b = await vanWithLine('RACE-B', item, 0);
  const take = () => call(local, 'POST', '/api/floor/take', { as: owner, body: { line_id: a.line, qty: 1, seen_issued: 0 } });
  const res = await Promise.all([take(), take()]);
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409], res.map(r => r.buf.toString()).join(' | '));
  assert.equal(res.find(r => r.status === 409).json.error, 'Someone already took some of this. Check the list.');
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', item)).on_hand, 0);
  assert.deepEqual(await get('SELECT issued, reserved FROM van_lines WHERE id = ?', a.line), { issued: 1, reserved: 0 });
  assert.deepEqual(await get('SELECT issued, reserved FROM van_lines WHERE id = ?', b.line), { issued: 0, reserved: 0 });
  const moves = await all(`SELECT type, qty, user_id FROM movements WHERE item_id = ?`, item);
  assert.deepEqual(moves, [{ type: 'issue', qty: -1, user_id: moves[0].user_id }]); // taken exactly once…
  assert.ok(moves[0].user_id > 0); // …and stamped with the login, in the same transaction
});

test('a repeated floor delivery id books once', async () => {
  const item = await insert(`INSERT INTO items(sku, name, category, kind, on_hand) VALUES('T-RID', 'Delivered', 'General', 'stock', 0)`);
  const send = () => call(local, 'POST', '/api/floor/receive', { as: owner, body: { item_id: item, qty: 2, rid: 'phone-1-abc' } });
  const res = [...await Promise.all([send(), send()]), await send()]; // two at once (lost reply, tapped again), then once more
  for (const r of res) assert.equal(r.status, 200, r.buf.toString());
  assert.equal(new Set(res.map(r => r.json.movement_id)).size, 1);
  assert.deepEqual(res[1].json, res[0].json);
  assert.equal((await all(`SELECT id FROM movements WHERE item_id = ? AND type = 'receive'`, item)).length, 1);
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', item)).on_hand, 2);
  const kept = await get('SELECT out, at FROM request_receipts WHERE rid = ?', 'phone-1-abc');
  assert.equal(kept.out.movement_id, res[0].json.movement_id);
  assert.ok(Math.abs(kept.at - Date.now()) < 60 * 1000);
  // another id is another delivery
  const r = await call(local, 'POST', '/api/floor/receive', { as: owner, body: { item_id: item, qty: 1, rid: 'phone-1-def' } });
  assert.notEqual(r.json.movement_id, res[0].json.movement_id);
  assert.equal((await get('SELECT on_hand FROM items WHERE id = ?', item)).on_hand, 3);
});

test('export filename uses Melbourne date', async t => {
  const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone; // (put back by name: a delete doesn't reset Node's zone)
  process.env.TZ = 'UTC';
  t.after(() => { process.env.TZ = tz; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T14:30:00Z') }); // 1:30 am on the 25th in Melbourne
  const r = await call(local, 'GET', '/api/export/plan.xlsx', { as: owner });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /filename="Production Plan 2026-10-25\.xlsx"/);
});

test('cloud mode refuses plan import', async () => {
  const gone = { error: 'Not available in the online version' };
  for (const p of ['/api/import/plan/apply?confirm=RESET', '/api/import/plan/preview', '/api/import/plan/update', '/api/import/plan/update/preview']) {
    const r = await call(cloud, 'POST', p, { as: owner, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 410, p);
    assert.deepEqual(r.json, gone);
  }
  let r = await call(cloud, 'POST', '/api/setup', { body: { username: 'x', name: 'X', password: 'abcdefgh1' } });
  assert.equal(r.status, 410);
  assert.deepEqual(r.json, gone);
  r = await call(cloud, 'GET', '/api/me', { as: owner });
  assert.equal(r.status, 200);
  assert.equal(r.json.cloud, true);
  assert.equal((await call(local, 'GET', '/api/me', { as: owner })).json.cloud, false);
  // the pages come from Cloudflare Pages, not from here
  for (const p of ['/', '/floor', '/login', '/styles.css']) assert.equal((await call(cloud, 'GET', p, { as: owner })).status, 404, p);
  // locally plan import has gone too (it is done on the original, pre-move version), with its own message
  r = await call(local, 'POST', '/api/import/plan/apply?confirm=RESET', { as: owner, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 410);
  assert.match(r.json.error, /original version/);
  assert.deepEqual((await call(local, 'GET', '/api/plan-conflicts', { as: owner })).json, []);
});

test('a wrong password does not change data_version (other screens do not refresh); a change does, once', async () => {
  const v0 = await dataVersion();
  let r = await call(local, 'POST', '/api/login', { body: { username: 'boss', password: 'wrong-pass-9' } });
  assert.equal(r.status, 401);
  assert.equal(await dataVersion(), v0);
  r = await call(local, 'POST', '/api/login', { body: { username: 'nobody', password: 'wrong-pass-9' } });
  assert.equal(r.status, 401);
  assert.equal(await dataVersion(), v0);
  // logging in (the wrong tries are cleared, last login and the session saved, all in one go) doesn't either
  r = await call(local, 'POST', '/api/login', { body: { username: 'boss', password: 'owner-pass-1' } });
  assert.equal(r.status, 200);
  assert.equal(await dataVersion(), v0);
  assert.equal((await call(local, 'POST', '/api/logout', { as: r.cookie })).status, 200);
  assert.equal(await dataVersion(), v0);
  // a real change: one bump for the whole request (however many writes inside it)
  r = await call(local, 'POST', '/api/items', { as: owner, body: { sku: 'T-BUMP', name: 'Bump test', on_hand: 3 } });
  assert.equal(r.status, 200, r.buf.toString());
  assert.equal(Number(await dataVersion()), Number(v0) + 1);
});

test('an id that is not a number: 404, not 500', async () => {
  let r = await call(local, 'GET', '/api/vans/abc', { as: owner });
  assert.equal(r.status, 404, r.buf.toString());
  assert.deepEqual(r.json, { error: 'Not found' });
  r = await call(local, 'PUT', '/api/vans/abc', { as: owner, body: { eta: '2027-01-01' } });
  assert.equal(r.status, 404);
  // inside a write (the database refuses the text as an id): rolled back, then a plain 404
  r = await call(local, 'POST', '/api/floor/take', { as: owner, body: { line_id: 'abc', qty: 1 } });
  assert.equal(r.status, 404, r.buf.toString());
  assert.deepEqual(r.json, { error: 'Not found' });
});

test('a change that fails half-way leaves nothing behind', async () => {
  // "Link all": a new part is made from the text, the first line is linked to it, then the second line
  // turns out to be gone. The new part and the first link are undone with it.
  const ph = await insert(`INSERT INTO items(sku, name, category, kind, placeholder) VALUES('PLAN-HALF', 'As per plan', 'General', 'per-van', 1)`);
  const { line } = await vanWithLine('HALF-1', ph, 0);
  const v0 = await dataVersion();
  const r = await call(local, 'POST', '/api/van-lines/link-many', { as: owner, body: { line_ids: [line, 999999], new_item: { name: 'Half made part' } } });
  assert.equal(r.status, 404, r.buf.toString());
  assert.equal(r.json.error, 'That part line no longer exists — refresh');
  assert.equal(await get(`SELECT id FROM items WHERE name = 'Half made part'`), undefined);
  assert.equal((await get('SELECT item_id FROM van_lines WHERE id = ?', line)).item_id, ph);
  assert.equal(await dataVersion(), v0);
});

test('item photos: saved, shown to a login, replaced, removed', async () => {
  const item = await insert(`INSERT INTO items(sku, name, category) VALUES('T-PIC', 'Pictured', 'General')`);
  const jpeg = fill => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, fill)]).toString('base64')}`;
  let r = await call(local, 'POST', `/api/items/${item}/photo`, { as: owner, body: { full: jpeg(1), thumb: jpeg(2) } });
  assert.equal(r.status, 200, r.buf.toString());
  const first = r.json.photo;
  assert.equal((await get('SELECT photo FROM items WHERE id = ?', item)).photo, first);
  r = await call(local, 'GET', `/photos/${first}`, { as: owner });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(r.buf[0], 0xff);
  assert.equal((await call(local, 'GET', `/photos/${first.replace('.jpg', '-t.jpg')}`, { as: owner })).buf[4], 2);
  assert.equal((await call(local, 'GET', `/photos/${first}`)).status, 401);
  assert.equal((await call(local, 'GET', '/photos/..%5Csecret.jpg', { as: owner })).status, 400);
  await new Promise(res => setTimeout(res, 5)); // a new name (milliseconds)
  r = await call(local, 'POST', `/api/items/${item}/photo`, { as: owner, body: { full: jpeg(3), thumb: jpeg(4) } });
  assert.equal(r.status, 200, r.buf.toString());
  assert.notEqual(r.json.photo, first);
  assert.equal((await call(local, 'GET', `/photos/${first}`, { as: owner })).status, 404); // the old one is gone
  assert.equal((await call(local, 'POST', '/api/items/999999/photo', { as: owner, body: { full: jpeg(1), thumb: jpeg(2) } })).status, 404);
  r = await call(local, 'DELETE', `/api/items/${item}/photo`, { as: owner });
  assert.equal(r.status, 200, r.buf.toString());
  assert.equal((await get('SELECT photo FROM items WHERE id = ?', item)).photo, '');
  assert.equal(fs.readdirSync(path.join(tmp, 'photos')).filter(f => f.startsWith(`${item}-`)).length, 0);
});

// M4: the office PC's server.js never starts on the cloud database by accident (two servers writing the same
// data, start-up jobs run against the live copy): it stops with the reason unless --cloud-db is given.
test('server.js refuses a Supabase database unless --cloud-db, and never prints the address', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = (env, args = []) => spawnSync(process.execPath, [path.join(root, 'server.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATA_DIR: tmp, PORT: '0', DATABASE_URL: '', SUPABASE_URL: '', ...env },
  });
  const secretUrl = 'postgresql://postgres.abcdefghijklmnopqrst:not-a-real-password@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres';
  for (const env of [{ DATABASE_URL: secretUrl }, { DATABASE_URL: 'postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres' },
    { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }]) {
    const r = run(env);
    assert.equal(r.status, 2, JSON.stringify(env) + r.stdout + r.stderr);
    const said = r.stdout + r.stderr;
    assert.match(said, /cloud database/i);
    assert.match(said, /--cloud-db/);
    assert.doesNotMatch(said, /not-a-real-password|pw@/, 'the address (with its password) is never printed');
    assert.doesNotMatch(said, /Factory Stock is running/);
  }
});
