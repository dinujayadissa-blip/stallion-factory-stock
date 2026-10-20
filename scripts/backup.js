// Safe backup of the live database and photos, while the app keeps running.
//   npm run backup -- "E:\Factory Stock backups"      (or set BACKUP_DIR)
//
// Each run makes BACKUP_DIR\<yyyy-mm-dd_hhmm>\factory.db — a complete, consistent copy made with
// SQLite's VACUUM INTO (copying factory.db by hand can miss recent work still in factory.db-wal).
// Photos go into one shared BACKUP_DIR\photos folder (new files only). The newest BACKUP_KEEP
// snapshots are kept (default 30); older ones are removed. Photos are never removed.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const BACKUP_DIR = process.argv[2] || process.env.BACKUP_DIR;
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 30);
const now = () => new Date().toLocaleString('sv-SE');

function fail(msg) {
  console.error(`${now()}  Backup FAILED: ${msg}`);
  process.exit(1);
}
// Anything unexpected (folder can't be made, drive gone...) still gives one plain "Backup FAILED" line.
process.on('uncaughtException', e => fail(e.message));

if (!BACKUP_DIR) fail('say where to put it, e.g.  npm run backup -- "E:\\Factory Stock backups"');
const src = path.join(DATA_DIR, 'factory.db');
// Never open (and so create) a database that isn't there.
if (!fs.existsSync(src)) fail(`no database found at ${src}`);
const dest = path.resolve(BACKUP_DIR);
const rel = path.relative(path.resolve(DATA_DIR), dest);
if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) fail('the backup folder must not be inside the data folder');

const t = new Date();
const p2 = n => String(n).padStart(2, '0');
const name = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}_${p2(t.getHours())}${p2(t.getMinutes())}`;
const snapDir = path.join(dest, name);
const out = path.join(snapDir, 'factory.db');
if (fs.existsSync(out)) { console.log(`${now()}  Already backed up this minute: ${out}`); process.exit(0); }
fs.mkdirSync(snapDir, { recursive: true });

// 1. Database: written to a temporary name first, so a half-written file is never taken for a backup.
const part = out + '.part';
fs.rmSync(part, { force: true });
let counts;
try {
  const live = new DatabaseSync(src);
  live.exec('PRAGMA busy_timeout = 10000');
  live.exec(`VACUUM INTO '${part.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  live.close();
  const copy = new DatabaseSync(part, { readOnly: true });
  const ok = copy.prepare('PRAGMA integrity_check').get();
  counts = copy.prepare('SELECT (SELECT COUNT(*) FROM vans) AS vans, (SELECT COUNT(*) FROM items) AS items').get();
  copy.close();
  if (Object.values(ok)[0] !== 'ok') throw new Error('the copy failed its check');
  fs.renameSync(part, out);
} catch (e) {
  fs.rmSync(part, { force: true });
  try { fs.rmdirSync(snapDir); } catch {} // don't leave an empty dated folder that looks like a backup
  fail(e.message);
}

// 2. Photos: one shared folder; a photo's file name changes on every upload, so new names are enough.
let newPhotos = 0;
const photoSrc = path.join(DATA_DIR, 'photos');
const photoDest = path.join(dest, 'photos');
fs.mkdirSync(photoDest, { recursive: true });
if (fs.existsSync(photoSrc)) {
  for (const f of fs.readdirSync(photoSrc)) {
    const from = path.join(photoSrc, f);
    const to = path.join(photoDest, f);
    if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
    newPhotos++;
  }
}

// 3. Keep the newest KEEP database snapshots.
const snaps = fs.readdirSync(dest).filter(d => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(d)).sort();
for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP))) {
  fs.rmSync(path.join(dest, old), { recursive: true, force: true });
}

// 4. Remember when, so the Settings page can show "Last backup" (a failed backup leaves it old).
try {
  const live = new DatabaseSync(src);
  live.exec('PRAGMA busy_timeout = 10000');
  live.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('last_backup', t.toISOString());
  live.close();
} catch (e) {
  console.log(`  (could not note the backup time for the Settings page: ${e.message})`);
}

console.log(`${now()}  Backup saved: ${out} (${counts.vans} vans, ${counts.items} items, ${newPhotos} new photos)`);
if (path.parse(dest).root.toLowerCase() === path.parse(path.resolve(DATA_DIR)).root.toLowerCase()) {
  console.log('  Note: the backup is on the same drive as the app. Use another drive, a USB stick or a');
  console.log('  cloud-synced folder, so a broken disk does not take the backups with it.');
}
