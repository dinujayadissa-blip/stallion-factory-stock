// What every route group uses: h() (errors as JSON, a change as one writeTx stamped with the login), the
// small request helpers (id, num, worker) and the "not in this version" answers.
import { asBusy, countQueries, get, getSetting, run, writeTx } from '../db.js';
import * as inv from '../inventory.js';

// Local date and time for the log ("2026-10-12 14:05:09"), so "it failed yesterday afternoon" can be found.
export const now = () => new Date().toLocaleString('sv-SE');
// What the online version doesn't do (the same answer for every such route).
export const NOT_ONLINE = 'Not available in the online version';
// Importing the production plan (and "start again from the spreadsheet") is done on the original version
// of the app (the SQLite one, before the move): src/importPlan.js was never moved onto Postgres.
export const PLAN_IMPORT_GONE = 'Not available in this version — the production plan is imported on the original version of the app (before the move)';
// Every stock movement a change makes is stamped with the login's id (issue #2: "undo only your own", floor
// stats). This runs inside the change's writeTx, which holds the global write lock: no other change can make
// movements meanwhile, on this server or any other, so the movements numbered above the highest one before
// it are exactly its own.
export async function stamped(req, fn) {
  if (!req.user) return fn();
  const hi = (await get('SELECT COALESCE(MAX(id), 0) AS n FROM movements')).n;
  const out = await fn();
  await run('UPDATE movements SET user_id = ? WHERE id > ? AND user_id IS NULL', req.user.id, hi);
  return out;
}
// Wrap handlers so thrown errors become JSON responses, and changes run as one writeTx (see the top of src/app.js).
// { write: false }: the handler runs as it is, outside any transaction. Only for changes that manage their
// own writeTx and must not hold the write lock around slow work that isn't the database (password hashing,
// a PDF, a download, a picture upload), for the log in / log out (no new data_version: a wrong password must
// not refresh every screen — Ruling R12), and for requests that change nothing (previews).
export const READS = new Set(['GET', 'HEAD']);
export function h(fn, { write = true } = {}) {
  return async (req, res) => {
    try {
      const out = await countQueries(req.dbStats, () => (write && !READS.has(req.method)
        ? writeTx(() => stamped(req, () => fn(req, res)))
        : fn(req, res)));
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
export const OWN_TX = { write: false }; // (see h())
// An id from the address: a whole number, or "Not found" before any query (Postgres refuses text as an id).
export const id = req => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n < 0 || String(req.params.id).trim() === '') throw inv.httpError(404, 'Not found');
  return n;
};
export const num = v => (v === '' || v == null ? undefined : Number(v));
// Who did it: always the name of the login (never `by` from the page — still accepted from older pages, but ignored).
export const worker = req => req.user?.name || '';
export const gone = message => () => { throw inv.httpError(410, message); };
export const json = async (key, fallback) => {
  const raw = await getSetting(key, ''); // (a database error is passed on, not taken for "no setting")
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};
export const importHistory = async () => { const h0 = await json('plan_import_history', []); return Array.isArray(h0) ? h0 : []; };
