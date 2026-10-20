// One-off stock clean-up, run at start-up (server.js calls runTidy() once).
//
// Safe on the real database and safe to run again:
//   - a backup of factory.db is taken first (data/backups/before-tidy-<date>); if it fails, nothing runs
//   - each step runs once (settings flag 'tidy_<step>_v1') and only touches rows that still need it
//   - each step runs in one transaction (all or nothing)
//   - every change is written to allocation_log with reason 'tidy:<step>' and before -> after,
//     so the Clean-up report page can show the office exactly what changed.
// Step order matters: locks first, so every later step respects them.
//   lock -> plan quantities -> duplicate merge -> placeholders -> re-links -> sure auto-links (round 2) ->
//   new parts + their links, notes without line numbers (round 3) ->
//   line states -> "...." re-check (round 2) -> order numbers re-read (round 2) ->
//   "Gave to Alex" lines booked out (round 2, batch 3) -> kinds -> suppliers ->
//   PO specs -> PO tidy -> plan POs' ordered date unknown (Small fixes & phone round 1)
//   -> notes on "merge all" that moved nothing (Small fixes & phone round 1, batch 3)
//   -> part code typo PLAN-ROOF-BAW → PLAN-ROOF-BOW (follow-up round 1, planner batch)
// Later steps are added to STEPS in that order.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, all, get, run, tx, getSetting, setSetting, logAlloc, DATA_DIR, syncSuppliers } from './db.js';
import { cellParts } from './importPlan.js';
import { normHeader, capFor, poRef, poRefV1 } from './planMap.js';
import { itemMedians, allocateItem, closeAsGiven, PLAN_PO_SQL } from './inventory.js';
import { detectState, detectStateV1, STATE_LABEL, specForPo, givenTo, pickedUp } from './lineState.js';
import { NAME_FIXES, SKU_RENAMES, skuNow, RELINKS, relinkTarget, ensureNewItems, linkLine, isPlaceholderSku, suggestionsFor, linkableItems, learnedLinks, planLineName, dupFlag, withMergedCols, mergedCols } from './relink.js';

const ACTIVE = `v.status IN ('planned','in_production')`;
const IMPORT_NOTE = 'Received for this van (production plan import)';
const q = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
const appendNote = (note, add) => (String(note || '').includes(add) ? note : [note, add].filter(Boolean).join(' · '));
const log = (step, row) => logAlloc(`tidy:${step}`, row);

// ── 1. lock: stock received for a van stays with that van ──
// Per van + item: received for the van = 'receive' movements booked for that van (the production
// plan import's grey cells, PO deliveries for the van, deliveries booked for it on the floor).
// Locked = min(set aside, received - already fitted), spread over the van's lines in line order.
// Anything set aside above what was received for the van stays flexible.
function stepLock() {
  const rec = all(`SELECT m.van_id, m.item_id, SUM(m.qty) AS rec FROM movements m JOIN vans v ON v.id = m.van_id
                   WHERE m.type = 'receive' AND ${ACTIVE} GROUP BY m.van_id, m.item_id HAVING rec > 0`);
  let n = 0;
  for (const r of rec) {
    const lines = all('SELECT * FROM van_lines WHERE van_id = ? AND item_id = ? ORDER BY id', r.van_id, r.item_id);
    const issued = lines.reduce((s, l) => s + l.issued, 0);
    let left = Math.max(0, r.rec - issued) - lines.reduce((s, l) => s + l.reserved_firm, 0);
    for (const l of lines) {
      if (left <= 1e-9) break;
      if (l.reserved_firm > 0 || l.reserved <= 0) continue;
      const lock = Math.min(l.reserved, left);
      run('UPDATE van_lines SET reserved_firm = ? WHERE id = ? AND reserved_firm = 0', lock, l.id);
      log('lock', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'locked', before: 0, after: q(lock),
        note: `received for this van ${q(r.rec)}, fitted ${q(issued)}, set aside ${q(l.reserved)}` });
      left -= lock;
      n++;
    }
  }
  return n;
}

// ── 2. plan quantities read wrongly from codes / order numbers ("634M" → 634 m of vinyl) ──
function stepPlanQty() {
  const lines = all(`SELECT l.*, i.sku, i.unit, i.placeholder, i.plan_column AS item_col, i.on_hand, v.chassis
                     FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id
                     WHERE l.source = 'plan' AND l.issued = 0 AND trim(l.spec) <> ''`);
  const usual = itemMedians(lines.map(l => l.item_id));
  const rows = new Map();
  let n = 0;
  for (const l of lines) {
    if (!rows.has(l.van_id)) rows.set(l.van_id, all(`SELECT label, value FROM order_fields WHERE van_id = ? AND section = 'PRODUCTION PLAN'`, l.van_id));
    const fields = rows.get(l.van_id);
    const rowGet = name => fields.find(f => normHeader(f.label).startsWith(normHeader(name)))?.value || '';
    let parts;
    try { parts = cellParts({ header: l.plan_column, text: l.spec }, rowGet); } catch { continue; }
    const ph = l.placeholder || isPlaceholderSku(l.sku);
    const p = parts.find(x => x.sku === l.sku) || (ph ? parts.find(x => x.generic) : null);
    if (!p) continue;
    const newQty = p.qty > 0 ? p.qty : 1;
    if (Math.abs(newQty - l.qty) < 1e-9) continue;
    const med = usual.get(l.item_id) || 0;
    const cap = capFor(l.plan_column || l.item_col, l.unit, med);
    if (!(l.qty > cap || (med > 0 && l.qty > 3 * med))) continue; // looks plausible: leave it
    const cur = get('SELECT * FROM van_lines WHERE id = ?', l.id);
    if (cur.issued > 0) continue;
    const newRes = Math.min(cur.reserved, newQty);
    const freed = cur.reserved - newRes;
    const note = `Plan quantity corrected (was ${q(cur.qty)})`;
    run('UPDATE van_lines SET qty = ?, reserved = ?, reserved_firm = MIN(reserved_firm, ?), note = ? WHERE id = ?',
        newQty, newRes, newRes, appendNote(cur.note, note), l.id);
    log('plan_qty', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'qty', before: q(cur.qty), after: q(newQty),
      note: `plan text "${l.spec}"${freed ? `; set aside ${q(cur.reserved)} -> ${q(newRes)}` : ''}` });
    n++;
    if (freed <= 0) continue;
    // The wrong quantity was also booked onto the shelf by the import ("received" cell). Take that
    // back off — never more than the import booked for this line, never below 0, and not at all if
    // someone has counted or corrected this item since (their figure wins; office checks it).
    const imp = get(`SELECT * FROM movements WHERE van_id = ? AND item_id = ? AND type = 'receive' AND note = ?
                     ORDER BY abs(qty - ?), id LIMIT 1`, l.van_id, l.item_id, IMPORT_NOTE, cur.qty);
    if (!imp) {
      log('plan_qty', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'flag', note: `${q(freed)} freed stays as free stock (not booked in by the plan import)` });
      continue;
    }
    const later = get(`SELECT at, type FROM movements WHERE item_id = ? AND type IN ('adjust','count') AND id > ? ORDER BY id DESC LIMIT 1`, l.item_id, imp.id);
    if (later) {
      log('plan_qty', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'flag', before: q(freed), after: '',
        note: `quantity fixed, shelf figure not changed – please check (item was ${later.type === 'count' ? 'counted' : 'corrected'} on ${later.at.slice(0, 10)})` });
      continue;
    }
    const onHand = get('SELECT on_hand FROM items WHERE id = ?', l.item_id).on_hand;
    const cut = Math.max(0, Math.min(freed, imp.qty, onHand));
    if (cut <= 0) continue;
    run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', cut, l.item_id);
    run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note) VALUES(?, ?, 'adjust', ?, ?, ?)`, l.item_id, -cut, l.van_id, l.chassis, note);
    log('plan_qty', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'on_hand', before: q(onHand), after: q(onHand - cut), note });
  }
  // Odd quantities the parser itself isn't sure about are only flagged (the van page shows "please check").
  return n;
}

// ── 3. exact duplicate lines (same van, item, plan column and text) become one ──
function stepMergeDupes() {
  const groups = all(`SELECT van_id, item_id, plan_column, spec, COUNT(*) AS c FROM van_lines
                      GROUP BY van_id, item_id, plan_column, spec HAVING c > 1`);
  const poHasLine = all('PRAGMA table_info(po_lines)').some(c => c.name === 'line_id');
  let n = 0;
  for (const g of groups) {
    const lines = all('SELECT * FROM van_lines WHERE van_id = ? AND item_id = ? AND plan_column = ? AND spec = ? ORDER BY id',
                      g.van_id, g.item_id, g.plan_column, g.spec);
    const keep = lines[0];
    let { qty, reserved, reserved_firm: firm, issued, note, po_ref: poRef, merged_cols: mcols } = keep;
    for (const o of lines.slice(1)) {
      qty += o.qty; reserved += o.reserved; firm += o.reserved_firm; issued += o.issued;
      mcols = withMergedCols(mcols, keep.plan_column, mergedCols(o.merged_cols)); // round 4: keep merged plan cells
      // Round 3 (user-r2-3): the note names the plan line, never a line number.
      note = appendNote(appendNote(note, o.note), `merged from the plan line ${planLineName(o.plan_column, '')} (it was listed ${lines.length} times)`);
      if (o.po_ref && !String(poRef).split(', ').includes(o.po_ref)) poRef = [poRef, o.po_ref].filter(Boolean).join(', ');
      run('UPDATE allocation_log SET line_id = ? WHERE line_id = ?', keep.id, o.id);
      if (poHasLine) run('UPDATE po_lines SET line_id = ? WHERE line_id = ?', keep.id, o.id);
      run('DELETE FROM van_lines WHERE id = ?', o.id);
      log('merge_dupes', { van_id: g.van_id, item_id: g.item_id, line_id: keep.id, field: 'merged',
        before: `the same plan line again: need ${q(o.qty)}, set aside ${q(o.reserved)}, fitted ${q(o.issued)}`,
        after: 'into the first one', note: g.plan_column || g.spec });
      n++;
    }
    run('UPDATE van_lines SET qty = ?, reserved = ?, reserved_firm = ?, issued = ?, note = ?, po_ref = ?, merged_cols = ?, urgent = (SELECT MAX(urgent) FROM van_lines WHERE id = ?) WHERE id = ?',
        Math.max(qty, issued), reserved, Math.min(firm, reserved), issued, note, poRef, mcols || '', keep.id, keep.id);
  }
  return n;
}

// ── 4. "(as per plan)" catch-alls are marked, and their names' spelling fixed ──
function stepPlaceholders() {
  let n = 0;
  for (const i of all(`SELECT * FROM items WHERE (sku LIKE 'PLAN-%' OR category = 'As per plan') AND placeholder = 0`)) {
    run('UPDATE items SET placeholder = 1 WHERE id = ?', i.id);
    log('placeholder', { item_id: i.id, field: 'placeholder', before: 0, after: 1, note: `${i.sku} – ${i.name}` });
    n++;
  }
  for (const i of all('SELECT * FROM items WHERE placeholder = 1')) {
    const name = NAME_FIXES.reduce((s, [re, to]) => s.replace(re, to), i.name);
    if (name === i.name) continue;
    run('UPDATE items SET name = ? WHERE id = ?', name, i.id);
    log('placeholder', { item_id: i.id, field: 'name', before: i.name, after: name });
    n++;
  }
  return n;
}

// ── 5. catch-all lines that clearly name a real part are moved onto that part ──
function stepRelink() {
  let n = 0;
  for (const sku of ensureNewItems()) {
    const it = get('SELECT * FROM items WHERE sku = ?', sku);
    log('relink', { item_id: it.id, field: 'new item', before: '', after: `${sku} – ${it.name}`, note: 'comes up often on the production plan' });
  }
  const lines = all(`SELECT l.id, l.spec, i.sku FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id
                     WHERE ${ACTIVE} AND (i.placeholder = 1 OR i.sku LIKE 'PLAN-%') ORDER BY l.id`);
  for (const l of lines) {
    const target = relinkTarget(l.sku, l.spec);
    if (!target) continue;
    const to = get('SELECT id FROM items WHERE sku = ?', target);
    if (!to) continue;
    const r = linkLine(l.id, to.id, { reason: 'tidy:relink' });
    if (r.result !== 'skipped') n++;
  }
  return n;
}

// ── 5b. special parts whose text plainly names one catalogue part (round 2, user-r1-2) ──
// Only "sure" matches (relink.js suggestLink): on the reviewed list, the same text linked the same way
// by a person before, or a model number that is in exactly one part's name ("PR8235"). Uses the same
// safe linkLine as the office button: a van that already has a line for that part is merged only when
// it's clearly the same need, otherwise left "to confirm" marked "possible duplicate"; only the stock set
// aside on the line moves (two adjust movements); fitted parts are not moved.
// Round 3 (user-r2-3): same rules as the screens (suggestionsFor) — never a part the van already has, never
// one part for two lines of one van.
function stepAutoLink() {
  let n = 0;
  const items = linkableItems(), learned = learnedLinks();
  const lines = all(`SELECT l.id, l.van_id, l.spec, l.plan_column, i.sku, i.name FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id
                     WHERE ${ACTIVE} AND (i.placeholder = 1 OR i.sku LIKE 'PLAN-%') AND l.issued < l.qty ORDER BY l.id`);
  const sugg = suggestionsFor(lines, { items, learned });
  for (const l of lines) {
    const s = sugg.get(l.id)?.suggest;
    if (!s || !s.sure) continue;
    const r = linkLine(l.id, s.item_id, { reason: 'tidy:autolink', why: `"${l.spec}" → ${s.sku}: ${s.why}` });
    if (r.result === 'linked' || r.result === 'merged') n++;
  }
  return n;
}

// ── 5c. round 3 (user-r2-3): the Thetford 175L fridge and the white round Razor basin ──
// Creates the two parts if they are missing (ensureNewItems: only when the SKU doesn't exist, so a part the
// office made inactive is never brought back) and moves the catch-all lines whose plan text names them
// (the round-3 entries of the reviewed list) onto them with the same safe linkLine as everywhere else.
// On a fresh database the relink step already does this (it uses the whole reviewed list): 0 here.
function stepPartsR3() {
  let n = 0;
  for (const sku of ensureNewItems()) {
    const it = get('SELECT * FROM items WHERE sku = ?', sku);
    log('parts_r3', { item_id: it.id, field: 'new item', before: '', after: `${sku} – ${it.name}`,
      note: `comes up on the production plan${it.supplier ? ` · supplier ${it.supplier} (check)` : ''}` });
    n++;
  }
  const r3 = RELINKS.filter(r => r.r3);
  const lines = all(`SELECT l.id, l.spec, i.sku FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id
                     WHERE ${ACTIVE} AND (i.placeholder = 1 OR i.sku LIKE 'PLAN-%') AND l.issued < l.qty ORDER BY l.id`);
  for (const l of lines) {
    const hit = r3.find(r => r.fromSku === l.sku && r.re.test(String(l.spec || '')));
    if (!hit) continue;
    const to = get('SELECT id, sku FROM items WHERE sku = ? AND active = 1', hit.toSku);
    if (!to) continue;
    const r = linkLine(l.id, to.id, { reason: 'tidy:parts_r3', why: `"${l.spec}" → ${to.sku}: on the reviewed list of plan texts` });
    if (r.result === 'linked' || r.result === 'merged') n++;
  }
  return n;
}

// ── 5d. round 3 (user-r2-3): notes say which plan line, not a line number ──
// "merged from line 812 (PLAN-SLIDING-DOOR-PELMET: Nikpol 13)" → "merged from the plan line Sliding Door Pelmet
// ("Nikpol 13")"; "merged from line 812" (exact duplicates) → "merged from the plan line <its column> (it was
// listed twice)"; "possible duplicate of line 640" → "possible duplicate of this van's "Sliding door rail +
// pelmet" line (for: Sliding Door Railing)". Only these words change; the old note is kept in the log
// (before → after). A note that no longer has a line number is never touched again (safe to run twice).
function stepNotesR3() {
  let n = 0;
  const rows = all(`SELECT l.id, l.van_id, l.item_id, l.note, l.plan_column, i.name FROM van_lines l JOIN items i ON i.id = l.item_id
                    WHERE l.note LIKE '%merged from line %' OR l.note LIKE '%possible duplicate of line %' ORDER BY l.id`);
  for (const l of rows) {
    let note = String(l.note)
      .replace(/merged from line \d+ \((PLAN-[^\s:)]+)(?:: (.*?))?\)(?=\s*(?:·|$))/g, (_, sku, spec) => {
        const ph = get('SELECT name, plan_column FROM items WHERE sku = ?', skuNow(sku));
        return `merged from the plan line ${planLineName(ph?.plan_column, ph?.name || sku)}${spec ? ` ("${spec}")` : ''}`;
      })
      .replace(/merged from line \d+(?! \()/g, () => `merged from the plan line ${planLineName(l.plan_column, l.name)} (it was listed twice)`)
      .replace(/possible duplicate of line (\d+)/g, (_, id) => {
        const e = get('SELECT l.plan_column, i.name FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?', Number(id));
        return e ? dupFlag(e.name, e) : 'possible duplicate of another line on this van';
      });
    if (note === l.note) continue;
    run('UPDATE van_lines SET note = ? WHERE id = ?', note, l.id);
    log('notes_r3', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'note', before: l.note, after: note });
    n++;
  }
  return n;
}

// ── 5e. round 4 (check-r3-3): plan lines merged before this version keep their colour ──
// A plan line merged into the van's own line used to be deleted, so its cell on the Production plan (and in
// the Excel export) went blank. New merges record the plan column on the van's line (van_lines.merged_cols).
// This step does the same for merges already made, from the history ('merged' rows of the allocation log,
// whose `before` names the plan line: "plan line Sliding Door Pelmet ("Nikpol 13") on PLAN-…", or the older
// "line 812 (PLAN-…: text)"). Only a name that is a real plan column is used; only adds, never removes;
// a column already listed is skipped (safe to run twice).
function stepMergedCols() {
  let n = 0;
  let planCols = [];
  try { planCols = JSON.parse(getSetting('plan_columns', '[]')); } catch { /* none */ }
  const known = [...new Set([...planCols, ...all(`SELECT DISTINCT plan_column AS c FROM van_lines WHERE plan_column <> ''
                                                   UNION SELECT DISTINCT plan_column FROM items WHERE plan_column <> ''`).map(r => r.c)])]
    .filter(Boolean).sort((a, b) => b.length - a.length); // longest first: "Sliding Door Pelmet" before "Sliding Door"
  const rows = all(`SELECT a.before, l.id, l.van_id, l.item_id, l.plan_column, l.merged_cols, i.plan_column AS item_col, i.category
                    FROM allocation_log a JOIN van_lines l ON l.id = a.line_id JOIN items i ON i.id = l.item_id
                    WHERE a.field = 'merged' AND a.reason NOT LIKE 'tidy:merge_dupes' ORDER BY a.id`);
  for (const r of rows) {
    const b = String(r.before || '');
    let col = '';
    const old = /^line \d+ \((PLAN-[^\s:)]+)/.exec(b);
    if (old) col = get('SELECT plan_column FROM items WHERE sku = ?', skuNow(old[1]))?.plan_column || '';
    else if (b.startsWith('plan line ')) {
      const rest = b.slice('plan line '.length);
      col = known.find(c => rest.startsWith(`${c} ("`) || rest.startsWith(`${c} on `)) || '';
    }
    if (!col) continue;
    const own = r.plan_column || r.item_col || r.category;
    const cur = get('SELECT merged_cols FROM van_lines WHERE id = ?', r.id).merged_cols;
    const next = withMergedCols(cur, own, col);
    if (next === cur) continue;
    run('UPDATE van_lines SET merged_cols = ? WHERE id = ?', next, r.id);
    log('merged_cols', { van_id: r.van_id, item_id: r.item_id, line_id: r.id, field: 'merged_cols', before: cur, after: next,
      note: `the plan cell "${col}" is coloured from this line (its plan line was merged into it)` });
    n++;
  }
  return n;
}

// ── 6. "customer supplies" / "to be decided" lines (C5) ──
// Only lines with no status yet and nothing fitted. The shelf stock merely held for them (reserved −
// reserved_firm) goes back to free stock and on to the next van waiting (logged). Stock received for
// the van (locked) is NOT released: the line goes on the "please check" list instead.
function stepState() {
  let n = 0;
  const items = new Set();
  for (const l of all(`SELECT l.*, v.chassis, v.status AS van_status FROM van_lines l JOIN vans v ON v.id = l.van_id
                       WHERE l.state = '' AND l.issued = 0 AND trim(l.spec) <> ''
                         -- a line whose status someone already set or cleared keeps their answer
                         AND NOT EXISTS (SELECT 1 FROM allocation_log a WHERE a.line_id = l.id AND a.field = 'state')
                       ORDER BY l.id`)) {
    const state = detectState(l.spec);
    if (!state) continue;
    run(`UPDATE van_lines SET state = ? WHERE id = ? AND state = ''`, state, l.id);
    log('state', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'state', before: '', after: STATE_LABEL[state], note: `plan text "${l.spec}"` });
    n++;
    const flex = Math.max(0, l.reserved - l.reserved_firm);
    if (flex > 1e-9) {
      run('UPDATE van_lines SET reserved = reserved - ? WHERE id = ?', flex, l.id);
      log('state', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: q(l.reserved), after: q(l.reserved - flex),
        note: `${q(flex)} shelf stock released to free stock (${STATE_LABEL[state]})` });
      items.add(l.item_id);
    }
    if (l.reserved_firm > 0) {
      log('state', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'flag', before: q(l.reserved_firm), after: STATE_LABEL[state],
        note: `Stock received but marked ${STATE_LABEL[state].toLowerCase()} – check (${q(l.reserved_firm)} kept for ${l.chassis})` });
    }
  }
  for (const itemId of items) allocateItem(itemId, null, { reason: 'tidy:state' });
  return n;
}

// ── 6b. "...." next to a count or description is not "to be decided" (round 2, check-r1-5) ──
// Before round 2 any "...." in the plan text marked a line "to be decided" ("2 ......." on ST0377's fans,
// in production). Re-checks lines still marked to be decided ONLY because of that rule (the old rule says
// tbd, the new one doesn't) and that nobody has set or confirmed by hand since: they go back to normal,
// get stock again if any is free (build order), and are listed under "Please check" so the office looks at
// the text. Every change is logged.
function stepStateDots() {
  let n = 0;
  for (const l of all(`SELECT l.*, v.chassis FROM van_lines l JOIN vans v ON v.id = l.van_id
                       WHERE ${ACTIVE} AND l.state = 'tbd' AND l.issued < l.qty ORDER BY l.id`)) {
    if (detectStateV1(l.spec) !== 'tbd' || detectState(l.spec) === 'tbd') continue; // not the dots rule alone
    if (get(`SELECT 1 FROM allocation_log WHERE line_id = ? AND field = 'state' AND reason = 'state' LIMIT 1`, l.id)) continue; // a person's answer
    run(`UPDATE van_lines SET state = '' WHERE id = ? AND state = 'tbd'`, l.id);
    log('state_dots', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'state', before: STATE_LABEL.tbd, after: STATE_LABEL[''],
      note: `plan text "${l.spec}" – "...." next to a count or description is a real part, not "to be decided"` });
    log('state_dots', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'flag', before: STATE_LABEL.tbd, after: 'normal – please check',
      note: `${l.chassis}: plan text "${l.spec}" has "...." in it – check what is needed` });
    allocateItem(l.item_id, null, { reason: 'tidy:state_dots' }); // free stock, if any, in build order
    n++;
  }
  return n;
}

// ── 6c. order numbers read wrongly from the plan text (round 2, user-r1-1) ──
// Dates ("Order 29/06/2026" → 29), quantities ("Ordered 2 and need to order 2", "8 x 225 or 9"), axles
// ("Dual Axel 2") and codes ("ATS4", "DO35") were read as order numbers, so unrelated parts were grouped
// under one number on "Check: already ordered?" and left off the order list. The text is read again with
// the new reader; a line changes only when its stored number is exactly what the old reader made of the
// text (so a number a person typed, or two numbers joined by a merge, are never touched). The plan text
// itself is kept, and the old number is in the log. The other way round too: "121 / NCE" (roof baw) had
// no order number at all and now reads as NCE order 121, so it goes to "Check: already ordered?" instead of
// looking "not ordered".
function stepPoRef() {
  let n = 0;
  for (const l of all(`SELECT l.id, l.van_id, l.item_id, l.spec, l.po_ref FROM van_lines l JOIN vans v ON v.id = l.van_id
                       WHERE ${ACTIVE} AND l.source = 'plan' AND trim(l.spec) <> '' AND l.issued < l.qty ORDER BY l.id`)) {
    const stored = String(l.po_ref || '').trim();
    if (poRefV1(l.spec) !== stored) continue;
    const now = poRef(l.spec);
    if (now === stored) continue;
    run('UPDATE van_lines SET po_ref = ? WHERE id = ? AND trim(po_ref) = ?', now, l.id, stored);
    log('po_ref', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'order number', before: stored || '(none)', after: now || '(none)',
      note: `plan text "${l.spec}"` });
    n++;
  }
  return n;
}

// ── 6d. parts the plan says were handed to a worker ("Gave to Alex") (round 2, user-r1-5) ──
// "Black Jack Gave to Alex 15/07/2026" on a van still being built: the jack left the shelf when it was
// handed over, but the line still had it set aside, so the shelf figure counted it as on the shelf. The
// line is closed as given out to that van (closeAsGiven, the same stock rule as "Already fitted": what was
// set aside comes off the shelf figure with an 'issue' movement naming the person; nothing else changes).
// Lines marked customer supplies / to be decided are only flagged. "Picked up" ("Jordan picked up") means
// collected from the supplier, not handed to the van: only flagged for the office to check.
// Safe twice: a closed line is never touched again.
function stepGiven() {
  let n = 0;
  for (const l of all(`SELECT l.id, l.van_id, l.item_id, l.spec, l.state, l.reserved, l.qty, l.issued, v.chassis FROM van_lines l JOIN vans v ON v.id = l.van_id
                       WHERE ${ACTIVE} AND l.issued < l.qty AND trim(l.spec) <> '' ORDER BY l.id`)) {
    const g = givenTo(l.spec);
    const flaggedBefore = () => !!get(`SELECT 1 FROM allocation_log WHERE line_id = ? AND reason = 'tidy:given' LIMIT 1`, l.id);
    if (g && ['customer', 'tbd'].includes(l.state)) {
      if (flaggedBefore()) continue;
      log('given', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'flag', before: STATE_LABEL[l.state], after: 'please check',
        note: `${l.chassis}: plan says "${l.spec}" but the line is marked ${STATE_LABEL[l.state].toLowerCase()} – not changed, check` });
      continue;
    }
    if (g) {
      const r = closeAsGiven(l.id, { reason: 'tidy:given', by: 'clean-up' });
      if (!r) continue;
      n++;
      if (r.notFromStock > 1e-9) {
        log('given', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'flag', before: q(r.notFromStock), after: 'not set aside',
          note: `${l.chassis}: "${l.spec}" – ${q(r.notFromStock)} ${r.unit} was never set aside for this van, so the shelf figure was not changed for it. If it came off the shelf, the next count will show it.` });
      }
      continue;
    }
    if (pickedUp(l.spec) && !flaggedBefore()) {
      log('given', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'flag', before: `${q(l.reserved)} set aside`, after: 'please check',
        note: `${l.chassis}: plan says "${l.spec}" – collected from the supplier; check it is in the factory (or already in the van: "Already fitted…")` });
    }
  }
  return n;
}

// ── 7. shelf stock vs bought for one van (C9) ──
// Reviewed list. Bought for one van ('per-van'): every fridge, aircon (NOT the AC-CHG-… Victron AC
// chargers), diesel heater, washing machine, microwave, toilet, hot water system, the roll-out awning,
// the entrance door, window sets, TVs (not the TV bracket) and both Apex showers.
// Kept on the shelf ('stock'): down lights, switch sets, trailer jacks, table legs, both toolboxes.
// Only items whose kind is still the old value change (an office change is never undone); the old
// kind is written into the item's notes. Stock already set aside for vans stays with those vans (a
// per-van part is never handed to another van). Stock of a new per-van part that is on the shelf but
// not set aside for any van would otherwise go nowhere: it is flagged here and listed under Stock →
// Bought for vans → "no van – assign to a van" until someone assigns it or keeps it as a spare.
export const KIND_TO_PER_VAN = ['FRIDGE-BUSH-225', 'FRIDGE-DOM-190', 'FRIDGE-DOM-220', 'AC-FRESHJET', 'AC-FRESHJET-PRO', 'AC-BELAIR-3400',
  'HEATER-DIESEL', 'WM-AT-3KG', 'WM-AT-TOP', 'WM-NCE-COMBO', 'MW-CAMEC-28', 'MW-NCE-23', 'HAWK-COMBI',
  'TOILET-C263', 'TOILET-PLASTIC', 'TOILET-LOOSEAL', 'TOILET-OGO', 'HWS-REFLEX', 'HWS-SWIFT', 'AWNING-AT', 'DOOR-TRILOCK',
  'WINDOW-SET', 'TV-24', 'TV-32', 'SHOWER-CS11R', 'SHOWER-CS13F'];
// Same families, for parts added later under a matching code (still only when kind = 'stock').
const PER_VAN_FAMILY = /^(FRIDGE-|AC-(?!CHG)|HEATER-|WM-|MW-|TOILET-|HWS-)/;
export const KIND_TO_SHELF = ['LIGHT-DOWN-BLK', 'LIGHT-DOWN-WHT', 'SWITCH-BLACK', 'SWITCH-WHITE', 'SWITCH-SPHERE',
  'JACK-KO', 'JACK-BLACKJACK', 'TABLE-LEG', 'TOOLBOX-GOLD', 'TOOLBOX-PROLINE'];
const KIND_LABEL = { stock: 'kept on the shelf', 'per-van': 'bought for one van' };

function stepKind() {
  let n = 0;
  const day = new Date().toLocaleString('sv-SE').slice(0, 10);
  const change = (it, to) => {
    run('UPDATE items SET kind = ?, notes = ? WHERE id = ? AND kind = ?', to, appendNote(it.notes, `kind was ${it.kind} (changed ${day})`), it.id, it.kind);
    log('kind', { item_id: it.id, field: 'kind', before: KIND_LABEL[it.kind], after: KIND_LABEL[to], note: it.sku });
    n++;
  };
  const items = all(`SELECT * FROM items WHERE placeholder = 0 AND sku NOT LIKE 'PLAN-%' ORDER BY sku`);
  for (const it of items) {
    if (it.kind === 'stock' && (KIND_TO_PER_VAN.includes(it.sku) || PER_VAN_FAMILY.test(it.sku))) {
      change(it, 'per-van');
      // Shelf stock of it that no van has: listed for the office (assign to a van / keep as a spare).
      const held = get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE}`, it.id).r;
      const loose = it.on_hand - held;
      if (loose > 1e-9) {
        log('kind', { item_id: it.id, field: 'flag', before: q(loose), after: 'no van',
          note: `${q(loose)} ${it.unit} on the shelf not set aside for any van – Stock → Bought for vans: assign to a van or keep as a spare` });
      }
      const shelfPo = get(`SELECT COALESCE(SUM(pl.qty - pl.received - pl.closed),0) AS q FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                           WHERE p.status = 'open' AND pl.item_id = ? AND pl.van_id IS NULL AND pl.qty - pl.received - pl.closed > 1e-9`, it.id).q;
      if (shelfPo > 1e-9) {
        log('kind', { item_id: it.id, field: 'flag', before: q(shelfPo), after: 'on order, no van',
          note: `${q(shelfPo)} ${it.unit} on order for the shelf, not for a van – when it arrives, assign it to a van` });
      }
    } else if (it.kind === 'per-van' && KIND_TO_SHELF.includes(it.sku)) {
      change(it, 'stock');
    }
  }
  return n;
}

// ── 8. blank suppliers filled from the item's own purchase orders (C9) ──
// The most common supplier on POs that have this part (POs with no supplier don't count). Only blank
// suppliers are filled, so a second run changes nothing. Supplier names found in the plan text are
// only suggested on the "Fix the catalogue" page (nothing is saved without a click).
function stepSupplier() {
  let n = 0;
  const day = new Date().toLocaleString('sv-SE').slice(0, 10);
  for (const it of all(`SELECT * FROM items WHERE trim(supplier) = '' ORDER BY id`)) {
    const best = get(`SELECT trim(p.supplier) AS s, COUNT(*) AS c FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                      WHERE pl.item_id = ? AND trim(p.supplier) <> '' GROUP BY lower(trim(p.supplier)) ORDER BY c DESC, s LIMIT 1`, it.id);
    if (!best) continue;
    run(`UPDATE items SET supplier = ?, notes = ? WHERE id = ? AND trim(supplier) = ''`, best.s, appendNote(it.notes, `supplier filled from its purchase orders (${day})`), it.id);
    log('supplier', { item_id: it.id, field: 'supplier', before: '(none)', after: best.s, note: `${it.sku}: ${best.c} PO line(s) with ${best.s}` });
    n++;
  }
  syncSuppliers();
  return n;
}

// ── 9. PO lines for a van get that van's spec (colour, size, model) (C7) ──
// Only blank specs are filled, so running it twice changes nothing.
function stepPoSpec() {
  let n = 0;
  for (const pl of all(`SELECT pl.id, pl.van_id, pl.item_id FROM po_lines pl WHERE pl.van_id IS NOT NULL AND trim(pl.spec) = '' ORDER BY pl.id`)) {
    const l = get(`SELECT spec, po_ref FROM van_lines WHERE van_id = ? AND item_id = ? AND trim(spec) <> '' ORDER BY id LIMIT 1`, pl.van_id, pl.item_id);
    if (!l) continue;
    const spec = specForPo(l.spec, l.po_ref);
    if (!spec) continue;
    run(`UPDATE po_lines SET spec = ? WHERE id = ? AND trim(spec) = ''`, spec, pl.id);
    log('po_spec', { van_id: pl.van_id, item_id: pl.item_id, field: 'po line spec', before: '', after: spec, note: `PO line ${pl.id}` });
    n++;
  }
  return n;
}

// ── 10. imported POs: dates, clear names, "to check" (C8) ──
// ordered_at = created_at where blank; "From plan" → "Plan – <supplier> (no number)" (old name kept in
// the notes); needs_check on POs with no real number, no supplier, or a number used twice.
function stepPo() {
  let n = 0;
  // Not POs from the production plan: the plan never says when they were ordered, so their date stays
  // blank = "unknown (from plan)" (Small fixes & phone round 1, user-r4-5).
  const dated = run(`UPDATE purchase_orders SET ordered_at = substr(created_at, 1, 10) WHERE ordered_at = '' AND NOT (${PLAN_PO_SQL})`).changes;
  if (dated) { log('po', { field: 'ordered date', before: '(blank)', after: 'date the PO was entered', note: `${dated} PO(s)` }); n++; }
  for (const p of all(`SELECT * FROM purchase_orders WHERE trim(po_no) = 'From plan' ORDER BY id`)) {
    const name = `Plan – ${p.supplier.trim() || 'no supplier'} (no number)`;
    run('UPDATE purchase_orders SET po_no = ?, notes = ? WHERE id = ?', name, appendNote(p.notes, `was "${p.po_no}"`), p.id);
    log('po', { field: 'PO name', before: p.po_no, after: name, note: `PO #${p.id}` });
    n++;
  }
  // Same number twice = a problem when it's the same supplier, or one of them has no supplier (the plan's
  // order numbers run per supplier, so "11" for White Vision and "11" for Nikpol is normal).
  const isDupe = p => !!get(`SELECT 1 FROM purchase_orders WHERE id <> ? AND lower(trim(po_no)) = lower(trim(?))
                               AND (lower(trim(supplier)) = lower(trim(?)) OR trim(supplier) = '' OR trim(?) = '')`, p.id, p.po_no, p.supplier, p.supplier);
  // Not POs the office has already dealt with (closed, said "looks right", changed, or confirmed from
  // "Check: already ordered?") — so a second run never undoes their answer.
  for (const p of all(`SELECT * FROM purchase_orders WHERE needs_check = 0 AND status = 'open' AND notes NOT LIKE '%looks right%'
                         AND notes NOT LIKE '%(changed %' AND notes NOT LIKE '%confirmed on order%' ORDER BY id`)) {
    const why = [];
    if (!/\d/.test(p.po_no) || /\(no number\)\s*$/i.test(p.po_no)) why.push('no real PO number');
    if (!p.supplier.trim()) why.push('no supplier');
    if (/\d/.test(p.po_no) && isDupe(p)) why.push(`number ${p.po_no} used on more than one PO`);
    if (!why.length) continue;
    run('UPDATE purchase_orders SET needs_check = 1 WHERE id = ?', p.id);
    log('po', { field: 'flag', before: `PO ${p.po_no} (${p.supplier || 'no supplier'})`, after: 'to check', note: why.join(', ') });
    n++;
  }
  return n;
}

// ── 11. POs from the plan: ordered date "unknown (from plan)" (Small fixes & phone round 1, user-r4-5) ──
// Step 10 (before this round) and the plan import filled the ordered date of the plan's POs with the day
// they were entered (11/10/2026 on all 37), so it looked real. The plan never says when something was
// ordered: those dates are cleared (blank = "unknown (from plan)" on screen) — only where the date is still
// exactly the day the PO was entered, so a date someone typed is kept. The entered day itself stays in
// created_at, and every cleared date is in the clean-up report (before → after).
function stepPoDates() {
  let n = 0;
  for (const p of all(`SELECT id, po_no, supplier, ordered_at, created_at FROM purchase_orders
                       WHERE ordered_at <> '' AND ${PLAN_PO_SQL}
                         AND ordered_at IN (substr(created_at, 1, 10), date(created_at), date(created_at, 'localtime')) ORDER BY id`)) {
    run(`UPDATE purchase_orders SET ordered_at = '' WHERE id = ? AND ordered_at = ?`, p.id, p.ordered_at);
    log('po_dates', { field: 'ordered date', before: p.ordered_at, after: 'unknown (from plan)',
      note: `PO ${p.po_no}${p.supplier ? ` (${p.supplier})` : ''}: the date was the day it was entered, not when it was ordered` });
    n++;
  }
  return n;
}

// ── 12. "Merge all" that moved nothing (Small fixes & phone round 1, check-r4-1) ──
// Before this version a forced merge where nothing could move (both lines already had a part for the van)
// still wrote "merged from the plan line …" on the van's line and copied the plan line's own warning onto it
// ("… probably not the same part as this van's "Sliding door rail + pelmet" line"), so the line warned about
// itself. New merges never do this. For merges already made this way, a note is ADDED (nothing is removed —
// the old notes, merged columns and history all stay):
//  a) a line whose note carries a warning that names the line itself gets: "the warning above came with the
//     plan line merged in – it is about this line itself, nothing to check here";
//  b) a 'merged' history row that moved nothing (nothing set aside, locked or fitted moved, the plan line kept
//     what it held) gets its van line noted: "nothing moved in the merge from the plan line … – both lines
//     already have a part for this van; the plan line stays to check".
// Each note is added once (a note already there is skipped), so it is safe to run twice.
const SELF_WARN_NOTE = 'the warning above came with the plan line merged in – it is about this line itself, nothing to check here';
function stepMergeNotes() {
  let n = 0;
  const add = (l, text, why) => {
    const cur = get('SELECT note FROM van_lines WHERE id = ?', l.id)?.note;
    if (cur == null || String(cur).includes(text)) return;
    const next = appendNote(cur, text);
    run('UPDATE van_lines SET note = ? WHERE id = ?', next, l.id);
    log('merge_notes', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'note', before: cur, after: next, note: why });
    n++;
  };
  // a) warnings about the line itself
  for (const l of all(`SELECT l.id, l.van_id, l.item_id, l.note, i.name FROM van_lines l JOIN items i ON i.id = l.item_id
                       WHERE l.note LIKE '%merged from the %' ORDER BY l.id`)) {
    const self = `this van's "${l.name}" line`;
    const bits = String(l.note).split(' · ');
    if (bits.some(b => /^(possible duplicate of |two deliveries were received for this van|to check: )/i.test(b.trim()) && b.includes(self)))
      add(l, SELF_WARN_NOTE, 'a merge copied the plan line\'s warning onto the line it was about');
  }
  // b) 'merged' rows that moved nothing
  for (const a of all(`SELECT a.id, a.line_id, a.before, a.at, l.van_id, l.item_id FROM allocation_log a JOIN van_lines l ON l.id = a.line_id
                       WHERE a.field = 'merged' AND a.reason NOT LIKE 'tidy:%' AND a.change IS NOT NULL AND abs(a.change) < 1e-9
                         AND abs(COALESCE(a.firm_change, 0)) < 1e-9 AND a.note LIKE '%stays on the plan line%' ORDER BY a.id`)) {
    if (!/fitted 0(?:\D|$)/.test(String(a.before))) continue; // something fitted moved across: a real merge
    const m = /^plan line (.*?) on PLAN-/.exec(String(a.before));
    const day = String(a.at || '').slice(0, 10);
    add({ id: a.line_id, van_id: a.van_id, item_id: a.item_id },
      `nothing moved in the merge from the plan line ${m ? m[1] : ''}${day ? ` (${day})` : ''} – both lines already have a part for this van; the plan line stays to check`.replace(/  +/g, ' '),
      'a "merge all" that moved nothing');
  }
  return n;
}

// ── 13. a typo in a part code: PLAN-ROOF-BAW → PLAN-ROOF-BOW (follow-up round 1, planner-r3-4) ──
// Only the code (and the "Roof Baw (as per plan)" name) of that one catch-all changes; it keeps its id, so
// every van line, PO line, movement and history row stays on it. The old code goes in the part's notes and
// in the clean-up report (before → after), and still finds the part (relink.js skuNow: a plan re-import with
// the "Roof Baw" column, a stock count sheet, older notes). If a part with the new code already exists,
// nothing is renamed and the report says so. A part already renamed is skipped, so it is safe to run twice.
function stepSkuFix() {
  let n = 0;
  for (const [from, to] of SKU_RENAMES) {
    const it = get('SELECT * FROM items WHERE sku = ?', from);
    if (!it) continue;
    if (get('SELECT 1 FROM items WHERE sku = ?', to)) {
      log('sku_fix', { item_id: it.id, field: 'flag', before: from, after: '', note: `part code not changed: a part with the code ${to} already exists – check the two parts` });
      continue;
    }
    const name = NAME_FIXES.reduce((s, [re, fix]) => s.replace(re, fix), it.name);
    const notes = appendNote(it.notes, `part code was ${from} (typo fixed)`);
    run('UPDATE items SET sku = ?, name = ?, notes = ? WHERE id = ? AND sku = ?', to, name, notes, it.id, from);
    log('sku_fix', { item_id: it.id, field: 'sku', before: from, after: to, note: name !== it.name ? `name "${it.name}" → "${name}"` : '' });
    n++;
  }
  return n;
}

// Steps in the order they must run.
export const STEPS = [
  { key: 'lock', label: 'Parts received for a van are locked to it', run: stepLock },
  { key: 'plan_qty', label: 'Quantities read wrongly from the plan', run: stepPlanQty },
  { key: 'merge_dupes', label: 'Exact duplicate lines merged', run: stepMergeDupes },
  { key: 'placeholder', label: '"As per plan" catch-all items marked', run: stepPlaceholders },
  { key: 'relink', label: 'Catch-all lines moved onto real parts', run: stepRelink },
  { key: 'autolink', label: 'Special parts that plainly name a catalogue part linked to it', run: stepAutoLink },
  { key: 'parts_r3', label: 'Thetford 175L fridge and white round Razor basin added, plan lines that name them linked', run: stepPartsR3 },
  { key: 'notes_r3', label: 'Notes name the plan line instead of a line number ("merged from the plan line …")', run: stepNotesR3 },
  { key: 'merged_cols', label: 'Merged plan lines keep their colour on the Production plan and in the Excel export', run: stepMergedCols },
  { key: 'state', label: 'Customer supplies / to be decided lines marked', run: stepState },
  { key: 'state_dots', label: '"...." next to a count or description: back to a normal part', run: stepStateDots },
  { key: 'po_ref', label: 'Order numbers read wrongly from the plan (dates, sizes, quantities) fixed', run: stepPoRef },
  { key: 'given', label: 'Parts the plan says were given to someone ("Gave to Alex") booked out to that van', run: stepGiven },
  { key: 'kind', label: 'Shelf stock vs bought for one van (fridges, aircons, heaters…)', run: stepKind },
  { key: 'supplier', label: 'Blank suppliers filled from the part\'s purchase orders', run: stepSupplier },
  { key: 'po_spec', label: 'Colour, size and model copied onto van PO lines', run: stepPoSpec },
  { key: 'po', label: 'Imported purchase orders named, dated and marked to check', run: stepPo },
  { key: 'po_dates', label: 'Purchase orders from the plan: ordered date "unknown (from plan)" instead of the import date', run: stepPoDates },
  { key: 'merge_notes', label: '"Merge all" that moved nothing: a note on the van\'s line (nothing removed)', run: stepMergeNotes },
  { key: 'sku_fix', label: 'Typo in a part code fixed: PLAN-ROOF-BAW → PLAN-ROOF-BOW (the old code still finds it)', run: stepSkuFix },
];
const flagKey = key => `tidy_${key}_v1`;

// Consistent copy of factory.db (same method as scripts/backup.js: VACUUM INTO, then an integrity
// check, then rename). Returns the folder. Throws if anything goes wrong.
export function backupBeforeTidy() {
  const t = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const dir = path.join(DATA_DIR, 'backups', `before-tidy-${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}_${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'factory.db');
  const part = out + '.part';
  try {
    db.exec(`VACUUM INTO '${part.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(part, { readOnly: true });
    const ok = Object.values(copy.prepare('PRAGMA integrity_check').get())[0];
    const c = copy.prepare('SELECT (SELECT COUNT(*) FROM vans) AS vans, (SELECT COUNT(*) FROM van_lines) AS lines').get();
    copy.close();
    if (ok !== 'ok') throw new Error('the copy failed its check');
    const live = get('SELECT (SELECT COUNT(*) FROM vans) AS vans, (SELECT COUNT(*) FROM van_lines) AS lines');
    if (c.vans !== live.vans || c.lines !== live.lines) throw new Error('the copy does not match the live data');
    fs.renameSync(part, out);
    return dir;
  } catch (e) {
    fs.rmSync(part, { force: true });
    try { fs.rmdirSync(dir); } catch { /* not empty / gone */ }
    throw e;
  }
}

// Run every step that hasn't run yet. Returns a short summary for the start-up log.
export function runTidy({ log: say = console.log } = {}) {
  const todo = STEPS.filter(s => !getSetting(flagKey(s.key)));
  if (!todo.length) return { ran: [] };
  let backup;
  try {
    backup = backupBeforeTidy();
    setSetting('tidy_backup', backup);
  } catch (e) {
    say(`  Stock clean-up NOT run: the backup before it failed (${e.message}). Nothing was changed.`);
    return { ran: [], error: e.message };
  }
  say(`  Stock clean-up: backup saved in ${backup}`);
  const ran = [];
  for (const s of STEPS) {
    if (getSetting(flagKey(s.key))) continue;
    try {
      const n = tx(() => {
        const changed = s.run();
        setSetting(flagKey(s.key), new Date().toISOString());
        return changed;
      });
      ran.push({ key: s.key, changed: n });
      say(`  Stock clean-up: ${s.label} — ${n} change(s)`);
    } catch (e) {
      say(`  Stock clean-up stopped at "${s.label}": ${e.message}. That step and the ones after it were not done (nothing half-done).`);
      console.error(e);
      break;
    }
  }
  if (ran.length) setSetting('tidy_report_checked', '');
  return { ran, backup };
}

// The Clean-up report page: per step, what changed (before -> after), what was flagged or skipped.
export function tidyReport() {
  const rows = all(`SELECT a.*, v.chassis, i.sku, i.name AS item_name FROM allocation_log a
                    LEFT JOIN vans v ON v.id = a.van_id LEFT JOIN items i ON i.id = a.item_id
                    WHERE a.reason LIKE 'tidy:%' ORDER BY a.id`);
  let checked = null;
  try { checked = JSON.parse(getSetting('tidy_report_checked', '') || 'null'); } catch { checked = null; }
  return {
    backup: getSetting('tidy_backup', ''),
    checked,
    steps: STEPS.map(s => {
      const mine = rows.filter(r => r.reason === `tidy:${s.key}`);
      return { key: s.key, label: s.label, doneAt: getSetting(flagKey(s.key), ''),
        changes: mine.filter(r => r.field !== 'flag'), flagged: mine.filter(r => r.field === 'flag') };
    }),
  };
}

// After "Start again from spreadsheet" (C12): every step runs once more on the new data. Each step only
// touches rows that still need it, so this is safe. runTidy() takes its own backup first.
export function rerunTidy(opts) {
  for (const s of STEPS) setSetting(flagKey(s.key), '');
  return runTidy(opts);
}

// Go-live checklist step (a): every clean-up step has run and the report was checked.
export function tidyStatus() {
  let checked = null;
  try { checked = JSON.parse(getSetting('tidy_report_checked', '') || 'null'); } catch { checked = null; }
  return { steps: STEPS.length, done: STEPS.filter(s => getSetting(flagKey(s.key))).length, checked };
}

export function markReportChecked(by = '') {
  setSetting('tidy_report_checked', JSON.stringify({ at: new Date().toISOString(), by }));
}
