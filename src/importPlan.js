// Imports the "2026 Production Plan" spreadsheet: one row per van, one column per part, cell
// colour = status (white not ordered, pink ordered, grey received, blue finished/fitted).
//
// Two ways in (C12):
//   - "Update from spreadsheet" (the normal one, planUpdate): always a preview first, applied only after
//     Confirm. Adds new vans and lines, updates dates / statuses, changes the text / quantity only of
//     lines with nothing set aside or fitted, books grey cells in only up to what a line still needs
//     (never twice), closes blue cells like "Already fitted". A line whose plan text changed after parts
//     were set aside is NOT changed: it is listed as a conflict ("Use new" / "Keep current"). Vans and
//     lines missing from the sheet are flagged "Not in latest plan – check", never deleted. Movements and
//     purchase orders are never deleted.
//   - "Start again from spreadsheet" (applyPlan): the old full replace, behind a backup and typing RESET
//     (server.js), after which the clean-up steps run again.
import XLSX from 'xlsx';
import { all, get, run, tx, getSetting, setSetting, syncSuppliers, logAlloc } from './db.js';
import { detectState, specForPo, today, givenTo } from './lineState.js';
import { syncCatalog } from './seed.js';
import { handlerFor, INFO_COLUMNS, NOT_A_PART, normHeader, poRef, skuColumns, lead, leadInfo, capFor } from './planMap.js';
import { relinkTarget, ensureNewItems, NAME_FIXES, skuNow, skuNames } from './relink.js';
import { allocateItem, markFitted, updateVan, receiveForLine, httpError, closeAsGiven } from './inventory.js';

export const PLAN_SECTION = 'PRODUCTION PLAN';

// ── colours → status ──
function colourStatus(cell) {
  const rgb = cell?.s?.fgColor?.rgb || cell?.s?.fill?.fgColor?.rgb;
  if (!rgb || !/^[0-9A-F]{6}$/i.test(rgb.slice(-6))) return 'none';
  const hex = rgb.slice(-6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 14) return max < 0xF0 ? 'received' : 'none'; // greys (white = none)
  if (b > r + 20) return 'done';                                 // blues = finished
  if (r > b + 15) return 'ordered';                              // pinks / reds
  return 'none';
}

function excelDate(v) {
  if (typeof v === 'number' && v > 30000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v || ''));
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

const isInfo = h => INFO_COLUMNS.has(normHeader(h).replace(/ \(\d+\)$/, ''));
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const slug = s => normHeader(s).replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
const title = s => clean(s).toLowerCase().replace(/(^|[\s(/])(\w)/g, (m, a, c) => a + c.toUpperCase());
const q = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
const appendNote = (note, add) => (String(note || '').includes(add) ? note : [note, add].filter(Boolean).join(' · '));

// Read the workbook into plain rows. Nothing is written to the database here.
export function readPlan(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellStyles: true, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];

  // Header row is the one with "CHASSIS #" in it.
  let headerRow = -1, chassisCol = -1;
  for (let r = 0; r <= Math.min(10, range.e.r) && headerRow < 0; r++) {
    for (let c = 0; c <= range.e.c; c++) {
      if (/^CHASSIS\s*#/i.test(clean(at(r, c)?.v))) { headerRow = r; chassisCol = c; break; }
    }
  }
  if (headerRow < 0) throw Object.assign(new Error('Couldn\'t find the "CHASSIS #" header row — is this the production plan?'), { status: 400 });

  const seen = new Map();
  const headers = [];
  for (let c = 0; c <= range.e.c; c++) {
    let h = clean(at(headerRow, c)?.v);
    if (!h) { headers.push(null); continue; }
    const n = (seen.get(normHeader(h)) || 0) + 1;
    seen.set(normHeader(h), n);
    if (n > 1) h = `${h} (${n})`;
    headers.push(h);
  }
  const col = name => headers.findIndex(h => h && normHeader(h).startsWith(name));
  const C = {
    date: col('DATE'), size: col('VAN SIZE'), eta: col('EXPECTED DELIVERY'), customer: col('CUSTOMER NAME'),
    dealer: col('DEALER'), requests: col('CUSTOMER REQUESTS'),
    status: headers.findIndex(h => h && normHeader(h) === 'STATUS'), // written by this app's export
  };
  const STATUS_WORDS = { CANCELLED: 'cancelled', FINISHED: 'completed', 'IN PRODUCTION': 'in_production', PLANNED: 'planned' };

  const vans = [];
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const chassisCell = at(r, chassisCol);
    const chassis = clean(chassisCell?.v).toUpperCase();
    if (!/^[A-Z]{2,3}\d{3,}$/.test(chassis)) continue;
    const sizeType = clean(at(r, C.size)?.v);
    const sizeMatch = /^([\d.]+\s*(?:ft\b|m\b)?)\s*(.*)$/i.exec(sizeType);
    const van = {
      row: r + 1,
      chassis,
      status: STATUS_WORDS[normHeader(at(r, C.status)?.v)]
        || { done: 'completed', received: 'in_production' }[colourStatus(chassisCell)] || 'planned',
      length: sizeMatch ? sizeMatch[1].trim() : '',
      model: sizeMatch ? sizeMatch[2] : sizeType,
      eta: excelDate(at(r, C.eta)?.v),
      etaText: clean(at(r, C.eta)?.w ?? at(r, C.eta)?.v),
      customer: clean(at(r, C.customer)?.v),
      dealer: clean(at(r, C.dealer)?.v),
      requests: clean(at(r, C.requests)?.v),
      info: [],
      cells: [],
    };
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (!h || c === chassisCol) continue;
      const cell = at(r, c);
      const text = typeof cell?.v === 'number' && /DATE/i.test(h) ? excelDate(cell.v) : clean(cell?.v);
      if (!text) continue;
      if (isInfo(h)) {
        van.info.push({ label: h, value: text });
      } else {
        van.cells.push({ header: h, text, status: colourStatus(cell) });
      }
    }
    vans.push(van);
  }
  const partColumns = headers.filter((h, c) => h && c !== chassisCol && !isInfo(h));
  return { headers, partColumns, vans };
}

// Turn one cell into part lines: [{sku | generic, qty, check}] or [] when it isn't a part.
// `check` says why a person should look at the quantity ('' = fine).
export function cellParts(cell, rowGet) {
  if (NOT_A_PART.test(cell.text)) return [];
  const fn = handlerFor(cell.header);
  let parts;
  try { parts = fn ? fn(cell.text, { get: rowGet }) : undefined; } catch { parts = undefined; }
  if (parts === null) return [];
  const textCheck = leadInfo(cell.text, 1).check;
  if (parts === undefined) return [{ generic: true, qty: lead(cell.text, 1), check: textCheck }];
  return parts.map(p => ({ ...p, check: p.check || textCheck }));
}

// Quantity flag for one part: the parser's own doubt, or more than a van normally needs.
export function qtyCheck(header, unit, qty, check = '', usual = 0) {
  if (check) return check;
  const cap = capFor(header, unit, usual);
  return qty > cap ? `${qty} is more than the usual most (${cap}) for one van` : '';
}

const rowGetter = v => name => v.cells.find(c => normHeader(c.header).startsWith(normHeader(name)))?.text || '';

// "Check file": what the sheet holds, and (for "Start again") what a full replace would wipe.
export function previewPlan(buffer) {
  const plan = readPlan(buffer);
  const stats = { vans: plan.vans.length, byStatus: {}, cells: 0, lines: 0, matched: 0, generic: 0, cellStatus: {} };
  const genericCols = new Map();
  const units = new Map(all('SELECT sku, unit FROM items').map(i => [i.sku, i.unit]));
  const found = [];
  for (const v of plan.vans) {
    stats.byStatus[v.status] = (stats.byStatus[v.status] || 0) + 1;
    const rowGet = rowGetter(v);
    for (const cell of v.cells) {
      stats.cells++;
      const parts = cellParts(cell, rowGet);
      for (const p of parts) {
        stats.lines++;
        if (p.generic) { stats.generic++; genericCols.set(cell.header, (genericCols.get(cell.header) || 0) + 1); }
        else stats.matched++;
        if (!['completed', 'cancelled'].includes(v.status)) stats.cellStatus[cell.status] = (stats.cellStatus[cell.status] || 0) + 1;
        found.push({ v, cell, p });
      }
    }
  }
  // Quantities a person should look at before importing (vans still to build only).
  const usual = columnMedians(found.map(f => ({ col: f.cell.header, qty: f.p.qty })));
  const checks = found.filter(f => !['completed', 'cancelled'].includes(f.v.status)).map(f => ({
    chassis: f.v.chassis, column: f.cell.header, text: f.cell.text, qty: f.p.qty,
    check: qtyCheck(f.cell.header, f.p.generic ? 'ea' : units.get(f.p.sku) || 'ea', f.p.qty, f.p.check, usual.get(f.cell.header)),
  })).filter(c => c.check);
  // What "Start again from spreadsheet" would reset (the first import has nothing to lose).
  const onSheet = new Set(plan.vans.map(v => v.chassis));
  const lose = {
    movements: get(`SELECT COUNT(*) AS c FROM movements WHERE note <> ?`, IMPORT_NOTE).c,
    manualLines: get(`SELECT COUNT(*) AS c FROM van_lines WHERE source = 'manual'`).c,
    // shelf-stock counts that changed since the last import (stocktakes, deliveries, parts taken)
    stockCounts: get(`SELECT COUNT(*) AS c FROM items i WHERE i.kind = 'stock'
                        AND i.on_hand <> COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.item_id = i.id AND m.note = ?), 0)`, IMPORT_NOTE).c,
    vansNotOnSheet: all('SELECT chassis FROM vans ORDER BY chassis').map(v => v.chassis).filter(c => !onSheet.has(c)),
    purchaseOrders: get('SELECT COUNT(*) AS c FROM purchase_orders').c,
    setAside: get('SELECT COUNT(*) AS c FROM van_lines WHERE reserved > 0').c,
  };
  return {
    ...stats,
    columns: plan.partColumns.length,
    genericColumns: [...genericCols.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => ({ header: h, count: n })),
    vanList: plan.vans.map(v => ({ chassis: v.chassis, model: v.model, status: v.status, eta: v.eta })),
    lose,
    checks,
  };
}

// Median quantity per plan column ({col, qty} rows) — "what this column normally uses".
export function columnMedians(rows) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.col)) by.set(r.col, []); by.get(r.col).push(r.qty); }
  const out = new Map();
  for (const [col, qs] of by) out.set(col, median(qs));
  return out;
}
export function median(list) {
  const s = list.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const IMPORT_NOTE = 'Received for this van (production plan import)';
const UPDATE_NOTE = 'Received for this van (production plan update)';
const NOT_IN_PLAN = 'Not in latest plan – check';
const byChassis = rows => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.chassis)) m.set(r.chassis, []);
    m.get(r.chassis).push(r);
  }
  return m;
};

// ── shared by both ways in ──

// Items, column medians, the "as per plan" catch-alls and purchase orders for one import.
// `create: false` (preview): nothing is written; a catch-all that doesn't exist yet is a stand-in.
function planContext(plan, { create = true } = {}) {
  const itemBySku = new Map(all('SELECT * FROM items').map(i => [i.sku, i]));
  const usual = new Map();
  {
    const rows = [];
    for (const v of plan.vans) {
      const rowGet = rowGetter(v);
      for (const cell of v.cells) for (const p of cellParts(cell, rowGet)) rows.push({ col: cell.header, qty: p.qty });
    }
    for (const [k, m] of columnMedians(rows)) usual.set(k, m);
  }
  const genericItem = header => {
    const sku = skuNow(`PLAN-${slug(header)}`); // "Roof Baw" → PLAN-ROOF-BOW (planner-r3-4)
    let it = itemBySku.get(sku);
    if (!it) {
      const name = NAME_FIXES.reduce((n, [re, to]) => n.replace(re, to), `${title(header)} (as per plan)`);
      if (!create) return { id: null, sku, name, unit: 'ea', kind: 'per-van', placeholder: 1, supplier: '' };
      run(`INSERT INTO items(sku, name, category, supplier, unit, kind, plan_column, notes, placeholder)
           VALUES(?, ?, 'As per plan', '', 'ea', 'per-van', ?, 'Created by the production plan import for text that isn''t a specific stock item', 1)`,
          sku, name, header);
      it = get('SELECT * FROM items WHERE sku = ?', sku);
      itemBySku.set(sku, it);
    }
    return it;
  };
  const pos = new Map();
  // The plan does not say when an order was placed: ordered date left blank = "unknown (from plan)"
  // until someone types it on the PO (Small fixes & phone round 1, user-r4-5).
  // Pink cells: the open PO with that number for that supplier (made if there isn't one). No order number
  // on the plan: named so it's clearly not a real PO number, and marked "to check".
  const poFor = (supplier, ref) => {
    const key = `${supplier}|${ref}`;
    if (!pos.has(key)) {
      const name = ref || `Plan – ${supplier || 'no supplier'} (no number)`;
      const old = get(`SELECT id FROM purchase_orders WHERE status = 'open' AND lower(trim(po_no)) = lower(?) AND lower(trim(supplier)) = lower(?) ORDER BY id LIMIT 1`, name, supplier);
      pos.set(key, old ? old.id : Number(run(`INSERT INTO purchase_orders(po_no, supplier, notes, ordered_at, needs_check) VALUES(?,?,?,?,?)`,
        name, supplier, 'Imported from the production plan (pink cells)', '', ref && supplier ? 0 : 1).lastInsertRowid));
    }
    return pos.get(key);
  };
  return { itemBySku, usual, genericItem, poFor, pos };
}

// Every part of one van row, with the item it goes on. A catch-all cell that names a real part ("Black
// Jack" under trailer jack) only becomes that part when no other column of the van (nor `otherItems`,
// the van's existing lines in other columns) already asks for it.
function vanEntries(v, ctx, otherItems = new Map()) {
  const rowGet = rowGetter(v);
  const entries = [];
  for (const cell of v.cells) {
    for (const p of cellParts(cell, rowGet)) {
      entries.push({ cell, p, item: p.generic ? ctx.genericItem(cell.header) : (ctx.itemBySku.get(p.sku) || ctx.genericItem(cell.header)), note: '' });
    }
  }
  for (const e of entries) {
    if (!e.item.placeholder && !/^PLAN-/.test(e.item.sku)) continue;
    e.fromSku = e.item.sku;
    const target = ctx.itemBySku.get(relinkTarget(e.item.sku, e.cell.text));
    if (!target) continue;
    const other = entries.find(x => x !== e && x.item.id === target.id);
    const otherCol = otherItems.get(target.id);
    if (other) e.note = `possible duplicate of the ${other.cell.header} line`;
    else if (otherCol && otherCol !== e.cell.header) e.note = `possible duplicate of the ${otherCol} line`;
    else { e.note = `was ${e.item.sku}`; e.item = target; }
  }
  return entries;
}

// One new van line from a plan cell, with its colour: grey = received for the van (set aside and
// locked), blue = fitted, pink = on a PO. `vanStatus` completed → fitted.
function insertLine(vanId, vanStatus, e, ctx, stats, { noteTxt = IMPORT_NOTE } = {}) {
  const { cell, p, item, note } = e;
  const qty = p.qty > 0 ? p.qty : 1;
  const ref = poRef(cell.text);
  const check = qtyCheck(cell.header, item.unit, qty, p.check, ctx.usual.get(cell.header));
  const lineNote = [note, check ? `Please check quantity: ${check}` : ''].filter(Boolean).join(' · ');
  // "Customer supply" / "TBA" / "????" in the cell: a reminder line (fitted cells are just fitted).
  const state = vanStatus === 'completed' || cell.status === 'done' ? '' : detectState(cell.text);
  const lineId = Number(run(`INSERT INTO van_lines(van_id, item_id, qty, spec, source, plan_column, po_ref, note, state)
                             VALUES(?,?,?,?, 'plan', ?, ?, ?, ?)`, vanId, item.id, qty, cell.text, cell.header, ref, lineNote, state).lastInsertRowid);
  stats.lines++;
  // A cancelled van keeps its lines but has nothing set aside for it.
  const status = vanStatus === 'completed' ? 'done'
    : vanStatus === 'cancelled' && cell.status === 'received' ? 'none' : cell.status;
  if (status === 'done') {
    run('UPDATE van_lines SET issued = qty WHERE id = ?', lineId);
    stats.done++;
  } else if (status === 'received') {
    // (a "customer supplies" / "to be decided" line too: the stock is here, so it is booked in and kept
    // for the van; it shows on "received but customer supplies / to be decided – check")
    run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', qty, item.id);
    // Received for this van (grey cell): set aside and locked to it.
    run('UPDATE van_lines SET reserved = qty, reserved_firm = qty WHERE id = ?', lineId);
    run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note) VALUES(?, ?, 'receive', ?, ?, ?)`,
        item.id, qty, vanId, ref ? `Order ${ref}` : 'Production plan', noteTxt);
    stats.received++;
  } else if (status === 'ordered') {
    const poId = ctx.poFor(item.supplier || '', ref);
    run('INSERT INTO po_lines(po_id, item_id, qty, van_id, spec) VALUES(?,?,?,?,?)', poId, item.id, qty, vanId, specForPo(cell.text, ref));
    stats.ordered++;
  } else {
    stats.notOrdered++;
  }
  // "Black Jack Gave to Alex": handed to a worker for this van, so not on the shelf (user-r1-5). A grey
  // cell was just booked in and set aside above, so it is booked out again (receive + issue: the shelf
  // figure is unchanged and both movements explain it); otherwise the line just closes.
  if (status !== 'done' && !state && givenTo(cell.text)) {
    if (closeAsGiven(lineId, { reason: noteTxt === IMPORT_NOTE ? 'plan import' : 'plan update' })) stats.given = (stats.given || 0) + 1;
  }
  return lineId;
}

function planFields(vanId, v, start = 0) {
  let sort = start;
  const insField = 'INSERT INTO order_fields(van_id, section, label, value, sort) VALUES(?,?,?,?,?)';
  for (const f of v.info) run(insField, vanId, PLAN_SECTION, f.label, f.value, sort++);
  for (const c of v.cells) run(insField, vanId, PLAN_SECTION, c.header, c.text, sort++);
}

// A whole van from one sheet row. `keep`: what the office had for this chassis before a full replace.
function insertPlanVan(v, ctx, stats, keep = {}, opts = {}) {
  const oldNotes = keep.notes || '';
  const sheetNotes = [v.requests, !v.eta && v.etaText ? `Delivery: ${v.etaText}` : ''].filter(Boolean).filter(t => !oldNotes.includes(t));
  const vanId = Number(run(`INSERT INTO vans(chassis, customer, dealer, model, length, eta, status, reviewed, notes)
                            VALUES(?,?,?,?,?,?,?,1,?)`,
    v.chassis, v.customer, v.dealer, v.model, v.length, v.eta, v.status, [oldNotes, ...sheetNotes].filter(Boolean).join('\n')).lastInsertRowid);
  stats.vans++;
  let sort = 0;
  const insField = 'INSERT INTO order_fields(van_id, section, label, value, sort) VALUES(?,?,?,?,?)';
  for (const f of keep.fields || []) run(insField, vanId, f.section, f.label, f.value, sort++);
  // Notes, reminders and the bay / yard space stay with the chassis.
  for (const n of keep.vanNotes || []) run('INSERT INTO van_notes(van_id, text, worker, created_at) VALUES(?,?,?,?)', vanId, n.text, n.worker, n.created_at);
  for (const r of keep.reminders || []) {
    run(`INSERT INTO reminders(van_id, text, due, done, worker, created_at, done_at, source, trade) VALUES(?,?,?,?,?,?,?,?,?)`,
        vanId, r.text, r.due, r.done, r.worker, r.created_at, r.done_at, r.source, r.trade);
  }
  if (keep.area && !['completed', 'cancelled'].includes(v.status)) run('UPDATE vans SET area_id = ? WHERE id = ?', keep.area, vanId);
  planFields(vanId, v, sort);
  for (const e of vanEntries(v, ctx)) insertLine(vanId, v.status, e, ctx, stats, opts);
  return vanId;
}

function finishImport(plan) {
  for (const [sku, header] of skuColumns(plan.partColumns)) {
    run(`UPDATE items SET plan_column = ? WHERE sku = ? AND plan_column = ''`, header, sku);
  }
  // The same order number twice where one has no supplier (can't tell them apart) is worth a look too.
  run(`UPDATE purchase_orders SET needs_check = 1 WHERE status = 'open' AND EXISTS (SELECT 1 FROM purchase_orders o WHERE o.id <> purchase_orders.id
         AND lower(trim(o.po_no)) = lower(trim(purchase_orders.po_no)) AND (trim(o.supplier) = '' OR trim(purchase_orders.supplier) = ''))`);
  syncSuppliers();
  setSetting('plan_columns', JSON.stringify(plan.partColumns));
  setSetting('plan_imported_at', new Date().toISOString());
}

// Each import is written down: settings 'last_plan_import' and the last 30 in 'plan_import_history'.
export function recordImport(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  setSetting('last_plan_import', JSON.stringify(e));
  let hist = [];
  try { hist = JSON.parse(getSetting('plan_import_history', '[]')); } catch { hist = []; }
  hist.unshift(e);
  setSetting('plan_import_history', JSON.stringify(hist.slice(0, 30)));
  logAlloc('plan import', { field: e.mode, after: e.file || '', worker: e.by || '', note: JSON.stringify(e.counts || {}) });
}
export function importHistory() {
  let hist = [];
  try { hist = JSON.parse(getSetting('plan_import_history', '[]')); } catch { hist = []; }
  return hist;
}

// ── "Start again from spreadsheet": replace all vans, part lines, POs and stock levels ──
// The item catalogue and parts rules are kept. For a chassis on the sheet, the dealer-order details (from
// the PDF), notes, reminders and its place on the floor map are kept too. server.js takes a backup first
// and asks for RESET; the clean-up steps run again afterwards.
export function applyPlan(buffer, { file = '', by = '' } = {}) {
  const plan = readPlan(buffer);
  syncCatalog();
  return tx(() => {
    const keepFields = byChassis(all(`SELECT f.*, v.chassis FROM order_fields f JOIN vans v ON v.id = f.van_id WHERE f.section <> ?`, PLAN_SECTION));
    const keepNotes = byChassis(all('SELECT n.*, v.chassis FROM van_notes n JOIN vans v ON v.id = n.van_id ORDER BY n.id'));
    const keepReminders = byChassis(all('SELECT r.*, v.chassis FROM reminders r JOIN vans v ON v.id = r.van_id ORDER BY r.id'));
    const keepArea = new Map(all('SELECT chassis, area_id FROM vans WHERE area_id IS NOT NULL').map(v => [v.chassis, v.area_id]));
    const keepVanNotes = new Map(all(`SELECT chassis, notes FROM vans WHERE notes <> ''`).map(v => [v.chassis, v.notes]));
    for (const t of ['movements', 'po_lines', 'purchase_orders', 'van_lines', 'order_fields', 'vans']) run(`DELETE FROM ${t}`);
    run('UPDATE items SET on_hand = 0, last_counted = \'\'');
    setSetting('demo', '0');
    setSetting('plan_conflicts', '[]');
    setSetting('plan_conflicts_kept', '[]');
    ensureNewItems(); // recurring parts the "as per plan" cells are re-linked to
    const ctx = planContext(plan);
    const stats = { vans: 0, lines: 0, received: 0, ordered: 0, done: 0, notOrdered: 0 };
    for (const v of plan.vans) {
      insertPlanVan(v, ctx, stats, { notes: keepVanNotes.get(v.chassis), fields: keepFields.get(v.chassis), vanNotes: keepNotes.get(v.chassis),
        reminders: keepReminders.get(v.chassis), area: keepArea.get(v.chassis) });
    }
    finishImport(plan);
    const out = { ...stats, purchaseOrders: ctx.pos.size };
    recordImport({ file, mode: 'start again', by, counts: out });
    return out;
  });
}

// ── "Update from spreadsheet" ──

const RANK = { planned: 0, in_production: 1, completed: 2 };
const norm = s => clean(s).toLowerCase();

// Work out what an update would change. Read-only when ctx was made with create: false.
function updateDiff(plan, ctx) {
  const d = { newVans: [], dateChanges: [], statusChanges: [], statusKept: [], textUpdates: [], newLines: [], receipts: [], fitted: [], given: [],
    conflicts: [], removedVans: [], removedLines: [], fieldsVans: [], dealerVans: [] };
  const dbVans = new Map(all('SELECT * FROM vans').map(v => [v.chassis, v]));
  const onSheet = new Set(plan.vans.map(v => v.chassis));
  const keptCurrent = keptConflicts();
  for (const v of plan.vans) {
    const ex = dbVans.get(v.chassis);
    if (!ex) { d.newVans.push(v); continue; }
    d.fieldsVans.push({ id: ex.id, v });
    // Dates and status: a date is only changed to a real date; a status only moves forward
    // (planned → in production → finished), or to cancelled when the sheet says so.
    if (v.eta && v.eta !== ex.eta) d.dateChanges.push({ van_id: ex.id, chassis: ex.chassis, from: ex.eta, to: v.eta });
    if (v.status !== ex.status) {
      const fwd = v.status === 'cancelled' ? !['completed', 'cancelled'].includes(ex.status)
        : ex.status !== 'cancelled' && RANK[v.status] > RANK[ex.status];
      (fwd ? d.statusChanges : d.statusKept).push({ van_id: ex.id, chassis: ex.chassis, from: ex.status, to: v.status });
    }
    // Finished / cancelled vans: only the status changes, their lines are left as they are.
    if (['completed', 'cancelled'].includes(ex.status) || ['completed', 'cancelled'].includes(v.status)) continue;

    const lines = all(`SELECT l.*, i.sku, i.name, i.unit, i.placeholder AS ph FROM van_lines l JOIN items i ON i.id = l.item_id
                       WHERE l.van_id = ? AND l.source = 'plan' ORDER BY l.id`, ex.id);
    // A van loaded from a dealer order (its parts come from the rules): the plan's cells are not added
    // on top (that would order everything twice). Only its date and status follow the sheet.
    if (!lines.length && get(`SELECT 1 FROM van_lines WHERE van_id = ? LIMIT 1`, ex.id)) { d.dealerVans.push({ van_id: ex.id, chassis: ex.chassis }); continue; }
    const otherItems = new Map(all(`SELECT item_id, plan_column FROM van_lines WHERE van_id = ? AND issued < qty`, ex.id).map(r => [r.item_id, r.plan_column]));
    const entries = vanEntries(v, ctx, otherItems);
    // What the sheet said last time: a cell with the same text as before is not new, even if its line
    // is gone (merged into another line or removed by the office) — it is never added back.
    const before = new Map(all(`SELECT label, value FROM order_fields WHERE van_id = ? AND section = ?`, ex.id, PLAN_SECTION).map(f => [f.label, norm(f.value)]));
    // Received for this van but no longer on any of its lines (borrowed by another van, found missing at
    // a count, corrected…): already booked once, so a grey cell must not book it again.
    const booked = new Map(all(`SELECT m.item_id, SUM(m.qty) AS rec FROM movements m WHERE m.van_id = ? AND m.type = 'receive' GROUP BY m.item_id`, ex.id)
      .map(r => [r.item_id, r.rec]));
    const held = new Map(all(`SELECT item_id, SUM(reserved + issued) AS h FROM van_lines WHERE van_id = ? GROUP BY item_id`, ex.id).map(r => [r.item_id, r.h]));
    const gone = new Map([...booked].map(([id, rec]) => [id, Math.max(0, rec - (held.get(id) || 0))]));
    const headers = [...new Set([...entries.map(e => e.cell.header), ...lines.map(l => l.plan_column)])];
    for (const h of headers) {
      const es = entries.filter(e => e.cell.header === h);
      const ls = lines.filter(l => l.plan_column === h);
      const pairs = [];
      // Same part first (also a line the clean-up / office moved off the catch-all: note "was PLAN-…").
      for (const e of [...es]) {
        const i = ls.findIndex(l => (e.item.id != null && l.item_id === e.item.id) || (e.fromSku && skuNames(e.fromSku).some(s => String(l.note || '').includes(`was ${s}`))));
        if (i < 0) continue;
        pairs.push([e, ls.splice(i, 1)[0]]);
        es.splice(es.indexOf(e), 1);
      }
      while (es.length && ls.length) pairs.push([es.shift(), ls.shift()]);
      for (const e of es) {
        if (before.get(h) === norm(e.cell.text)) continue; // unchanged cell: its line was merged / removed on purpose
        d.newLines.push({ van_id: ex.id, chassis: ex.chassis, e });
      }
      for (const l of ls) {
        if (l.issued < l.qty - 1e-9 && !String(l.note || '').includes(NOT_IN_PLAN)) d.removedLines.push({ line_id: l.id, chassis: ex.chassis, column: h, name: l.name, spec: l.spec });
      }
      for (const [e, l] of pairs) {
        const newQty = e.p.qty > 0 ? e.p.qty : 1;
        let qtyAfter = l.qty;
        let state = l.state;
        // (the app's own Excel export writes "1 x <part>" for a line with no plan text: not a change)
        const ownExport = e.cell.text.split(/;\s*/).some(t => norm(t) === norm(`${q(l.qty)} x ${l.name}`));
        // "Black Jack" → "Black Jack Gave to Alex": the part was handed out for this van (user-r1-5). Same
        // part, still open, not a reminder line: closed as given out (not a "plan changed" conflict).
        const g = e.cell.status !== 'done' && !['customer', 'tbd'].includes(l.state) && l.issued < l.qty - 1e-9 ? givenTo(e.cell.text) : null;
        const samePart = e.item.id === l.item_id || e.item.placeholder || e.item.id == null || skuNames(e.fromSku).some(s => String(l.note || '').includes(`was ${s}`));
        if (g && samePart && !ownExport) {
          d.given.push({ line_id: l.id, van_id: ex.id, chassis: ex.chassis, column: h, name: l.name, text: e.cell.text, to: g.name, reserved: l.reserved,
            newText: norm(l.spec) !== norm(e.cell.text) });
          continue;
        }
        if (norm(l.spec) !== norm(e.cell.text) && !ownExport) {
          // Never back from a real part to a catch-all the office (or the clean-up) moved it off.
          const item = (e.item.placeholder || e.item.id == null) && !l.ph ? { id: l.item_id, sku: l.sku, name: l.name } : e.item;
          const now = { spec: e.cell.text, qty: newQty, item_id: item.id, sku: item.sku, name: item.name, po_ref: poRef(e.cell.text) };
          if (l.reserved <= 1e-9 && l.issued <= 1e-9) {
            const newState = l.state || (e.cell.status === 'done' ? '' : detectState(e.cell.text));
            d.textUpdates.push({ line_id: l.id, chassis: ex.chassis, column: h, was: { spec: l.spec, qty: l.qty, item_id: l.item_id, name: l.name }, now, state: newState });
            qtyAfter = newQty; state = newState;
          } else if (!keptCurrent.some(k => k.line_id === l.id && norm(k.spec) === norm(e.cell.text))) {
            // (not when the office already said "Keep current" to this same new text)
            d.conflicts.push({ line_id: l.id, van_id: ex.id, chassis: ex.chassis, column: h, was: { spec: l.spec, qty: l.qty, item_id: l.item_id, name: l.name },
              now, reserved: l.reserved, issued: l.issued, at: today() });
          }
        }
        if (['customer', 'tbd'].includes(state)) continue;
        // Grey: only up to what the line needs, so a delivery already booked is never booked twice.
        if (e.cell.status === 'received') {
          const target = Math.min(qtyAfter, newQty);
          let add = target - l.reserved - l.issued;
          const already = Math.min(Math.max(0, add), gone.get(l.item_id) || 0);
          if (already > 0) { gone.set(l.item_id, gone.get(l.item_id) - already); add -= already; }
          if (add > 1e-9) d.receipts.push({ line_id: l.id, chassis: ex.chassis, column: h, name: l.name, qty: add, unit: l.unit });
        }
        // Blue: closed like "Already fitted".
        if (e.cell.status === 'done' && l.issued < qtyAfter - 1e-9) d.fitted.push({ line_id: l.id, van_id: ex.id, chassis: ex.chassis, column: h, name: l.name });
      }
    }
  }
  for (const v of dbVans.values()) {
    if (onSheet.has(v.chassis) || !['planned', 'in_production'].includes(v.status) || String(v.notes || '').includes(NOT_IN_PLAN)) continue;
    d.removedVans.push({ van_id: v.id, chassis: v.chassis, status: v.status });
  }
  return d;
}

const short = s => (clean(s).length > 60 ? clean(s).slice(0, 58) + '…' : clean(s));
function diffSummary(d) {
  const newLineCount = d.newVans.reduce((s, v) => s + v.cells.length, 0) + d.newLines.length;
  return {
    counts: { newVans: d.newVans.length, newLines: d.newLines.length, newVanCells: newLineCount - d.newLines.length,
      dates: d.dateChanges.length, statuses: d.statusChanges.length, textUpdates: d.textUpdates.length,
      receipts: d.receipts.length + d.newLines.filter(n => n.e.cell.status === 'received').length, fitted: d.fitted.length,
      conflicts: d.conflicts.length, removedVans: d.removedVans.length, removedLines: d.removedLines.length, statusKept: d.statusKept.length,
      given: d.given.length },
    given: d.given.map(g => ({ chassis: g.chassis, column: g.column, name: g.name, text: short(g.text), to: g.to, reserved: g.reserved })),
    newVans: d.newVans.map(v => ({ chassis: v.chassis, model: v.model, status: v.status, eta: v.eta, cells: v.cells.length })),
    dateChanges: d.dateChanges, statusChanges: d.statusChanges, statusKept: d.statusKept,
    textUpdates: d.textUpdates.map(t => ({ chassis: t.chassis, column: t.column, was: short(t.was.spec), now: short(t.now.spec), qty: t.now.qty })),
    newLines: d.newLines.map(n => ({ chassis: n.chassis, column: n.e.cell.header, text: short(n.e.cell.text), status: n.e.cell.status })),
    receipts: [...d.receipts, ...d.newLines.filter(n => n.e.cell.status === 'received').map(n => ({ chassis: n.chassis, column: n.e.cell.header,
      name: n.e.item.name, qty: n.e.p.qty > 0 ? n.e.p.qty : 1, unit: n.e.item.unit, newLine: 1 }))],
    fitted: d.fitted,
    conflicts: d.conflicts.map(c => ({ chassis: c.chassis, column: c.column, was: short(c.was.spec), now: short(c.now.spec),
      message: `Plan changed after parts were set aside: was ${short(c.was.spec) || '(blank)'}, now ${short(c.now.spec)} – check` })),
    removedVans: d.removedVans, removedLines: d.removedLines.map(r => ({ ...r, spec: short(r.spec) })),
    dealerVans: d.dealerVans,
  };
}

// Preview (apply false: nothing is written) or do it (apply true, all in one transaction).
export function planUpdate(buffer, { apply = false, file = '', by = '' } = {}) {
  const plan = readPlan(buffer);
  if (!apply) return { mode: 'update', ...diffSummary(updateDiff(plan, planContext(plan, { create: false }))) };
  syncCatalog();
  return tx(() => {
    ensureNewItems();
    const ctx = planContext(plan);
    const d = updateDiff(plan, ctx);
    const stats = { vans: 0, lines: 0, received: 0, ordered: 0, done: 0, notOrdered: 0 };
    const who = by || 'Plan update';
    const touched = new Set();
    for (const v of d.newVans) insertPlanVan(v, ctx, stats, {}, { noteTxt: UPDATE_NOTE });
    // The sheet's text for each existing van (what the plan grid shows) follows the sheet.
    for (const { id, v } of d.fieldsVans) {
      run('DELETE FROM order_fields WHERE van_id = ? AND section = ?', id, PLAN_SECTION);
      planFields(id, v, 1000);
    }
    for (const t of d.textUpdates) {
      const l = get('SELECT * FROM van_lines WHERE id = ?', t.line_id);
      if (!l || l.reserved > 1e-9 || l.issued > 1e-9) continue;
      run('UPDATE van_lines SET spec = ?, qty = ?, item_id = ?, po_ref = ?, state = ? WHERE id = ?', t.now.spec, t.now.qty, t.now.item_id, t.now.po_ref, t.state, l.id);
      logAlloc('plan update', { van_id: l.van_id, item_id: t.now.item_id, line_id: l.id, field: 'plan text', before: `${q(l.qty)} × "${l.spec}"`, after: `${q(t.now.qty)} × "${t.now.spec}"`, worker: who,
        note: t.now.item_id !== l.item_id ? `part changed from ${t.was.name} to ${t.now.name}` : '' });
      touched.add(l.item_id); touched.add(t.now.item_id);
    }
    for (const n of d.newLines) {
      const id = insertLine(n.van_id, 'planned', n.e, ctx, stats, { noteTxt: UPDATE_NOTE });
      logAlloc('plan update', { van_id: n.van_id, item_id: n.e.item.id, line_id: id, field: 'new line', after: `${n.e.cell.header}: ${n.e.cell.text}`, worker: who });
      touched.add(n.e.item.id);
    }
    let receipts = 0;
    for (const r of d.receipts) receipts += receiveForLine(r.line_id, r.qty, { ref: 'Production plan update', by: who }) > 0 ? 1 : 0;
    const fittedByVan = new Map();
    for (const f of d.fitted) { if (!fittedByVan.has(f.van_id)) fittedByVan.set(f.van_id, []); fittedByVan.get(f.van_id).push(f.line_id); }
    for (const [vanId, ids] of fittedByVan) markFitted(vanId, ids, who);
    // "Gave to Alex": closed as given out to the van (set-aside stock booked out, see closeAsGiven).
    for (const g of d.given) {
      const l = get('SELECT spec FROM van_lines WHERE id = ?', g.line_id);
      if (l && g.newText) {
        run('UPDATE van_lines SET spec = ? WHERE id = ?', g.text, g.line_id);
        logAlloc('plan update', { van_id: g.van_id, line_id: g.line_id, field: 'plan text', before: `"${l.spec}"`, after: `"${g.text}"`, worker: who });
      }
      closeAsGiven(g.line_id, { reason: 'plan update', by: who, text: g.text });
    }
    for (const c of d.dateChanges) updateVan(c.van_id, { eta: c.to });
    for (const c of d.statusChanges) updateVan(c.van_id, { status: c.to });
    for (const r of d.removedLines) {
      const l = get('SELECT note FROM van_lines WHERE id = ?', r.line_id);
      run('UPDATE van_lines SET note = ? WHERE id = ?', appendNote(l.note, NOT_IN_PLAN), r.line_id);
      logAlloc('plan update', { line_id: r.line_id, field: 'flag', after: NOT_IN_PLAN, worker: who, note: `${r.chassis} · ${r.column}` });
    }
    for (const r of d.removedVans) {
      const v = get('SELECT notes FROM vans WHERE id = ?', r.van_id);
      run('UPDATE vans SET notes = ? WHERE id = ?', [v.notes, `${NOT_IN_PLAN} (${today()})`].filter(Boolean).join('\n'), r.van_id);
      logAlloc('plan update', { van_id: r.van_id, field: 'flag', after: NOT_IN_PLAN, worker: who });
    }
    // Conflicts wait for "Use new" / "Keep current" (one entry per line, the newest wins).
    const keep = planConflictsRaw().filter(c => !d.conflicts.some(n => n.line_id === c.line_id));
    setSetting('plan_conflicts', JSON.stringify([...keep, ...d.conflicts]));
    for (const c of d.conflicts) logAlloc('plan update', { van_id: c.van_id, item_id: c.was.item_id, line_id: c.line_id, field: 'flag', before: c.was.spec, after: c.now.spec, worker: who,
      note: 'Plan changed after parts were set aside – check' });
    for (const itemId of touched) if (itemId) allocateItem(itemId, null, { reason: 'plan update', worker: who });
    finishImport(plan);
    const sum = diffSummary(d);
    const out = { mode: 'update', ...sum, done: { ...stats, receipts, purchaseOrders: ctx.pos.size } };
    recordImport({ file, mode: 'update', by, counts: sum.counts });
    return out;
  });
}

// ── "Plan changed after parts were set aside" ──

function planConflictsRaw() {
  try { return JSON.parse(getSetting('plan_conflicts', '[]')) || []; } catch { return []; }
}
// "Keep current" answers: {line_id, spec} — the same new plan text isn't asked about again.
function keptConflicts() {
  try { return JSON.parse(getSetting('plan_conflicts_kept', '[]')) || []; } catch { return []; }
}
export function planConflicts() {
  return planConflictsRaw().map(c => {
    const l = get(`SELECT l.qty, l.reserved, l.issued, l.spec, i.name, i.unit FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?`, c.line_id);
    return l ? { ...c, current: l, message: `Plan changed after parts were set aside: was ${short(c.was.spec) || '(blank)'}, now ${short(c.now.spec)} – check` } : null;
  }).filter(Boolean);
}

// use 'new': the line takes the plan's new text / quantity (and part); 'current': it stays as it is.
export function resolvePlanConflict(lineId, use, by = '') {
  if (!['new', 'current'].includes(use)) throw httpError(400, 'Pick "Use new" or "Keep current"');
  return tx(() => {
    const list = planConflictsRaw();
    const c = list.find(x => x.line_id === Number(lineId));
    if (!c) throw httpError(404, 'Already answered — refresh');
    const rest = list.filter(x => x !== c);
    const l = get('SELECT l.*, v.chassis FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.id = ?', c.line_id);
    if (l && use === 'new') {
      const itemChanges = c.now.item_id && c.now.item_id !== l.item_id;
      if (itemChanges && l.issued > 1e-9) throw httpError(400, 'Part of this line is already fitted — keep it, and add the new part to the van by hand');
      const qty = Math.max(c.now.qty, l.issued);
      if (itemChanges) {
        // What was set aside for the old part goes back to the shelf (a bought-for-van part shows up on
        // "no van – assign to a van"); the line then waits for the new part.
        if (l.reserved > 1e-9) logAlloc('plan update', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0, worker: by,
          firm_change: -l.reserved_firm, note: `plan changed to ${c.now.name}: set-aside of the old part back on the shelf` });
        run('UPDATE van_lines SET item_id = ?, reserved = 0, reserved_firm = 0, qty = ?, spec = ?, po_ref = ? WHERE id = ?', c.now.item_id, qty, c.now.spec, c.now.po_ref || '', l.id);
        allocateItem(l.item_id, null, { reason: 'plan update', worker: by });
        allocateItem(c.now.item_id, l.van_id, { reason: 'plan update', worker: by });
      } else {
        const reserved = Math.min(l.reserved, Math.max(0, qty - l.issued));
        if (reserved < l.reserved - 1e-9) logAlloc('plan update', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: reserved, worker: by,
          firm_change: Math.min(l.reserved_firm, reserved) - l.reserved_firm, note: 'plan quantity lowered: the extra back on the shelf' });
        run('UPDATE van_lines SET qty = ?, reserved = ?, reserved_firm = MIN(reserved_firm, ?), spec = ?, po_ref = ? WHERE id = ?', qty, reserved, reserved, c.now.spec, c.now.po_ref || '', l.id);
        allocateItem(l.item_id, l.van_id, { reason: 'plan update', worker: by });
      }
    }
    logAlloc('plan update', { van_id: c.van_id, item_id: c.was.item_id, line_id: c.line_id, field: 'conflict', before: c.was.spec, after: c.now.spec, worker: by,
      note: use === 'new' ? 'Use new: line changed to the plan' : 'Keep current: line left as it was' });
    setSetting('plan_conflicts', JSON.stringify(rest));
    if (use === 'current') {
      const kept = keptConflicts().filter(k => k.line_id !== c.line_id);
      setSetting('plan_conflicts_kept', JSON.stringify([...kept, { line_id: c.line_id, spec: c.now.spec }].slice(-500)));
    }
    return { ok: true };
  });
}

export function planColumns() {
  try { return JSON.parse(get(`SELECT value FROM settings WHERE key = 'plan_columns'`)?.value || '[]'); } catch { return []; }
}
