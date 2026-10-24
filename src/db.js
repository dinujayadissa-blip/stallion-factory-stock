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
const unreachable = e => CONNECTION_CODES.has(e?.code) || /^08/.test(String(e?.code ?? '')) || /\bpaused\b/i.test(String(e?.message ?? ''));
const translate = e => (unreachable(e)
  ? Object.assign(new Error('The database is asleep or unreachable — try again in a minute'), { status: 503, cause: e })
  : e);

// The connection of the transaction we're inside (set by tx()), so every query in it — however deep in
// the call chain — runs on that one connection. Outside a transaction: the driver itself.
const als = new AsyncLocalStorage();
// Are we inside tx() / writeTx() right now? (replaces the old `db.isTransaction`)
export const inTx = () => !!als.getStore();

async function query(sql, p) {
  try {
    const conn = als.getStore()?.conn ?? await driver();
    // No params: the SQL goes as it is (it may be several statements, e.g. a migration file).
    return await conn.query(p.length ? placeholders(sql) : sql, p);
  } catch (e) { throw translate(e); }
}

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
export async function tx(fn) {
  if (als.getStore()) return fn();
  const d = await driver().catch(e => { throw translate(e); });
  try {
    return await d.begin(conn => als.run({ conn, write: false }, fn));
  } catch (e) { throw translate(e); }
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
export async function logAlloc(reason, { van_id = null, item_id = null, line_id = null, field = '', before = '', after = '', worker = '', note = '',
  change, firm_change } = {}) {
  const b = Number(before), a = Number(after);
  const numeric = String(before ?? '') !== '' && String(after ?? '') !== '' && Number.isFinite(b) && Number.isFinite(a);
  if (change === undefined && numeric && SET_ASIDE_FIELD.test(field) && !/firm/.test(field) && field !== 'locked') change = a - b;
  if (firm_change === undefined && numeric && (field === 'reserved_firm' || field === 'locked')) firm_change = a - b;
  await run(`INSERT INTO allocation_log(reason, van_id, item_id, line_id, field, before, after, worker, note, change, firm_change)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`, reason, van_id, item_id, line_id, field, String(before ?? ''), String(after ?? ''), worker || '', note || '',
    change ?? null, firm_change ?? null);
}
