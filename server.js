import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, all, get, run, tx, getSetting, setSetting, PHOTO_DIR, DATA_DIR, logAlloc, syncSuppliers } from './src/db.js';
import { savePhoto, deletePhoto } from './src/photos.js';
import { fetchWebImage } from './src/webImage.js';
import * as layout from './src/layout.js';
import { seed, syncCatalog } from './src/seed.js';
import { previewPlan, applyPlan, planUpdate, planConflicts, resolvePlanConflict, importHistory } from './src/importPlan.js';
import { goLive } from './src/golive.js';
import { execFileSync } from 'node:child_process';
import { parseOrderPdf } from './src/parseOrder.js';
import { parseConditions, testRule } from './src/rules.js';
import * as inv from './src/inventory.js';
import { exportWorkbook } from './src/exportXlsx.js';
import { TRADES, assignMissingTrades, isTrade } from './src/trades.js';
import { runTidy, rerunTidy, tidyReport, markReportChecked } from './src/tidy.js';
import { linkLine, linkPreview, makeOneOff, addTextParts } from './src/relink.js';
import * as auth from './src/auth.js';

seed();        // first run only: loads the starter catalogue
syncCatalog(); // adds any items/rules introduced by updates
assignMissingTrades(); // every part gets a trade (electrician, builder, …) if it has none
layout.seedLayout(); // first run only: a starting factory floor layout
layout.drawingRemindersAll(); // reminders for "as per drawing" lines on orders already loaded
// One-off stock clean-up (backup first, each step once, everything logged) — see src/tidy.js.
const tidyResult = runTidy({ log: msg => console.log(new Date().toLocaleString('sv-SE'), msg.trim()) });
if (tidyResult.ran?.length) assignMissingTrades(); // parts the clean-up added

const app = express();
// PORT=0 picks any free port (the tests use it); unset = 3000.
const PORT = process.env.PORT != null && String(process.env.PORT).trim() !== '' ? Number(process.env.PORT) : 3000;
let listenPort = PORT; // the port really in use (set once listening)
const dir = path.dirname(fileURLToPath(import.meta.url));
// Local date and time for the log ("2026-10-12 14:05:09"), so "it failed yesterday afternoon" can be found.
const now = () => new Date().toLocaleString('sv-SE');
// Last resort: write down what happened, then stop (the auto-start loop starts the app again).
process.on('uncaughtException', e => { console.error(now(), 'Factory Stock stopped because of an error:', e); process.exit(1); });

// ── Logins (src/auth.js) ──
// Behind a tunnel / proxy on this PC (Cloudflare Tunnel, Tailscale serve) set TRUST_PROXY=1, so the
// visitor's address (login throttling) and https (Secure cookie) come from the proxy's headers — only
// when the proxy itself is on this PC. Without it those headers are never believed.
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 'loopback' : false);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
const throttle = auth.createThrottle();
const clientIp = req => String(req.ip || req.socket?.remoteAddress || '');
// Who is logged in on this browser: req.user = { id, username, name, role, trade, mustChange }.
app.use((req, res, next) => {
  const token = auth.readCookie(req.headers.cookie);
  if (token) {
    const s = auth.sessionFromToken(token);
    if (s) {
      req.user = s.user;
      req.sessionHash = s.tokenHash;
      if (s.refreshed) res.append('Set-Cookie', auth.sessionCookie(token, { secure: req.secure })); // 30 more days
    }
  }
  next();
});
// Old sessions are cleared out once an hour.
setInterval(() => { try { auth.pruneSessions(); } catch { /* next time */ } }, 60 * 60 * 1000).unref();

// Changes must come from the app's own pages: a different website open in the same browser must
// not be able to send them. Requests with no Origin (scripts, curl) are allowed. Changes are only
// taken on this PC's own addresses / names (and ALLOWED_HOSTS): stops "DNS rebinding".
const rejectedHosts = new Set();
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('Origin');
  let sameHost = true;
  if (origin) { try { sameHost = new URL(origin).host === req.get('host'); } catch { sameHost = false; } }
  if (req.get('Sec-Fetch-Site') === 'cross-site' || !sameHost) return res.status(403).json({ error: 'Please use the Factory Stock app' });
  if (!auth.hostAllowed(req.get('host'))) {
    const h = String(req.get('host') || '').slice(0, 100);
    if (!rejectedHosts.has(h) && rejectedHosts.size < 50) { rejectedHosts.add(h); console.log(now(), `Refused a change sent to the address "${h}" — if that is a real name for this PC, add it to ALLOWED_HOSTS`); }
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
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
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
const nextTo = req => `/login?next=${encodeURIComponent(req.originalUrl)}`;
const noStore = res => res.setHeader('Cache-Control', 'no-store');
app.get(['/', '/index.html'], (req, res) => {
  noStore(res);
  if (!req.user) return res.redirect(302, nextTo(req));
  if (req.user.mustChange) return res.redirect(302, nextTo(req));
  if (!auth.capabilities(req.user.role).officeApp) return res.redirect(302, '/floor'); // workers: the worker app only
  if (req.path !== '/') return res.redirect(302, '/');
  res.sendFile(path.join(dir, 'public', 'index.html'));
});
app.get(['/floor', '/floor.html'], (req, res) => {
  noStore(res);
  if (!req.user || req.user.mustChange) return res.redirect(302, '/login?next=%2Ffloor');
  if (req.path !== '/floor') return res.redirect(302, '/floor');
  res.sendFile(path.join(dir, 'public', 'floor.html'));
});
app.get(['/login', '/login.html'], (req, res) => { noStore(res); res.sendFile(path.join(dir, 'public', 'login.html')); });
// Styles, scripts, fonts, logos, the app icon / manifest / service worker: no login needed (no data in them).
app.use(express.static(path.join(dir, 'public'), { index: false }));
// three.js for the 3D factory view — only the built module and the add-ons, nothing else from node_modules.
app.use('/vendor/three/build', express.static(path.join(dir, 'node_modules', 'three', 'build'), { maxAge: '7d', index: false }));
app.use('/vendor/three/addons', express.static(path.join(dir, 'node_modules', 'three', 'examples', 'jsm'), { maxAge: '7d', index: false }));
// Item photos: any login (the browser sends the cookie with each picture). File names change on every
// upload, so they can be kept for a long time — but only in that browser ("private").
app.use('/photos', (req, res, next) => (req.user ? next() : res.status(401).send('Please log in')),
  express.static(PHOTO_DIR, { maxAge: '365d', immutable: true, index: false,
    setHeaders: r => r.setHeader('Cache-Control', 'private, max-age=31536000, immutable') }));

// Wrap handlers so thrown errors become JSON responses.
// Every stock movement a change makes is stamped with the login's id (issue #2: "undo only your own", floor stats).
// A handler that doesn't wait runs to the end before any other request, so the movements numbered above the
// highest one before it are exactly its own. (Handlers that wait — PDFs, logins — make no movements.)
function stampMovements(req, run0) {
  if (!req.user || req.method === 'GET' || req.method === 'HEAD') return run0();
  const hi = get('SELECT COALESCE(MAX(id), 0) AS n FROM movements').n;
  const out = run0();
  if (!(out && typeof out.then === 'function')) run('UPDATE movements SET user_id = ? WHERE id > ? AND user_id IS NULL', req.user.id, hi);
  return out;
}
const h = fn => async (req, res) => {
  try {
    const out = await stampMovements(req, () => fn(req, res));
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    // Our own messages (with a status) are written for staff; anything else is an internal error.
    if (!e.status) console.error(now(), req.method, req.originalUrl, e);
    // confirm: the action needs a yes first (e.g. taking another van's part); problems: every reason a save was refused.
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong — try again',
      ...(e.status && e.confirm ? { confirm: e.confirm } : {}), ...(e.status && e.problems ? { problems: e.problems } : {}) });
  }
};
const id = req => Number(req.params.id);
const num = v => (v === '' || v == null ? undefined : Number(v));

// ── Logging in, my login, the Logins page (src/auth.js) ──
const setSession = (req, res, token) => res.append('Set-Cookie', auth.sessionCookie(token, { secure: req.secure }));
const meOut = u => ({ user: { ...auth.publicUser(u), mustChange: !!u.mustChange }, can: auth.capabilities(u.role),
  roles: Object.fromEntries(Object.entries(auth.ROLES).map(([k, r]) => [k, r.label])), trades: TRADES });
app.post('/api/login', h(async (req, res) => {
  const r = await auth.login({ username: req.body.username, password: req.body.password, ip: clientIp(req), ua: req.get('User-Agent') || '' }, throttle);
  // A new session every time (never re-use one that was there before the login).
  if (req.sessionHash) auth.endSession(req.sessionHash);
  setSession(req, res, r.token);
  console.log(now(), `Logged in: ${r.user.username} (${r.user.role}) from ${clientIp(req)}`);
  return meOut(r.user);
}));
app.post('/api/logout', h((req, res) => {
  if (req.sessionHash) auth.endSession(req.sessionHash);
  res.append('Set-Cookie', auth.clearCookie({ secure: req.secure }));
}));
app.get('/api/me', h(req => meOut(req.user)));
app.post('/api/me/password', h(async req => {
  await auth.changeOwnPassword(req.user.id, String(req.body.current ?? ''), String(req.body.password ?? ''), req.sessionHash);
  return meOut({ ...req.user, mustChange: false });
}));
// First login (the owner): only while there are none, and only on this PC itself.
app.get('/api/setup', h(req => ({ needed: auth.userCount() === 0, here: auth.fromThisPc(req) })));
app.post('/api/setup', h(async (req, res) => {
  if (auth.userCount() > 0) throw inv.httpError(409, 'The first login was already made — log in instead');
  if (!auth.fromThisPc(req)) throw inv.httpError(403, 'Open this on the office PC itself to create the first login');
  const u = await auth.setupOwner({ username: req.body.username, name: req.body.name, password: req.body.password });
  setSession(req, res, auth.createSession(u.id, { ip: clientIp(req), ua: req.get('User-Agent') || '' }));
  console.log(now(), `First login made: ${u.username} (owner)`);
  return meOut(u);
}));
// The Logins page (owner only — see the table in src/auth.js).
app.get('/api/users', h(() => ({ users: auth.listUsers(), roles: auth.ROLES, trades: TRADES })));
app.post('/api/users', h(async req => {
  const b = req.body || {};
  const u = await auth.createUser({ username: b.username, name: b.name, role: String(b.role || ''), trade: String(b.trade || ''),
    password: b.password, mustChange: b.must_change !== false }, req.user.name);
  console.log(now(), `Login added: ${u.username} (${u.role}) by ${req.user.username}`);
  return u;
}));
app.put('/api/users/:id', h(req => {
  const b = req.body || {};
  const u = auth.updateUser(id(req), { name: b.name, role: b.role === undefined ? undefined : String(b.role), trade: b.trade === undefined ? undefined : String(b.trade) }, req.user);
  console.log(now(), `Login changed: ${u.username} (${u.role}${u.trade ? `, ${u.trade}` : ''}) by ${req.user.username}`);
  return u;
}));
app.post('/api/users/:id/password', h(async req => {
  const u = await auth.resetPassword(id(req), req.body.password, { mustChange: req.body.must_change !== false });
  console.log(now(), `Password reset: ${u.username} by ${req.user.username}`);
  return u;
}));
app.post('/api/users/:id/active', h(req => {
  const u = auth.setActive(id(req), !!req.body.active, req.user);
  console.log(now(), `Login ${u.active ? 'turned on' : 'turned off'}: ${u.username} by ${req.user.username}`);
  return u;
}));

// ── Dashboard ──
app.get('/api/summary', h(() => ({ ...inv.summary(), golive: goLive(), demo: getSetting('demo') === '1' })));

// ── Dealer orders ──
app.post('/api/orders/parse', express.raw({ type: 'application/pdf', limit: '25mb' }), h(async req => {
  if (!req.body?.length) throw inv.httpError(400, 'No PDF received');
  let parsed;
  try { parsed = await parseOrderPdf(req.body); } catch { throw inv.httpError(400, "Couldn't read that PDF"); }
  if (!parsed.fields.length) throw inv.httpError(400, "That PDF doesn't look like a dealer order form");
  // from_plan: the van's parts come from the production plan, so saving won't re-run the rules.
  const existing = parsed.header.chassis ? get(`SELECT id, status,
      EXISTS(SELECT 1 FROM van_lines l WHERE l.van_id = vans.id AND l.source = 'plan') AS from_plan
    FROM vans WHERE chassis = ?`, parsed.header.chassis) : null;
  return { ...parsed, existing, preview: inv.previewOrder(parsed.fields, parsed.header.chassis) };
}));
app.post('/api/orders/preview', h(req => inv.previewOrder(req.body.fields || [])));

// ── Vans ──
app.get('/api/vans', h(req => inv.listVans({ status: req.query.status })));
app.post('/api/vans', h(req => {
  const vanId = inv.createVan({ ...req.body, by: worker(req) || 'Office' }, { replace: !!req.body.replace });
  // "As per drawing" lines on the dealer order become reminders on the van.
  // Options the office marked "Customer supplies" that no parts rule covers: a reminder on the van (user-r4-9).
  return { id: vanId, drawingReminders: layout.drawingReminders(vanId), customerReminders: layout.customerReminders(vanId, req.body.customer_fields) };
}));
app.get('/api/vans/:id', h(req => inv.getVan(id(req))));
app.put('/api/vans/:id', h(req => inv.updateVan(id(req), req.body)));
app.delete('/api/vans/:id', h(req => inv.deleteVan(id(req))));
app.post('/api/vans/:id/rebuild', h(req => {
  if (!tx(() => inv.applyRules(id(req)))) {
    throw inv.httpError(400, 'This van came from the production plan, so its parts list is the plan — edit it on the van or plan page');
  }
}));
app.post('/api/vans/:id/issue', h(req => ({ issued: inv.issue(id(req), req.body.line_ids || null) })));
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
app.post('/api/van-lines/:id/qty-ok', h(req => tx(() => {
  const l = get('SELECT * FROM van_lines WHERE id = ?', id(req));
  if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
  if (!/qty-ok/.test(l.note)) run('UPDATE van_lines SET note = ? WHERE id = ?', [l.note, 'qty-ok'].filter(Boolean).join(' · '), l.id);
})));
// Parts put in before go-live: close the lines (see inventory.markFitted).
// done: the office went through this van's list (go-live checklist), even with nothing ticked.
// "Already fitted…" quick start: parts received for this van (and when), to offer "tick everything received N weeks ago".
app.get('/api/vans/:id/fitted-quick', h(req => inv.fittedQuickStart(id(req))));
app.post('/api/vans/:id/fitted', h(req => inv.markFitted(id(req), Array.isArray(req.body.line_ids) ? req.body.line_ids : [], worker(req), { done: !!req.body.done })));
// "Why?": every change to what is set aside for this line, with who / when / why.
app.get('/api/van-lines/:id/log', h(req => inv.lineHistory(id(req))));
// "As per plan" lines → a real part (an existing one, or a new part made from the plan text).
app.get('/api/placeholders/count', h(req => inv.placeholderCounts({ vanId: Number(req.query.van) || null })));
app.get('/api/placeholders', h(req =>inv.placeholderLines({ vanId: Number(req.query.van) || null, onlyShort: req.query.short === '1' })));
app.post('/api/van-lines/:id/link', h(req => tx(() => {
  let itemId = Number(req.body.item_id) || null;
  const nu = req.body.new_item;
  if (!itemId && nu) {
    const name = String(nu.name || '').trim().slice(0, 120);
    if (!name) throw inv.httpError(400, 'Type a name for the new part');
    const l = get('SELECT l.*, i.trade, i.plan_column AS col, i.category FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?', id(req));
    if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
    let sku = String(nu.sku || '').trim().toUpperCase() || name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
    if (/^PLAN-/.test(sku)) sku = sku.slice(5);
    for (let n = 2; get('SELECT 1 FROM items WHERE sku = ?', sku); n++) sku = `${sku.replace(/-\d+$/, '')}-${n}`;
    itemId = Number(run(`INSERT INTO items(sku, name, category, supplier, unit, kind, plan_column, trade, notes)
                         VALUES(?, ?, ?, ?, 'ea', 'per-van', ?, ?, ?)`, sku, name, String(nu.category || 'General'), String(nu.supplier || ''),
                         l.plan_column || l.col || '', l.trade || '', `Made from the plan text "${l.spec}"`).lastInsertRowid);
  }
  if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
  return linkLine(id(req), itemId, { reason: 'link', worker: worker(req) || 'Office', force: !!req.body.force });
})));
// "Link all N lines with this same text" (round 2, user-r1-2): one part (picked, or made once from the
// text) for every line listed. Each line goes through the same safe linkLine; a van that already has a
// line for that part with a different amount / text is left "to confirm" (reported back as duplicate).
app.post('/api/van-lines/link-many', h(req => tx(() => {
  const ids = [...new Set((Array.isArray(req.body.line_ids) ? req.body.line_ids : []).map(Number).filter(Boolean))];
  if (!ids.length) throw inv.httpError(400, 'Which lines?');
  let itemId = Number(req.body.item_id) || null;
  const nu = req.body.new_item;
  if (!itemId && nu) {
    const name = String(nu.name || '').trim().slice(0, 120);
    if (!name) throw inv.httpError(400, 'Type a name for the new part');
    const l = get('SELECT l.*, i.trade, i.plan_column AS col FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?', ids[0]);
    if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
    let sku = String(nu.sku || '').trim().toUpperCase() || name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
    if (/^PLAN-/.test(sku)) sku = sku.slice(5);
    for (let n = 2; get('SELECT 1 FROM items WHERE sku = ?', sku); n++) sku = `${sku.replace(/-\d+$/, '')}-${n}`;
    // Bought for each van (it came from the plan as a per-van catch-all) unless the office says it's shelf stock.
    itemId = Number(run(`INSERT INTO items(sku, name, category, supplier, unit, kind, plan_column, trade, notes)
                         VALUES(?, ?, ?, ?, 'ea', ?, ?, ?, ?)`, sku, name, String(nu.category || 'General'), String(nu.supplier || '').trim(),
                         nu.kind === 'stock' ? 'stock' : 'per-van', l.plan_column || l.col || '', l.trade || '',
                         `Made from the plan text "${l.spec}" (${ids.length} line${ids.length === 1 ? '' : 's'})`).lastInsertRowid);
  }
  if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
  const out = { linked: 0, merged: 0, duplicate: 0, skipped: 0, item_id: itemId };
  // force: the office saw the "already has this part" warning (link-preview) and said merge anyway.
  const force = !!req.body.force;
  for (const lineId of ids) {
    const r = linkLine(lineId, itemId, { reason: 'link many', worker: worker(req) || 'Office', force, why: `linked with ${ids.length - 1} other line(s) with the same text` });
    out[r.result] = (out[r.result] || 0) + 1;
  }
  syncSuppliers();
  return out;
})));
// What linking would do, before anything is changed (round 3, user-r2-3): per line 'link', 'merge' (the van
// already has that part — one part, not two), 'duplicate' (it has it with a different amount / text) or
// 'skipped'. The screens show this and ask before merging.
app.post('/api/van-lines/link-preview', h(req => {
  const ids = [...new Set((Array.isArray(req.body.line_ids) ? req.body.line_ids : []).map(Number).filter(Boolean))];
  if (!ids.length) throw inv.httpError(400, 'Which lines?');
  const itemId = Number(req.body.item_id);
  if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
  return linkPreview(ids, itemId);
}));
// "Add each part" (Small fixes & phone round 1, user-r4-6): a plan text that names several parts
// ("induction cooker + CAMEC MICROWAVE 28LTR + AIR FRYER…") — each picked part becomes its own line on the van.
// { parts: [{ text, item_id }] }. The new lines get their stock set aside like any other line.
app.post('/api/van-lines/:id/add-parts', h(req => tx(() => {
  const r = addTextParts(id(req), req.body.parts, { worker: worker(req) || 'Office' });
  for (const itemId of r.allocate) inv.allocateItem(itemId, r.van_id, { reason: 'add part', worker: worker(req) || 'Office' });
  syncSuppliers();
  const { allocate, ...out } = r;
  return out;
})));
// "Keep as a one-off special part for this van": its own per-van part, still orderable (round 2, user-r1-2).
app.post('/api/van-lines/:id/one-off', h(req => {
  const r = makeOneOff(id(req), { supplier: String(req.body.supplier || '').trim().slice(0, 60), name: String(req.body.name || '').slice(0, 120), worker: worker(req) || 'Office' });
  syncSuppliers();
  return r;
}));

// ── Floor screen for workers (/floor) ──
// Who did it: always the name of the login (never `by` from the page — still accepted from older pages, but ignored).
const worker = req => req.user?.name || '';
// A worker only ever sees their own trade; everyone else picks a trade view on /floor ('all' = every trade).
const floorTrade = (req, asked) => (req.user?.role === 'worker' ? req.user.trade : asked);
// A worker may only undo their own take / delivery booking (the name saved on it = their login's name).
// It goes by the login's id saved on the movement; only movements from before logins (no id) go by the name.
function ownMovementOnly(req, type) {
  if (req.user?.role !== 'worker') return;
  const m = get('SELECT worker, user_id FROM movements WHERE id = ? AND type = ?', Number(req.body.movement_id), type);
  if (!m) return; // "Nothing to undo" from the undo itself
  const own = m.user_id != null ? Number(m.user_id) === Number(req.user.id)
    : String(m.worker || '').trim().toLowerCase() === String(req.user.name).trim().toLowerCase();
  if (!own) throw inv.httpError(403, 'Only the person who did it can undo it — ask the office');
}

app.get('/api/floor/vans', h(() => inv.floorVans()));
app.get('/api/trades', h(() => TRADES));
// The worker home screen: the floor map with badges for one trade.
// `trade` in the answer: the trade really shown (a worker's own, whatever was asked).
app.get('/api/floor/map', h(req => { const t = floorTrade(req, String(req.query.trade || 'all')); return { ...layout.floorMap(t), trade: isTrade(t) ? t : 'all' }; }));
app.get('/api/floor/vans/:id', h(req => inv.floorVan(id(req))));
app.get('/api/floor/stats', h(req => inv.floorStats({ userId: req.user.id, name: worker(req) })));
// accept_borrow: true = the worker agreed to take another van's part, false = it's a new delivery.
const acceptBorrow = v => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
app.post('/api/floor/take', h(req => inv.takeForVan(Number(req.body.line_id), num(req.body.qty), worker(req),
  { seenIssued: num(req.body.seen_issued), acceptBorrow: acceptBorrow(req.body.accept_borrow) })));
// put_back: "Put back on shelf" from the Done tab — a take from earlier today (phone round 1, C11).
// line_id / van_id (sp-r1-5): what the phone is undoing — a movement for another line or van is refused.
const optId = v => (v == null || v === '' ? null : Number(v));
app.post('/api/floor/undo', h(req => {
  ownMovementOnly(req, 'issue');
  return inv.undoTake(Number(req.body.movement_id), { sameDay: req.body.put_back === true, lineId: optId(req.body.line_id), vanId: optId(req.body.van_id) });
}));
// Delivery screen (phone round 1, C11): what is still to come on open POs, Undo a booking, set where a part is kept.
app.get('/api/floor/waiting', h(() => inv.floorWaiting()));
// item_id (sp-r1-5): the part the phone booked in — a movement for another part is refused.
app.post('/api/floor/receive/undo', h(req => {
  ownMovementOnly(req, 'receive');
  return inv.undoReceive(Number(req.body.movement_id), worker(req), { itemId: optId(req.body.item_id) });
}));
app.post('/api/floor/items/:id/place', h(req => inv.setItemPlace(id(req), req.body.area_id == null || req.body.area_id === '' ? null : Number(req.body.area_id),
  req.body.location, worker(req))));
// A part that wasn't on the worker's list: tick off the van's open line for it, or add one and take it.
app.post('/api/floor/extra', h(req => inv.floorExtra(Number(req.body.van_id), Number(req.body.item_id), Number(req.body.qty), worker(req),
  { seenTaken: num(req.body.seen_taken), acceptBorrow: acceptBorrow(req.body.accept_borrow) })));
// A delivery booked on a phone carries a one-off id: if the reply was lost and the worker taps again,
// the same booking is answered again instead of booking the delivery twice.
const floorReceipts = new Map();
app.post('/api/floor/receive', h(req => {
  const rid = String(req.body.rid || '').slice(0, 80);
  if (rid && floorReceipts.has(rid)) return floorReceipts.get(rid).out;
  const out = tx(() => {
    const vanId = Number(req.body.van_id) || null;
    const r = inv.receiveDelivery(Number(req.body.item_id), Number(req.body.qty), { ref: 'Delivery (floor)', vanId, by: worker(req) });
    // Which vans got it, to show the worker where it's going; movement_id lets the phone undo it (C11).
    const vans = all(`SELECT v.chassis FROM vans v WHERE v.status IN ('planned','in_production')
                  AND EXISTS (SELECT 1 FROM van_lines l WHERE l.van_id = v.id AND l.item_id = ? AND l.reserved > 0)
                ORDER BY ${inv.PRIORITY} LIMIT 6`, Number(req.body.item_id)).map(x => x.chassis);
    // to / shelf (follow-up round 1, worker-r3-4): where THIS delivery went — "1 → ST0380", or on the shelf.
    return { vans, movement_id: r.movement_id, to: r.to || [], shelf: r.shelf || 0 };
  });
  if (rid) {
    floorReceipts.set(rid, { out, at: Date.now() });
    for (const [k, v] of floorReceipts) { if (Date.now() - v.at < 60 * 60 * 1000) break; floorReceipts.delete(k); } // oldest first
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
const xlsxBody = express.raw({ type: 'application/octet-stream', limit: '30mb' });
// A damaged or wrong file gives a plain message instead of the spreadsheet library's error.
const planFile = (fn, buf) => {
  try { return fn(buf); } catch (e) {
    if (e.status) throw e;
    console.error(now(), 'Production plan file:', e);
    throw inv.httpError(400, "Couldn't read that file — is it the production plan (.xlsx)?");
  }
};
app.post('/api/import/plan/preview', xlsxBody, h(req => {
  if (!req.body?.length) throw inv.httpError(400, 'No file received');
  return planFile(previewPlan, req.body);
}));
// The file's name, sent by the page as a header (for the import history).
const fileName = req => { try { return decodeURIComponent(String(req.get('X-File-Name') || '')).slice(0, 200); } catch { return ''; } };
// "Update from spreadsheet" (the normal way, C12): preview first, then apply after Confirm.
app.post('/api/import/plan/update/preview', xlsxBody, h(req => {
  if (!req.body?.length) throw inv.httpError(400, 'No file received');
  return planFile(buf => planUpdate(buf, { apply: false }), req.body);
}));
app.post('/api/import/plan/update', xlsxBody, h(req => {
  if (!req.body?.length) throw inv.httpError(400, 'No file received');
  const r = planFile(buf => planUpdate(buf, { apply: true, file: fileName(req), by: worker(req) || 'Office' }), req.body);
  assignMissingTrades(); // new "as per plan" items
  return r;
}));
// "Start again from spreadsheet": wipes vans, part lines, POs, stock levels and history. Only with
// ?confirm=RESET, and only after scripts/backup.js has made a full copy. The clean-up steps then run again.
app.post('/api/import/plan/apply', xlsxBody, h(req => {
  if (!req.body?.length) throw inv.httpError(400, 'No file received');
  if (String(req.query.confirm || '') !== 'RESET') throw inv.httpError(400, 'Type RESET to start again from the spreadsheet');
  const dest = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(DATA_DIR)), 'Factory Stock backups (before start again)');
  try {
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'backup.js'), dest], { env: { ...process.env, DATA_DIR }, stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    console.error(now(), 'Backup before "start again" failed:', String(e.stderr || e.message));
    throw inv.httpError(500, `The backup before starting again failed, so nothing was changed. ${String(e.stderr || '').trim().split('\n').pop() || ''}`.trim());
  }
  console.log(now(), `Backup before "start again from spreadsheet" saved in ${dest}`);
  const r = planFile(buf => applyPlan(buf, { file: fileName(req), by: worker(req) || 'Office' }), req.body);
  assignMissingTrades(); // new "as per plan" items
  const t = rerunTidy({ log: msg => console.log(now(), msg.trim()) });
  if (t.ran?.length) assignMissingTrades();
  return { ...r, backup: dest, tidy: t.ran || [], tidyError: t.error || '' };
}));
app.get('/api/import/history', h(() => importHistory()));
app.get('/api/plan-conflicts', h(() => planConflicts()));
app.post('/api/plan-conflicts/:id', h(req => resolvePlanConflict(id(req), String(req.body.use || ''), worker(req) || 'Office')));
// Re-prioritise in two steps: see what each van gains and loses, then confirm.
app.get('/api/allocate/reprioritise/preview', h(() => inv.reprioritisePreview()));
app.post('/api/allocate/reprioritise', h(req => inv.reprioritiseAll({ by: worker(req) || 'Office' })));

// ── Clean-up report (what the start-up clean-up changed) ──
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
app.post('/api/items', h(req => {
  const v = itemValues(req.body);
  if (!v.sku || !v.name) throw inv.httpError(400, 'SKU and name are required');
  if (get('SELECT 1 FROM items WHERE sku = ?', v.sku)) throw inv.httpError(409, `SKU ${v.sku} already exists`);
  const keys = ITEM_FIELDS.filter(k => v[k] != null);
  const r = run(`INSERT INTO items(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => v[k]));
  const newId = Number(r.lastInsertRowid);
  if (Number(req.body.on_hand) > 0) tx(() => inv.receive(newId, Number(req.body.on_hand), { note: 'Opening stock' }));
  assignMissingTrades(); // no trade picked → best guess from the name
  return { id: newId };
}));
app.put('/api/items/:id', h(req => {
  const v = itemValues(req.body);
  const keys = ITEM_FIELDS.filter(k => v[k] !== undefined);
  if (v.sku && get('SELECT 1 FROM items WHERE sku = ? AND id <> ?', v.sku, id(req))) throw inv.httpError(409, `SKU ${v.sku} already exists`);
  const before = get('SELECT * FROM items WHERE id = ?', id(req));
  if (!before) throw inv.httpError(404, 'Item not found');
  tx(() => {
    if (keys.length) run(`UPDATE items SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => v[k]), id(req));
    // Catalogue changes that matter for ordering / counting go into the item's history.
    for (const k of ['kind', 'supplier', 'area_id', 'reorder_level', 'order_up_to', 'unit', 'unit_size']) {
      if (v[k] === undefined || String(v[k] ?? '') === String(before[k] ?? '')) continue;
      logAlloc('catalogue', { item_id: before.id, field: k === 'area_id' ? 'rack' : k.replace(/_/g, ' '), before: before[k] ?? '', after: v[k] ?? '', worker: worker(req) || 'Office' });
    }
  });
  if (v.supplier !== undefined) syncSuppliers();
  assignMissingTrades(); // "guess from the name" picked → best guess straight away
}));
app.post('/api/items/:id/adjust', h(req => inv.adjust(id(req), { mode: req.body.mode, qty: Number(req.body.qty), note: req.body.note, by: worker(req) })));
app.post('/api/items/:id/receive', h(req => inv.receiveDelivery(id(req), Number(req.body.qty),
  { ref: req.body.ref || '', note: req.body.note || '', vanId: Number(req.body.van_id) || null, by: worker(req) })));
app.post('/api/items/:id/photo', h(req => savePhoto(id(req), req.body)));
app.delete('/api/items/:id/photo', h(req => deletePhoto(id(req))));
// Download a picture from an internet link (or the main picture of a product page).
app.post('/api/web-image', h(async (req, res) => {
  const img = await fetchWebImage(req.body.url);
  res.setHeader('Content-Type', img.type);
  res.setHeader('Cache-Control', 'no-store');
  res.send(img.body);
}));
app.post('/api/stocktake', h(req => inv.stocktake(req.body.rows || [], req.body.note, worker(req))));

// ── Rules ──
app.get('/api/rules', h(() => all(`SELECT r.*, i.sku, i.name AS item_name FROM rules r JOIN items i ON i.id = r.item_id ORDER BY r.sort, r.id`)));
function checkRule(b) {
  parseConditions(b.conditions); // throws a readable error if malformed
  if (!b.item_id) throw inv.httpError(400, 'Pick the item this rule adds');
}
app.post('/api/rules', h(req => {
  try { checkRule(req.body); } catch (e) { throw inv.httpError(400, e.message); }
  const sort = (get('SELECT MAX(sort) AS s FROM rules').s || 0) + 10;
  const r = run('INSERT INTO rules(name, conditions, item_id, qty, spec_fields, active, sort) VALUES(?,?,?,?,?,?,?)',
    req.body.name || '', req.body.conditions, Number(req.body.item_id), String(req.body.qty || '1'), req.body.spec_fields || '', req.body.active === false ? 0 : 1, sort);
  return { id: Number(r.lastInsertRowid) };
}));
app.put('/api/rules/:id', h(req => {
  try { checkRule(req.body); } catch (e) { throw inv.httpError(400, e.message); }
  run('UPDATE rules SET name=?, conditions=?, item_id=?, qty=?, spec_fields=?, active=? WHERE id=?',
    req.body.name || '', req.body.conditions, Number(req.body.item_id), String(req.body.qty || '1'), req.body.spec_fields || '', req.body.active === false ? 0 : 1, id(req));
}));
app.delete('/api/rules/:id', h(req => run('DELETE FROM rules WHERE id = ?', id(req))));
// Try a rule against every active van and say which ones it would fire for.
app.post('/api/rules/test', h(req => {
  try { checkRule({ ...req.body, item_id: 1 }); } catch (e) { throw inv.httpError(400, e.message); }
  return inv.listVans({ status: 'active' }).map(v => {
    const fields = all('SELECT * FROM order_fields WHERE van_id = ? ORDER BY sort', v.id);
    const r = testRule(req.body, fields);
    return { chassis: v.chassis, fired: r.fired, matched: r.fired ? [...r.pos].map(f => `${f.label}: ${f.value}`) : [] };
  });
}));

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
app.post('/api/pos', h(req => ({ id: inv.createPO(req.body) })));
app.post('/api/pos/:id/receive', h(req => inv.receivePO(id(req), Array.isArray(req.body.lines) ? req.body.lines : [],
  { backorder: req.body.backorder || {}, closeBalance: Array.isArray(req.body.close_balance) ? req.body.close_balance : [], by: worker(req) })));
app.post('/api/pos/:id/merge', h(req => inv.mergePO(id(req), Number(req.body.into), worker(req) || 'Office')));
app.put('/api/pos/:id', h(req => {
  const b = req.body || {};
  if (b.status) inv.setPOStatus(id(req), b.status === 'closed' ? 'closed' : 'open', worker(req) || 'Office');
  const fields = ['po_no', 'supplier', 'ordered_at', 'expected', 'notes', 'checked'].filter(k => b[k] !== undefined);
  if (fields.length) return inv.updatePO(id(req), Object.fromEntries(fields.map(k => [k, b[k]])), worker(req) || 'Office');
}));
app.delete('/api/pos/:id', h(req => {
  if (get('SELECT COALESCE(SUM(received),0) AS r FROM po_lines WHERE po_id = ?', id(req)).r > 0) {
    throw inv.httpError(400, 'Stock was already received against this PO — close it instead');
  }
  run('DELETE FROM purchase_orders WHERE id = ?', id(req));
}));

// ── Settings / export ──
app.get('/api/settings', h(() => ({ ignore: inv.ignoreList(), dealer: getSetting('dealer', ''), demo: getSetting('demo') === '1', planImportedAt: getSetting('plan_imported_at', ''),
  importHistory: importHistory().slice(0, 10),
  lastBackup: getSetting('last_backup', ''), floorUrls: lanAddresses().map(ip => `http://${ip}:${listenPort}/floor`) })));
app.put('/api/settings', h(req => {
  if (Array.isArray(req.body.ignore)) setSetting('ignore', JSON.stringify(req.body.ignore.map(s => String(s).trim()).filter(Boolean)));
  if (req.body.dealer != null) setSetting('dealer', String(req.body.dealer));
}));
// Shelf stock counts go to zero (logged, like a stocktake). Per-van parts already received for a
// van stay with that van.
app.post('/api/settings/clear-stock', h(() => tx(() => {
  run(`DELETE FROM movements WHERE type = 'adjust' AND note = 'Demo stock level'`);
  for (const { id: itemId } of all(`SELECT id FROM items WHERE kind = 'stock' AND on_hand <> 0`)) {
    inv.adjust(itemId, { mode: 'set', qty: 0, note: 'Set to zero before stocktake', type: 'adjust' }); // not a count
  }
  setSetting('demo', '0');
})));
app.get('/api/export/plan.xlsx', async (req, res) => {
  try {
    const buf = await exportWorkbook();
    const d = new Date(); // local date, not UTC (UTC is yesterday until ~10am in Victoria)
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Production Plan ${stamp}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error(now(), req.method, req.originalUrl, e);
    res.status(500).send('Export failed');
  }
});

// Anything not matched above: plain JSON messages, never a technical error page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found — refresh the page' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big' });
  const status = err.status || err.statusCode;
  if (err.type === 'entity.parse.failed' || (status >= 400 && status < 500)) {
    return res.status(status || 400).json({ error: "The app couldn't read that request — refresh the page and try again" });
  }
  console.error(now(), req.method, req.originalUrl, err);
  res.status(500).json({ error: 'Something went wrong — try again' });
});

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses();
  const c = get('SELECT (SELECT COUNT(*) FROM vans) AS vans, (SELECT COUNT(*) FROM items) AS items');
  console.log(`${now()}  Factory Stock is running.`);
  // Shows at a glance if the app has opened the wrong (or a brand-new, empty) data folder.
  console.log(`  Data folder:         ${DATA_DIR} - ${c.vans} vans, ${c.items} items${c.vans ? '' : '  (NO VANS - is this the right data folder?)'}`);
  listenPort = server.address().port;
  console.log(`  On this PC:          http://localhost:${listenPort}`);
  lan.forEach(ip => console.log(`  Other PCs / tablets:  http://${ip}:${listenPort}`));
  lan.forEach(ip => console.log(`  Workers' phones:      http://${ip}:${listenPort}/floor`));
  const users = auth.userCount();
  console.log(users ? `  Logins:              ${users}` : `  Logins:              NONE YET - open http://localhost:${listenPort} on THIS PC to create the owner login`);
});
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Usually the app is already running (started automatically, or from another window).
  console.log(`${now()}  Factory Stock is already running on this PC - open http://localhost:${PORT}`);
  process.exit(0);
});
// Closing the window or Ctrl+C: close the database cleanly so everything is written into factory.db.
for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
  process.on(sig, () => {
    try { db.close(); } catch {}
    process.exit(0);
  });
}
