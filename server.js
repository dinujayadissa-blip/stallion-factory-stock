// Factory Stock on this PC: opens the database, does the start-up jobs once, then serves the app
// (src/app.js) on PORT. The database is PGlite in DATA_DIR/pg (a brand-new folder gets its tables from
// supabase/migrations/), or the Postgres server in DATABASE_URL when that is set.
// The online version runs the same app from the Edge Function instead (createApp({ cloud: true })).
import http from 'node:http';
import os from 'node:os';
import { openDb, closeDb, migrate, writeTx, get, DATA_DIR } from './src/db.js';
import { createApp } from './src/app.js';
import * as layout from './src/layout.js';
import { assignMissingTrades } from './src/trades.js';
import * as auth from './src/auth.js';

// PORT=0 picks any free port; unset = 3000.
const PORT = process.env.PORT != null && String(process.env.PORT).trim() !== '' ? Number(process.env.PORT) : 3000;
auth.setCookiePort(PORT);
// Local date and time for the log ("2026-10-12 14:05:09"), so "it failed yesterday afternoon" can be found.
const now = () => new Date().toLocaleString('sv-SE');
// Last resort: write down what happened, then stop (the auto-start loop starts the app again).
process.on('uncaughtException', e => { console.error(now(), 'Factory Stock stopped because of an error:', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error(now(), 'Factory Stock stopped because of an error:', e); process.exit(1); });

// The port is taken first: a second copy (started by hand while the auto-started one runs) stops there,
// before it opens the database — PGlite's folder must only ever be open in one program at a time.
// Requests that arrive while the database is opening wait for it.
let app = null;
const waiting = [];
const server = http.createServer((req, res) => (app ? app(req, res) : waiting.push([req, res])));
server.listen(PORT, '0.0.0.0', async () => {
  await openDb();
  if (await migrate()) console.log(now(), 'A new, empty database: the tables were made (supabase/migrations).');
  // Start-up jobs, once (one write, one data_version bump):
  //   every part gets a trade (electrician, builder, …) if it has none;
  //   first run only: a starting factory floor layout;
  //   reminders for "as per drawing" lines on orders already loaded.
  // (The starter catalogue, plan import and the one-off clean-up are SQLite-only: they were done on the
  // original version before the move.)
  await writeTx(async () => {
    await assignMissingTrades();
    await layout.seedLayout();
    await layout.drawingRemindersAll();
  });
  const port = server.address().port;
  auth.setCookiePort(port); // (PORT=0: the port really in use)
  app = createApp({ cloud: false });
  for (const [req, res] of waiting.splice(0)) app(req, res);
  // Old sessions are cleared out once an hour (online the nightly job does it).
  setInterval(() => { auth.pruneSessions().catch(() => { /* next time */ }); }, 60 * 60 * 1000).unref();

  const lan = lanAddresses();
  const c = await get('SELECT (SELECT COUNT(*) FROM vans) AS vans, (SELECT COUNT(*) FROM items) AS items');
  const where = process.env.DATABASE_URL ? 'the database in DATABASE_URL' : `${DATA_DIR}`;
  console.log(`${now()}  Factory Stock is running.`);
  // Shows at a glance if the app has opened the wrong (or a brand-new, empty) data folder.
  console.log(`  Data:                ${where} - ${c.vans} vans, ${c.items} items${c.vans ? '' : '  (NO VANS - is this the right data folder?)'}`);
  console.log(`  On this PC:          http://localhost:${port}`);
  lan.forEach(ip => console.log(`  Other PCs / tablets:  http://${ip}:${port}`));
  lan.forEach(ip => console.log(`  Workers' phones:      http://${ip}:${port}/floor`));
  const users = await auth.userCount();
  console.log(users ? `  Logins:              ${users}` : `  Logins:              NONE YET - open http://localhost:${port} on THIS PC to create the owner login`);
});
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Usually the app is already running (started automatically, or from another window).
  console.log(`${now()}  Factory Stock is already running on this PC - open http://localhost:${PORT}`);
  process.exit(0);
});
// Closing the window or Ctrl+C: close the database cleanly so everything is written to disk.
for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await closeDb(); } catch { /* closing anyway */ }
    process.exit(0);
  });
}
