// The online version as the Edge Function runs it: createApp({ cloud: true }) behind the Cloudflare Pages
// pass-through, which adds x-pass-secret, x-fs-client-ip / x-fs-host / x-fs-proto. Started in this process on a new,
// empty in-memory database (PGlite) and a free port — never on real data.   node --test test/
// The tests share ONE database and run top to bottom; the last one points the app at a database that isn't there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { get, closeDb, openDb, isUnreachable } from '../src/db.js';
import * as auth from '../src/auth.js';
import { createApp } from '../src/app.js';
import { functionPath, edgeHandler } from '../src/edge.js';

const SECRET = 'test-pass-secret-0123456789abcdef';
const HOST = 'stallion-stock.pages.dev';
const ASLEEP = 'The database is asleep or unreachable — try again in a minute';
const env0 = { CLOUD: process.env.CLOUD, ALLOWED_HOSTS: process.env.ALLOWED_HOSTS };
let server, owner;

const listen = app => new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

// One request as Pages sends it. `secret: null` leaves the pass secret out; `ip` = the visitor's address.
async function call(method, p, { body, as, secret = SECRET, ip = '192.0.2.1', host = HOST, headers = {}, to = server } = {}) {
  const res = await fetch(`http://127.0.0.1:${to.address().port}${p}`, {
    method, redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(secret != null ? { 'x-pass-secret': secret } : {}),
      'x-region': 'ap-southeast-2', 'x-fs-client-ip': ip, 'x-fs-host': host, 'x-fs-proto': 'https',
      ...(as ? { Cookie: `fs_session=${as}` } : {}), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map(c => /^fs_session=([^;]*)/.exec(c)?.[1]).filter(Boolean).pop();
  return { status: res.status, json, text, cookies, cookie, headers: res.headers };
}
const loginAs = (username, password, opts = {}) => call('POST', '/api/login', { body: { username, password }, ...opts });

before(async () => {
  process.env.CLOUD = '1';
  process.env.ALLOWED_HOSTS = HOST;
  await freshDb();
  server = await listen(createApp({ cloud: true, passSecret: SECRET }));
  await auth.createUser({ username: 'boss', name: 'Bea Boss', role: 'owner', password: 'owner-pass-1', mustChange: false });
  await auth.createUser({ username: 'sam', name: 'Sam Office', role: 'office', password: 'office-pass-1', mustChange: false });
  const r = await loginAs('boss', 'owner-pass-1');
  assert.equal(r.status, 200, r.text);
  owner = r.cookie;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  await closeDb();
  for (const [k, v] of Object.entries(env0)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

test('request without the pass secret is refused (403)', async () => {
  for (const [method, p] of [['GET', '/api/me'], ['POST', '/api/login'], ['GET', '/photos/a.jpg'], ['GET', '/api/summary']]) {
    for (const secret of [null, '', 'wrong', `${SECRET}x`, SECRET.slice(0, -1)]) {
      const r = await call(method, p, { secret, as: owner, ...(method === 'POST' ? { body: { username: 'boss', password: 'owner-pass-1' } } : {}) });
      assert.equal(r.status, 403, `${method} ${p} secret=${secret}`);
      assert.equal(r.cookie, undefined); // nothing was looked up or logged in
    }
  }
  // with it: through to the app
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { as: owner })).status, 200);
  // a function with no PASS_SECRET set refuses everything, even an empty header
  const bare = await listen(createApp({ cloud: true, passSecret: '' }));
  try {
    for (const secret of [null, '']) assert.equal((await call('GET', '/api/me', { secret, to: bare })).status, 403);
  } finally { await new Promise(r => bare.close(r)); }
});

test('with the pass secret, each x-fs-client-ip address is throttled on its own (the first entry, not the socket)', async () => {
  const A = '203.0.113.5', B = '198.51.100.7';
  // 30 wrong tries from A (different usernames, so it is the per-address lock that bites); Supabase's gateway
  // may add its own entries after the visitor's.
  let r;
  for (let i = 1; i <= 30; i++) r = await loginAs(`nobody${i}`, 'wrong-pass-1', { ip: `${A}, 10.1.2.3` });
  assert.equal(r.status, 401);
  assert.equal(r.json.left, 0);
  r = await loginAs('sam', 'office-pass-1', { ip: A });
  assert.equal(r.status, 429, 'A is locked, even with the right password');
  r = await loginAs('sam', 'office-pass-1', { ip: B });
  assert.equal(r.status, 200, `B is not locked: ${r.text}`);
  // the keys are the forwarded address, never the socket's (127.0.0.1) or the gateway's
  assert.ok((await get('SELECT locked_until FROM login_throttle WHERE key = ?', `i:${A}`)).locked_until > Date.now());
  assert.equal((await get(`SELECT COUNT(*) AS n FROM login_throttle WHERE key LIKE 'i:%' AND key <> ?`, `i:${A}`)).n, 0);
  assert.equal((await get(`SELECT COUNT(*) AS n FROM login_throttle WHERE key LIKE '%127.0.0.1%' OR key LIKE '%10.1.2.3%'`)).n, 0);
  assert.equal((await get('SELECT ip FROM sessions WHERE token_hash = ?', auth.tokenHash(r.cookie))).ip, B);
  // an unlock-free reset of A for the tests below
  await auth.createThrottle().clear();
});

test('a trusted cloud request gets a Secure session cookie (x-fs-proto: https)', async () => {
  const r = await loginAs('boss', 'owner-pass-1');
  assert.equal(r.status, 200);
  const c = r.cookies.find(x => x.startsWith('fs_session='));
  assert.match(c, /; Secure$/);
  assert.match(c, /HttpOnly; SameSite=Lax/);
});

test('only x-fs-* are believed: the x-forwarded-* headers (as the Supabase gateway sends them) are never read', async () => {
  const body = { username: 'boss', password: 'owner-pass-1' };
  const forwardedOnly = { 'x-fs-client-ip': '', 'x-fs-host': '', 'x-fs-proto': '',
    'x-forwarded-for': '203.0.113.200', 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https' };
  // the host check: x-forwarded-host does not count, so the change is refused
  let r = await call('POST', '/api/login', { body, host: '', headers: forwardedOnly });
  assert.equal(r.status, 403);
  // the address and https: from x-fs-* only (the session is not Secure, and its address is not the x-forwarded-for one)
  r = await call('POST', '/api/login', { body, headers: { 'x-fs-proto': 'http', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.201' }, ip: '192.0.2.55' });
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(r.cookies.find(x => x.startsWith('fs_session=')), /Secure/);
  assert.equal((await get('SELECT ip FROM sessions WHERE token_hash = ?', auth.tokenHash(r.cookie))).ip, '192.0.2.55');
});

test('every answer of the app carries the x-fs-app marker (the pass-through tells it from errors Supabase makes itself)', async () => {
  for (const r of [await call('GET', '/api/me'), await call('GET', '/api/me', { secret: null }), await call('GET', '/api/nothing-here', { as: owner }),
    await call('GET', '/api/me', { as: owner })]) {
    assert.equal(r.headers.get('x-fs-app'), '1', String(r.status));
  }
});

test('changes are checked against the forwarded host (ALLOWED_HOSTS), not the function\'s own', async () => {
  const body = { username: 'boss', password: 'owner-pass-1' };
  // the public address, with or without a matching Origin
  assert.equal((await call('POST', '/api/login', { body })).status, 200);
  assert.equal((await call('POST', '/api/login', { body, headers: { Origin: `https://${HOST}` } })).status, 200);
  // another site's page, or an address that isn't the public one (not even "localhost" in the cloud)
  assert.equal((await call('POST', '/api/login', { body, headers: { Origin: 'https://evil.example' } })).status, 403);
  for (const host of ['evil.example', 'localhost', '127.0.0.1', '']) {
    const r = await call('POST', '/api/login', { body, host });
    assert.equal(r.status, 403, host);
    assert.match(r.json.error, /address/);
  }
});

test('text where an id should be: 404, and the original error is logged (method, path, message — no body)', async t => {
  const warned = [];
  t.mock.method(console, 'warn', (...a) => { warned.push(a.map(String).join(' ')); });
  const r = await call('POST', '/api/floor/take', { as: owner, body: { line_id: 'abc', qty: 1, secret_note: 'do-not-log-me' } });
  assert.equal(r.status, 404, r.text);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /POST \/api\/floor\/take/);
  assert.match(warned[0], /invalid input syntax/);
  assert.doesNotMatch(warned[0], /do-not-log-me/);
});

test('a password reset lifts the lock in the same transaction (a failed unlock undoes the reset)', async () => {
  const sam = await auth.findUser('sam');
  const ip = '192.0.2.77';
  for (let i = 0; i < 5; i++) await loginAs('sam', 'wrong-pass-1', { ip });
  assert.equal((await loginAs('sam', 'office-pass-1', { ip })).status, 429);
  // the work done inside the reset fails: the new password is not kept
  const before0 = (await get('SELECT pass_hash FROM users WHERE id = ?', sam.id)).pass_hash;
  await assert.rejects(auth.resetPassword(sam.id, 'brand-new-pass-1', { also: async () => { throw new Error('unlock failed'); } }), /unlock failed/);
  assert.equal((await get('SELECT pass_hash FROM users WHERE id = ?', sam.id)).pass_hash, before0);
  // through the app: reset and unlock together, so sam can log in at once from that address
  const r = await call('POST', `/api/users/${sam.id}/password`, { as: owner, body: { password: 'brand-new-pass-1', must_change: false } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await loginAs('sam', 'brand-new-pass-1', { ip })).status, 200);
});

test('paused / unreachable database errors count as "asleep"', () => {
  for (const e of [
    Object.assign(new Error('Tenant or user not found'), { code: 'XX000' }), // Supavisor, project paused
    Object.assign(new Error('getaddrinfo ENOTFOUND db.abc.supabase.co'), { code: 'ENOTFOUND' }),
    new Error('getaddrinfo ENOTFOUND aws-0-ap-southeast-2.pooler.supabase.com'),
    new Error('connect ECONNREFUSED 127.0.0.1:6543'),
    new Error('Connection refused (os error 111)'),
    Object.assign(new Error('write CONNECT_TIMEOUT x:6543'), { code: 'CONNECT_TIMEOUT' }),
    new Error('connection timed out'),
    Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
    Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
  ]) assert.equal(isUnreachable(e), true, e.message);
  for (const e of [
    Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    Object.assign(new Error('invalid input syntax for type integer: "abc"'), { code: '22P02' }),
    new Error('Something else'),
  ]) assert.equal(isUnreachable(e), false, e.message);
});

test('the function entry: Supabase\'s path is the app\'s path, and the database opens once, before the first request', async () => {
  assert.equal(functionPath('/api/api/me'), '/api/me');
  assert.equal(functionPath('/api/api/vans?status=x'), '/api/vans?status=x');
  assert.equal(functionPath('/api/photos/a.jpg'), '/photos/a.jpg');
  assert.equal(functionPath('/functions/v1/api/api/me'), '/api/me');
  assert.equal(functionPath('/api/me'), '/api/me'); // already the app's own
  assert.equal(functionPath('/photos/a.jpg'), '/photos/a.jpg');
  assert.equal(functionPath('/api'), '/api');

  let opens = 0, fail = true;
  const seen = [];
  const open = async () => { opens++; if (fail) throw Object.assign(new Error(ASLEEP), { status: 503 }); };
  const handler = edgeHandler({ open, app: (req, res) => { seen.push(req.url); res.end('ok'); } });
  assert.equal(opens, 1, 'opened at once, not on the first request');
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  try {
    const port = s.address().port;
    let r = await fetch(`http://127.0.0.1:${port}/api/api/me`);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('x-fs-app'), '1', 'our own answer: the pass-through passes it on as it is');
    assert.deepEqual(await r.json(), { error: ASLEEP });
    fail = false; // the database woke up: the next request tries again
    r = await fetch(`http://127.0.0.1:${port}/api/api/me`);
    assert.equal(await r.text(), 'ok');
    r = await fetch(`http://127.0.0.1:${port}/api/photos/b.jpg`);
    // start-up (failed), the first request (tried again, failed), the second (worked) — then kept
    assert.equal(opens, 3);
    assert.deepEqual(seen, ['/api/me', '/photos/b.jpg']);
  } finally { await new Promise(r => s.close(r)); }
});

// (last: the app's database is pointed at nothing from here on)
test('database down gives a 503 with a plain message', async () => {
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await openDb({ url: `postgres://nobody:nothing@127.0.0.1:${port}/none` });
  // a phone that is logged in (its session has to be looked up) …
  let r = await call('GET', '/api/me', { as: owner });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: ASLEEP });
  // … and a log in
  r = await loginAs('boss', 'owner-pass-1');
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: ASLEEP });
});
