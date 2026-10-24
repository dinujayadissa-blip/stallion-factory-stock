// The Supabase Edge Function "api" (supabase/functions/api/index.ts) in plain JavaScript, so it is tested in
// Node like the rest: the online app, src/app.js with cloud: true, on the Supabase database.
//
// - The database is opened once per isolate (one running copy of the function), as soon as it starts and
//   before the first request is answered. If that fails (the project is paused), the request gets the plain
//   503 and the next request tries again.
// - Supabase hands the function its own path: /api/<the app's path> (the function is called "api"), so
//   /api/api/me is the app's /api/me and /api/photos/x.jpg is /photos/x.jpg.
// - Nothing local runs here: no PGlite, no pages or static files (Cloudflare Pages serves those), no timers
//   (the nightly job prunes old sessions), no start-up jobs, no migrations (scripts/deploy-api.ps1 pushes them).
import http from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';

const ASLEEP = 'The database is asleep or unreachable — try again in a minute';

// Supabase's path → the app's path. (Also copes with the full /functions/v1/api/… form, just in case.)
export function functionPath(url) {
  let u = String(url || '/').replace(/^\/functions\/v1(?=[/?]|$)/, '') || '/';
  if (/^\/api\/(api|photos)(?=[/?]|$)/.test(u)) u = u.slice('/api'.length);
  return u;
}

// A Node request handler: waits for the database, then hands the request to `app` on the app's own path.
export function edgeHandler({ open, app }) {
  const start = () => open().catch(e => { opening = null; throw e; });
  let opening = start(); // now, not on the first request
  opening.catch(() => {}); // (the failure is answered on the request that meets it)
  return async (req, res) => {
    try {
      await (opening ??= start());
    } catch (e) {
      console.error(new Date().toLocaleString('sv-SE'), 'The database could not be opened:', e?.cause?.message || e?.message || e);
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: ASLEEP }));
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
  const server = http.createServer(edgeHandler({ open, app: createApp({ cloud: true }) }));
  return server.listen(port);
}
