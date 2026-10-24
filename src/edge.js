// The Supabase Edge Function "api" (supabase/functions/api/index.ts) in plain JavaScript, so it is tested in
// Node like the rest: the online app, src/app.js with cloud: true, on the Supabase database.
//
// - The database is opened once per isolate (one running copy of the function), as soon as it starts and
//   before the first request is answered. If that fails (the project is paused), the request gets the plain
//   503 and the next request tries again.
// - Once the database is open, a self-check (sameTransactionCheck below): if it fails, every request is refused.
// - Supabase hands the function its own path: /api/<the app's path> (the function is called "api"), so
//   /api/api/me is the app's /api/me and /api/photos/x.jpg is /photos/x.jpg.
// - Nothing local runs here: no PGlite, no pages or static files (Cloudflare Pages serves those), no timers
//   (the nightly job prunes old sessions), no start-up jobs, no migrations (scripts/deploy-api.ps1 pushes them).
import http from 'node:http';
import { openDb, tx, get } from './db.js';
import { createApp } from './app.js';

const ASLEEP = 'The database is asleep or unreachable — try again in a minute';
export const SETUP_PROBLEM = 'Server setup problem — tell Claude';
const now = () => new Date().toLocaleString('sv-SE');

// One writer at a time rests on this: every statement of a transaction runs on the one database connection
// (the advisory lock and the changes it guards are in the same transaction). With DATABASE_URL on Supabase's
// transaction pooler (port 6543) that holds; a different pooler or mode could hand the statements to different
// connections, and the lock would then guard nothing. So: two statements in one tx() must see the same
// txid_current(). `db` is { tx, get } (src/db.js; a fake in the tests).
export async function sameTransactionCheck(db = { tx, get }) {
  return db.tx(async () => {
    const a = (await db.get('SELECT txid_current() AS t')).t;
    const b = (await db.get('SELECT txid_current() AS t')).t;
    return a != null && String(a) === String(b);
  });
}
const SELF_CHECK_FAILED = 'SELF-CHECK FAILED: two statements of one transaction got different txid_current() values, so a '
  + 'transaction is not kept on one database connection (is DATABASE_URL the Supabase transaction pooler, port 6543?). '
  + 'Every request is refused (503) until this is fixed: the write lock would not protect anything.';
const answer = (res, msg) => {
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'x-fs-app': '1' });
  res.end(JSON.stringify({ error: msg }));
};

// Supabase's path → the app's path. (Also copes with the full /functions/v1/api/… form, just in case.)
export function functionPath(url) {
  let u = String(url || '/').replace(/^\/functions\/v1(?=[/?]|$)/, '') || '/';
  if (/^\/api\/(api|photos)(?=[/?]|$)/.test(u)) u = u.slice('/api'.length);
  return u;
}

// A Node request handler: waits for the database (and the self-check), then hands the request to `app` on the
// app's own path. `check` resolves true when all is well (sameTransactionCheck); a failed check is for good.
export function edgeHandler({ open, app, check = async () => true }) {
  let broken = false;
  const start = () => open()
    .then(async () => {
      if (await check()) return;
      broken = true;
      console.error(now(), SELF_CHECK_FAILED);
    })
    .catch(e => { opening = null; throw e; }); // (could not open, or the check could not run: try again next time)
  let opening = start(); // now, not on the first request
  opening.catch(() => {}); // (the failure is answered on the request that meets it)
  return async (req, res) => {
    try {
      await (opening ??= start());
    } catch (e) {
      console.error(now(), 'The database could not be opened:', e?.cause?.message || e?.message || e);
      answer(res, ASLEEP);
      return;
    }
    if (broken) {
      console.error(now(), SELF_CHECK_FAILED, '-', req.method, String(req.url || '').split('?')[0]);
      answer(res, SETUP_PROBLEM);
      return;
    }
    req.url = functionPath(req.url);
    app(req, res);
  };
}

// The function itself: listens on 8000, as Supabase runs Node-style servers.
export function startEdge({ databaseUrl, port = 8000 } = {}) {
  // (never openDb() without a url: that would fall back to a PGlite folder)
  const open = databaseUrl
    ? () => openDb({ url: databaseUrl })
    : async () => { throw new Error('DATABASE_URL is not set for the function (npx supabase secrets set …)'); };
  const server = http.createServer(edgeHandler({ open, check: () => sameTransactionCheck(), app: createApp({ cloud: true }) }));
  return server.listen(port);
}
