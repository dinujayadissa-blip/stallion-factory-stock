// Logging in and out, my login, first-time setup and the Logins page (src/auth.js).
import * as auth from '../auth.js';
import * as inv from '../inventory.js';
import { TRADES } from '../trades.js';
import { NOT_ONLINE, OWN_TX, gone, h, id, now } from './common.js';

// (the second argument: what createApp knows about this server and each request — see `ctx` in src/app.js)
export function loginRoutes(app, { cloud, throttle, clientIp, secure }) {
  // ── Logging in, my login, the Logins page (src/auth.js) ──
  const setSession = (req, res, token) => res.append('Set-Cookie', auth.sessionCookie(token, { secure: secure(req) }));
  const meOut = u => ({ user: { ...auth.publicUser(u), mustChange: !!u.mustChange }, can: auth.capabilities(u.role),
    roles: Object.fromEntries(Object.entries(auth.ROLES).map(([k, r]) => [k, r.label])), trades: TRADES, cloud: !!cloud });
  // (auth.login does its own writes without a new data_version: Ruling R12)
  app.post('/api/login', h(async (req, res) => {
    const r = await auth.login({ username: req.body.username, password: req.body.password, ip: clientIp(req), ua: req.get('User-Agent') || '' }, throttle);
    // A new session every time (never re-use one that was there before the login).
    if (req.sessionHash) await auth.endSession(req.sessionHash);
    setSession(req, res, r.token);
    console.log(now(), `Logged in: ${r.user.username} (${r.user.role}) from ${clientIp(req)}`);
    return meOut(r.user);
  }, OWN_TX));
  app.post('/api/logout', h(async (req, res) => {
    if (req.sessionHash) await auth.endSession(req.sessionHash);
    res.append('Set-Cookie', auth.clearCookie({ secure: secure(req) }));
  }, OWN_TX));
  app.get('/api/me', h(req => meOut(req.user)));
  app.post('/api/me/password', h(async req => {
    // Wrong "current password" counts like a wrong log in (same lockout), so a phone left logged in can't be used to
    // guess the password. (OWN_TX: the wrong try must be kept although the request fails, and the hashing is
    // done outside the write lock; changeOwnPassword has its own writeTx.)
    const ip = clientIp(req);
    const lockEnd = await throttle.lockedUntil(ip, req.user.username);
    if (lockEnd) throw Object.assign(inv.httpError(429, auth.LOCKED), { until: lockEnd });
    try { await auth.changeOwnPassword(req.user.id, String(req.body.current ?? ''), String(req.body.password ?? ''), req.sessionHash); }
    catch (e) { if (e.wrongCurrent) await throttle.fail(ip, req.user.username); throw e; }
    return meOut({ ...req.user, mustChange: false });
  }, OWN_TX));
  // First login (the owner): only while there are none, and only on this PC itself. Online there is no
  // "this PC": the first owner is made with `npm run users -- add` against the cloud database.
  app.get('/api/setup', h(async req => ({ needed: (await auth.userCount()) === 0, here: !cloud && auth.fromThisPc(req) })));
  app.post('/api/setup', cloud ? h(gone(NOT_ONLINE), OWN_TX) : h(async (req, res) => {
    if (await auth.userCount() > 0) throw inv.httpError(409, 'The first login was already made — log in instead');
    if (!auth.fromThisPc(req)) throw inv.httpError(403, 'Open this on the office PC itself to create the first login');
    const u = await auth.setupOwner({ username: req.body.username, name: req.body.name, password: req.body.password });
    setSession(req, res, await auth.createSession(u.id, { ip: clientIp(req), ua: req.get('User-Agent') || '' }));
    console.log(now(), `First login made: ${u.username} (owner)`);
    return meOut(u);
  }, OWN_TX));
  // The Logins page (owner only — see the table in src/auth.js).
  // locked_until: a username locked after wrong passwords (from any device) — the owner can Unlock it.
  app.get('/api/users', h(async () => {
    const locks = await throttle.lockedUsers();
    return { users: (await auth.listUsers()).map(u => ({ ...u, locked_until: locks.get(u.username.toLowerCase()) || 0 })), roles: auth.ROLES, trades: TRADES };
  }));
  app.post('/api/users/:id/unlock', h(async req => {
    const u = await auth.getUser(id(req));
    if (!u) throw inv.httpError(404, 'That login no longer exists — refresh');
    await throttle.unlockUser(u.username);
    console.log(now(), `Login unlocked: ${u.username} by ${req.user.username}`);
  }));
  // (OWN_TX: the password is hashed before createUser's own writeTx, outside the write lock)
  app.post('/api/users', h(async req => {
    const b = req.body || {};
    const u = await auth.createUser({ username: b.username, name: b.name, role: String(b.role || ''), trade: String(b.trade || ''),
      password: b.password, mustChange: b.must_change !== false }, req.user.name);
    console.log(now(), `Login added: ${u.username} (${u.role}) by ${req.user.username}`);
    return u;
  }, OWN_TX));
  app.put('/api/users/:id', h(async req => {
    const b = req.body || {};
    const u = await auth.updateUser(id(req), { name: b.name, role: b.role === undefined ? undefined : String(b.role), trade: b.trade === undefined ? undefined : String(b.trade) }, req.user);
    console.log(now(), `Login changed: ${u.username} (${u.role}${u.trade ? `, ${u.trade}` : ''}) by ${req.user.username}`);
    return u;
  }));
  // (OWN_TX: as for a new login, the hashing stays outside the lock)
  app.post('/api/users/:id/password', h(async req => {
    // A new password also lifts a lock from wrong tries — in the reset's own transaction, so it is both or neither.
    const u = await auth.resetPassword(id(req), req.body.password, { mustChange: req.body.must_change !== false,
      also: row => throttle.unlockUser(row.username) });
    console.log(now(), `Password reset: ${u.username} by ${req.user.username}`);
    return u;
  }, OWN_TX));
  app.post('/api/users/:id/active', h(async req => {
    const u = await auth.setActive(id(req), !!req.body.active, req.user);
    console.log(now(), `Login ${u.active ? 'turned on' : 'turned off'}: ${u.username} by ${req.user.username}`);
    return u;
  }));
}
