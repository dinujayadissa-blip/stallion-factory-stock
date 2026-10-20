// Logins and job roles through the real server: the app is started on a new, empty database in a temp
// folder, on a free port (PORT=0) — never on the real data, never on port 3000.   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-http-'));
let child, port, db;
const lanIp = Object.values(os.networkInterfaces()).flat().find(n => n?.family === 'IPv4' && !n.internal)?.address;

before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, DATA_DIR: dir, PORT: '0', ALLOWED_HOSTS: '', TRUST_PROXY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 90000);
    const on = d => { out += d; const m = /On this PC:\s+http:\/\/localhost:(\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', code => { clearTimeout(t); reject(new Error(`server stopped (${code}):\n${out}`)); });
  });
  db = new DatabaseSync(path.join(dir, 'factory.db'));
  db.exec('PRAGMA busy_timeout = 5000');
});
after(async () => {
  try { db?.close(); } catch { /* closed */ }
  if (child && child.exitCode == null) { child.removeAllListeners('exit'); child.kill(); await new Promise(r => child.once('exit', r)); }
  for (let i = 0; i < 10; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
});

// One request; `as` = the cookie of a logged-in person (or none).
function call(method, p, { body, as, headers = {}, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host, port, method, path: p, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      ...(as ? { Cookie: `fs_session=${as}` } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        const cookies = [res.headers['set-cookie'] || []].flat();
        const set = cookies.map(c => /^fs_session=([^;]*)/.exec(c)?.[1]).filter(v => v != null).pop();
        resolve({ status: res.statusCode, headers: res.headers, json, text, cookie: set, cookies });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const login = async (username, password) => {
  const r = await call('POST', '/api/login', { body: { username, password } });
  assert.equal(r.status, 200, `log in ${username}: ${r.text}`);
  assert.ok(r.cookie);
  return r.cookie;
};
const NO = "Your login can't do that — ask the owner";
const S = {}; // cookies by person
const id = {}; // ids of fixtures and logins

test('not logged in: the API says "Please log in", the pages go to /login, styles / scripts / app icon still load', async () => {
  let r = await call('GET', '/api/me');
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: 'Please log in' });
  assert.equal((await call('GET', '/api/vans')).status, 401);
  assert.equal((await call('POST', '/api/vans', { body: {} })).status, 401);
  r = await call('GET', '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login?next=%2F');
  r = await call('GET', '/floor');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login?next=%2Ffloor');
  assert.equal((await call('GET', '/index.html')).status, 302);
  assert.equal((await call('GET', '/login')).status, 200);
  for (const p of ['/styles.css', '/floor.css', '/login.js', '/floor.webmanifest', '/floor-sw.js', '/fonts/fonts.css', '/assets/brand/mark-bark.png']) {
    assert.equal((await call('GET', p)).status, 200, p);
  }
  assert.equal((await call('GET', '/photos/1-1.jpg')).status, 401);
});

test('first login: refused from another PC and through a proxy; made on this PC; only once', async () => {
  let r = await call('GET', '/api/setup');
  assert.deepEqual(r.json, { needed: true, here: true });
  const body = { username: 'boss', name: 'Bea Boss', password: 'owner-pass-1' };
  if (lanIp) {
    r = await call('GET', '/api/setup', { host: lanIp });
    assert.deepEqual(r.json, { needed: true, here: false });
    r = await call('POST', '/api/setup', { host: lanIp, body });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'Open this on the office PC itself to create the first login');
  }
  // a header can't make it "this PC" — and a request that came through a tunnel on this PC is refused
  r = await call('POST', '/api/setup', { body, headers: { 'X-Forwarded-For': '203.0.113.7' } });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/setup', { body });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.role, 'owner');
  assert.match(r.cookies.join('\n'), /fs_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  S.owner = r.cookie;
  r = await call('POST', '/api/setup', { body: { ...body, username: 'boss2' } });
  assert.equal(r.status, 409);
  assert.deepEqual((await call('GET', '/api/setup')).json, { needed: false, here: true });
  r = await call('GET', '/api/me', { as: S.owner });
  assert.equal(r.json.user.name, 'Bea Boss');
  assert.equal(r.json.can.users, true);
  assert.equal('pass_hash' in r.json.user, false);
});

test('the owner adds one login per job role; each logs in', async () => {
  const add = async (username, name, role, trade = '', must_change = false) => {
    const r = await call('POST', '/api/users', { as: S.owner, body: { username, name, role, trade, password: `${username}-pass-1`, must_change } });
    assert.equal(r.status, 200, r.text);
    assert.equal('pass_hash' in r.json, false);
    id[username] = r.json.id;
  };
  await add('olive', 'Olive Office', 'office');
  await add('stu', 'Stu Stores', 'stores');
  await add('lee', 'Lee Leading', 'leadhand');
  await add('sam', 'Sam Sparks', 'worker', 'electrician');
  await add('pat', 'Pat Plumber', 'worker', 'plumber');
  await add('newbie', 'Nick New', 'worker', 'builder', true);
  for (const u of ['olive', 'stu', 'lee', 'sam', 'pat']) S[u] = await login(u, `${u}-pass-1`);
  const list = await call('GET', '/api/users', { as: S.owner });
  assert.equal(list.json.users.length, 7);
  assert.ok(list.json.users.every(u => !('pass_hash' in u)));
  // the office can't see or change the logins
  assert.deepEqual((await call('GET', '/api/users', { as: S.olive })).json, { error: NO });
  assert.equal((await call('POST', '/api/users', { as: S.olive, body: { username: 'x1', name: 'X', role: 'owner', password: 'abcdefgh1' } })).status, 403);

  // fixtures for the tests below: a van in production with an electrician part, a plumber part, a supplier part
  const item = (sku, name, trade) => Number(db.prepare(`INSERT INTO items(sku, name, category, supplier, trade, on_hand) VALUES(?, ?, 'General', 'Onex', ?, 10)`)
    .run(sku, name, trade).lastInsertRowid);
  id.sparkItem = item('T-SPARK', 'Test switch', 'electrician');
  id.plumbItem = item('T-PLUMB', 'Test tap', 'plumber');
  id.van = Number(db.prepare(`INSERT INTO vans(chassis, status, eta) VALUES('TST1', 'in_production', '2027-01-01')`).run().lastInsertRowid);
  id.sparkLine = Number(db.prepare(`INSERT INTO van_lines(van_id, item_id, qty, source) VALUES(?, ?, 3, 'manual')`).run(id.van, id.sparkItem).lastInsertRowid);
});

test('a temporary password: nothing works until a new one is chosen', async () => {
  const r = await call('POST', '/api/login', { body: { username: 'NEWBIE', password: 'newbie-pass-1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.mustChange, true);
  const c = r.cookie;
  let x = await call('GET', '/api/floor/map', { as: c });
  assert.equal(x.status, 403);
  assert.equal(x.json.mustChange, true);
  assert.equal((await call('GET', '/floor', { as: c })).status, 302);
  assert.equal((await call('POST', '/api/me/password', { as: c, body: { current: 'newbie-pass-1', password: 'short' } })).status, 400);
  x = await call('POST', '/api/me/password', { as: c, body: { current: 'newbie-pass-1', password: 'my-own-pass-9' } });
  assert.equal(x.status, 200, x.text);
  assert.equal(x.json.user.mustChange, false);
  assert.equal((await call('GET', '/api/floor/map', { as: c })).status, 200);
});

test('a worker: only the worker app, only their own trade', async () => {
  assert.equal((await call('GET', '/api/summary', { as: S.sam })).status, 403);
  assert.deepEqual((await call('GET', '/api/vans', { as: S.sam })).json, { error: NO });
  assert.equal((await call('POST', '/api/items/1/receive', { as: S.sam, body: { qty: 1 } })).status, 403);
  // issue #1: the office lists under /api/items/… are not the worker's /api/items/:id
  for (const p of ['/api/items/unassigned', '/api/items/many-specs', '/api/items/still-to-order']) assert.equal((await call('GET', p, { as: S.sam })).status, 403, p);
  assert.equal((await call('GET', '/api/items/unassigned', { as: S.stu })).status, 200);
  assert.equal((await call('POST', '/api/vans/1/move', { as: S.sam, body: { area_id: null } })).status, 403);
  let r = await call('GET', '/', { as: S.sam });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/floor');
  assert.equal((await call('GET', '/floor', { as: S.sam })).status, 200);
  assert.equal((await call('GET', '/photos/none.jpg', { as: S.sam })).status, 404); // logged in: the picture is looked for
  // the trade asked for is ignored: always their own
  r = await call('GET', '/api/floor/map?trade=plumber', { as: S.sam });
  assert.equal(r.status, 200);
  assert.equal(r.json.trade, 'electrician');
  assert.equal((await call('GET', '/api/floor/map?trade=all', { as: S.pat })).json.trade, 'plumber');
  // everyone else picks a trade view
  assert.equal((await call('GET', '/api/floor/map?trade=plumber', { as: S.lee })).json.trade, 'plumber');
  assert.equal((await call('GET', '/api/floor/map', { as: S.stu })).json.trade, 'all');
  const me = await call('GET', '/api/me', { as: S.sam });
  assert.equal(me.json.can.officeApp, false);
  assert.equal(me.json.can.pickTrade, false);
});

test('the name on every change is the login\'s name — a "by" sent from the page is ignored', async () => {
  let r = await call('POST', `/api/vans/${id.van}/notes`, { as: S.sam, body: { text: 'Cable run checked', by: 'Mallory' } });
  assert.equal(r.status, 200, r.text);
  r = await call('GET', `/api/vans/${id.van}/floor`, { as: S.sam });
  assert.equal(r.json.notes[0].worker, 'Sam Sparks');
  r = await call('POST', '/api/floor/take', { as: S.sam, body: { line_id: id.sparkLine, qty: 1, seen_issued: 0, by: 'Mallory' } });
  assert.equal(r.status, 200, r.text);
  id.take = r.json.movement_id;
  assert.equal(db.prepare('SELECT worker FROM movements WHERE id = ?').get(id.take).worker, 'Sam Sparks');
  r = await call('GET', '/api/floor/stats?by=Mallory', { as: S.sam });
  assert.equal(r.json.mine_took, 1);
  // stores receiving at the office: the name is recorded too
  r = await call('POST', `/api/items/${id.plumbItem}/receive`, { as: S.stu, body: { qty: 2, by: 'Mallory' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare(`SELECT worker FROM movements WHERE item_id = ? AND type = 'receive' ORDER BY id DESC`).get(id.plumbItem).worker, 'Stu Stores');
  // a reminder added by the leading hand
  r = await call('POST', '/api/reminders', { as: S.lee, body: { van_id: id.van, text: 'Check the A-frame', by: 'Mallory' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare(`SELECT worker FROM reminders WHERE text = 'Check the A-frame'`).get().worker, 'Lee Leading');
});

test('a worker can undo only their own take — by login, not by name (issue #2)', async () => {
  // the take carries the login's id
  assert.equal(db.prepare('SELECT user_id FROM movements WHERE id = ?').get(id.take).user_id, id.sam);
  let r = await call('POST', '/api/floor/undo', { as: S.pat, body: { movement_id: id.take, line_id: id.sparkLine, van_id: id.van } });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Only the person who did it/);
  // same name on the movement but another login's id: still not theirs
  db.prepare('UPDATE movements SET worker = ? WHERE id = ?').run('Pat Plumber', id.take);
  r = await call('POST', '/api/floor/undo', { as: S.pat, body: { movement_id: id.take, line_id: id.sparkLine, van_id: id.van } });
  assert.equal(r.status, 403);
  db.prepare('UPDATE movements SET worker = ? WHERE id = ?').run('Sam Sparks', id.take);
  r = await call('POST', '/api/floor/undo', { as: S.sam, body: { movement_id: id.take, line_id: id.sparkLine, van_id: id.van } });
  assert.equal(r.status, 200, r.text);
  // a take saved before logins (no login id) still goes by the name
  r = await call('POST', '/api/floor/take', { as: S.sam, body: { line_id: id.sparkLine, qty: 1, seen_issued: 0 } });
  assert.equal(r.status, 200, r.text);
  const mv = r.json.movement_id;
  db.prepare('UPDATE movements SET user_id = NULL WHERE id = ?').run(mv);
  assert.equal((await call('POST', '/api/floor/undo', { as: S.pat, body: { movement_id: mv, line_id: id.sparkLine, van_id: id.van } })).status, 403);
  assert.equal((await call('POST', '/api/floor/undo', { as: S.sam, body: { movement_id: mv, line_id: id.sparkLine, van_id: id.van } })).status, 200);
  // deliveries booked on the phone carry the login's id too
  r = await call('POST', '/api/floor/receive', { as: S.sam, body: { item_id: id.plumbItem, qty: 1 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare('SELECT user_id FROM movements WHERE id = ?').get(r.json.movement_id).user_id, id.sam);
  assert.equal((await call('POST', '/api/floor/receive/undo', { as: S.pat, body: { movement_id: r.json.movement_id, item_id: id.plumbItem } })).status, 403);
  assert.equal((await call('POST', '/api/floor/receive/undo', { as: S.sam, body: { movement_id: r.json.movement_id, item_id: id.plumbItem } })).status, 200);
});

test('two logins can never have the same name (issue #2)', async () => {
  let r = await call('POST', '/api/users', { as: S.owner, body: { username: 'sam2', name: 'sam  SPARKS', role: 'worker', trade: 'plumber', password: 'sam2-pass-1' } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already has the name/);
  r = await call('PUT', `/api/users/${id.pat}`, { as: S.owner, body: { name: 'Sam Sparks' } });
  assert.equal(r.status, 409);
  r = await call('PUT', `/api/users/${id.pat}`, { as: S.owner, body: { name: 'Pat Plumber' } }); // own name again is fine
  assert.equal(r.status, 200, r.text);
});

test('stores: receive and say where parts are kept — not create purchase orders or edit parts', async () => {
  assert.equal((await call('GET', '/api/summary', { as: S.stu })).status, 200);
  assert.equal((await call('GET', '/api/pos', { as: S.stu })).status, 200);
  assert.equal((await call('POST', '/api/pos', { as: S.stu, body: { po_no: 'T1', supplier: 'Onex', lines: [] } })).status, 403);
  assert.equal((await call('POST', '/api/check-ordered', { as: S.stu, body: { po_ref: '1', answer: 'yes' } })).status, 403);
  let r = await call('PUT', `/api/items/${id.plumbItem}`, { as: S.stu, body: { location: 'Shelf 2', by: 'x' } });
  assert.equal(r.status, 200, r.text);
  r = await call('PUT', `/api/items/${id.plumbItem}`, { as: S.stu, body: { location: 'Shelf 3', name: 'Renamed' } });
  assert.deepEqual(r.json, { error: NO });
  assert.equal(db.prepare('SELECT name, location FROM items WHERE id = ?').get(id.plumbItem).name, 'Test tap');
  assert.equal((await call('POST', `/api/vans/${id.van}/move`, { as: S.stu, body: { area_id: null } })).status, 403);
  assert.equal((await call('GET', '/api/settings', { as: S.stu })).status, 403);
  assert.equal((await call('GET', '/', { as: S.stu })).status, 200);
});

test('leading hand: moves vans and runs the floor — not the parts rules or the layout', async () => {
  let r = await call('POST', `/api/vans/${id.van}/move`, { as: S.lee, body: { area_id: null } });
  assert.equal(r.status, 200, r.text);
  r = await call('PUT', `/api/vans/${id.van}`, { as: S.lee, body: { status: 'in_production' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call('PUT', `/api/vans/${id.van}`, { as: S.lee, body: { eta: '2027-02-02' } })).status, 403);
  assert.equal((await call('PUT', `/api/vans/${id.van}`, { as: S.lee, body: { status: 'completed' } })).status, 403);
  assert.equal((await call('POST', '/api/rules', { as: S.lee, body: { conditions: '*', item_id: 1 } })).status, 403);
  assert.equal((await call('POST', '/api/layout/areas', { as: S.lee, body: { kind: 'bay', x: 1, y: 1, w: 9, h: 3 } })).status, 403);
  assert.equal((await call('POST', `/api/items/${id.plumbItem}/receive`, { as: S.lee, body: { qty: 1 } })).status, 403);
  assert.equal((await call('GET', '/api/plan', { as: S.lee })).status, 200);
});

test('office: everything in the office app', async () => {
  assert.equal((await call('GET', '/api/settings', { as: S.olive })).status, 200);
  assert.equal((await call('PUT', `/api/vans/${id.van}`, { as: S.olive, body: { eta: '2027-02-02' } })).status, 200);
  assert.equal((await call('GET', '/api/export/plan.xlsx', { as: S.olive })).status, 200);
});

test('the last owner stays an owner; a new role or a turned-off login logs that person out', async () => {
  const ownerId = (await call('GET', '/api/me', { as: S.owner })).json.user.id;
  let r = await call('POST', `/api/users/${ownerId}/active`, { as: S.owner, body: { active: false } });
  assert.equal(r.status, 400);
  r = await call('PUT', `/api/users/${ownerId}`, { as: S.owner, body: { role: 'office' } });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/me', { as: S.owner })).json.user.role, 'owner');
  // stores → leading hand: logged out, logs in again with the new role
  r = await call('PUT', `/api/users/${id.stu}`, { as: S.owner, body: { role: 'leadhand' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call('GET', '/api/me', { as: S.stu })).status, 401);
  // turned off: logged out, and can't log in
  r = await call('POST', `/api/users/${id.pat}/active`, { as: S.owner, body: { active: false } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call('GET', '/api/floor/map', { as: S.pat })).status, 401);
  r = await call('POST', '/api/login', { body: { username: 'pat', password: 'pat-pass-1' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'Wrong username or password');
  // the owner resets a password: logged out everywhere
  r = await call('POST', `/api/users/${id.lee}/password`, { as: S.owner, body: { password: 'fresh-temp-1' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call('GET', '/api/me', { as: S.lee })).status, 401);
});

test('log out ends the session on the office PC', async () => {
  const r = await call('POST', '/api/logout', { as: S.olive });
  assert.equal(r.status, 200);
  assert.ok(r.cookies.some(c => /^fs_session=;.*Max-Age=0/.test(c)));
  assert.equal((await call('GET', '/api/me', { as: S.olive })).status, 401);
  assert.equal((await call('GET', '/', { as: S.olive })).status, 302);
});

test('5 wrong passwords lock that username for 15 minutes; changes from another website or address are refused', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/login', { body: { username: 'sam', password: `wrong-${i}-x` } });
    assert.equal(r.json.error, 'Wrong username or password');
  }
  let r = await call('POST', '/api/login', { body: { username: 'sam', password: 'sam-pass-1' } });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'Too many tries — wait 15 minutes');
  // another username from the same address still works
  assert.ok(await login('olive', 'olive-pass-1'));
  // another website in the same browser
  r = await call('POST', '/api/login', { body: { username: 'olive', password: 'olive-pass-1' }, headers: { Origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  // a name that isn't this PC's (DNS rebinding)
  r = await call('POST', '/api/login', { body: { username: 'olive', password: 'olive-pass-1' }, headers: { Host: `evil.example:${port}` } });
  assert.equal(r.status, 403);
});
