// Logins and job roles: passwords, sessions, login throttling, and WHO MAY DO WHAT.
//
// The table API_RULES below is the one place that says which job role may use which /api route.
// It is read top to bottom; the first line that matches the method + path wins. Any /api route that is
// not in the table is owner-only (default deny) — so a new route added to server.js without a line here
// only works for the owner until someone decides who else may use it.
//
// Only node:crypto is used (no extra packages): scrypt for passwords, random 32-byte session tokens of
// which only a sha256 is stored.
import crypto from 'node:crypto';
import os from 'node:os';
import { promisify } from 'node:util';
import { all, get, run, tx } from './db.js';
import { TRADES, isTrade } from './trades.js';

// ───────────────────────── job roles ─────────────────────────

export const ROLES = {
  owner: { label: 'Owner', about: 'Everything, and manages the logins' },
  office: { label: 'Office', about: 'Everything in the office app except the logins' },
  stores: { label: 'Stores', about: 'Sees the office pages; stock, counts, deliveries and receiving POs; the worker app' },
  leadhand: { label: 'Leading hand', about: 'Sees the office pages; runs the factory floor (moves vans, reminders, notes); the worker app' },
  worker: { label: 'Worker', about: 'Only the worker app, for their own trade' },
};
export const isRole = r => Object.hasOwn(ROLES, r);

// Who is in each group (used in the table below).
const OWNER = ['owner'];
const OFFICE = ['owner', 'office'];
const STORES = ['owner', 'office', 'stores'];                    // stock, counts, deliveries
const FLOOR = ['owner', 'office', 'leadhand'];                   // running the factory floor
const STAFF = ['owner', 'office', 'stores', 'leadhand'];         // can open the office app (read-only for stores / leading hands)
const ALL = ['owner', 'office', 'stores', 'leadhand', 'worker']; // everyone with a login, incl. the worker app
const PUBLIC = 'public';    // no login needed (log in, first-time setup)
const SESSION = 'session';  // any login — also one that still has to choose a new password

// ───────────────────────── who may use which route ─────────────────────────
// [method, path, who, extra]. Method 'GET' also covers HEAD; '*' = any method. ':x' = one path part.
// When several lines match, the one with the fewest ':x' parts wins (so '/api/items/unassigned' is never
// swallowed by '/api/items/:id'); between equals the first line wins. test/auth.test.js checks every line
// can be reached.
// extra.only: for that role, the request body may only contain these fields (or these values).
export const API_RULES = [
  // ── logging in (no login needed) ──
  ['POST', '/api/login', PUBLIC],
  ['POST', '/api/logout', PUBLIC],
  ['GET', '/api/setup', PUBLIC],
  ['POST', '/api/setup', PUBLIC],        // only works with no logins yet, from this PC itself (checked in server.js)
  // ── my own login ──
  ['GET', '/api/me', SESSION],
  ['POST', '/api/me/password', SESSION],
  // ── logins (owner only) ──
  ['*', '/api/users', OWNER],
  ['*', '/api/users/:id', OWNER],
  ['*', '/api/users/:id/:action', OWNER],

  // ── worker app (/floor): everyone. A worker only ever sees their own trade (forced in server.js) ──
  ['GET', '/api/trades', ALL],
  ['GET', '/api/floor/vans', ALL],
  ['GET', '/api/floor/vans/:id', ALL],
  ['GET', '/api/floor/map', ALL],
  ['GET', '/api/floor/stats', ALL],
  ['GET', '/api/floor/waiting', ALL],
  ['POST', '/api/floor/take', ALL],
  ['POST', '/api/floor/extra', ALL],
  ['POST', '/api/floor/undo', ALL],              // a worker: only their own takes (checked in server.js)
  ['POST', '/api/floor/receive', ALL],           // book in a delivery
  ['POST', '/api/floor/receive/undo', ALL],      // a worker: only their own bookings (checked in server.js)
  ['POST', '/api/floor/items/:id/place', ALL],   // Find a part → Set place (rack / shelf)
  ['GET', '/api/items', ALL],                    // part search on the phone
  // (office lists under /api/items/… — the literal names win over /api/items/:id, see apiRule)
  ['GET', '/api/items/unassigned', STAFF],
  ['GET', '/api/items/many-specs', STAFF],
  ['GET', '/api/items/still-to-order', STAFF],
  ['GET', '/api/items/:id', ALL],                // Find a part / Book in
  ['GET', '/api/layout', ALL],                   // the floor map
  ['GET', '/api/vans/:id/floor', ALL],           // a van's notes and reminders
  ['POST', '/api/vans/:id/notes', ALL],          // add a note to a van
  ['PUT', '/api/reminders/:id', ALL],            // tick a reminder done (or not done)

  // ── factory floor management: leading hands + office ──
  ['POST', '/api/vans/:id/move', FLOOR],
  ['POST', '/api/vans/:id/leave', FLOOR],
  ['POST', '/api/layout/advance', FLOOR],        // move the line along
  ['DELETE', '/api/notes/:id', FLOOR],
  ['POST', '/api/reminders', FLOOR],
  ['DELETE', '/api/reminders/:id', FLOOR],
  // Undo of a van move puts a planned van back to planned: a leading hand may only change the status.
  ['PUT', '/api/vans/:id', [...OFFICE, 'leadhand'], { only: { leadhand: { status: ['planned', 'in_production'] } } }],
  // Factory floor layout (bays, racks, walls): office only.
  ['POST', '/api/layout/areas', OFFICE],
  ['PUT', '/api/layout/areas/:id', OFFICE],
  ['DELETE', '/api/layout/areas/:id', OFFICE],

  // ── stock: stores + office ──
  ['POST', '/api/items/:id/receive', STORES],
  ['POST', '/api/items/:id/adjust', STORES],
  ['POST', '/api/items/:id/photo', STORES],
  ['DELETE', '/api/items/:id/photo', STORES],
  ['POST', '/api/items/rack', STORES],                           // bulk "Put on rack"
  // Edit an item: stores may only set where it is kept (rack / shelf); everything else is office.
  ['PUT', '/api/items/:id', STORES, { only: { stores: ['area_id', 'location'] } }],
  ['POST', '/api/stocktake', STORES],
  ['POST', '/api/counts', STORES],
  ['POST', '/api/counts/:id/check', STORES],
  ['POST', '/api/counts/:id/save', STORES],
  ['POST', '/api/stock-checks/ack', STORES],
  ['POST', '/api/van-lines/:id/check', STORES],                  // bought-for-van check: here / missing / fitted
  ['POST', '/api/vans/:id/issue', STORES],                       // issue stock to the floor
  ['POST', '/api/van-lines/:id/return', STORES],                 // issued stock back to the shelf
  ['POST', '/api/pos/:id/receive', STORES],                      // receive a delivery against a PO

  // ── read-only office pages: everyone who can open the office app ──
  ['GET', '/api/summary', STAFF],
  ['GET', '/api/vans', STAFF],
  ['GET', '/api/vans/:id', STAFF],
  ['GET', '/api/vans/:id/fitted-quick', STAFF],
  ['GET', '/api/van-lines/:id/log', STAFF],
  ['GET', '/api/placeholders', STAFF],
  ['GET', '/api/placeholders/count', STAFF],
  ['GET', '/api/layout/areas/:id/items', STAFF],
  ['GET', '/api/layout/advance', STAFF],        // preview only
  ['GET', '/api/reminders', STAFF],
  ['GET', '/api/plan', STAFF],
  ['GET', '/api/import/history', STAFF],
  ['GET', '/api/plan-conflicts', STAFF],
  ['GET', '/api/counts/choices', STAFF],
  ['GET', '/api/bought-for-van', STAFF],
  ['GET', '/api/catalogue', STAFF],
  ['GET', '/api/stock-checks', STAFF],
  ['GET', '/api/rules', STAFF],
  ['GET', '/api/shortages', STAFF],
  ['GET', '/api/suppliers', STAFF],
  ['GET', '/api/check-ordered', STAFF],
  ['GET', '/api/decisions', STAFF],
  ['GET', '/api/pos', STAFF],
  ['GET', '/api/pos/to-check', STAFF],
  ['GET', '/api/pos/overdue', STAFF],
  ['GET', '/api/pos/:id', STAFF],
  ['GET', '/api/tidy/report', STAFF],

  // ── office (and owner): everything else in the office app ──
  ['POST', '/api/orders/parse', OFFICE],
  ['POST', '/api/orders/preview', OFFICE],
  ['POST', '/api/vans', OFFICE],
  ['DELETE', '/api/vans/:id', OFFICE],
  ['POST', '/api/vans/:id/rebuild', OFFICE],
  ['POST', '/api/vans/:id/lines', OFFICE],
  ['POST', '/api/vans/:id/fitted', OFFICE],
  ['PUT', '/api/van-lines/:id', OFFICE],
  ['DELETE', '/api/van-lines/:id', OFFICE],
  ['POST', '/api/van-lines/:id/status', OFFICE],     // plan cell: ordered / received / fitted
  ['POST', '/api/van-lines/:id/qty-ok', OFFICE],
  ['POST', '/api/van-lines/:id/link', OFFICE],
  ['POST', '/api/van-lines/link-many', OFFICE],
  ['POST', '/api/van-lines/link-preview', OFFICE],
  ['POST', '/api/van-lines/:id/add-parts', OFFICE],
  ['POST', '/api/van-lines/:id/one-off', OFFICE],
  ['POST', '/api/van-lines/:id/state', OFFICE],      // customer supplies / to be decided
  ['POST', '/api/import/plan/preview', OFFICE],
  ['POST', '/api/import/plan/update/preview', OFFICE],
  ['POST', '/api/import/plan/update', OFFICE],
  ['POST', '/api/import/plan/apply', OFFICE],        // start again from the spreadsheet
  ['POST', '/api/plan-conflicts/:id', OFFICE],
  ['GET', '/api/allocate/reprioritise/preview', OFFICE],
  ['POST', '/api/allocate/reprioritise', OFFICE],
  ['POST', '/api/tidy/checked', OFFICE],
  ['POST', '/api/items/:id/assign', OFFICE],
  ['POST', '/api/items/:id/spare', OFFICE],
  ['POST', '/api/items', OFFICE],
  ['POST', '/api/web-image', OFFICE],                // photo from the internet (the server downloads it)
  ['POST', '/api/rules', OFFICE],
  ['PUT', '/api/rules/:id', OFFICE],
  ['DELETE', '/api/rules/:id', OFFICE],
  ['POST', '/api/rules/test', OFFICE],
  ['PUT', '/api/suppliers', OFFICE],
  ['PUT', '/api/purchasing/settings', OFFICE],
  ['POST', '/api/check-ordered', OFFICE],
  ['POST', '/api/check-ordered/all', OFFICE],
  ['POST', '/api/pos', OFFICE],
  ['POST', '/api/pos/:id/merge', OFFICE],
  ['PUT', '/api/pos/:id', OFFICE],
  ['DELETE', '/api/pos/:id', OFFICE],
  ['GET', '/api/settings', OFFICE],
  ['PUT', '/api/settings', OFFICE],
  ['POST', '/api/settings/clear-stock', OFFICE],
  ['GET', '/api/export/plan.xlsx', OFFICE],
];

const compiled = API_RULES.map(([method, path, who, extra = {}]) => ({
  method, path, who, ...extra, params: (path.match(/:[a-z]+/gi) || []).length,
  re: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z]+/gi, '[^/]+')}/?$`, 'i'), // like Express: capitals don't matter
}));
const OWNER_ONLY = { method: '*', path: '(not in the table)', who: OWNER, re: /^/, fallback: true };

// The rule for a request — of the matching lines the most exact one (fewest ':x' parts, then the first) —
// or the owner-only fallback.
export function apiRule(method, path) {
  const m = String(method || '').toUpperCase();
  let best = null;
  for (const r of compiled) {
    if (r.method !== '*' && r.method !== m && !(r.method === 'GET' && m === 'HEAD')) continue;
    if (r.re.test(path) && (!best || r.params < best.params)) best = r;
  }
  return best || OWNER_ONLY;
}

// May this role use the route? (PUBLIC / SESSION rules: anyone / any login.)
export function roleAllowed(rule, role) {
  if (rule.who === PUBLIC) return true;
  if (!role) return false;
  if (rule.who === SESSION) return true;
  return rule.who.includes(role);
}
export const allowed = (method, path, role) => roleAllowed(apiRule(method, path), role);

// extra.only: for some roles only certain fields (or values) may be sent. `by` is always allowed (ignored).
export function fieldsAllowed(rule, role, body) {
  const only = rule.only?.[role];
  if (!only) return true;
  const keys = Object.keys(body && typeof body === 'object' ? body : {}).filter(k => k !== 'by');
  if (!keys.length) return false;
  if (Array.isArray(only)) return keys.every(k => only.includes(k));
  return keys.every(k => Object.hasOwn(only, k) && only[k].includes(body[k]));
}

// What the pages may show for a role — worked out from the table, so screens and server always agree.
const CAPS = {
  officeApp: ['GET', '/api/summary'],          // can open the office app at all
  office: ['POST', '/api/vans'],                // office editing (orders, vans, plan, purchasing, rules, settings)
  stock: ['POST', '/api/items/1/adjust'],       // receive / count / adjust / stocktake / photos / racks
  issue: ['POST', '/api/vans/1/issue'],
  poReceive: ['POST', '/api/pos/1/receive'],
  floor: ['POST', '/api/vans/1/move'],          // factory floor: move vans, move the line along, reminders
  layout: ['POST', '/api/layout/areas'],        // edit the factory layout
  webImage: ['POST', '/api/web-image'],
  export: ['GET', '/api/export/plan.xlsx'],
  settings: ['GET', '/api/settings'],
  users: ['GET', '/api/users'],                 // the Logins page
};
export function capabilities(role) {
  const can = Object.fromEntries(Object.entries(CAPS).map(([k, [m, p]]) => [k, allowed(m, p, role)]));
  can.pickTrade = role !== 'worker'; // a worker always sees their own trade on /floor
  return can;
}

// ───────────────────────── passwords ─────────────────────────
// Stored as scrypt$N$r$p$saltB64$hashB64 (N=16384, r=8, p=1, 64-byte key, random 16-byte salt).

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAXMEM = 64 * 1024 * 1024;
export const MIN_PASSWORD = 8;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Only sane settings (a damaged row must not make the server do a huge amount of work).
  if (N < 1024 || N > 1 << 20 || (N & (N - 1)) || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(m[4], 'base64'), want = Buffer.from(m[5], 'base64');
  if (want.length < 16 || want.length > 128) return false;
  let got;
  try { got = await scrypt(String(password ?? '').normalize('NFC'), salt, want.length, { N, r, p, maxmem: MAXMEM * 4 }); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Used when the username doesn't exist, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(64).toString('base64')}`;

// A plain message when a new password isn't good enough, or '' when it is.
export function passwordProblem(password, username = '') {
  const p = String(password ?? '');
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the password`;
  if (p.length > 200) return 'That password is too long';
  if (username && p.trim().toLowerCase() === String(username).trim().toLowerCase()) return "Don't use the username as the password";
  return '';
}

// ───────────────────────── users ─────────────────────────

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const nowText = () => new Date().toLocaleString('sv-SE'); // "2026-10-20 14:05:09", this PC's time

export const cleanUsername = u => String(u ?? '').trim();
function checkUsername(u) {
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(u)) throw httpError(400, 'Username: 2 to 32 letters or numbers, no spaces (dots, dashes and _ are fine)');
}
function cleanName(n) {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) throw httpError(400, "Type the person's name");
  if (s.length > 40) throw httpError(400, 'The name can be 40 characters at most');
  return s;
}
function checkRoleTrade(role, trade) {
  if (!isRole(role)) throw httpError(400, 'Pick a job role');
  if (role === 'worker') {
    if (!isTrade(trade)) throw httpError(400, "Pick the worker's trade");
    return trade;
  }
  return ''; // only workers have a fixed trade
}

// What a page may see about a login (never the password hash).
export const publicUser = u => (u ? { id: u.id, username: u.username, name: u.name, role: u.role, trade: u.trade || '' } : null);
const USER_COLS = 'id, username, name, role, trade, active, must_change, created_at, created_by, last_login';

// Two logins never share a display name (capitals and spaces ignored): it is the name on everything they do.
function checkNameFree(name, exceptId = null) {
  if (get('SELECT 1 FROM users WHERE lower(name) = lower(?) AND id <> ?', name, exceptId ?? -1)) {
    throw httpError(409, `Someone already has the name "${name}" — add a surname or an initial so the two can be told apart`);
  }
}
export const userCount = () => get('SELECT COUNT(*) AS n FROM users').n;
export const listUsers = () => all(`SELECT ${USER_COLS} FROM users ORDER BY active DESC, CASE role WHEN 'owner' THEN 1 WHEN 'office' THEN 2
  WHEN 'stores' THEN 3 WHEN 'leadhand' THEN 4 ELSE 5 END, name COLLATE NOCASE`);
export const getUser = id => get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, Number(id));
export const findUser = username => get(`SELECT ${USER_COLS} FROM users WHERE username = ?`, cleanUsername(username));

export async function createUser({ username, name, role, trade = '', password, mustChange = true }, createdBy = '', { firstLogin = false } = {}) {
  const u = cleanUsername(username);
  checkUsername(u);
  const n = cleanName(name ?? u);
  const t = checkRoleTrade(role, trade);
  const bad = passwordProblem(password, u);
  if (bad) throw httpError(400, bad);
  if (findUser(u)) throw httpError(409, `The username "${u}" is already taken`);
  checkNameFree(n);
  const hash = await hashPassword(password);
  // First-time setup: checked again right before saving (two browsers at once can't both make an owner).
  if (firstLogin && userCount() > 0) throw httpError(409, 'The first login was already made — log in instead');
  checkNameFree(n); // again: another login may have been added while the password was hashed
  try {
    const r = run(`INSERT INTO users(username, name, role, trade, pass_hash, active, must_change, created_at, created_by)
                   VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?)`, u, n, role, t, hash, mustChange ? 1 : 0, nowText(), String(createdBy || '').slice(0, 40));
    return getUser(Number(r.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw httpError(409, `The username "${u}" is already taken`);
    throw e;
  }
}

const activeOwners = (exceptId = null) => get(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND id <> ?`, exceptId ?? -1).n;

// Name / role / trade. A role change ends that person's sessions (they log in again with the new role).
// `actor`: the owner doing it (they can't change their own role, and the last owner always stays an owner).
export function updateUser(id, { name, role, trade } = {}, actor = null) {
  return tx(() => {
    const u = getUser(id);
    if (!u) throw httpError(404, 'That login no longer exists — refresh');
    const newRole = role === undefined ? u.role : role;
    const newTrade = checkRoleTrade(newRole, trade === undefined ? u.trade : trade);
    const newName = name === undefined ? u.name : cleanName(name);
    if (newName.toLowerCase() !== u.name.toLowerCase()) checkNameFree(newName, u.id);
    if (newRole !== u.role) {
      if (actor && actor.id === u.id) throw httpError(400, "You can't change your own job role — ask another owner");
      if (u.role === 'owner' && u.active && !activeOwners(u.id)) throw httpError(400, 'This is the only owner login — make someone else an owner first');
    }
    run('UPDATE users SET name = ?, role = ?, trade = ? WHERE id = ?', newName, newRole, newTrade, u.id);
    if (newRole !== u.role || newTrade !== u.trade) endUserSessions(u.id);
    return getUser(u.id);
  });
}

// Turn a login off (or back on). Turning it off ends its sessions at once.
export function setActive(id, active, actor = null) {
  return tx(() => {
    const u = getUser(id);
    if (!u) throw httpError(404, 'That login no longer exists — refresh');
    if (!active) {
      if (actor && actor.id === u.id) throw httpError(400, "You can't turn off your own login");
      if (u.role === 'owner' && u.active && !activeOwners(u.id)) throw httpError(400, 'This is the only owner login — make someone else an owner first');
    }
    run('UPDATE users SET active = ? WHERE id = ?', active ? 1 : 0, u.id);
    if (!active) endUserSessions(u.id);
    return getUser(u.id);
  });
}

// New password set by the owner (or `npm run users -- reset`): ends all of that person's sessions.
export async function resetPassword(id, password, { mustChange = true } = {}) {
  const u = getUser(id);
  if (!u) throw httpError(404, 'That login no longer exists — refresh');
  const bad = passwordProblem(password, u.username);
  if (bad) throw httpError(400, bad);
  const hash = await hashPassword(password);
  tx(() => {
    run('UPDATE users SET pass_hash = ?, must_change = ? WHERE id = ?', hash, mustChange ? 1 : 0, u.id);
    endUserSessions(u.id);
  });
  return getUser(u.id);
}

// Someone changes their own password: the current one first. Their other sessions (other phones / PCs)
// end; the one they are using stays.
export async function changeOwnPassword(userId, current, next, keepTokenHash = null) {
  const row = get('SELECT * FROM users WHERE id = ?', userId);
  if (!row || !row.active) throw httpError(401, 'Please log in');
  if (!(await verifyPassword(current, row.pass_hash))) throw httpError(400, 'Your current password is not right', { wrongCurrent: true });
  const bad = passwordProblem(next, row.username);
  if (bad) throw httpError(400, bad);
  if (await verifyPassword(next, row.pass_hash)) throw httpError(400, 'Choose a different password from the one you have now');
  const hash = await hashPassword(next);
  tx(() => {
    run('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?', hash, row.id);
    endUserSessions(row.id, keepTokenHash);
  });
}

// ───────────────────────── sessions ─────────────────────────
// Cookie fs_session = a random 32-byte token; the database keeps only sha256(token). Sliding expiry:
// 30 days from the last use, so phones stay logged in.

// The cookie's name carries the port the app runs on (fs_session_3000): browsers keep cookies per PC name, not
// per port, so a second copy on the same PC (a test copy on another port) no longer logs the real one out.
export let COOKIE = 'fs_session';
export function setCookiePort(port) { COOKIE = Number(port) > 0 ? `fs_session_${Number(port)}` : 'fs_session'; }
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000; // write "last seen" at most every 5 minutes
export const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');

export function createSession(userId, { ip = '', ua = '' } = {}, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions(token_hash, user_id, created_at, last_seen, expires_at, ip, ua) VALUES(?, ?, ?, ?, ?, ?, ?)',
    tokenHash(token), userId, now, now, now + SESSION_MS, String(ip).slice(0, 64), String(ua).slice(0, 200));
  return token;
}

// The login behind a cookie token, or null. `refreshed`: the expiry moved on (send the cookie again).
export function sessionFromToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const h = tokenHash(token);
  const s = get('SELECT * FROM sessions WHERE token_hash = ?', h);
  if (!s) return null;
  if (s.expires_at <= now) { run('DELETE FROM sessions WHERE token_hash = ?', h); return null; }
  const u = get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!u || !u.active) { run('DELETE FROM sessions WHERE token_hash = ?', h); return null; }
  let refreshed = false;
  if (now - s.last_seen >= TOUCH_MS) {
    run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?', now, now + SESSION_MS, h);
    refreshed = true;
  }
  return { tokenHash: h, user: { ...publicUser(u), mustChange: !!u.must_change }, refreshed };
}

export const endSession = hash => { run('DELETE FROM sessions WHERE token_hash = ?', hash); };
export function endUserSessions(userId, exceptHash = null) {
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, exceptHash ?? '');
}
export const pruneSessions = (now = Date.now()) => run('DELETE FROM sessions WHERE expires_at <= ?', now).changes;

export function readCookie(header, name = COOKIE) { // (default = the name in use now)
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
export const sessionCookie = (token, { secure = false } = {}) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
export const clearCookie = ({ secure = false } = {}) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

// ───────────────────────── logging in, with throttling ─────────────────────────
// In memory (a restart clears it): 5 wrong tries for one username from one address → that username
// is locked for that address for 15 minutes; 30 wrong tries from one address within 15 minutes →
// that address is locked for 15 minutes.

export const WRONG = 'Wrong username or password';
export const LOCKED = 'Too many tries — wait 15 minutes';

export function createThrottle({ perUser = 5, perIp = 30, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
  const map = new Map(); // key → { times: [ms], until: ms }
  const entry = k => { let e = map.get(k); if (!e) { e = { times: [], until: 0 }; map.set(k, e); } return e; };
  const uKey = (ip, user) => `u:${ip}|${String(user).trim().toLowerCase()}`;
  const iKey = ip => `i:${ip}`;
  function prune(now) {
    if (map.size < 5000) return;
    for (const [k, e] of map) if (e.until <= now && !e.times.some(t => now - t < windowMs)) map.delete(k);
  }
  // Returns how many tries are left before the lock (0 = locked now).
  const bump = (k, limit, now) => {
    const e = entry(k);
    e.times = e.times.filter(t => now - t < windowMs);
    e.times.push(now);
    if (e.times.length >= limit) { e.until = now + lockMs; e.times = []; return 0; }
    return limit - e.times.length;
  };
  const until = (k, now) => { const u = map.get(k)?.until || 0; return u > now ? u : 0; };
  const nameOf = k => k.slice(k.indexOf('|') + 1);
  return {
    locked(ip, user, now = Date.now()) { return this.lockedUntil(ip, user, now) > 0; },
    // When the lock for this username from this address ends (ms), or 0.
    lockedUntil(ip, user, now = Date.now()) { return Math.max(until(iKey(ip), now), until(uKey(ip, user), now)); },
    // A wrong try: how many are left for this username from this address (and the address as a whole).
    fail(ip, user, now = Date.now()) { prune(now); const u = bump(uKey(ip, user), perUser, now); const i = bump(iKey(ip), perIp, now); return Math.min(u, i); },
    success(ip, user) { map.delete(uKey(ip, user)); },
    // Usernames locked right now (from any address) → when the lock ends: for the Logins page.
    lockedUsers(now = Date.now()) {
      const out = new Map();
      for (const [k, e] of map) if (k.startsWith('u:') && e.until > now) out.set(nameOf(k), Math.max(out.get(nameOf(k)) || 0, e.until));
      return out;
    },
    // The owner's Unlock (and a password reset): every address's lock and wrong tries for this username.
    unlockUser(user) { const n = String(user).trim().toLowerCase(); for (const k of [...map.keys()]) if (k.startsWith('u:') && nameOf(k) === n) map.delete(k); },
    clear() { map.clear(); },
  };
}

// Same answer for an unknown username, a wrong password and a login that is turned off.
export async function login({ username, password, ip = '', ua = '' }, throttle, now = Date.now()) {
  const uname = cleanUsername(username).slice(0, 64);
  const lockEnd = throttle.lockedUntil(ip, uname, now);
  if (lockEnd) throw httpError(429, LOCKED, { until: lockEnd });
  const row = uname ? get('SELECT * FROM users WHERE username = ?', uname) : null;
  const ok = await verifyPassword(String(password ?? '').slice(0, 200), row?.pass_hash || DUMMY_HASH);
  if (!row || !ok || !row.active) {
    const left = throttle.fail(ip, uname, now);
    // `left`: tries left before the 15-minute lock (the page warns at 2 and 1) — the same for any username, so it
    // says nothing about which usernames exist.
    throw httpError(401, WRONG, { left, ...(left === 0 ? { until: throttle.lockedUntil(ip, uname, now) } : {}) });
  }
  throttle.success(ip, uname);
  run('UPDATE users SET last_login = ? WHERE id = ?', nowText(), row.id);
  const token = createSession(row.id, { ip, ua }, now);
  return { token, user: { ...publicUser(row), mustChange: !!row.must_change } };
}

// ───────────────────────── first login (setup) ─────────────────────────
// Only from this PC itself (the socket's own address — never a header), and only while there are no
// logins at all.

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
export const isLoopback = addr => LOOPBACK.test(String(addr || ''));
// A request that came through a proxy / tunnel (Cloudflare Tunnel, Tailscale serve…) arrives from this
// PC too. Such headers never make a request trusted; they only rule out setup.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'tailscale-user-login'];
export const fromThisPc = req => isLoopback(req.socket?.remoteAddress) && !PROXY_HEADERS.some(h => req.headers?.[h] != null);

export async function setupOwner({ username, name, password }) {
  if (userCount() > 0) throw httpError(409, 'The first login was already made — log in instead');
  const u = await createUser({ username, name, role: 'owner', password, mustChange: false }, 'first setup', { firstLogin: true });
  run('UPDATE users SET last_login = ? WHERE id = ?', nowText(), u.id); // logged straight in
  return getUser(u.id);
}

// ───────────────────────── which addresses the app answers changes on ─────────────────────────
// Stops "DNS rebinding" (a web page on another site pretending to be this PC). Allowed: localhost,
// 127.0.0.1, [::1], this PC's network addresses and name, and ALLOWED_HOSTS (comma list, e.g. the
// tunnel's name). ALLOWED_HOSTS=* turns the check off.

let lanCache = { at: 0, set: new Set() };
function thisPcNames() {
  if (Date.now() - lanCache.at < 60 * 1000) return lanCache.set;
  const set = new Set(['localhost', '127.0.0.1', '::1']);
  for (const n of Object.values(os.networkInterfaces()).flat()) if (n?.address) set.add(n.address.toLowerCase().replace(/%.*$/, ''));
  const hn = os.hostname().toLowerCase();
  set.add(hn);
  set.add(`${hn}.local`);
  for (const h of String(process.env.ALLOWED_HOSTS || '').split(',')) if (h.trim()) set.add(h.trim().toLowerCase());
  lanCache = { at: Date.now(), set };
  return set;
}
export function hostOnly(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (v6) return v6[1];
  return h.replace(/:\d+$/, '');
}
export function hostAllowed(hostHeader) {
  if (String(process.env.ALLOWED_HOSTS || '').trim() === '*') return true;
  const h = hostOnly(hostHeader);
  if (!h) return false;
  const names = thisPcNames();
  if (names.has(h)) return true;
  // This PC's name under the network's own ending ("office-pc.lan", "office-pc.home").
  const hn = os.hostname().toLowerCase();
  return h.startsWith(`${hn}.`) && /^[a-z0-9.-]+$/.test(h);
}

export const TRADE_KEYS = Object.keys(TRADES);
