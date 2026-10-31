// The one place that talks to the database: Postgres (Supabase in the cloud, PGlite for tests and local
// runs — see src/pg.js). Every helper is async. SQL is written with `?` placeholders as before; they are
// turned into Postgres's $1, $2… here. The schema lives in supabase/migrations/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { makeDriver } from './pg.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch { /* read-only file system (the cloud): nothing is kept on disk there */ }

// ── Opening and closing ──
// `ready` is the driver being opened / open. Nothing opens by itself: a query before openDb() is an
// error, so a test or script can never wander onto the cloud database (or make a PGlite folder) by accident.
let ready = null;

function driver() {
  if (!ready) return Promise.reject(new Error('The database is not open — call openDb() first'));
  return ready;
}

// openDb({ url }) or openDb({ pgliteDir }) uses exactly that (a test's 'memory://' never falls through to
// DATABASE_URL). openDb() uses DATABASE_URL when it is set, otherwise PGlite on disk in DATA_DIR/pg.
// Any database already open is closed first.
export async function openDb({ url, pgliteDir } = {}) {
  await closeDb();
  const target = url ? { url } : pgliteDir ? { pgliteDir }
    : process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : { pgliteDir: path.join(DATA_DIR, 'pg') };
  const opening = ready = makeDriver(target);
  try { await opening; } catch (e) { if (ready === opening) ready = null; throw translate(e); }
}

export async function closeDb() {
  const opening = ready;
  ready = null;
  const d = opening && await opening.catch(() => null);
  if (d) await d.close();
}

// ── Running SQL ──
// `?` → $1, $2… in order, except inside '…' literals, "…" names, -- and /* */ comments and $$…$$ bodies
// (so an apostrophe in a comment, "the van's part", can't swallow the placeholders after it).
function placeholders(sql) {
  let out = '', n = 0, i = 0;
  while (i < sql.length) {
    const end = skipQuoted(sql, i);
    if (end > i) { out += sql.slice(i, end); i = end; continue; }
    out += sql[i] === '?' ? `$${++n}` : sql[i];
    i++;
  }
  return out;
}
// Where a quoted or commented stretch starting at i ends (just after it), or i when none starts there.
// '' inside a literal needs no special case: it reads as one literal ending and the next starting.
function skipQuoted(sql, i) {
  const until = (s, from) => { const j = sql.indexOf(s, from); return j < 0 ? sql.length : j + s.length; };
  const c = sql[i], two = sql.slice(i, i + 2);
  if (c === "'" || c === '"') return until(c, i + 1);
  if (two === '--') return until('\n', i);
  if (two === '/*') return until('*/', i + 2);
  const tag = c === '$' && /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64)); // $$ or $body$, never $1
  return tag ? until(tag[0], i + tag[0].length) : i;
}

// Can't reach the database at all (or the free Supabase project is paused): say so plainly, as a 503
// (the same shape as httpError() in inventory.js; not imported from there, so db.js stays free of cycles).
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED',
  '57P01', '57P02', '57P03']); // (and every SQLSTATE 08xxx, "connection exception")
// Supabase's pooler (Supavisor) answers "Tenant or user not found" while the project is paused. Network
// failures are also recognised by their text, for runtimes (Deno, in the Edge Function) whose errors may not
// carry Node's codes — but never on the server's own SQL errors (a statement timeout is not the database
// being away). A wrapped error is judged by its cause.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const NETWORK_TEXT = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CONNECT_TIMEOUT)\b|connection refused|timed out|getaddrinfo|failed to lookup address|dns error/i;
export function isUnreachable(e, depth = 0) {
  if (!e || depth > 2) return false;
  const code = String(e.code ?? ''), msg = String(e.message ?? '');
  if (CONNECTION_CODES.has(code) || /^08/.test(code) || /\bpaused\b/i.test(msg) || /tenant or user not found/i.test(msg)) return true;
  if (!SQLSTATE.test(code) && NETWORK_TEXT.test(msg)) return true;
  return isUnreachable(e.cause, depth + 1);
}
// Waited too long for the write lock (55P03, lock_timeout) or a statement ran past statement_timeout (57014,
// query_canceled): another change is holding things up. Nothing was kept (the transaction is rolled back);
// trying again in a moment works. Also used by app.js's h() for any such error that comes its way.
export const BUSY = 'Busy — try again in a moment';
const BUSY_CODES = new Set(['55P03', '57014']);
export const asBusy = e => (e && !e.status && BUSY_CODES.has(String(e.code ?? ''))
  ? Object.assign(new Error(BUSY), { status: 503, cause: e })
  : e);
const translate = e => (isUnreachable(e)
  ? Object.assign(new Error('The database is asleep or unreachable — try again in a minute'), { status: 503, cause: e })
  : asBusy(e));

// The connection of the transaction we're inside (set by tx()), so every query in it — however deep in
// the call chain — runs on that one connection. Outside a transaction: the driver itself.
const als = new AsyncLocalStorage();
// Are we inside tx() / writeTx() right now? (replaces the old `db.isTransaction`)
export const inTx = () => !!als.getStore();

// How many statements a request sent and how long it waited for them, for the Server-Timing header (app.js):
// the browser's Network tab shows it, online too. Only these two numbers are kept — never SQL, values or rows.
// countQueries(stats, fn) runs fn with every query under it (however deep) added to `stats`. Queries running at
// the same time each add their own wait, so ms can be more than the request's own time.
const counting = new AsyncLocalStorage();
export const newQueryStats = () => ({ queries: 0, ms: 0 });
export const countQueries = (stats, fn) => (stats ? counting.run(stats, fn) : fn());
async function timed(n, work) {
  const stats = counting.getStore();
  if (!stats) return work();
  const t0 = performance.now();
  try { return await work(); } finally { stats.queries += n; stats.ms += performance.now() - t0; }
}

async function query(sql, p) {
  try {
    const conn = als.getStore()?.conn ?? await driver();
    // No params: the SQL goes as it is (it may be several statements, e.g. a migration file).
    return await timed(1, () => conn.query(p.length ? placeholders(sql) : sql, p));
  } catch (e) { throw translate(e); }
}

// A whole list of ids as one value, so one statement covers every row instead of one statement per row:
//   all(`SELECT … WHERE l.van_id IN ${ID_LIST}`, ids(vanIds))
export const ID_LIST = '(SELECT value::int FROM json_array_elements_text(?::text::json))';
export const ids = list => JSON.stringify([...list].map(Number).filter(Number.isSafeInteger)); // (anything else matches no row)

export const all = async (sql, ...p) => (await query(sql, p)).rows;
export const get = async (sql, ...p) => (await query(sql, p)).rows[0];
export const run = async (sql, ...p) => ({ changes: (await query(sql, p)).count });
// INSERT … → the new row's id (replaces run(...).lastInsertRowid). Only for tables with an `id` column.
// RETURNING goes on a new line, so a trailing "-- comment" in the SQL can't swallow it.
export async function insert(sql, ...p) {
  const row = (await query(`${sql.trim().replace(/;$/, '')}
RETURNING id`, p)).rows[0];
  if (!row) throw new Error('insert(): no row came back (does the statement insert a row, e.g. not skipped by ON CONFLICT DO NOTHING?)');
  return row.id;
}

// ── Transactions ──
// All or nothing. Re-entrant: called inside another tx() it just joins that transaction, so several
// steps can be combined into one all-or-nothing change.
// Time limits, for this transaction only (SET LOCAL), before anything else in it (so before writeTx's lock):
// at most 15 s waiting for a lock (the write lock behind another change), 30 s for one statement, and
// 30 s idle in the middle (a request that stalled mid-change must not hold the write lock for everyone).
// Running past one is "Busy — try again in a moment" (asBusy above), and nothing is kept.
const LIMITS = `SET LOCAL lock_timeout = '15s'; SET LOCAL statement_timeout = '30s'; SET LOCAL idle_in_transaction_session_timeout = '30s'`;
export async function tx(fn) {
  if (als.getStore()) return fn();
  const d = await driver().catch(e => { throw translate(e); });
  // For Server-Timing: BEGIN (until fn may start) and COMMIT / ROLLBACK (after fn) count as a statement each.
  const stats = counting.getStore();
  let t = performance.now();
  const tally = () => { if (stats) { stats.queries += 1; stats.ms += performance.now() - t; } };
  try {
    return await d.begin(async conn => {
      tally();
      await timed(1, () => conn.query(LIMITS, []));
      try { return await als.run({ conn, write: false }, fn); } finally { t = performance.now(); }
    });
  } catch (e) { throw translate(e); } finally { tally(); }
}

// A transaction that changes data: one writer at a time across every server instance (advisory lock 42,
// held until commit), and settings.data_version goes up by one in the same commit, so other screens can
// tell their figures are out of date. Inside a writeTx it just joins (one lock, one bump); inside a plain
// tx() it takes the lock there and bumps the version once.
// { bump: false }: the lock and the transaction, but no new data_version — for writes no screen shows
// (wrong-password counters, last login, a new session), so a wrong password doesn't refresh every screen.
// A bumping writeTx that joins a non-bumping one still gets its bump (once, at the end).
const bumpVersion = async store => {
  await run(`UPDATE settings SET value = (value::int + 1)::text WHERE key = 'data_version'`);
  store.bumped = true;
};
export async function writeTx(fn, { bump = true } = {}) {
  const cur = als.getStore();
  if (cur?.write) {
    if (bump) cur.bump = true;
    const r = await fn();
    // (the writeTx that took the lock already finished: we are in a plain tx() after it)
    if (bump && cur.lockDone && !cur.bumped) await bumpVersion(cur);
    return r;
  }
  const body = async () => {
    await run('SELECT pg_advisory_xact_lock(42)');
    const store = als.getStore();
    store.write = true;
    if (bump) store.bump = true;
    const r = await fn();
    if (store.bump && !store.bumped) await bumpVersion(store);
    store.lockDone = true;
    return r;
  };
  return cur ? body() : tx(body);
}

// A brand-new database (a new local DATA_DIR/pg folder) has no tables: build them from
// supabase/migrations/*.sql, in name order — the same files the cloud database is made from. A database
// that already has them is left alone. (Only the local runner calls this; the cloud is migrated by hand.)
export async function migrate() {
  if ((await get(`SELECT to_regclass('public.settings') IS NOT NULL AS ok`)).ok) return false;
  const dir = path.join(root, 'supabase', 'migrations');
  await tx(async () => {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await run(fs.readFileSync(path.join(dir, f), 'utf8'));
  });
  return true;
}

export async function dataVersion() {
  return getSetting('data_version', '0');
}

// ── Settings ──
export async function getSetting(key, fallback = '') {
  return (await get('SELECT value FROM settings WHERE key = ?', key))?.value ?? fallback;
}
export async function setSetting(key, value) {
  await run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

// Every supplier named on an item or a PO gets a row (14 days, not confirmed). Safe to run any time.
export async function syncSuppliers() {
  await run(`INSERT INTO suppliers(name) SELECT DISTINCT trim(supplier) FROM items WHERE trim(supplier) <> '' ON CONFLICT DO NOTHING`);
  await run(`INSERT INTO suppliers(name) SELECT DISTINCT trim(supplier) FROM purchase_orders WHERE trim(supplier) <> '' ON CONFLICT DO NOTHING`);
}

// One line in the allocation log. `before`/`after` are stored as text (numbers or short labels).
// `change` / `firm_change`: how much `reserved` / `reserved_firm` moved (worked out from before/after
// when the field is a set-aside field and both are numbers; pass them to say it exactly).
const SET_ASIDE_FIELD = /^reserved|^locked$|^set aside/;
function allocRow(reason, { van_id = null, item_id = null, line_id = null, field = '', before = '', after = '', worker = '', note = '',
  change, firm_change } = {}) {
  const b = Number(before), a = Number(after);
  const numeric = String(before ?? '') !== '' && String(after ?? '') !== '' && Number.isFinite(b) && Number.isFinite(a);
  if (change === undefined && numeric && SET_ASIDE_FIELD.test(field) && !/firm/.test(field) && field !== 'locked') change = a - b;
  if (firm_change === undefined && numeric && (field === 'reserved_firm' || field === 'locked')) firm_change = a - b;
  return { reason, van_id, item_id, line_id, field, before: String(before ?? ''), after: String(after ?? ''), worker: worker || '', note: note || '',
    change: change ?? null, firm_change: firm_change ?? null };
}
export async function logAlloc(reason, entry = {}) {
  await logAllocMany([[reason, entry]]);
}
// Many lines in the allocation log in one statement, in this order: [[reason, { van_id, … }], …].
export async function logAllocMany(entries) {
  if (!entries.length) return;
  await run(`INSERT INTO allocation_log(reason, van_id, item_id, line_id, field, before, after, worker, note, change, firm_change)
             SELECT x->>'reason', (x->>'van_id')::integer, (x->>'item_id')::integer, (x->>'line_id')::integer, x->>'field', x->>'before',
               x->>'after', x->>'worker', x->>'note', (x->>'change')::double precision, (x->>'firm_change')::double precision
             FROM json_array_elements(?::text::json) WITH ORDINALITY AS g(x, n) ORDER BY n`, JSON.stringify(entries.map(([reason, e]) => allocRow(reason, e))));
}
