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
//
// The routes themselves are in src/routes/ (one file per area), added below in this order — Express tries
// them in the order they were added, so a fixed address ("/api/items/unassigned") is added before the
// same address with an id ("/api/items/:id").
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import { asBusy, countQueries, newQueryStats } from './db.js';
import { readPhoto } from './photos.js';
import { now } from './routes/common.js';
import { loginRoutes } from './routes/logins.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { vanRoutes } from './routes/vans.js';
import { floorRoutes } from './routes/floor.js';
import { planRoutes } from './routes/plan.js';
import { countRoutes } from './routes/counts.js';
import { itemRoutes } from './routes/items.js';
import { ruleRoutes } from './routes/rules.js';
import { purchasingRoutes } from './routes/purchasing.js';
import { settingsRoutes } from './routes/settings.js';

export { NOT_ONLINE } from './routes/common.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  // Server-Timing: "db;dur=12.3;desc=\"5 queries\"" — the database statements this request sent and the time spent
  // waiting for them (src/db.js countQueries; the session look-up and the route's own work, through h()). It shows
  // in the browser's Network tab, so the real cost of each screen can be seen on the live site. Numbers only:
  // never SQL, values or data. Set just before the headers go out (whatever sends them: json, a file, a
  // stream), and never once they are sent.
  app.use((req, res, next) => {
    const stats = req.dbStats = newQueryStats();
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!res.headersSent) res.setHeader('Server-Timing', `db;dur=${stats.ms.toFixed(1)};desc="${stats.queries} ${stats.queries === 1 ? 'query' : 'queries'}"`);
      return writeHead.apply(this, args);
    };
    next();
  });
  app.use((req, res, next) => {
    res.setHeader('x-fs-app', '1'); // (see the top)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  // Every /api answer is one person's data (or a refusal): never kept by the browser or anything between it and
  // here, unless a route says otherwise (it sets its own Cache-Control, which replaces this one).
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
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
        const s = await countQueries(req.dbStats, () => auth.sessionFromToken(token));
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

  // ── The routes (src/routes/), in this order ──
  const ctx = { cloud, throttle, clientIp, hostOf, secure };
  loginRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  vanRoutes(app, ctx);
  floorRoutes(app, ctx);
  planRoutes(app, ctx);
  countRoutes(app, ctx);
  itemRoutes(app, ctx);
  ruleRoutes(app, ctx);
  purchasingRoutes(app, ctx);
  settingsRoutes(app, ctx);

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
