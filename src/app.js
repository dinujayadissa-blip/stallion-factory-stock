// The Factory Stock web app (Express): every /api route, the item photos and — run locally — the pages.
// createApp({ cloud }) only builds the app; it opens nothing and starts no timers. Whoever runs it opens the
// database first (openDb) and listens: server.js on the office PC, the Edge Function in the cloud.
//
// cloud: true — the online version. The pages (/, /floor, /login and the files in public/) come from
// Cloudflare Pages, not from here; first-time setup and plan import are refused (410); GET /api/me says
// cloud: true. It runs as a Supabase Edge Function (src/edge.js) that only Cloudflare Pages may call: every
// request must carry x-pass-secret = PASS_SECRET (else 403), and only then are the visitor's address
// (x-fs-client-ip), the public host name (x-fs-host) and https (x-fs-proto) believed. Those are our own
// headers, set by the pass-through (functions/_forward.js): the x-forwarded-* ones are never read online, as
// Supabase's gateway in between may add to or replace them.
// Every answer carries x-fs-app: 1, so the pass-through can tell the app's own errors from Supabase's.
//
// One writer at a time: every change (POST / PUT / PATCH / DELETE, through h()) runs inside one writeTx —
// the global write lock, one transaction, one data_version bump — and the stock movements it made are
// stamped with the login's id inside that same transaction. A failure rolls the whole change back and
// only then is it answered.
import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, insert, writeTx, getSetting, setSetting, logAlloc, syncSuppliers, asBusy } from './db.js';
import { savePhoto, deletePhoto, readPhoto } from './photos.js';
import { fetchWebImage } from './webImage.js';
import * as layout from './layout.js';
import { goLive } from './golive.js';
import { parseConditions, testRule } from './rules.js';
import * as inv from './inventory.js';
import { TRADES, assignMissingTrades, isTrade } from './trades.js';
import { tidyReport, markReportChecked } from './tidyReport.js';
import { linkLine, linkPreview, makeOneOff, addTextParts } from './relink.js';
import * as auth from './auth.js';

// The PDF reader (pdfjs) and the Excel writer (exceljs) are big: loaded the first time they're needed, so a
// cold start of the Edge Function (whose CPU time counts) doesn't pay for them, and a library that won't load
// there breaks only its own route.
const pdfReader = () => import('./parseOrder.js');
const exportWorkbook = async () => (await import('./exportXlsx.js')).exportWorkbook();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Local date and time for the log ("2026-10-12 14:05:09"), so "it failed yesterday afternoon" can be found.
const now = () => new Date().toLocaleString('sv-SE');

// What the online version doesn't do (the same answer for every such route).
export const NOT_ONLINE = 'Not available in the online version';
// Importing the production plan (and "start again from the spreadsheet") is done on the original version
// of the app (the SQLite one, before the move): src/importPlan.js was never moved onto Postgres.
const PLAN_IMPORT_GONE = 'Not available in this version — the production plan is imported on the original version of the app (before the move)';

function lanAddresses() {
  try {
    return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  } catch { return []; }
}

// Every stock movement a change makes is stamped with the login's id (issue #2: "undo only your own", floor
// stats). This runs inside the change's writeTx, which holds the global write lock: no other change can make
// movements meanwhile, on this server or any other, so the movements numbered above the highest one before
// it are exactly its own.
async function stamped(req, fn) {
  if (!req.user) return fn();
  const hi = (await get('SELECT COALESCE(MAX(id), 0) AS n FROM movements')).n;
  const out = await fn();
  await run('UPDATE movements SET user_id = ? WHERE id > ? AND user_id IS NULL', req.user.id, hi);
  return out;
}

// Wrap handlers so thrown errors become JSON responses, and changes run as one writeTx (see the top).
// { write: false }: the handler runs as it is, outside any transaction. Only for changes that manage their
// own writeTx and must not hold the write lock around slow work that isn't the database (password hashing,
// a PDF, a download, a picture upload), for the log in / log out (no new data_version: a wrong password must
// not refresh every screen — Ruling R12), and for requests that change nothing (previews).
const READS = new Set(['GET', 'HEAD']);
function h(fn, { write = true } = {}) {
  return async (req, res) => {
    try {
      const out = write && !READS.has(req.method)
        ? await writeTx(() => stamped(req, () => fn(req, res)))
        : await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e0) {
      // (the transaction is already rolled back here)
      // 22P02 "invalid input syntax": text where the database wants a number (an id like "abc") — on SQLite
      // that simply found nothing.
      // A backstop (ids from the address are checked first, by id()): logged, so a route that should check
      // its input can be found — the method, address and database message, never the request's body.
      if (e0?.code === '22P02') console.warn(now(), 'Taken as "Not found" (text where a number belongs):', req.method, req.originalUrl, '—', e0.message);
      // 55P03 / 57014 (a time limit of the transaction, src/db.js): "Busy — try again in a moment", 503.
      const e = e0?.code === '22P02' ? inv.httpError(404, 'Not found') : asBusy(e0);
      // Our own messages (with a status) are written for staff; anything else is an internal error.
      if (!e.status) console.error(now(), req.method, req.originalUrl, e);
      // confirm: the action needs a yes first (e.g. taking another van's part); problems: every reason a save was refused.
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong — try again',
        ...(e.status && e.confirm ? { confirm: e.confirm } : {}), ...(e.status && e.problems ? { problems: e.problems } : {}),
        // log in: tries left before the lock, and when a lock ends (ms) — the log in page says so
        ...(e.status && e.left != null ? { left: e.left } : {}), ...(e.status && e.until ? { until: e.until } : {}) });
    }
  };
}
const OWN_TX = { write: false }; // (see h())
// An id from the address: a whole number, or "Not found" before any query (Postgres refuses text as an id).
const id = req => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n < 0 || String(req.params.id).trim() === '') throw inv.httpError(404, 'Not found');
  return n;
};
const num = v => (v === '' || v == null ? undefined : Number(v));
// Who did it: always the name of the login (never `by` from the page — still accepted from older pages, but ignored).
const worker = req => req.user?.name || '';
const gone = message => () => { throw inv.httpError(410, message); };
const json = async (key, fallback) => {
  const raw = await getSetting(key, ''); // (a database error is passed on, not taken for "no setting")
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};
const importHistory = async () => { const h0 = await json('plan_import_history', []); return Array.isArray(h0) ? h0 : []; };

// The first value of a header that may hold a list ("client, proxy1, proxy2"): what Pages itself put there.
const firstOf = v => String(v ?? '').split(',')[0].trim().slice(0, 100);
const digest = s => crypto.createHash('sha256').update(String(s)).digest();

// passSecret (cloud only): what x-pass-secret must be (PASS_SECRET, shared with the Pages pass-through).
export function createApp({ cloud = false, passSecret = process.env.PASS_SECRET } = {}) {
  const app = express();
  // ── Logins (src/auth.js) ──
  // Behind a tunnel / proxy on this PC (Cloudflare Tunnel, Tailscale serve) set TRUST_PROXY=1, so the
  // visitor's address (login throttling: req.ip is then the client's, from X-Forwarded-For) and https
  // (Secure cookie) come from the proxy's headers — only when the proxy itself is on this PC. Without it
  // those headers are never believed.
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 'loopback' : false);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('x-fs-app', '1'); // (see the top)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  // ── Online: only the Pages pass-through may call (see the top) ──
  // The secret is compared in constant time (as sha256 digests, so a wrong length tells nothing either).
  // Without it: 403 before anything else — no session look-up, no database at all. Not set on the function:
  // everything is refused.
  if (cloud) {
    const want = String(passSecret ?? '');
    if (!want) console.error(now(), 'PASS_SECRET is not set: every request is refused (403) until it is');
    const wantDigest = digest(want);
    app.use((req, res, next) => {
      const got = req.headers['x-pass-secret'];
      if (!want || typeof got !== 'string' || !crypto.timingSafeEqual(digest(got), wantDigest)) {
        return res.status(403).json({ error: 'Please use the Factory Stock app' });
      }
      req.viaPages = {
        ip: firstOf(req.headers['x-fs-client-ip']),
        host: firstOf(req.headers['x-fs-host']),
        https: firstOf(req.headers['x-fs-proto']).toLowerCase() === 'https',
      };
      next();
    });
  }
  const throttle = auth.createThrottle();
  // The visitor's address (login throttling, the session's record), the host name they used (the change
  // checks below) and whether it was https (Secure cookies): online, what Pages said; locally, this request's.
  const clientIp = req => (cloud ? req.viaPages?.ip || 'unknown' : String(req.ip || req.socket?.remoteAddress || ''));
  const hostOf = req => (cloud ? req.viaPages?.host || '' : req.get('host'));
  const secure = req => (cloud ? !!req.viaPages?.https : req.secure);
  // Who is logged in on this browser: req.user = { id, username, name, role, trade, mustChange }.
  // (A session look-up / touch is one statement of its own: no write lock — Ruling R11.)
  app.use(async (req, res, next) => {
    try {
      const token = auth.readCookie(req.headers.cookie);
      if (token) {
        const s = await auth.sessionFromToken(token);
        if (s) {
          req.user = s.user;
          req.sessionHash = s.tokenHash;
          if (s.refreshed) res.append('Set-Cookie', auth.sessionCookie(token, { secure: secure(req) })); // 30 more days
        } else {
          // The browser still had a session that has ended (turned off, new role, password reset, logged out on
          // another device, 30 days unused): the log in page says so once, and the old cookie goes.
          req.sessionEnded = true;
          res.append('Set-Cookie', auth.clearCookie({ secure: secure(req) }));
        }
      }
      next();
    } catch (e) { next(e); }
  });

  // Changes must come from the app's own pages: a different website open in the same browser must
  // not be able to send them. Requests with no Origin (scripts, curl) are allowed. Changes are only
  // taken on this PC's own addresses / names (and ALLOWED_HOSTS): stops "DNS rebinding".
  const rejectedHosts = new Set();
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('Origin');
    let sameHost = true;
    if (origin) { try { sameHost = new URL(origin).host === hostOf(req); } catch { sameHost = false; } }
    if (req.get('Sec-Fetch-Site') === 'cross-site' || !sameHost) return res.status(403).json({ error: 'Please use the Factory Stock app' });
    if (!auth.hostAllowed(hostOf(req))) {
      const hh = String(hostOf(req) || '').slice(0, 100);
      if (!rejectedHosts.has(hh) && rejectedHosts.size < 50) { rejectedHosts.add(hh); console.log(now(), `Refused a change sent to the address "${hh}" — if that is a real name for this PC, add it to ALLOWED_HOSTS`); }
      return res.status(403).json({ error: "Open the app with the office PC's address to make changes" });
    }
    next();
  });
  // Who may use which route: the table in src/auth.js (anything not in it: owner only).
  const NO_RIGHTS = "Your login can't do that — ask the owner";
  app.use('/api', (req, res, next) => {
    const rule = auth.apiRule(req.method, req.baseUrl + req.path);
    req.rule = rule;
    if (rule.who === 'public') return next();
    if (!req.user) return res.status(401).json({ error: 'Please log in', ...(req.sessionEnded ? { ended: true } : {}) });
    if (req.user.mustChange && rule.who !== 'session') return res.status(403).json({ error: 'Choose a new password first', mustChange: true });
    if (!auth.roleAllowed(rule, req.user.role)) return res.status(403).json({ error: NO_RIGHTS });
    next();
  });
  app.use(express.json({ limit: '5mb' }));
  // Some roles may only send certain fields to a route (e.g. stores: only an item's rack / shelf).
  app.use('/api', (req, res, next) => {
    if (req.user && req.rule?.only && !auth.fieldsAllowed(req.rule, req.user.role, req.body)) return res.status(403).json({ error: NO_RIGHTS });
    next();
  });

  // ── Pages: the office app and the worker app need a login; the login page doesn't ──
  // Only when run locally: online, Cloudflare Pages serves them (with the same checks, see functions/).
  // index.html and floor.html live in views/ (not public/), so no odd address (/%69ndex.html, //index.html…) can
  // reach them through the static files without these checks.
  if (!cloud) {
    const nextTo = req => `/login?next=${encodeURIComponent(req.originalUrl)}${req.sessionEnded ? '&ended=1' : ''}`;
    const noStore = res => res.setHeader('Cache-Control', 'no-store');
    app.get(['/', '/index.html'], (req, res) => {
      noStore(res);
      if (!req.user) return res.redirect(302, nextTo(req));
      if (req.user.mustChange) return res.redirect(302, nextTo(req));
      if (!auth.capabilities(req.user.role).officeApp) return res.redirect(302, '/floor'); // workers: the worker app only
      if (req.path !== '/') return res.redirect(302, '/');
      res.sendFile(path.join(root, 'views', 'index.html'));
    });
    app.get(['/floor', '/floor.html'], (req, res) => {
      noStore(res);
      if (!req.user || req.user.mustChange) return res.redirect(302, `/login?next=%2Ffloor${req.sessionEnded ? '&ended=1' : ''}`);
      if (req.path !== '/floor') return res.redirect(302, '/floor');
      res.sendFile(path.join(root, 'views', 'floor.html'));
    });
    app.get(['/login', '/login.html'], (req, res) => { noStore(res); res.sendFile(path.join(root, 'public', 'login.html')); });
    // Styles, scripts, fonts, logos, the app icon / manifest / service worker: no login needed (no data in them).
    app.use(express.static(path.join(root, 'public'), { index: false }));
    // three.js for the 3D factory view — only the built module and the add-ons, nothing else from node_modules.
    app.use('/vendor/three/build', express.static(path.join(root, 'node_modules', 'three', 'build'), { maxAge: '7d', index: false }));
    app.use('/vendor/three/addons', express.static(path.join(root, 'node_modules', 'three', 'examples', 'jsm'), { maxAge: '7d', index: false }));
  }
  // Item photos (on disk locally, in Supabase Storage online — src/photos.js): any login (the browser sends the
  // cookie with each picture). File names change on every upload, so they can be kept for a long time — but
  // only in that browser ("private"). A name that could leave the folder: 400; no such picture: 404.
  app.get('/photos/:name', async (req, res, next) => {
    try {
      if (!(req.user && !req.user.mustChange)) return res.status(401).send('Please log in');
      const p = await readPhoto(req.params.name);
      if (!p) return res.status(404).send('No such picture');
      res.set({ 'Content-Type': p.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.send(Buffer.from(p.body));
    } catch (e) { next(e); }
  });

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

  // ── Dashboard ──
  app.get('/api/summary', h(async () => ({ ...await inv.summary(), golive: await goLive(), demo: (await getSetting('demo')) === '1' })));

  // ── Dealer orders ──
  // (OWN_TX: reading the PDF takes a moment and changes nothing — not under the write lock)
  app.post('/api/orders/parse', express.raw({ type: 'application/pdf', limit: '25mb' }), h(async req => {
    if (!req.body?.length) throw inv.httpError(400, 'No PDF received');
    const { parseOrderPdf } = await pdfReader(); // (a library that won't load: an internal error, logged)
    let parsed;
    try { parsed = await parseOrderPdf(req.body); } catch { throw inv.httpError(400, "Couldn't read that PDF"); }
    if (!parsed.fields.length) throw inv.httpError(400, "That PDF doesn't look like a dealer order form");
    // from_plan: the van's parts come from the production plan, so saving won't re-run the rules.
    const existing = parsed.header.chassis ? await get(`SELECT id, status,
        (EXISTS(SELECT 1 FROM van_lines l WHERE l.van_id = vans.id AND l.source = 'plan'))::int AS from_plan
      FROM vans WHERE chassis = ?`, parsed.header.chassis) : null;
    return { ...parsed, existing: existing ?? null, preview: await inv.previewOrder(parsed.fields, parsed.header.chassis) };
  }, OWN_TX));
  // (a preview: changes nothing)
  app.post('/api/orders/preview', h(req => inv.previewOrder(req.body.fields || []), OWN_TX));

  // ── Vans ──
  app.get('/api/vans', h(req => inv.listVans({ status: req.query.status })));
  app.post('/api/vans', h(async req => {
    const vanId = await inv.createVan({ ...req.body, by: worker(req) || 'Office' }, { replace: !!req.body.replace });
    // "As per drawing" lines on the dealer order become reminders on the van.
    // Options the office marked "Customer supplies" that no parts rule covers: a reminder on the van (user-r4-9).
    return { id: vanId, drawingReminders: await layout.drawingReminders(vanId), customerReminders: await layout.customerReminders(vanId, req.body.customer_fields) };
  }));
  app.get('/api/vans/:id', h(req => inv.getVan(id(req))));
  // A van that was deleted meanwhile: a plain 404, not "Something went wrong".
  const vanThere = async req => { if (!await get('SELECT 1 FROM vans WHERE id = ?', id(req))) throw inv.httpError(404, 'That van no longer exists — refresh'); };
  app.put('/api/vans/:id', h(async req => { await vanThere(req); return inv.updateVan(id(req), req.body); }));
  app.delete('/api/vans/:id', h(async req => { await vanThere(req); return inv.deleteVan(id(req)); }));
  app.post('/api/vans/:id/rebuild', h(async req => {
    await vanThere(req);
    if (!await inv.applyRules(id(req))) {
      throw inv.httpError(400, 'This van came from the production plan, so its parts list is the plan — edit it on the van or plan page');
    }
  }));
  app.post('/api/vans/:id/issue', h(async req => ({ issued: await inv.issue(id(req), req.body.line_ids || null) })));
  app.post('/api/vans/:id/lines', h(req => inv.addLine(id(req), { ...req.body, item_id: Number(req.body.item_id), qty: Number(req.body.qty) })));
  app.put('/api/van-lines/:id', h(req => inv.updateLine(id(req), { ...req.body, qty: num(req.body.qty) })));
  app.delete('/api/van-lines/:id', h(req => inv.deleteLine(id(req))));
  app.post('/api/van-lines/:id/return', h(req => {
    const qty = num(req.body.qty);
    if (!(qty > 0)) throw inv.httpError(400, 'Type how many to return, e.g. 2'); // never "return everything" by mistake
    return inv.returnLine(id(req), qty);
  }));
  app.post('/api/van-lines/:id/status', h(req => inv.setLineStatus(id(req), req.body.status, { po_no: req.body.po_no })));
  // "Quantity is right": the office checked an odd-looking quantity (stops the "please check" tag).
  app.post('/api/van-lines/:id/qty-ok', h(async req => {
    const l = await get('SELECT * FROM van_lines WHERE id = ?', id(req));
    if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
    if (!/qty-ok/.test(l.note)) await run('UPDATE van_lines SET note = ? WHERE id = ?', [l.note, 'qty-ok'].filter(Boolean).join(' · '), l.id);
  }));
  // Parts put in before go-live: close the lines (see inventory.markFitted).
  // done: the office went through this van's list (go-live checklist), even with nothing ticked.
  // "Already fitted…" quick start: parts received for this van (and when), to offer "tick everything received N weeks ago".
  app.get('/api/vans/:id/fitted-quick', h(req => inv.fittedQuickStart(id(req))));
  app.post('/api/vans/:id/fitted', h(req => inv.markFitted(id(req), Array.isArray(req.body.line_ids) ? req.body.line_ids : [], worker(req), { done: !!req.body.done })));
  // "Why?": every change to what is set aside for this line, with who / when / why.
  app.get('/api/van-lines/:id/log', h(req => inv.lineHistory(id(req))));
  // "As per plan" lines → a real part (an existing one, or a new part made from the plan text).
  app.get('/api/placeholders/count', h(req => inv.placeholderCounts({ vanId: Number(req.query.van) || null })));
  app.get('/api/placeholders', h(req => inv.placeholderLines({ vanId: Number(req.query.van) || null, onlyShort: req.query.short === '1' })));
  // A new per-van part made from a plan line's text (one free SKU worked out from the name).
  async function newPartFromPlanText(nu, l, { kind = 'per-van', supplier, note }) {
    const name = String(nu.name || '').trim().slice(0, 120);
    let sku = String(nu.sku || '').trim().toUpperCase() || name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
    if (/^PLAN-/.test(sku)) sku = sku.slice(5);
    for (let n = 2; await get('SELECT 1 FROM items WHERE sku = ?', sku); n++) sku = `${sku.replace(/-\d+$/, '')}-${n}`;
    return insert(`INSERT INTO items(sku, name, category, supplier, unit, kind, plan_column, trade, notes)
                   VALUES(?, ?, ?, ?, 'ea', ?, ?, ?, ?)`, sku, name, String(nu.category || 'General'), supplier,
                   kind, l.plan_column || l.col || '', l.trade || '', note);
  }
  app.post('/api/van-lines/:id/link', h(async req => {
    let itemId = Number(req.body.item_id) || null;
    const nu = req.body.new_item;
    if (!itemId && nu) {
      if (!String(nu.name || '').trim()) throw inv.httpError(400, 'Type a name for the new part');
      const l = await get('SELECT l.*, i.trade, i.plan_column AS col, i.category FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?', id(req));
      if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
      itemId = await newPartFromPlanText(nu, l, { supplier: String(nu.supplier || ''), note: `Made from the plan text "${l.spec}"` });
    }
    if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
    return linkLine(id(req), itemId, { reason: 'link', worker: worker(req) || 'Office', force: !!req.body.force });
  }));
  // "Link all N lines with this same text" (round 2, user-r1-2): one part (picked, or made once from the
  // text) for every line listed. Each line goes through the same safe linkLine; a van that already has a
  // line for that part with a different amount / text is left "to confirm" (reported back as duplicate).
  app.post('/api/van-lines/link-many', h(async req => {
    const ids = [...new Set((Array.isArray(req.body.line_ids) ? req.body.line_ids : []).map(Number).filter(Boolean))];
    if (!ids.length) throw inv.httpError(400, 'Which lines?');
    let itemId = Number(req.body.item_id) || null;
    const nu = req.body.new_item;
    if (!itemId && nu) {
      if (!String(nu.name || '').trim()) throw inv.httpError(400, 'Type a name for the new part');
      const l = await get('SELECT l.*, i.trade, i.plan_column AS col FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?', ids[0]);
      if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
      // Bought for each van (it came from the plan as a per-van catch-all) unless the office says it's shelf stock.
      itemId = await newPartFromPlanText(nu, l, { kind: nu.kind === 'stock' ? 'stock' : 'per-van', supplier: String(nu.supplier || '').trim(),
        note: `Made from the plan text "${l.spec}" (${ids.length} line${ids.length === 1 ? '' : 's'})` });
    }
    if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
    const out = { linked: 0, merged: 0, duplicate: 0, skipped: 0, item_id: itemId };
    // force: the office saw the "already has this part" warning (link-preview) and said merge anyway.
    const force = !!req.body.force;
    for (const lineId of ids) {
      const r = await linkLine(lineId, itemId, { reason: 'link many', worker: worker(req) || 'Office', force, why: `linked with ${ids.length - 1} other line(s) with the same text` });
      out[r.result] = (out[r.result] || 0) + 1;
    }
    await syncSuppliers();
    return out;
  }));
  // What linking would do, before anything is changed (round 3, user-r2-3): per line 'link', 'merge' (the van
  // already has that part — one part, not two), 'duplicate' (it has it with a different amount / text) or
  // 'skipped'. The screens show this and ask before merging. (A preview: changes nothing.)
  app.post('/api/van-lines/link-preview', h(req => {
    const ids = [...new Set((Array.isArray(req.body.line_ids) ? req.body.line_ids : []).map(Number).filter(Boolean))];
    if (!ids.length) throw inv.httpError(400, 'Which lines?');
    const itemId = Number(req.body.item_id);
    if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
    return linkPreview(ids, itemId);
  }, OWN_TX));
  // "Add each part" (Small fixes & phone round 1, user-r4-6): a plan text that names several parts
  // ("induction cooker + CAMEC MICROWAVE 28LTR + AIR FRYER…") — each picked part becomes its own line on the van.
  // { parts: [{ text, item_id }] }. The new lines get their stock set aside like any other line.
  app.post('/api/van-lines/:id/add-parts', h(async req => {
    const r = await addTextParts(id(req), req.body.parts, { worker: worker(req) || 'Office' });
    for (const itemId of r.allocate) await inv.allocateItem(itemId, r.van_id, { reason: 'add part', worker: worker(req) || 'Office' });
    await syncSuppliers();
    const { allocate, ...out } = r;
    return out;
  }));
  // "Keep as a one-off special part for this van": its own per-van part, still orderable (round 2, user-r1-2).
  app.post('/api/van-lines/:id/one-off', h(async req => {
    const r = await makeOneOff(id(req), { supplier: String(req.body.supplier || '').trim().slice(0, 60), name: String(req.body.name || '').slice(0, 120), worker: worker(req) || 'Office' });
    await syncSuppliers();
    return r;
  }));

  // ── Floor screen for workers (/floor) ──
  // A worker only ever sees their own trade; everyone else picks a trade view on /floor ('all' = every trade).
  const floorTrade = (req, asked) => (req.user?.role === 'worker' ? req.user.trade : asked);
  // A worker may only undo their own take / delivery booking (the name saved on it = their login's name).
  // It goes by the login's id saved on the movement; only movements from before logins (no id) go by the name.
  async function ownMovementOnly(req, type) {
    if (req.user?.role !== 'worker') return;
    const m = await get('SELECT worker, user_id FROM movements WHERE id = ? AND type = ?', Number(req.body.movement_id), type);
    if (!m) return; // "Nothing to undo" from the undo itself
    const own = m.user_id != null ? Number(m.user_id) === Number(req.user.id)
      : String(m.worker || '').trim().toLowerCase() === String(req.user.name).trim().toLowerCase();
    if (!own) throw inv.httpError(403, 'Only the person who did it can undo it — ask the office');
  }

  app.get('/api/floor/vans', h(() => inv.floorVans()));
  app.get('/api/trades', h(() => TRADES));
  // The worker home screen: the floor map with badges for one trade.
  // `trade` in the answer: the trade really shown (a worker's own, whatever was asked).
  app.get('/api/floor/map', h(async req => { const t = floorTrade(req, String(req.query.trade || 'all')); return { ...await layout.floorMap(t), trade: isTrade(t) ? t : 'all' }; }));
  app.get('/api/floor/vans/:id', h(req => inv.floorVan(id(req))));
  app.get('/api/floor/stats', h(req => inv.floorStats({ userId: req.user.id, name: worker(req) })));
  // accept_borrow: true = the worker agreed to take another van's part, false = it's a new delivery.
  const acceptBorrow = v => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
  app.post('/api/floor/take', h(req => inv.takeForVan(Number(req.body.line_id), num(req.body.qty), worker(req),
    { seenIssued: num(req.body.seen_issued), acceptBorrow: acceptBorrow(req.body.accept_borrow) })));
  // put_back: "Put back on shelf" from the Done tab — a take from earlier today (phone round 1, C11).
  // line_id / van_id (sp-r1-5): what the phone is undoing — a movement for another line or van is refused.
  const optId = v => (v == null || v === '' ? null : Number(v));
  app.post('/api/floor/undo', h(async req => {
    await ownMovementOnly(req, 'issue');
    return inv.undoTake(Number(req.body.movement_id), { sameDay: req.body.put_back === true, lineId: optId(req.body.line_id), vanId: optId(req.body.van_id) });
  }));
  // Delivery screen (phone round 1, C11): what is still to come on open POs, Undo a booking, set where a part is kept.
  app.get('/api/floor/waiting', h(() => inv.floorWaiting()));
  // item_id (sp-r1-5): the part the phone booked in — a movement for another part is refused.
  app.post('/api/floor/receive/undo', h(async req => {
    await ownMovementOnly(req, 'receive');
    return inv.undoReceive(Number(req.body.movement_id), worker(req), { itemId: optId(req.body.item_id) });
  }));
  app.post('/api/floor/items/:id/place', h(req => inv.setItemPlace(id(req), req.body.area_id == null || req.body.area_id === '' ? null : Number(req.body.area_id),
    req.body.location, worker(req))));
  // A part that wasn't on the worker's list: tick off the van's open line for it, or add one and take it.
  app.post('/api/floor/extra', h(req => inv.floorExtra(Number(req.body.van_id), Number(req.body.item_id), Number(req.body.qty), worker(req),
    { seenTaken: num(req.body.seen_taken), acceptBorrow: acceptBorrow(req.body.accept_borrow) })));
  // A delivery booked on a phone carries a one-off id (rid): if the reply was lost and the worker taps again,
  // the same booking is answered again instead of booking the delivery twice. The answer is kept in
  // request_receipts for 24 hours, written in the same transaction as the delivery (and looked up under the
  // same write lock, so two taps at once book it once — on any server).
  const RECEIPT_MS = 24 * 60 * 60 * 1000;
  app.post('/api/floor/receive', h(async req => {
    const rid = String(req.body.rid || '').slice(0, 80);
    const at = Date.now();
    if (rid) {
      // (?::text::jsonb: a jsonb-typed parameter would be JSON-encoded twice by the postgres client)
      const seen = await get('SELECT out FROM request_receipts WHERE rid = ? AND at > ?', rid, at - RECEIPT_MS);
      if (seen) return seen.out;
    }
    const vanId = Number(req.body.van_id) || null;
    const r = await inv.receiveDelivery(Number(req.body.item_id), Number(req.body.qty), { ref: 'Delivery (floor)', vanId, by: worker(req) });
    // Which vans got it, to show the worker where it's going; movement_id lets the phone undo it (C11).
    const vans = (await all(`SELECT v.chassis FROM vans v WHERE v.status IN ('planned','in_production')
                  AND EXISTS (SELECT 1 FROM van_lines l WHERE l.van_id = v.id AND l.item_id = ? AND l.reserved > 0)
                ORDER BY ${inv.PRIORITY} LIMIT 6`, Number(req.body.item_id))).map(x => x.chassis);
    // to / shelf (follow-up round 1, worker-r3-4): where THIS delivery went — "1 → ST0380", or on the shelf.
    const out = { vans, movement_id: r.movement_id, to: r.to || [], shelf: r.shelf || 0 };
    if (rid) {
      // (?::text::jsonb: a jsonb-typed parameter would be JSON-encoded twice by the postgres client)
      // (old receipts go here as well as in the nightly clean-up, so a local run without it stays small)
      await run('DELETE FROM request_receipts WHERE at <= ?', at - RECEIPT_MS);
      await run(`INSERT INTO request_receipts(rid, out, at) VALUES(?, ?::text::jsonb, ?)
                 ON CONFLICT (rid) DO UPDATE SET out = excluded.out, at = excluded.at`, rid, JSON.stringify(out), at);
    }
    return out;
  }));

  // ── Factory floor map, notes, reminders ──
  app.get('/api/layout', h(() => layout.getLayout()));
  app.post('/api/layout/areas', h(req => layout.saveArea(null, req.body)));
  app.put('/api/layout/areas/:id', h(req => layout.saveArea(id(req), req.body)));
  app.delete('/api/layout/areas/:id', h(req => layout.deleteArea(id(req))));
  app.get('/api/layout/areas/:id/items', h(req => layout.areaItems(id(req))));
  // Push every van one bay along the loop (preview with GET, do it with POST).
  app.get('/api/layout/advance', h(req => layout.advanceLine({ nextVanId: Number(req.query.next) || null, dryRun: true })));
  app.post('/api/layout/advance', h(req => layout.advanceLine({ nextVanId: Number(req.body.next_van_id) || null, expect: Array.isArray(req.body.expect) ? req.body.expect : null })));
  app.post('/api/vans/:id/move', h(req => layout.moveVan(id(req), req.body.area_id == null || req.body.area_id === '' ? null : Number(req.body.area_id))));
  app.post('/api/vans/:id/leave', h(req => layout.leaveFactory(id(req))));
  app.get('/api/vans/:id/floor', h(req => layout.vanFloorInfo(id(req))));
  app.post('/api/vans/:id/notes', h(req => layout.addNote(id(req), req.body.text, worker(req))));
  app.delete('/api/notes/:id', h(req => layout.deleteNote(id(req))));
  app.get('/api/reminders', h(() => layout.openReminders()));
  app.post('/api/reminders', h(req => layout.addReminder({ ...req.body, van_id: Number(req.body.van_id) || null }, worker(req))));
  app.put('/api/reminders/:id', h(req => layout.setReminderDone(id(req), !!req.body.done)));
  app.delete('/api/reminders/:id', h(req => layout.deleteReminder(id(req))));

  // ── Production plan ──
  app.get('/api/plan', h(req => inv.planGrid({ includeFinished: req.query.all === '1', parts: true })));
  // Importing the plan spreadsheet — preview, update, and "start again from the spreadsheet" (which made a
  // backup first) — is not part of this version: it is done on the original version before the move.
  app.post('/api/import/plan/*', h(gone(cloud ? NOT_ONLINE : PLAN_IMPORT_GONE), OWN_TX));
  app.get('/api/import/history', h(() => importHistory()));
  // "Plan changes to check" came from a plan import: none here (the go-live checklist shows 0 too).
  app.get('/api/plan-conflicts', h(() => []));
  app.post('/api/plan-conflicts/:id', h(gone(cloud ? NOT_ONLINE : PLAN_IMPORT_GONE), OWN_TX));
  // Re-prioritise in two steps: see what each van gains and loses, then confirm.
  app.get('/api/allocate/reprioritise/preview', h(() => inv.reprioritisePreview()));
  app.post('/api/allocate/reprioritise', h(req => inv.reprioritiseAll({ by: worker(req) || 'Office' })));

  // ── Clean-up report (what the clean-up on the original version changed) ──
  app.get('/api/tidy/report', h(() => tidyReport()));
  app.post('/api/tidy/checked', h(req => markReportChecked(worker(req) || 'Office')));

  // ── Counts: blind, one rack / trade at a time; bought-for-van parts checked one by one ──
  app.get('/api/counts/choices', h(() => inv.countChoices()));
  app.post('/api/counts', h(req => inv.openCount(String(req.body.scope || ''), worker(req))));
  const plainObj = o => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  app.post('/api/counts/:id/check', h(req => inv.checkCount(id(req), Array.isArray(req.body.counts) ? req.body.counts : [],
    { timing: plainObj(req.body.timing) })));
  // timing {itemId: 'before'|'after'} for parts that moved while counting; elsewhere {itemId: 'yes'|'no'} and
  // elsewhere_qty {itemId: n} (how many are kept elsewhere) for parts below what is kept for vans.
  app.post('/api/counts/:id/save', h(req => inv.saveCount(id(req), { counts: Array.isArray(req.body.counts) ? req.body.counts : [],
    elsewhere: plainObj(req.body.elsewhere), elsewhereQty: plainObj(req.body.elsewhere_qty), timing: plainObj(req.body.timing),
    ackMoves: !!req.body.ack_moves, by: worker(req) })));
  app.get('/api/bought-for-van', h(() => inv.boughtForVanList()));
  // Bought-for-van stock with no van (C9): assign to a van, or keep on the shelf as a spare.
  app.get('/api/items/unassigned', h(req => inv.unassignedPerVan({ all: req.query.all === '1' })));
  app.post('/api/items/:id/assign', h(req => inv.assignToVan(id(req), Number(req.body.van_id), num(req.body.qty), worker(req) || 'Office')));
  app.post('/api/items/:id/spare', h(req => inv.keepSpare(id(req), worker(req) || 'Office')));
  // Fix the catalogue (C9) and bulk "Put on rack".
  app.get('/api/catalogue', h(() => inv.catalogueGaps()));
  app.post('/api/items/rack', h(req => inv.putOnRack(Array.isArray(req.body.ids) ? req.body.ids : [], req.body.area_id, worker(req) || 'Office')));
  // Weekly "Stock checks" (C11).
  app.get('/api/stock-checks', h(() => inv.stockChecks()));
  app.post('/api/stock-checks/ack', h(req => inv.ackCheck(String(req.body.kind || ''), Number(req.body.id), req.body.ack !== false)));
  app.post('/api/van-lines/:id/check', h(req => inv.checkBoughtLine(id(req), String(req.body.answer || ''), worker(req))));

  // ── Items / stock ──
  const ITEM_FIELDS = ['sku', 'name', 'category', 'supplier', 'unit', 'kind', 'reorder_level', 'location', 'notes', 'active', 'plan_column', 'area_id', 'trade',
    'unit_size', 'order_up_to'];
  function itemValues(b) {
    const v = { ...b };
    if (v.sku != null) v.sku = String(v.sku).trim().toUpperCase();
    if (v.reorder_level != null) v.reorder_level = Math.max(0, Number(v.reorder_level) || 0);
    if (v.order_up_to != null) v.order_up_to = Math.max(0, Number(v.order_up_to) || 0);
    if (v.unit_size != null) v.unit_size = String(v.unit_size).trim().slice(0, 60);
    if (v.supplier != null) v.supplier = String(v.supplier).trim();
    if (v.active != null) v.active = v.active ? 1 : 0;
    if (v.area_id !== undefined) v.area_id = Number(v.area_id) || null;
    if (v.trade !== undefined && !isTrade(v.trade)) v.trade = '';
    if (v.kind !== undefined) v.kind = v.kind === 'per-van' ? 'per-van' : 'stock';
    return v;
  }
  app.get('/api/items', h(req => inv.listItems({ includeInactive: req.query.all === '1' })));
  app.get('/api/items/many-specs', h(() => inv.manySpecs(5)));
  // { item_id: qty } still to order for vans due soon, after what is on order (Stock page "Still to order").
  app.get('/api/items/still-to-order', h(() => inv.stillToOrderByItem()));
  app.get('/api/items/:id', h(req => inv.itemDetail(id(req))));
  app.post('/api/items', h(async req => {
    const v = itemValues(req.body);
    if (!v.sku || !v.name) throw inv.httpError(400, 'SKU and name are required');
    if (await get('SELECT 1 FROM items WHERE sku = ?', v.sku)) throw inv.httpError(409, `SKU ${v.sku} already exists`);
    const keys = ITEM_FIELDS.filter(k => v[k] != null);
    const newId = await insert(`INSERT INTO items(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => v[k]));
    if (Number(req.body.on_hand) > 0) await inv.receive(newId, Number(req.body.on_hand), { note: 'Opening stock' });
    await assignMissingTrades(); // no trade picked → best guess from the name
    return { id: newId };
  }));
  app.put('/api/items/:id', h(async req => {
    const v = itemValues(req.body);
    const keys = ITEM_FIELDS.filter(k => v[k] !== undefined);
    if (v.sku && await get('SELECT 1 FROM items WHERE sku = ? AND id <> ?', v.sku, id(req))) throw inv.httpError(409, `SKU ${v.sku} already exists`);
    const before = await get('SELECT * FROM items WHERE id = ?', id(req));
    if (!before) throw inv.httpError(404, 'Item not found');
    if (keys.length) await run(`UPDATE items SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => v[k]), id(req));
    // Catalogue changes that matter for ordering / counting go into the item's history.
    for (const k of ['kind', 'supplier', 'area_id', 'reorder_level', 'order_up_to', 'unit', 'unit_size']) {
      if (v[k] === undefined || String(v[k] ?? '') === String(before[k] ?? '')) continue;
      await logAlloc('catalogue', { item_id: before.id, field: k === 'area_id' ? 'rack' : k.replace(/_/g, ' '), before: before[k] ?? '', after: v[k] ?? '', worker: worker(req) || 'Office' });
    }
    if (v.supplier !== undefined) await syncSuppliers();
    await assignMissingTrades(); // "guess from the name" picked → best guess straight away
  }));
  app.post('/api/items/:id/adjust', h(req => inv.adjust(id(req), { mode: req.body.mode, qty: Number(req.body.qty), note: req.body.note, by: worker(req) })));
  app.post('/api/items/:id/receive', h(req => inv.receiveDelivery(id(req), Number(req.body.qty),
    { ref: req.body.ref || '', note: req.body.note || '', vanId: Number(req.body.van_id) || null, by: worker(req) })));
  // Photos (OWN_TX: the picture is stored — a file, or an upload to Storage — outside the write lock; then
  // items.photo changes in a writeTx; the old picture is removed only once that is saved).
  const dropPhoto = async name => {
    try { await deletePhoto(name); } catch (e) { console.error(now(), `Couldn't remove the old picture ${name}:`, e); }
  };
  app.post('/api/items/:id/photo', h(async req => {
    const itemId = id(req);
    if (!await get('SELECT 1 FROM items WHERE id = ?', itemId)) throw inv.httpError(404, 'Item not found');
    const name = await savePhoto(itemId, req.body?.full, req.body?.thumb);
    let old;
    try {
      old = await writeTx(async () => {
        const item = await get('SELECT id, photo FROM items WHERE id = ?', itemId);
        if (!item) throw inv.httpError(404, 'Item not found'); // deleted meanwhile
        await run('UPDATE items SET photo = ? WHERE id = ?', name, item.id);
        return item.photo;
      });
    } catch (e) { await dropPhoto(name); throw e; }
    if (old) await dropPhoto(old);
    return { photo: name };
  }, OWN_TX));
  app.delete('/api/items/:id/photo', h(async req => {
    const itemId = id(req);
    const old = await writeTx(async () => {
      const item = await get('SELECT id, photo FROM items WHERE id = ?', itemId);
      if (!item) throw inv.httpError(404, 'Item not found');
      await run(`UPDATE items SET photo = '' WHERE id = ?`, item.id);
      return item.photo;
    });
    if (old) await dropPhoto(old);
  }, OWN_TX));
  // Download a picture from an internet link (or the main picture of a product page). Nothing is saved
  // (OWN_TX: the download is not done under the write lock).
  app.post('/api/web-image', h(async (req, res) => {
    const img = await fetchWebImage(req.body.url);
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'no-store');
    res.send(img.body);
  }, OWN_TX));
  app.post('/api/stocktake', h(req => inv.stocktake(req.body.rows || [], req.body.note, worker(req))));

  // ── Rules ──
  app.get('/api/rules', h(() => all(`SELECT r.*, i.sku, i.name AS item_name FROM rules r JOIN items i ON i.id = r.item_id ORDER BY r.sort, r.id`)));
  function checkRule(b) {
    parseConditions(b.conditions); // throws a readable error if malformed
    if (!b.item_id) throw inv.httpError(400, 'Pick the item this rule adds');
  }
  app.post('/api/rules', h(async req => {
    try { checkRule(req.body); } catch (e) { throw inv.httpError(400, e.message); }
    const sort = ((await get('SELECT MAX(sort) AS s FROM rules')).s || 0) + 10;
    const newId = await insert('INSERT INTO rules(name, conditions, item_id, qty, spec_fields, active, sort) VALUES(?,?,?,?,?,?,?)',
      req.body.name || '', req.body.conditions, Number(req.body.item_id), String(req.body.qty || '1'), req.body.spec_fields || '', req.body.active === false ? 0 : 1, sort);
    return { id: newId };
  }));
  app.put('/api/rules/:id', h(async req => {
    try { checkRule(req.body); } catch (e) { throw inv.httpError(400, e.message); }
    await run('UPDATE rules SET name=?, conditions=?, item_id=?, qty=?, spec_fields=?, active=? WHERE id=?',
      req.body.name || '', req.body.conditions, Number(req.body.item_id), String(req.body.qty || '1'), req.body.spec_fields || '', req.body.active === false ? 0 : 1, id(req));
  }));
  app.delete('/api/rules/:id', h(req => run('DELETE FROM rules WHERE id = ?', id(req))));
  // Try a rule against every active van and say which ones it would fire for. (Changes nothing.)
  app.post('/api/rules/test', h(async req => {
    try { checkRule({ ...req.body, item_id: 1 }); } catch (e) { throw inv.httpError(400, e.message); }
    const out = [];
    for (const v of await inv.listVans({ status: 'active' })) {
      const fields = await all('SELECT * FROM order_fields WHERE van_id = ? ORDER BY sort', v.id);
      const r = testRule(req.body, fields);
      out.push({ chassis: v.chassis, fired: r.fired, matched: r.fired ? [...r.pos].map(f => `${f.label}: ${f.value}`) : [] });
    }
    return out;
  }, OWN_TX));

  // ── Purchasing ──
  // Order now / Coming up / Later / No date, netted against what is already on order.
  app.get('/api/shortages', h(() => inv.shortages()));
  app.get('/api/suppliers', h(() => inv.listSuppliers()));
  app.put('/api/suppliers', h(req => inv.setSupplierLead(req.body.name, req.body.lead_days)));
  app.put('/api/purchasing/settings', h(req => inv.savePurchasingSettings(req.body)));
  // "Check: already ordered?" — plan order numbers nobody has confirmed (display only until answered).
  app.get('/api/check-ordered', h(() => inv.checkOrdered()));
  app.post('/api/check-ordered', h(req => inv.answerOrdered(req.body.po_ref, String(req.body.answer || ''),
    { lineIds: Array.isArray(req.body.line_ids) ? req.body.line_ids : null, supplier: req.body.supplier || '', by: worker(req) || 'Office',
      group: typeof req.body.group === 'string' ? req.body.group : undefined, key: typeof req.body.key === 'string' ? req.body.key : undefined })));
  // "Yes, all on order" for one supplier: { supplier, groups: [{ key, po_ref, line_ids }] } — all or nothing.
  app.post('/api/check-ordered/all', h(req => inv.answerOrderedMany(req.body.groups, { supplier: req.body.supplier || '', by: worker(req) || 'Office',
    ordered_at: String(req.body.ordered_at || ''), expected: String(req.body.expected || '') })));
  // Customer supplies / to be decided, set or cleared on a van line; and the "waiting on a decision" list.
  app.post('/api/van-lines/:id/state', h(req => inv.setLineState(id(req), String(req.body.state ?? ''), { stock: String(req.body.stock || ''), by: worker(req) || 'Office' })));
  app.get('/api/decisions', h(req => inv.decisionLines({ vanId: Number(req.query.van) || null })));
  app.get('/api/pos', h(() => inv.listPOs()));
  app.get('/api/pos/to-check', h(() => inv.posToCheck()));
  app.get('/api/pos/overdue', h(() => inv.overdueLines()));
  app.get('/api/pos/:id', h(req => inv.getPO(id(req))));
  app.post('/api/pos', h(async req => ({ id: await inv.createPO(req.body) })));
  app.post('/api/pos/:id/receive', h(req => inv.receivePO(id(req), Array.isArray(req.body.lines) ? req.body.lines : [],
    { backorder: req.body.backorder || {}, closeBalance: Array.isArray(req.body.close_balance) ? req.body.close_balance : [], by: worker(req) })));
  app.post('/api/pos/:id/merge', h(req => inv.mergePO(id(req), Number(req.body.into), worker(req) || 'Office')));
  app.put('/api/pos/:id', h(async req => {
    const b = req.body || {};
    if (b.status) await inv.setPOStatus(id(req), b.status === 'closed' ? 'closed' : 'open', worker(req) || 'Office');
    const fields = ['po_no', 'supplier', 'ordered_at', 'expected', 'notes', 'checked'].filter(k => b[k] !== undefined);
    if (fields.length) return inv.updatePO(id(req), Object.fromEntries(fields.map(k => [k, b[k]])), worker(req) || 'Office');
  }));
  app.delete('/api/pos/:id', h(async req => {
    if ((await get('SELECT COALESCE(SUM(received),0) AS r FROM po_lines WHERE po_id = ?', id(req))).r > 0) {
      throw inv.httpError(400, 'Stock was already received against this PO — close it instead');
    }
    await run('DELETE FROM purchase_orders WHERE id = ?', id(req));
  }));

  // ── Settings / export ──
  // floorUrls: the worker screen's address to open on the phones — this PC's network addresses locally;
  // online the one public address (PUBLIC_URL, e.g. https://factory-stock.pages.dev) when it is set.
  const floorUrls = req => (cloud
    ? (process.env.PUBLIC_URL ? [`${String(process.env.PUBLIC_URL).replace(/\/+$/, '')}/floor`] : [])
    : lanAddresses().map(ip => `http://${ip}:${req.socket.localPort}/floor`));
  app.get('/api/settings', h(async req => ({ ignore: await inv.ignoreList(), dealer: await getSetting('dealer', ''), demo: (await getSetting('demo')) === '1',
    planImportedAt: await getSetting('plan_imported_at', ''), importHistory: (await importHistory()).slice(0, 10),
    lastBackup: await getSetting('last_backup', ''), floorUrls: floorUrls(req) })));
  app.put('/api/settings', h(async req => {
    if (Array.isArray(req.body.ignore)) await setSetting('ignore', JSON.stringify(req.body.ignore.map(s => String(s).trim()).filter(Boolean)));
    if (req.body.dealer != null) await setSetting('dealer', String(req.body.dealer));
  }));
  // Shelf stock counts go to zero (logged, like a stocktake). Per-van parts already received for a
  // van stay with that van.
  app.post('/api/settings/clear-stock', h(async () => {
    await run(`DELETE FROM movements WHERE type = 'adjust' AND note = 'Demo stock level'`);
    for (const { id: itemId } of await all(`SELECT id FROM items WHERE kind = 'stock' AND on_hand <> 0 ORDER BY id`)) {
      await inv.adjust(itemId, { mode: 'set', qty: 0, note: 'Set to zero before stocktake', type: 'adjust' }); // not a count
    }
    await setSetting('demo', '0');
  }));
  app.get('/api/export/plan.xlsx', async (req, res) => {
    try {
      const buf = await exportWorkbook();
      // Melbourne's date, whatever the server's own time zone (UTC in the cloud: yesterday until ~10am here).
      const stamp = inv.today();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Production Plan ${stamp}.xlsx"`);
      res.send(buf);
    } catch (e) {
      console.error(now(), req.method, req.originalUrl, e);
      res.status(e.status === 503 ? 503 : 500).send(e.status === 503 ? e.message : 'Export failed');
    }
  });

  // Anything not matched above: plain JSON messages, never a technical error page.
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found — refresh the page' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big' });
    const e = asBusy(err);
    const status = e.status || e.statusCode;
    // The database is asleep / can't be reached, or busy (src/db.js): say so, it is worth trying again.
    if (status === 503) return res.status(503).json({ error: e.message });
    if (err.type === 'entity.parse.failed' || (status >= 400 && status < 500)) {
      return res.status(status || 400).json({ error: "The app couldn't read that request — refresh the page and try again" });
    }
    console.error(now(), req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Something went wrong — try again' });
  });
  return app;
}
