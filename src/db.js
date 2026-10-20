import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'factory.db'));
// busy_timeout: if another program (a backup, DB Browser…) briefly holds the file, wait up to 5 s
// instead of failing the save straight away with "database is locked".
db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
// first_number('Bay 6') = 6: the bay number, read the same way as "Move the line along" reads it
// (first run of digits in the name; 9999 when there is none). Used to sort vans by how far along they are.
db.function('first_number', { deterministic: true }, s => Number((/\d+/.exec(String(s ?? '')) || [])[0] ?? 9999));

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  supplier TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'ea',
  -- 'stock' = kept on the shelf; 'per-van' = ordered for each van (chassis, furniture, cladding…)
  kind TEXT NOT NULL DEFAULT 'stock',
  on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

-- "When the order says X, the van needs item Y". Conditions are one per line:
--   LABEL ~ regex     field value matches (case-insensitive)
--   LABEL !~ regex    field value does not match (missing field counts as not matching)
--   LABEL ?           field is filled in and not "no"/"none"/"0"
--   *                 always (standard part on every van)
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty TEXT NOT NULL DEFAULT '1',
  spec_fields TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vans (
  id INTEGER PRIMARY KEY,
  chassis TEXT UNIQUE NOT NULL,
  customer TEXT NOT NULL DEFAULT '',
  dealer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  length TEXT NOT NULL DEFAULT '',
  floor_plan TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL DEFAULT '',
  atm TEXT NOT NULL DEFAULT '',
  quote_no TEXT NOT NULL DEFAULT '',
  order_date TEXT NOT NULL DEFAULT '',
  eta TEXT NOT NULL DEFAULT '',
  -- planned -> in_production -> completed
  status TEXT NOT NULL DEFAULT 'planned',
  reviewed INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS order_fields (
  id INTEGER PRIMARY KEY,
  van_id INTEGER NOT NULL REFERENCES vans(id) ON DELETE CASCADE,
  section TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);

-- Parts list for each van. reserved = set aside from stock, issued = handed to the floor.
CREATE TABLE IF NOT EXISTS van_lines (
  id INTEGER PRIMARY KEY,
  van_id INTEGER NOT NULL REFERENCES vans(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL,
  reserved REAL NOT NULL DEFAULT 0,
  issued REAL NOT NULL DEFAULT 0,
  spec TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'rule',  -- 'rule' or 'manual'
  rule_id INTEGER,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  po_no TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',  -- open / closed
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL,
  received REAL NOT NULL DEFAULT 0,
  van_id INTEGER REFERENCES vans(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused: a phone's Undo can't hit another movement
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  type TEXT NOT NULL,          -- receive / issue / adjust / return
  van_id INTEGER REFERENCES vans(id) ON DELETE SET NULL,
  ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS ix_lines_van ON van_lines(van_id);
CREATE INDEX IF NOT EXISTS ix_lines_item ON van_lines(item_id);
CREATE INDEX IF NOT EXISTS ix_fields_van ON order_fields(van_id);
CREATE INDEX IF NOT EXISTS ix_po_lines_item ON po_lines(item_id);
CREATE INDEX IF NOT EXISTS ix_moves_item ON movements(item_id);
`);

// Columns added after the first release — add them to existing databases.
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// Which production-plan column (e.g. "Battery", "FRIDGE") an item / part line shows under.
addColumn('items', 'plan_column', "TEXT NOT NULL DEFAULT ''");
addColumn('van_lines', 'plan_column', "TEXT NOT NULL DEFAULT ''");
// Free-text order reference as written on the plan ("Order 98", "Arizon 24").
addColumn('van_lines', 'po_ref', "TEXT NOT NULL DEFAULT ''");
// Photo file name in data/photos ("<id>-<time>.jpg"; the thumbnail is "<id>-<time>-t.jpg").
addColumn('items', 'photo', "TEXT NOT NULL DEFAULT ''");
// Who did it (worker name from the floor screen).
addColumn('movements', 'worker', "TEXT NOT NULL DEFAULT ''");
// For a part taken on the floor: what the take changed (JSON), so Undo can put it all back.
addColumn('movements', 'undo', "TEXT NOT NULL DEFAULT ''");

// ── Factory floor: areas (bays, yard spots, gates, racks, workstations, walls) in metres ──
db.exec(`
CREATE TABLE IF NOT EXISTS floor_areas (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- bay / yard / gate_in / gate_out / storage / work / wall / building
  name TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS van_notes (
  id INTEGER PRIMARY KEY,
  van_id INTEGER NOT NULL REFERENCES vans(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  worker TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  van_id INTEGER REFERENCES vans(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  due TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  worker TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  done_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_notes_van ON van_notes(van_id);
CREATE INDEX IF NOT EXISTS ix_rem_van ON reminders(van_id);
`);
// Reminders created automatically (e.g. "drawing:<order line>") so they're never added twice.
addColumn('reminders', 'source', "TEXT NOT NULL DEFAULT ''");
// Which trade (electrician, builder, cladding, plumber, finisher) a part / reminder is for.
// '' on a reminder means everyone.
addColumn('items', 'trade', "TEXT NOT NULL DEFAULT ''");
addColumn('reminders', 'trade', "TEXT NOT NULL DEFAULT ''");
// Where a van is parked on the floor, and where an item is stored.
addColumn('vans', 'area_id', 'INTEGER');
addColumn('items', 'area_id', 'INTEGER');

// ── Stock clean-up / allocation (2026-10 tidy) ──
// reserved_firm: the part of `reserved` that was received for this particular van (a PO for the van,
// a grey plan cell, "Assign to van"). Re-prioritising never moves it; only reserved - reserved_firm
// (stock merely held from the shelf) can move to another van.
addColumn('van_lines', 'reserved_firm', 'REAL NOT NULL DEFAULT 0');
// urgent = 1: this van's part was borrowed by another van on the floor, so it must be re-ordered now.
addColumn('van_lines', 'urgent', 'INTEGER NOT NULL DEFAULT 0');
// Office-set build sequence (1, 2, 3…) for planned vans; blank = use the due date.
addColumn('vans', 'build_order', 'INTEGER');
// Set only by a real count (movement type 'count'); '' = not counted yet.
addColumn('items', 'last_counted', "TEXT NOT NULL DEFAULT ''");
// 1 = an "as per plan" catch-all (PLAN-…) item, not a real part on a shelf.
addColumn('items', 'placeholder', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
-- Every change to what is set aside for a van (and every clean-up change), with before -> after.
CREATE TABLE IF NOT EXISTS allocation_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  reason TEXT NOT NULL,              -- 'tidy:lock', 'reprioritise', 'borrow', 'fitted', 'count'…
  van_id INTEGER,
  item_id INTEGER,
  line_id INTEGER,
  field TEXT NOT NULL DEFAULT '',    -- what changed: 'reserved', 'qty', 'on_hand', 'item', 'flag'…
  before TEXT NOT NULL DEFAULT '',
  after TEXT NOT NULL DEFAULT '',
  worker TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_alog_reason ON allocation_log(reason);
CREATE INDEX IF NOT EXISTS ix_alog_line ON allocation_log(line_id);
-- A rack / trade count: what the system expected for each item when the count was opened.
CREATE TABLE IF NOT EXISTS count_sessions (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,               -- 'area:<id>', 'norack', 'trade:<trade>'
  label TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  opened_by TEXT NOT NULL DEFAULT '',
  last_move_id INTEGER NOT NULL DEFAULT 0,
  expected TEXT NOT NULL DEFAULT '{}',   -- {itemId: on_hand when opened}
  closed_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_moves_van ON movements(van_id);  -- (also wanted by C6)
-- The firm part can never be more than what is set aside (or below 0), whatever code changes it.
CREATE TRIGGER IF NOT EXISTS trg_firm_cap AFTER UPDATE OF reserved, reserved_firm ON van_lines
  WHEN NEW.reserved_firm > NEW.reserved OR NEW.reserved_firm < 0
BEGIN
  UPDATE van_lines SET reserved_firm = MAX(0, MIN(NEW.reserved_firm, NEW.reserved)) WHERE id = NEW.id;
END;
`);

// ── Purchasing clean-up (2026-10, round 1 batch 2: C5–C8) ──
// One plain status per part line: '' (normal), 'customer' (customer supplies it), 'tbd' (to be decided),
// 'not_ordered' (office answered "No, still to order" for the plan's order number).
addColumn('van_lines', 'state', "TEXT NOT NULL DEFAULT ''");
// What exactly was ordered (colour, size, model) — copied from the van line's spec.
addColumn('po_lines', 'spec', "TEXT NOT NULL DEFAULT ''");
// PO dates / check flag, and per line: backorder date and the balance the supplier cancelled.
addColumn('purchase_orders', 'ordered_at', "TEXT NOT NULL DEFAULT ''");
addColumn('purchase_orders', 'expected', "TEXT NOT NULL DEFAULT ''");
addColumn('purchase_orders', 'needs_check', 'INTEGER NOT NULL DEFAULT 0');
addColumn('po_lines', 'expected', "TEXT NOT NULL DEFAULT ''");
addColumn('po_lines', 'closed', 'REAL NOT NULL DEFAULT 0');
db.exec(`
-- Lead time per supplier (days from ordering to arriving). lead_confirmed = 0: the 14-day default is assumed.
CREATE TABLE IF NOT EXISTS suppliers (
  name TEXT PRIMARY KEY,
  lead_days INTEGER NOT NULL DEFAULT 14,
  lead_confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_po_lines_van_item ON po_lines(van_id, item_id);
CREATE INDEX IF NOT EXISTS ix_lines_van_item ON van_lines(van_id, item_id);
CREATE INDEX IF NOT EXISTS ix_moves_item_at ON movements(item_id, at);
`);
// Every supplier named on an item or a PO gets a row (14 days, not confirmed). Safe to run any time.
export function syncSuppliers() {
  db.exec(`INSERT OR IGNORE INTO suppliers(name) SELECT DISTINCT trim(supplier) FROM items WHERE trim(supplier) <> '';
           INSERT OR IGNORE INTO suppliers(name) SELECT DISTINCT trim(supplier) FROM purchase_orders WHERE trim(supplier) <> '';`);
}
syncSuppliers();

// ── Catalogue, reorder levels, set-aside history (2026-10, round 1 batch 3: C9–C12) ──
// What one unit is ("1 length = 6.5 m", "set = 1 van"), shown next to every quantity on the floor.
addColumn('items', 'unit_size', "TEXT NOT NULL DEFAULT ''");
// Shelf top-up target: when stock falls below the reorder level, order back up to this (0 = the level).
addColumn('items', 'order_up_to', 'REAL NOT NULL DEFAULT 0');
// Set-aside history: the numeric change of `reserved` / `reserved_firm` on a line (so a figure can be
// explained), and ack = 1 once the office ticked it on the weekly "Stock checks" page.
addColumn('allocation_log', 'change', 'REAL');
addColumn('allocation_log', 'firm_change', 'REAL');
addColumn('allocation_log', 'ack', 'INTEGER NOT NULL DEFAULT 0');
addColumn('movements', 'ack', 'INTEGER NOT NULL DEFAULT 0');
// Round 4 (check-r3-3): production-plan columns whose plan line was merged into this line (JSON list,
// e.g. ["Sliding Door Pelmet"]). The Production plan grid and the Excel export colour those cells from
// this line, so a merged plan cell keeps its white / pink / grey / blue.
addColumn('van_lines', 'merged_cols', "TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE INDEX IF NOT EXISTS ix_alog_item ON allocation_log(item_id);
         CREATE INDEX IF NOT EXISTS ix_alog_at ON allocation_log(at);
         CREATE INDEX IF NOT EXISTS ix_moves_type_at ON movements(type, at);`);

// Small fixes & phone round 2 (sp-r1-5): a movement number is never given out twice. Without
// AUTOINCREMENT SQLite hands the next movement the number of the newest one that was just deleted
// (Undo deletes the take / delivery), so a phone still holding the old number could undo somebody
// else's take. Rebuild the table once with AUTOINCREMENT — same columns, same rows, same numbers —
// and start the counter above every number already used (also the "last movement" a count noted).
// Runs only while the table has no AUTOINCREMENT, inside one transaction (all or nothing).
function movementsAutoincrement() {
  const t = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'movements'`).get();
  if (!t || /AUTOINCREMENT/i.test(t.sql)) return;
  const create = t.sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(["`[]?)movements\1/i, 'CREATE TABLE movements_ai')
    .replace(/\bid\s+INTEGER\s+PRIMARY\s+KEY\b/i, 'id INTEGER PRIMARY KEY AUTOINCREMENT');
  if (!/^CREATE TABLE movements_ai/.test(create) || !/AUTOINCREMENT/.test(create)) return; // unexpected shape: leave it
  const indexes = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'movements' AND sql IS NOT NULL`).all().map(r => r.sql);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      const before = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(qty), 0) AS s FROM movements').get();
      db.exec('DROP TABLE IF EXISTS movements_ai');
      db.exec(create);
      db.exec('INSERT INTO movements_ai SELECT * FROM movements');
      const after = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(qty), 0) AS s FROM movements_ai').get();
      if (after.n !== before.n || Math.abs(after.s - before.s) > 1e-9) throw new Error('movements copy did not match');
      db.exec('DROP TABLE movements');
      db.exec('ALTER TABLE movements_ai RENAME TO movements');
      for (const sql of indexes) db.exec(sql);
      const hi = db.prepare(`SELECT MAX(COALESCE((SELECT MAX(id) FROM movements), 0),
                               COALESCE((SELECT MAX(last_move_id) FROM count_sessions), 0)) AS n`).get().n;
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'movements'`).run();
      db.prepare(`INSERT INTO sqlite_sequence(name, seq) VALUES('movements', ?)`).run(hi);
      db.exec('COMMIT');
      console.log(`Movements: numbers are never reused from now on (${after.n} movements kept, next number after ${hi}).`);
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('Movements: could not switch to never-reused numbers, left as it was:', e.message);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
movementsAutoincrement();

// ── Logins and job roles (see src/auth.js) ──
// users: one login per person. username is unique whatever its capitals; trade is set for workers only
// (electrician / builder / cladding / plumber / finisher). pass_hash = scrypt$N$r$p$salt$hash (never the
// password). active = 0: the login is turned off. must_change = 1: choose a new password at the next log in.
// sessions: one row per logged-in browser / phone. Only sha256 of the cookie's random token is kept;
// times are milliseconds (Date.now()). Expiry slides: 30 days from the last use.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','office','stores','leadhand','worker')),
  trade TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by TEXT NOT NULL DEFAULT '',
  last_login TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
`);

// One line in the allocation log. `before`/`after` are stored as text (numbers or short labels).
// `change` / `firm_change`: how much `reserved` / `reserved_firm` moved (worked out from before/after
// when the field is a set-aside field and both are numbers; pass them to say it exactly).
const SET_ASIDE_FIELD = /^reserved|^locked$|^set aside/;
export function logAlloc(reason, { van_id = null, item_id = null, line_id = null, field = '', before = '', after = '', worker = '', note = '',
  change, firm_change } = {}) {
  const b = Number(before), a = Number(after);
  const numeric = String(before ?? '') !== '' && String(after ?? '') !== '' && Number.isFinite(b) && Number.isFinite(a);
  if (change === undefined && numeric && SET_ASIDE_FIELD.test(field) && !/firm/.test(field) && field !== 'locked') change = a - b;
  if (firm_change === undefined && numeric && (field === 'reserved_firm' || field === 'locked')) firm_change = a - b;
  db.prepare(`INSERT INTO allocation_log(reason, van_id, item_id, line_id, field, before, after, worker, note, change, firm_change)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(reason, van_id, item_id, line_id, field, String(before ?? ''), String(after ?? ''), worker || '', note || '',
    change ?? null, firm_change ?? null);
}

export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// Re-entrant: called inside another tx() it just joins that transaction, so several steps can be
// combined into one all-or-nothing change.
export function tx(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function getSetting(key, fallback = '') {
  return get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
