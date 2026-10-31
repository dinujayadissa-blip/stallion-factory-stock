// A fresh start for a new owner of the data: every van and everything about them goes, every stock figure
// goes to 0 — the parts list stays (names, codes, suppliers, racks, photos), and so do the parts rules, the
// floor layout, the suppliers' lead times, the settings and the logins. The vans are then loaded again from
// the dealer orders.
//
//   node scripts/fresh-start.js --backup "<folder>"          shows what would go (changes nothing)
//   node scripts/fresh-start.js --backup "<folder>" --yes    saves a copy of it in <folder>, then does it
//
// Works on the database in DATABASE_URL (the cloud: the session kind, port 5432 — HANDOVER-CLOUD.md step 2);
// without it, nothing is done. All or nothing: the copy is written first, in the same transaction as the
// change, under the app's write lock (no screen changes anything in between); if the copy can't be written
// or anything fails, nothing is changed. The copy holds customers' names: keep it on this PC, never in GitHub.
// Only counts are printed, never rows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, all, get, run, writeTx } from '../src/db.js';

// What goes, in an order the links between the tables allow. Ids are not restarted: a phone's old Undo can
// never hit a new movement.
export const WIPED = ['po_lines', 'purchase_orders', 'movements', 'allocation_log', 'van_notes', 'reminders', 'order_fields',
  'van_lines', 'vans', 'count_sessions', 'request_receipts'];
// Settings about the old data (the plan import that made the vans, the demo flag).
const OLD_SETTINGS = ['plan_imported_at', 'plan_import_history'];

const count = async t => (await get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
async function figures() {
  const out = {};
  for (const t of WIPED) out[t] = await count(t);
  const s = await get(`SELECT COUNT(*) AS items, COALESCE(SUM(CASE WHEN on_hand <> 0 THEN 1 ELSE 0 END), 0) AS with_stock FROM items`);
  return { ...out, items: s.items, items_with_stock: s.with_stock };
}

// { yes: false } → what would go; { yes: true, backupDir } → the copy's file and what went.
export async function freshStart({ yes = false, backupDir } = {}) {
  if (!yes) return { done: false, before: await figures() };
  if (!backupDir) throw new Error('Say where to keep the copy: --backup "<folder>"');
  return writeTx(async () => {
    const before = await figures();
    // The copy: every row that goes, and every part's stock figure and last-counted date as they were.
    const copy = { made: new Date().toISOString(), note: 'Factory Stock fresh start: what was removed', tables: {} };
    for (const t of WIPED) copy.tables[t] = await all(`SELECT * FROM ${t} ORDER BY 1`);
    copy.tables.items_stock = await all('SELECT id, sku, on_hand, last_counted FROM items ORDER BY id');
    copy.tables.settings = await all(`SELECT * FROM settings WHERE key IN (${OLD_SETTINGS.map(() => '?').join(',')}) OR key = 'demo'`, ...OLD_SETTINGS);
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
    const file = path.join(backupDir, `fresh-start-copy-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(copy), { flag: 'wx' }); // (never over an older copy)
    for (const t of WIPED) await run(`DELETE FROM ${t}`);
    await run(`UPDATE items SET on_hand = 0, last_counted = ''`);
    await run(`DELETE FROM settings WHERE key IN (${OLD_SETTINGS.map(() => '?').join(',')})`, ...OLD_SETTINGS);
    await run(`UPDATE settings SET value = '0' WHERE key = 'demo'`);
    return { done: true, file, before, after: await figures() };
  });
}

function print(r) {
  const rows = Object.entries(r.before);
  console.log(`${'What'.padEnd(20)}${'Now'.padStart(10)}${r.done ? 'After'.padStart(10) : ''}`);
  for (const [k, v] of rows) console.log(`${k.padEnd(20)}${String(v).padStart(10)}${r.done ? String(r.after[k]).padStart(10) : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--backup');
  const backupDir = at >= 0 ? args[at + 1] : '';
  const yes = args.includes('--yes');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set: set it as in HANDOVER-CLOUD.md step 2 (the session kind), then run this again. Nothing was changed.');
    process.exit(1);
  }
  try {
    if (!backupDir) throw new Error('Say where to keep the copy: --backup "<folder>" (a folder on this PC, not in GitHub)');
    await openDb();
    const r = await freshStart({ yes, backupDir: path.resolve(backupDir) });
    print(r);
    if (r.done) console.log(`\nDone. The parts list is kept, every stock figure is 0, no vans. Copy of what was removed: ${r.file}`);
    else console.log('\nNothing was changed. To do it, run the same command with --yes at the end.');
  } catch (e) {
    console.error(`Stopped, nothing was changed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
