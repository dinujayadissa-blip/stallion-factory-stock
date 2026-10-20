// Logins and job roles (src/auth.js): passwords, sessions, throttling, setup, who may do what, last owner.
// Runs on a new, empty database in a temp folder — never on the real data.   node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
process.env.DATA_DIR = dir;
const { db, get, run } = await import('../src/db.js');
const auth = await import('../src/auth.js');
after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });

const DAY = 24 * 60 * 60 * 1000;

test('passwords: scrypt$N$r$p$salt$hash, verified with the right password only, never the same twice', async () => {
  const h = await auth.hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  const [, , , , salt, key] = h.split('$');
  assert.equal(Buffer.from(salt, 'base64').length, 16);
  assert.equal(Buffer.from(key, 'base64').length, 64);
  assert.equal(await auth.verifyPassword('correct horse', h), true);
  assert.equal(await auth.verifyPassword('correct horsE', h), false);
  assert.equal(await auth.verifyPassword('', h), false);
  assert.notEqual(await auth.hashPassword('correct horse'), h); // random salt
  assert.equal(await auth.verifyPassword('x', 'not a hash'), false);
  assert.equal(await auth.verifyPassword('x', 'scrypt$99999999$8$1$AAAA$AAAA'), false); // silly settings refused
  assert.equal(auth.passwordProblem('short'), 'Use at least 8 characters for the password');
  assert.equal(auth.passwordProblem('longenough'), '');
  assert.match(auth.passwordProblem('samsmith1', 'SamSmith1'), /username/);
});

test('users: unique username whatever the capitals, workers need a trade, the hash is never handed out', async () => {
  const u = await auth.createUser({ username: 'Sparky', name: 'Sam Sparks', role: 'worker', trade: 'electrician', password: 'volts-1234' }, 'test');
  assert.deepEqual(auth.publicUser(u), { id: u.id, username: 'Sparky', name: 'Sam Sparks', role: 'worker', trade: 'electrician' });
  assert.equal(u.must_change, 1); // a temporary password by default
  assert.equal('pass_hash' in u, false);
  assert.ok(auth.listUsers().every(x => !('pass_hash' in x)));
  await assert.rejects(auth.createUser({ username: 'sparky', name: 'Other', role: 'office', password: 'abcdefgh1' }), /already taken/);
  await assert.rejects(auth.createUser({ username: 'pete', name: 'Pete', role: 'worker', password: 'abcdefgh1' }), /trade/);
  await assert.rejects(auth.createUser({ username: 'pete', name: 'Pete', role: 'boss', password: 'abcdefgh1' }), /job role/);
  await assert.rejects(auth.createUser({ username: 'pe te', name: 'Pete', role: 'office', password: 'abcdefgh1' }), /Username/);
  await assert.rejects(auth.createUser({ username: 'pete', name: 'Pete', role: 'office', password: 'short' }), /8 characters/);
  // non-workers have no fixed trade
  const o = await auth.createUser({ username: 'office1', name: 'Olive Office', role: 'office', trade: 'plumber', password: 'office-123' });
  assert.equal(o.trade, '');
  assert.equal(auth.findUser('SPARKY').id, u.id);
});

test('log in: right password works; wrong password, unknown username and a turned-off login all say the same', async () => {
  const t = auth.createThrottle();
  await auth.createUser({ username: 'stores1', name: 'Stu Stores', role: 'stores', password: 'shelves-99', mustChange: false });
  const ok = await auth.login({ username: 'STORES1', password: 'shelves-99', ip: '10.0.0.5' }, t);
  assert.equal(ok.user.username, 'stores1');
  assert.equal(ok.user.mustChange, false);
  assert.match(ok.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(auth.findUser('stores1').last_login);
  // only sha256(token) is stored
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', ok.token).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', auth.tokenHash(ok.token)).n, 1);

  await assert.rejects(auth.login({ username: 'stores1', password: 'wrong-one', ip: '10.0.0.5' }, t), { status: 401, message: auth.WRONG });
  await assert.rejects(auth.login({ username: 'nobody', password: 'shelves-99', ip: '10.0.0.5' }, t), { status: 401, message: auth.WRONG });
  const id = auth.findUser('stores1').id;
  run('UPDATE users SET active = 0 WHERE id = ?', id);
  await assert.rejects(auth.login({ username: 'stores1', password: 'shelves-99', ip: '10.0.0.5' }, t), { status: 401, message: auth.WRONG });
  run('UPDATE users SET active = 1 WHERE id = ?', id);
  // a temporary password: logged in, but must choose a new one first
  const w = await auth.login({ username: 'sparky', password: 'volts-1234', ip: '10.0.0.5' }, t);
  assert.equal(w.user.mustChange, true);
});

test('log in: 5 wrong tries for a username from one address lock it 15 minutes; 30 from one address lock the address', async () => {
  const t = auth.createThrottle();
  const now = Date.UTC(2026, 9, 20, 2, 0, 0);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login({ username: 'stores1', password: 'nope-nope', ip: '10.0.0.9' }, t, now + i), { message: auth.WRONG });
  // locked — even the right password is refused, without saying whether it was right
  await assert.rejects(auth.login({ username: 'stores1', password: 'shelves-99', ip: '10.0.0.9' }, t, now + 10), { status: 429, message: auth.LOCKED });
  // another address, or another username from this address, is not locked
  assert.ok((await auth.login({ username: 'stores1', password: 'shelves-99', ip: '10.0.0.10' }, t, now + 20)).token);
  assert.equal(t.locked('10.0.0.9', 'office1', now + 30), false);
  // 15 minutes later it works again
  assert.ok((await auth.login({ username: 'stores1', password: 'shelves-99', ip: '10.0.0.9' }, t, now + 15 * 60 * 1000 + 20)).token);

  // address lock: 30 wrong tries (different usernames) within 15 minutes
  const t2 = auth.createThrottle();
  for (let i = 0; i < 30; i++) t2.fail('10.0.0.66', `user${i}`, now + i * 1000);
  assert.equal(t2.locked('10.0.0.66', 'stores1', now + 31000), true);
  assert.equal(t2.locked('10.0.0.67', 'stores1', now + 31000), false);
  assert.equal(t2.locked('10.0.0.66', 'stores1', now + 31000 + 15 * 60 * 1000), false);
  // spread over more than 15 minutes: no lock
  const t3 = auth.createThrottle();
  for (let i = 0; i < 30; i++) t3.fail('10.0.0.70', `user${i}`, now + i * 60 * 1000);
  assert.equal(t3.locked('10.0.0.70', 'x', now + 30 * 60 * 1000), false);
});

test('sessions: 30 days from the last use (phones stay logged in), then gone; log out ends it', async () => {
  const u = auth.findUser('stores1');
  const t0 = Date.UTC(2026, 0, 1);
  const token = auth.createSession(u.id, { ip: '1.2.3.4', ua: 'test' }, t0);
  assert.equal(auth.sessionFromToken(token, t0 + 1000).user.username, 'stores1');
  assert.equal(auth.sessionFromToken(token, t0 + 1000).refreshed, false); // not written on every request
  // used after 20 days: good for 30 more
  const s20 = auth.sessionFromToken(token, t0 + 20 * DAY);
  assert.equal(s20.refreshed, true);
  assert.ok(auth.sessionFromToken(token, t0 + 45 * DAY)); // 25 days after the last use
  // not used for over 30 days: logged out, and the row is removed
  assert.equal(auth.sessionFromToken(token, t0 + 45 * DAY + 31 * DAY), null);
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', auth.tokenHash(token)).n, 0);

  // log out
  const t2 = auth.createSession(u.id);
  assert.ok(auth.sessionFromToken(t2));
  auth.endSession(auth.tokenHash(t2));
  assert.equal(auth.sessionFromToken(t2), null);
  // rubbish cookies are just "not logged in"
  assert.equal(auth.sessionFromToken('abc'), null);
  assert.equal(auth.sessionFromToken(undefined), null);
  assert.equal(auth.sessionFromToken('A'.repeat(43)), null);
  // the cookie
  const c = auth.sessionCookie('tok', { secure: false });
  assert.match(c, /^fs_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.match(auth.sessionCookie('tok', { secure: true }), /; Secure$/);
  assert.equal(auth.readCookie('a=1; fs_session=xyz; b=2'), 'xyz');
  assert.equal(auth.readCookie('fs_sessionx=1'), '');
});

test('password changes: own change keeps this session and ends the others; reset / turn off / new role end them all', async () => {
  const u = auth.findUser('office1');
  const a = auth.createSession(u.id), b = auth.createSession(u.id);
  await assert.rejects(auth.changeOwnPassword(u.id, 'wrong-pass', 'new-office-1', auth.tokenHash(a)), /current password/);
  await assert.rejects(auth.changeOwnPassword(u.id, 'office-123', 'short', auth.tokenHash(a)), /8 characters/);
  await auth.changeOwnPassword(u.id, 'office-123', 'new-office-1', auth.tokenHash(a));
  assert.ok(auth.sessionFromToken(a));
  assert.equal(auth.sessionFromToken(b), null);
  assert.equal(auth.findUser('office1').must_change, 0);
  const t = auth.createThrottle();
  await assert.rejects(auth.login({ username: 'office1', password: 'office-123' }, t), { message: auth.WRONG });
  assert.ok(await auth.login({ username: 'office1', password: 'new-office-1' }, t));

  // the owner resets it: every session ends, temporary password
  const c = auth.createSession(u.id);
  await auth.resetPassword(u.id, 'temp-pass-1');
  assert.equal(auth.sessionFromToken(a), null);
  assert.equal(auth.sessionFromToken(c), null);
  assert.equal(auth.findUser('office1').must_change, 1);

  // a new job role ends the sessions; a name change alone doesn't
  const d = auth.createSession(u.id);
  auth.updateUser(u.id, { name: 'Olive O.' });
  assert.ok(auth.sessionFromToken(d));
  auth.updateUser(u.id, { role: 'stores' });
  assert.equal(auth.sessionFromToken(d), null);
  auth.updateUser(u.id, { role: 'office' });

  // turned off: logged out at once
  const e = auth.createSession(u.id);
  auth.setActive(u.id, false);
  assert.equal(auth.sessionFromToken(e), null);
  auth.setActive(u.id, true);
});

test('first login: only with no logins at all, only from this PC itself (never because of a header)', async () => {
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(auth.fromThisPc(req('127.0.0.1')), true);
  assert.equal(auth.fromThisPc(req('::1')), true);
  assert.equal(auth.fromThisPc(req('::ffff:127.0.0.1')), true);
  assert.equal(auth.fromThisPc(req('192.168.0.40')), false);
  assert.equal(auth.fromThisPc(req('::ffff:192.168.0.40')), false);
  // headers never make it "this PC" …
  assert.equal(auth.fromThisPc(req('192.168.0.40', { 'x-forwarded-for': '127.0.0.1', host: 'localhost' })), false);
  // … and a request through a tunnel / proxy on this PC is not "this PC" either
  assert.equal(auth.fromThisPc(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false);
  assert.equal(auth.fromThisPc(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })), false);
  // there are logins already (from the tests above): setup refuses
  await assert.rejects(auth.setupOwner({ username: 'boss', name: 'Boss', password: 'owner-pass-1' }), { status: 409 });
});

test('first login on an empty database makes an owner who does not have to change the password', async () => {
  run('DELETE FROM sessions'); run('DELETE FROM users');
  assert.equal(auth.userCount(), 0);
  const o = await auth.setupOwner({ username: 'boss', name: 'Bea Boss', password: 'owner-pass-1' });
  assert.equal(o.role, 'owner');
  assert.equal(o.must_change, 0);
  await assert.rejects(auth.setupOwner({ username: 'boss2', name: 'Other', password: 'owner-pass-2' }), { status: 409 });
});

test('the last active owner can never be turned off or given another role; nobody turns off themselves', async () => {
  const boss = auth.findUser('boss');
  assert.throws(() => auth.setActive(boss.id, false), /only owner/);
  assert.throws(() => auth.updateUser(boss.id, { role: 'office' }), /only owner/);
  const two = await auth.createUser({ username: 'boss2', name: 'Second Owner', role: 'owner', password: 'owner-pass-2' });
  // owners can't turn off themselves or change their own role, even with another owner there
  assert.throws(() => auth.setActive(boss.id, false, auth.publicUser(boss)), /your own login/);
  assert.throws(() => auth.updateUser(boss.id, { role: 'office' }, auth.publicUser(boss)), /your own job role/);
  // another owner can, now that there are two
  auth.updateUser(boss.id, { role: 'office' }, auth.publicUser(two));
  assert.throws(() => auth.setActive(two.id, false, auth.publicUser(boss)), /only owner/); // boss2 is the last owner now
  auth.updateUser(boss.id, { role: 'owner' }, auth.publicUser(two));
  auth.setActive(two.id, false, auth.publicUser(boss));
  assert.equal(auth.findUser('boss2').active, 0);
  // a turned-off owner doesn't count: boss is the only active one
  assert.throws(() => auth.setActive(boss.id, false, auth.publicUser(two)), /only owner/);
});

test('who may do what: a sample of the table for every job role', () => {
  const may = (role, method, p) => auth.allowed(method, p, role);
  // workers: the worker app only
  for (const [m, p] of [['GET', '/api/floor/map'], ['GET', '/api/floor/vans/3'], ['POST', '/api/floor/take'], ['POST', '/api/floor/undo'],
    ['POST', '/api/floor/receive'], ['POST', '/api/floor/extra'], ['GET', '/api/items'], ['GET', '/api/items/4'], ['GET', '/api/layout'],
    ['POST', '/api/vans/3/notes'], ['GET', '/api/vans/3/floor'], ['PUT', '/api/reminders/9'], ['GET', '/api/me'], ['POST', '/api/me/password']]) {
    assert.equal(may('worker', m, p), true, `worker ${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/api/summary'], ['GET', '/api/vans'], ['GET', '/api/vans/3'], ['GET', '/api/plan'], ['GET', '/api/pos'],
    ['POST', '/api/items/4/receive'], ['POST', '/api/vans/3/move'], ['DELETE', '/api/reminders/9'], ['POST', '/api/reminders'], ['GET', '/api/settings'],
    ['GET', '/api/export/plan.xlsx'], ['GET', '/api/users'], ['POST', '/api/rules']]) {
    assert.equal(may('worker', m, p), false, `worker ${m} ${p}`);
  }
  // stores: can receive (items, POs), count, adjust — not create / edit POs, not answer "already ordered?"
  for (const [m, p] of [['POST', '/api/items/4/receive'], ['POST', '/api/pos/2/receive'], ['POST', '/api/counts'], ['POST', '/api/counts/1/save'],
    ['POST', '/api/items/4/adjust'], ['POST', '/api/stocktake'], ['POST', '/api/stock-checks/ack'], ['POST', '/api/items/4/photo'],
    ['POST', '/api/items/rack'], ['GET', '/api/summary'], ['GET', '/api/pos/2'], ['POST', '/api/vans/3/issue'], ['POST', '/api/floor/take']]) {
    assert.equal(may('stores', m, p), true, `stores ${m} ${p}`);
  }
  for (const [m, p] of [['POST', '/api/pos'], ['PUT', '/api/pos/2'], ['DELETE', '/api/pos/2'], ['POST', '/api/check-ordered'], ['POST', '/api/check-ordered/all'],
    ['POST', '/api/vans/3/move'], ['POST', '/api/rules'], ['POST', '/api/items'], ['POST', '/api/web-image'], ['GET', '/api/settings'], ['GET', '/api/users']]) {
    assert.equal(may('stores', m, p), false, `stores ${m} ${p}`);
  }
  // leading hand: runs the floor — not the rules, not the layout, not stock
  for (const [m, p] of [['POST', '/api/vans/3/move'], ['POST', '/api/vans/3/leave'], ['POST', '/api/layout/advance'], ['POST', '/api/reminders'],
    ['DELETE', '/api/reminders/9'], ['DELETE', '/api/notes/2'], ['GET', '/api/plan'], ['GET', '/api/items'], ['POST', '/api/floor/take']]) {
    assert.equal(may('leadhand', m, p), true, `leadhand ${m} ${p}`);
  }
  for (const [m, p] of [['POST', '/api/rules'], ['PUT', '/api/rules/1'], ['POST', '/api/layout/areas'], ['PUT', '/api/layout/areas/1'],
    ['POST', '/api/items/4/receive'], ['POST', '/api/pos/2/receive'], ['POST', '/api/import/plan/update'], ['GET', '/api/users']]) {
    assert.equal(may('leadhand', m, p), false, `leadhand ${m} ${p}`);
  }
  // office: everything in the office app — but not the logins
  for (const [m, p] of [['POST', '/api/pos'], ['POST', '/api/rules'], ['POST', '/api/settings/clear-stock'], ['POST', '/api/import/plan/apply'],
    ['POST', '/api/layout/areas'], ['POST', '/api/web-image'], ['GET', '/api/export/plan.xlsx'], ['POST', '/api/vans/3/move'], ['POST', '/api/items/4/receive']]) {
    assert.equal(may('office', m, p), true, `office ${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/api/users'], ['POST', '/api/users'], ['PUT', '/api/users/2'], ['POST', '/api/users/2/password'], ['POST', '/api/users/2/active']]) {
    assert.equal(may('office', m, p), false, `office ${m} ${p}`);
    assert.equal(may('owner', m, p), true, `owner ${m} ${p}`);
  }
  // anything not in the table: owner only (default deny); HEAD = GET; capitals don't matter (like Express)
  assert.equal(may('office', 'POST', '/api/something-new'), false);
  assert.equal(may('owner', 'POST', '/api/something-new'), true);
  assert.equal(may('worker', 'HEAD', '/api/floor/map'), true);
  assert.equal(may('worker', 'GET', '/API/Floor/Map'), true);
  assert.equal(may('worker', 'GET', '/api/floor/map/'), true);
  assert.equal(may('worker', 'GET', '/api/floor/vans/3/extra'), false);
  // no login: only the log in routes
  assert.equal(may(undefined, 'POST', '/api/login'), true);
  assert.equal(may(undefined, 'GET', '/api/me'), false);
  // the front end's switches follow the table
  assert.deepEqual(auth.capabilities('stores'), { officeApp: true, office: false, stock: true, issue: true, poReceive: true, floor: false, layout: false,
    webImage: false, export: false, settings: false, users: false, pickTrade: true });
  assert.equal(auth.capabilities('worker').officeApp, false);
  assert.equal(auth.capabilities('worker').pickTrade, false);
  assert.equal(auth.capabilities('leadhand').floor, true);
  assert.equal(auth.capabilities('owner').users, true);
});

test('field limits: stores may only set where a part is kept; a leading hand may only set a van planned / in production', () => {
  const item = auth.apiRule('PUT', '/api/items/5');
  assert.equal(auth.fieldsAllowed(item, 'stores', { area_id: 3, location: 'Shelf 2', by: 'ignored' }), true);
  assert.equal(auth.fieldsAllowed(item, 'stores', { area_id: 3, name: 'New name' }), false);
  assert.equal(auth.fieldsAllowed(item, 'stores', {}), false);
  assert.equal(auth.fieldsAllowed(item, 'office', { name: 'New name' }), true);
  const van = auth.apiRule('PUT', '/api/vans/5');
  assert.equal(auth.fieldsAllowed(van, 'leadhand', { status: 'planned' }), true);
  assert.equal(auth.fieldsAllowed(van, 'leadhand', { status: 'completed' }), false);
  assert.equal(auth.fieldsAllowed(van, 'leadhand', { eta: '2026-12-01' }), false);
  assert.equal(auth.fieldsAllowed(van, 'office', { eta: '2026-12-01' }), true);
});

test('which addresses may send changes: this PC and its names, ALLOWED_HOSTS, never another site', () => {
  assert.equal(auth.hostAllowed('localhost:3000'), true);
  assert.equal(auth.hostAllowed('127.0.0.1:3000'), true);
  assert.equal(auth.hostAllowed('[::1]:3000'), true);
  assert.equal(auth.hostAllowed(`${os.hostname()}:3000`), true);
  assert.equal(auth.hostAllowed(`${os.hostname().toLowerCase()}.lan:3000`), true);
  assert.equal(auth.hostAllowed('evil.example:3000'), false);
  assert.equal(auth.hostAllowed(''), false);
  const lan = Object.values(os.networkInterfaces()).flat().find(n => n?.family === 'IPv4' && !n.internal);
  if (lan) assert.equal(auth.hostAllowed(`${lan.address}:3000`), true);
});

test('issue #1: every line of the table can be reached — a ":id" line never swallows a named path', () => {
  const methods = m => (m === '*' ? ['GET', 'POST', 'PUT', 'DELETE'] : [m]);
  for (const [method, p] of auth.API_RULES) {
    const concrete = p.replace(/:[a-z]+/gi, '7');
    const hit = methods(method).some(m => { const r = auth.apiRule(m, concrete); return r.method === method && r.path === p; });
    assert.ok(hit, `${method} ${p} is shadowed by ${auth.apiRule(methods(method)[0], concrete).path}`);
  }
  // the three office lists under /api/items/… are not open to workers
  for (const p of ['/api/items/unassigned', '/api/items/many-specs', '/api/items/still-to-order']) {
    assert.equal(auth.allowed('GET', p, 'worker'), false, p);
    assert.equal(auth.allowed('GET', p, 'stores'), true, p);
  }
  assert.equal(auth.allowed('GET', '/api/items/12', 'worker'), true);
});

test('issue #2: floor stats count by login id; only old movements (no id) by name', async () => {
  const inv = await import('../src/inventory.js');
  const item = Number(run(`INSERT INTO items(sku, name) VALUES('ST-1', 'Stats part')`).lastInsertRowid);
  const mv = (worker, userId) => run(`INSERT INTO movements(item_id, qty, type, worker, user_id) VALUES(?, -1, 'issue', ?, ?)`, item, worker, userId);
  mv('Sam Smith', 101); mv('Sam Smith', 102); mv('Sam Smith', 102); mv('Sam Smith', null);
  assert.equal(inv.floorStats({ userId: 101, name: 'Sam Smith' }).mine_took, 2); // own (1) + the old one by name (1)
  assert.equal(inv.floorStats({ userId: 102, name: 'Sam Smith' }).mine_took, 3);
  assert.equal(inv.floorStats('Sam Smith').mine_took, 1); // a plain name: only rows without a login id
});
