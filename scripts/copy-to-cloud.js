// Copy the SQLite factory.db into Postgres (the cloud database, or a local PGlite folder), keeping every
// id, then check the copy against the original.
//
//   node scripts/copy-to-cloud.js --from <factory.db> --to <postgres://… | PGlite folder>
//                                 [--photos <photos folder>] [--photos-to <folder>] [--wipe] [--no-prepare]
//
// - First, unless --no-prepare: the temporary copy is started once with the whole sqlite-final app's
//   start-up (stock clean-up, catalogue updates, trades, layout, reminders — see prepareCopy below),
//   as the old server would on its next start, so the cloud gets the data in its finished shape.
// - The source file is never changed: it is copied (VACUUM INTO) to a temporary folder, and the SQLite
//   code as it was before the cloud move (scripts/sqlite-final/db.js, the `sqlite-final` tag's
//   src/db.js, byte for byte) is run on that copy, so a database that missed some start-up migrations
//   gets every table and column the Postgres schema has.
// - The target must be empty (only settings.data_version) unless --wipe, which empties every table
//   first. Everything — wipe, load, id counters, checks — is one transaction: if anything fails, or a
//   check doesn't match, nothing is kept.
// - A PGlite folder with no tables gets supabase/migrations/*.sql first. A Postgres server must already
//   have them (`npx supabase db push`).
// - --photos: every file in that folder goes to Supabase Storage (bucket item-photos, same names) when
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set — the bucket is made private first if it is missing,
//   and a public one stops the copy before anything is sent (scripts/lib/bucket.mjs); otherwise it is copied to --photos-to, or to the
//   `photos` folder next to the PGlite folder (DATA_DIR/pg → DATA_DIR/photos).
// - Only table names, counts and check results are printed — never row contents (customer names).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeDriver } from '../src/pg.js';
import { ensurePrivateBucket } from './lib/bucket.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_FINAL_TAG = 'sqlite-final';
const SQLITE_FINAL_DB_JS = path.join(HERE, 'sqlite-final', 'db.js');
const MIGRATIONS = path.join(HERE, '..', 'supabase', 'migrations');
const BATCH = 500;
const q = name => `"${String(name).replace(/"/g, '""')}"`;
const isUrl = to => /^postgres(ql)?:\/\//i.test(String(to));

// ── The source: a brought-up-to-date temporary copy ──
// Anything a child process says on failure goes through this first: it could quote a value.
const redact = s => String(s ?? '').trim().split('\n')[0].replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'").slice(0, 300);

// "Prepare": start the old app's start-up once on the temp copy, exactly as server.js at the
// sqlite-final tag does before it listens — so a live database that never ran those steps (the stock
// clean-up, new catalogue items, trades, the floor layout, drawing reminders) gets them before it moves.
// The old src/ (and package.json, for "type": "module") come out of the tag with `git show`; they are
// put under node_modules/.cache so Node finds this checkout's node_modules for them (express, exceljs,
// pdfjs-dist, xlsx, three — the same versions the tag's package-lock has). The runner below imports the
// same modules server.js imports, in the same order, then calls server.js's start-up lines 22–29:
//   seed(); syncCatalog(); assignMissingTrades(); layout.seedLayout(); layout.drawingRemindersAll();
//   runTidy(); and assignMissingTrades() again when the clean-up ran.
// It only reports counts and the clean-up steps' fixed labels.
const RUNNER = `import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const file = path.join(process.env.DATA_DIR, 'factory.db');
const counts = d => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  .map(r => [r.name, d.prepare('SELECT COUNT(*) AS n FROM "' + r.name.replace(/"/g, '""') + '"').get().n]));
const pre = new DatabaseSync(file, { readOnly: true });
const before = counts(pre);
pre.close();
const dbm = await import('./src/db.js');
await import('./src/photos.js');
await import('./src/webImage.js');
const layout = await import('./src/layout.js');
const { seed, syncCatalog } = await import('./src/seed.js');
await import('./src/importPlan.js');
await import('./src/golive.js');
await import('./src/parseOrder.js');
await import('./src/rules.js');
await import('./src/inventory.js');
await import('./src/exportXlsx.js');
const { assignMissingTrades } = await import('./src/trades.js');
const { runTidy, tidyStatus, STEPS } = await import('./src/tidy.js');
await import('./src/relink.js');
await import('./src/auth.js');
seed();
syncCatalog();
assignMissingTrades();
layout.seedLayout();
layout.drawingRemindersAll();
const tidyResult = runTidy({ log: () => {} });
if (tidyResult.ran?.length) assignMissingTrades();
const status = tidyStatus();
const stopped = STEPS.find(s => !dbm.getSetting('tidy_' + s.key + '_v1'));
const label = Object.fromEntries(STEPS.map(s => [s.key, s.label]));
const after = counts(dbm.db);
dbm.db.exec('PRAGMA journal_mode = DELETE');
dbm.db.close();
console.log('@@PREPARE ' + JSON.stringify({ before, after, steps: status.steps, done: status.done,
  stopped: stopped ? stopped.label : null, backupFailed: !!tidyResult.error,
  ran: (tidyResult.ran || []).map(r => ({ label: label[r.key], changed: Number(r.changed) })) }));
process.exit(0);
`;

function prepareCopy(dataDir) {
  const repo = path.join(HERE, '..');
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...opts });
  let files;
  try {
    files = git(['ls-tree', '-r', '--name-only', SQLITE_FINAL_TAG, '--', 'src', 'package.json'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { files = []; }
  if (!files.includes('package.json') || !files.includes('src/tidy.js')) {
    throw new Error(`Preparing the copy needs the git tag ${SQLITE_FINAL_TAG} in this checkout (or --no-prepare, for a copy that has already been started once with the sqlite-final app)`);
  }
  fs.mkdirSync(path.join(repo, 'node_modules', '.cache'), { recursive: true });
  const code = fs.mkdtempSync(path.join(repo, 'node_modules', '.cache', 'fs-sqlite-final-'));
  try {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(code, f)), { recursive: true });
      fs.writeFileSync(path.join(code, f), git(['show', `${SQLITE_FINAL_TAG}:${f}`]));
    }
    fs.writeFileSync(path.join(code, 'prepare-runner.mjs'), RUNNER);
    let out;
    try {
      out = execFileSync(process.execPath, [path.join(code, 'prepare-runner.mjs')], {
        cwd: code, env: { ...process.env, DATA_DIR: dataDir, PORT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20,
      });
    } catch (e) {
      throw new Error(`Preparing the copy (the sqlite-final start-up) failed: ${redact(String(e.stderr || '').split('\n').find(l => /Error/.test(l)) || e.message)}`);
    }
    const line = out.split('\n').find(l => l.startsWith('@@PREPARE '));
    if (!line) throw new Error('Preparing the copy (the sqlite-final start-up) ended without reporting back');
    const r = JSON.parse(line.slice('@@PREPARE '.length));
    if (r.backupFailed) throw new Error('Preparing the copy failed: the stock clean-up could not make its backup, so it did not run');
    if (r.stopped || r.done < r.steps) throw new Error(`Preparing the copy failed: the stock clean-up stopped at "${r.stopped}" (${r.done} of ${r.steps} steps done)`);
    const names = [...new Set([...Object.keys(r.before), ...Object.keys(r.after)])].sort();
    return {
      tidy: r.ran.map(x => ({ label: x.label, changed: Number.isFinite(x.changed) ? x.changed : null })),
      tidySteps: r.steps,
      rows: names.map(name => ({ name, before: r.before[name] ?? 0, after: r.after[name] ?? 0 })),
    };
  } finally {
    fs.rmSync(code, { recursive: true, force: true, maxRetries: 5 });
  }
}

function upgradedCopy(from, { prepare = true } = {}) {
  if (!fs.existsSync(from)) throw new Error(`No database at --from ${from}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-copy-'));
  const file = path.join(dir, 'factory.db');
  try {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${file.replace(/\\/g, '/').replace(/'/g, "''")}'`); } finally { src.close(); }
    const prepared = prepare ? prepareCopy(dir) : null;
    // The old db.js opens DATA_DIR/factory.db and runs its CREATE TABLE IF NOT EXISTS / addColumn steps
    // (after a prepare that has already happened, so this changes nothing then). A child process, so the
    // file is closed (and the temp folder removable) when it ends.
    fs.copyFileSync(SQLITE_FINAL_DB_JS, path.join(dir, 'sqlite-final-db.mjs'));
    fs.writeFileSync(path.join(dir, 'upgrade.mjs'),
      `const m = await import('./sqlite-final-db.mjs');\nm.db.exec('PRAGMA journal_mode = DELETE');\nm.db.close();\n`);
    try {
      execFileSync(process.execPath, [path.join(dir, 'upgrade.mjs')], { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`Bringing the copy up to date failed: ${redact(e.stderr || e.message)}`);
    }
    return { dir, file, prepared };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    throw e;
  }
}

function readSource(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(r => r.name);
  const cols = Object.fromEntries(tables.map(t => [t, db.prepare(`PRAGMA table_info(${q(t)})`).all().map(c => c.name)]));
  const hasSeq = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'`).get();
  const seq = Object.fromEntries(hasSeq ? db.prepare('SELECT name, seq FROM sqlite_sequence').all().map(r => [r.name, r.seq]) : []);
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) {
    const per = {};
    for (const b of broken) per[b.table] = (per[b.table] || 0) + 1;
    db.close();
    throw new Error(`The source has rows pointing at rows that don't exist (fix those first): ${Object.entries(per).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  }
  return { db, tables, cols, seq };
}

// ── The target ──
async function targetInfo(c) {
  const cols = {}, identity = {};
  for (const r of (await c.query(`SELECT c.table_name AS t, c.column_name AS col, c.is_identity AS ident
      FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position`)).rows) {
    (cols[r.t] ||= []).push(r.col);
    if (r.ident === 'YES') (identity[r.t] ||= []).push(r.col);
  }
  const pk = Object.fromEntries((await c.query(`SELECT tc.table_name AS t, k.column_name AS col
      FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k
        ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'`)).rows.map(r => [r.t, r.col]));
  const deps = {};
  for (const r of (await c.query(`SELECT a.relname AS t, b.relname AS r FROM pg_constraint k
      JOIN pg_class a ON a.oid = k.conrelid JOIN pg_class b ON b.oid = k.confrelid
      WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace`)).rows) (deps[r.t] ||= []).push(r.r);
  // Parents before children, so every foreign key is satisfied as rows go in.
  const order = [], seen = new Set();
  const visit = t => { if (seen.has(t)) return; seen.add(t); for (const r of deps[t] || []) if (r !== t) visit(r); order.push(t); };
  Object.keys(cols).sort().forEach(visit);
  return { cols, identity, pk, order };
}

const countSql = t => `SELECT COUNT(*) AS n FROM public.${q(t)}${t === 'settings' ? ` WHERE key <> 'data_version'` : ''}`;

async function nonEmpty(c, tables) {
  const full = [];
  for (const t of tables) {
    const n = (await c.query(countSql(t))).rows[0].n;
    if (n) full.push(`${t} ${n}`);
  }
  return full;
}
const refuse = full => new Error(`The target is not empty (${full.join(', ')}). Run again with --wipe to replace everything in it.`);

// A Postgres error can quote the row's values (a customer name in a unique-key message…): keep the
// table and the kind of error, drop anything in quotes.
function loadError(table, e) {
  const msg = String(e?.message ?? e).replace(/"[^"]*"/g, '"…"').replace(/\(.*?\)=\(.*?\)/g, '(…)=(…)');
  return Object.assign(new Error(`Loading ${table} failed: ${msg}${e?.code ? ` [${e.code}]` : ''}`), { code: e?.code });
}

// A source value as Postgres will hold it (and as it reads back).
function plain(v, table) {
  if (v === null || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${table} holds a number Postgres can't store (infinity / NaN)`);
    return v;
  }
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`${table} holds binary data, which the cloud schema has no place for`);
}

const close = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const total = m => Math.round([...m.values()].reduce((s, x) => s + (Number(x) || 0), 0) * 1e6) / 1e6;
// key → value maps from both sides, equal when the keys match and every value matches.
function compareMaps(name, a, b) {
  const ok = a.size === b.size && [...a].every(([k, v]) => b.has(k) && close(v, b.get(k)));
  return { name, from: total(a), to: total(b), ok };
}
const srcMap = (db, sql) => new Map(db.prepare(sql).all().map(r => [String(r.k), r.v]));
const tgtMap = async (c, sql) => new Map((await c.query(sql)).rows.map(r => [String(r.k), r.v]));

// ── Photos ──
// Only JPEGs: the app saves nothing else (savePhoto refuses other files), so anything else is left out.
const isJpeg = name => /\.jpe?g$/i.test(name);
async function copyPhotos(dir, { to, photosTo }) {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`No photos folder at --photos ${dir}`);
  const all = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort();
  const names = all.filter(isJpeg), skipped = all.filter(n => !isJpeg(n));
  let done = 0;
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!photosTo && base) {
    if (!key) throw new Error('SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not');
    await ensurePrivateBucket({ base, key });
    const queue = [...names];
    const worker = async () => {
      for (let name; (name = queue.shift()) !== undefined;) {
        const res = await fetch(`${base.replace(/\/+$/, '')}/storage/v1/object/item-photos/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
          body: fs.readFileSync(path.join(dir, name)),
        });
        if (!res.ok) throw new Error(`Uploading photo ${name} failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        done++;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  } else {
    const dest = photosTo || (!isUrl(to) && path.join(path.dirname(path.resolve(to)), 'photos'));
    if (!dest) throw new Error('For --photos with a Postgres target, set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or give --photos-to)');
    fs.mkdirSync(dest, { recursive: true });
    for (const name of names) { fs.copyFileSync(path.join(dir, name), path.join(dest, name)); done++; }
  }
  return { check: { name: 'photos', from: names.length, to: done, ok: done === names.length }, skipped, names: new Set(names) };
}

class ChecksFailed extends Error {
  constructor(report) { super('checks failed'); this.report = report; }
}

// ── The copy ──
export async function copyAll({ from, to, photosDir, photosTo, wipe = false, prepare = true } = {}) {
  if (!from || !to) throw new Error('copyAll needs from and to');
  const tmp = upgradedCopy(path.resolve(from), { prepare });
  let src, drv;
  try {
    src = readSource(tmp.file);
    if (!isUrl(to)) fs.mkdirSync(path.resolve(to), { recursive: true }); // (PGlite won't make the parent folders)
    drv = await makeDriver(isUrl(to) ? { url: to } : { pgliteDir: path.resolve(to) });
    const hasSchema = (await drv.query(`SELECT to_regclass('public.vans') IS NOT NULL AS ok`)).rows[0].ok;
    if (!hasSchema && isUrl(to)) throw new Error('The target database has no tables yet — run `npx supabase db push` first');
    if (hasSchema && !wipe) {
      const full = await nonEmpty(drv, Object.keys((await targetInfo(drv)).cols));
      if (full.length) throw refuse(full);
    }
    const photos = photosDir ? await copyPhotos(photosDir, { to, photosTo }) : null;

    try {
      return await drv.begin(async c => {
        if (!hasSchema) {
          for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
        }
        await c.query('SELECT pg_advisory_xact_lock(42)'); // the app's writer lock: no screen writes mid-copy
        const info = await targetInfo(c);
        for (const t of src.tables) {
          if (!info.cols[t]) throw new Error(`The source table ${t} has no place in the target schema`);
          const a = [...src.cols[t]].sort().join(','), b = [...info.cols[t]].sort().join(',');
          if (a !== b) throw new Error(`Table ${t} has different columns: source (${a}) vs target (${b})`);
        }
        const version = Number((await c.query(`SELECT value FROM settings WHERE key = 'data_version'`)).rows[0]?.value) || 0;
        if (wipe) await c.query(`TRUNCATE ${info.order.map(t => `public.${q(t)}`).join(', ')} RESTART IDENTITY CASCADE`);
        else {
          const full = await nonEmpty(c, info.order);
          if (full.length) throw refuse(full);
        }

        const tables = [], checks = [];
        let rowsFrom = 0, rowsSame = 0;
        const differ = [];
        for (const t of info.order) {
          if (!src.tables.includes(t)) { // new in the cloud (login_throttle, request_receipts): stays empty
            const n = (await c.query(countSql(t))).rows[0].n;
            tables.push({ name: t, from: 0, to: n });
            continue;
          }
          const cols = src.cols[t];
          const rows = src.db.prepare(`SELECT * FROM ${q(t)}`).all()
            .filter(r => !(t === 'settings' && r.key === 'data_version'))
            .map(r => Object.fromEntries(cols.map(k => [k, plain(r[k], t)])));
          const list = cols.map(q).join(', ');
          const sql = `INSERT INTO public.${q(t)} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::public.${q(t)}, $1::jsonb)`
            + (t === 'settings' ? ' ON CONFLICT (key) DO UPDATE SET value = excluded.value' : '');
          try {
            for (let i = 0; i < rows.length; i += BATCH) await c.query(sql, [JSON.stringify(rows.slice(i, i + BATCH))]);
          } catch (e) { throw loadError(t, e); }

          // Every value back out, matched on the primary key (not on sort order: the two collations differ).
          const key = info.pk[t];
          const back = new Map((await c.query(`SELECT * FROM public.${q(t)}`)).rows
            .filter(r => !(t === 'settings' && r.key === 'data_version')).map(r => [String(r[key]), r]));
          let same = 0;
          for (const r of rows) {
            const b = back.get(String(r[key]));
            if (b && cols.every(k => r[k] === (b[k] ?? null))) same++;
          }
          rowsFrom += rows.length; rowsSame += same;
          if (same !== rows.length || back.size !== rows.length) differ.push(t);
          tables.push({ name: t, from: rows.length, to: back.size });
        }
        for (const x of tables) checks.push({ name: `rows ${x.name}`, from: x.from, to: x.to, ok: x.from === x.to });
        checks.push({ name: 'every value identical', from: rowsFrom, to: rowsSame, ok: !differ.length && rowsFrom === rowsSame, ...(differ.length ? { detail: differ } : {}) });

        // The figures people work from, per item / van / PO line.
        const pairs = [
          ['on_hand per item', 'SELECT id AS k, on_hand AS v FROM items'],
          ['reserved per van', 'SELECT van_id AS k, SUM(reserved) AS v FROM van_lines GROUP BY van_id'],
          ['reserved_firm per van', 'SELECT van_id AS k, SUM(reserved_firm) AS v FROM van_lines GROUP BY van_id'],
          ['open qty per PO line', 'SELECT id AS k, qty - received - closed AS v FROM po_lines'],
        ];
        for (const [name, sql] of pairs) checks.push(compareMaps(name, srcMap(src.db, sql), await tgtMap(c, sql)));
        const usersFrom = srcMap(src.db, 'SELECT id AS k, pass_hash AS v FROM users');
        const usersTo = await tgtMap(c, 'SELECT id AS k, pass_hash AS v FROM users');
        checks.push({ name: 'users', from: usersFrom.size, to: usersTo.size, ok: usersFrom.size === usersTo.size });
        const sameHash = [...usersFrom].filter(([k, v]) => usersTo.get(k) === v).length;
        checks.push({ name: 'users pass_hash', from: usersFrom.size, to: sameHash, ok: sameHash === usersFrom.size && usersTo.size === usersFrom.size });

        // Id counters restart above every id copied — and above any number SQLite already gave out
        // (sqlite_sequence: a deleted, undone movement) or a count noted (count_sessions.last_move_id),
        // so a phone's Undo can never hit a different movement.
        const lastMove = (await c.query('SELECT COALESCE(MAX(last_move_id), 0) AS n FROM count_sessions')).rows[0].n;
        let counters = 0, countersOk = 0;
        for (const t of info.order) {
          for (const col of info.identity[t] || []) {
            const max = (await c.query(`SELECT COALESCE(MAX(${q(col)}), 0) AS n FROM public.${q(t)}`)).rows[0].n;
            const next = Math.max(max, src.seq[t] ?? 0, t === 'movements' ? lastMove : 0) + 1;
            await c.query(`ALTER TABLE public.${q(t)} ALTER COLUMN ${q(col)} RESTART WITH ${Math.trunc(next)}`);
            const seqName = (await c.query(`SELECT pg_get_serial_sequence($1, $2) AS s`, [`public.${q(t)}`, col])).rows[0].s;
            const s = (await c.query(`SELECT last_value, is_called FROM ${seqName}`)).rows[0];
            const actual = Number(s.last_value) + (s.is_called ? 1 : 0);
            counters++;
            if (actual >= next) countersOk++;
            if (t === 'movements' && col === 'id') checks.push({ name: 'next movement id', from: next, to: actual, ok: actual >= next });
          }
        }
        checks.push({ name: 'id counters above copied ids', from: counters, to: countersOk, ok: counters === countersOk });

        // The load is one write: screens that are open see the data version move on.
        await c.query(`INSERT INTO settings(key, value) VALUES('data_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [String(version + 1)]);

        if (photos) {
          checks.push(photos.check);
          // every photo a part points at is in the folder: the picture and its thumbnail (<name>-t.jpg)
          const wanted = src.db.prepare(`SELECT photo FROM items WHERE photo <> ''`).all()
            .flatMap(r => [r.photo, r.photo.replace(/\.jpg$/i, '-t.jpg')]);
          const present = wanted.filter(n => photos.names.has(n)).length;
          checks.push({ name: 'photos referenced by items: present', from: wanted.length, to: present, ok: present === wanted.length });
        }
        const report = { tables, checks, ok: checks.every(x => x.ok),
          ...(tmp.prepared ? { prepare: tmp.prepared } : {}), ...(photos?.skipped.length ? { photosSkipped: photos.skipped } : {}) };
        if (!report.ok) throw new ChecksFailed(report); // roll everything back
        return report;
      });
    } catch (e) {
      if (e instanceof ChecksFailed) return { ...e.report, rolledBack: true };
      throw e;
    }
  } finally {
    try { src?.db.close(); } catch { /* already closed */ }
    if (drv) await drv.close();
    fs.rmSync(tmp.dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ── Command line ──
function parseArgs(argv) {
  const o = { wipe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wipe') o.wipe = true;
    else if (a === '--no-prepare') o.prepare = false;
    else if (['--from', '--to', '--photos', '--photos-to'].includes(a) && argv[i + 1] !== undefined) {
      o[{ '--from': 'from', '--to': 'to', '--photos': 'photosDir', '--photos-to': 'photosTo' }[a]] = argv[++i];
    } else throw new Error(`Unknown or incomplete option: ${a}`);
  }
  if (!o.from || !o.to) throw new Error('Usage: node scripts/copy-to-cloud.js --from <factory.db> --to <postgres://… | PGlite folder> [--photos <folder>] [--photos-to <folder>] [--wipe] [--no-prepare]');
  return o;
}

export function formatReport(r) {
  const fmt = v => (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v));
  const w = Math.max(28, ...r.tables.map(t => t.name.length + 2), ...r.checks.map(c => c.name.length + 2));
  const line = (a, b, c, d = '') => `${a.padEnd(w)}${b.padStart(14)}${c.padStart(14)}  ${d}`;
  const out = [];
  if (r.prepare) {
    out.push('Start-up of the sqlite-final app on the temporary copy (rows before -> after, changed tables only):');
    const moved = r.prepare.rows.filter(x => x.before !== x.after);
    for (const x of moved) out.push(`  ${x.name.padEnd(w - 2)}${String(x.before).padStart(14)}${String(x.after).padStart(14)}`);
    if (!moved.length) out.push('  (no table changed)');
    out.push(`Stock clean-up: ${r.prepare.tidy.length} of ${r.prepare.tidySteps} step(s) ran now (the others had run before)`);
    for (const t of r.prepare.tidy) out.push(`  ${t.label} — ${t.changed ?? '?'} change(s)`);
    out.push('');
  }
  if (r.photosSkipped) out.push(`Photos folder: ${r.photosSkipped.length} file(s) skipped (not .jpg): ${r.photosSkipped.join(', ')}`, '');
  out.push(line('Table', 'From', 'To'), ...r.tables.map(t => line(t.name, fmt(t.from), fmt(t.to), t.from === t.to ? 'ok' : 'DIFFERENT')), '');
  out.push(line('Check', 'From', 'To'));
  for (const c of r.checks) out.push(line(c.name, fmt(c.from), fmt(c.to), (c.ok ? 'ok' : 'FAILED') + (c.detail ? ` (${c.detail.join(', ')})` : '')));
  out.push('');
  out.push(r.ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED — nothing to switch to' + (r.rolledBack ? ' (nothing was kept in the target)' : ''));
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  // Never echo a postgres URL: it holds the password.
  console.log(`Copying ${opts.from} -> ${isUrl(opts.to) ? 'Postgres (the --to URL)' : path.resolve(opts.to)}${opts.wipe ? ' (wiping it first)' : ''}`);
  try {
    const report = await copyAll(opts);
    console.log('\n' + formatReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error(`\nCopy stopped: ${e.message}\nThe target database was not changed.`);
    console.error('CHECKS FAILED — nothing to switch to');
    process.exit(1);
  }
}
