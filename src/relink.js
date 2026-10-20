// "(as per plan)" catch-all items (PLAN-…) → real parts.
//
// The production plan import turns any cell text it doesn't recognise into a line on a per-column
// placeholder item ("Aircon (as per plan)"). Many of those cells clearly name a real part
// ("Belair 3400", "2 x300 Amp Lithium"). This file holds the reviewed list of such matches and the
// one routine that moves a line from a placeholder onto a real item — used by the start-up clean-up
// (tidy.js), by future plan imports, and by the office's "Link to a real part" button.
import { all, get, run, tx, logAlloc } from './db.js';

// Reviewed table: a line on `fromSku` whose plan text matches `re` is really `toSku`.
export const RELINKS = [
  { fromSku: 'PLAN-TRAILER-JACK', re: /black\s*jack/i, toSku: 'JACK-BLACKJACK' },
  { fromSku: 'PLAN-BATTERY', re: /2\s*x\s*300\s*amp.*lith/i, toSku: 'BAT-300' },
  { fromSku: 'PLAN-FRIDGE', re: /dometic.*220/i, toSku: 'FRIDGE-DOM-220' },
  { fromSku: 'PLAN-FRIDGE', re: /dometic.*190|190.*dometic/i, toSku: 'FRIDGE-DOM-190' },
  { fromSku: 'PLAN-TOILET', re: /thetford|c263|ceramic/i, toSku: 'TOILET-C263' },
  { fromSku: 'PLAN-TOILET', re: /loo\s*seal/i, toSku: 'TOILET-LOOSEAL' },
  { fromSku: 'PLAN-TOILET', re: /\bogo\b/i, toSku: 'TOILET-OGO' },
  { fromSku: 'PLAN-AIRCON', re: /fresh\s*jet/i, toSku: 'AC-FRESHJET' },
  { fromSku: 'PLAN-AIRCON', re: /bel\s*air.*3400/i, toSku: 'AC-BELAIR-3400' },
  { fromSku: 'PLAN-TABLE-LEG', re: /cafe/i, toSku: 'TABLE-LEG' },
  { fromSku: 'PLAN-1-PIECE-FLOOR', re: /./, toSku: 'FLOOR-HONEYCOMB' },
  { fromSku: 'PLAN-CHASSIS', re: /\brk\s*6\b|road\s*king\s*6/i, toSku: 'CH-RK6' },
  { fromSku: 'PLAN-COOKER', re: /swift\s*full\s*oven/i, toSku: 'OVEN-SWIFT-FULL' },
  { fromSku: 'PLAN-COOKER', re: /mini\s*grill/i, toSku: 'GRILL-SWIFT-MINI' },
  { fromSku: 'PLAN-TV-ANTENNA', re: /vinguard/i, toSku: 'ANT-VINGUARD' },
  { fromSku: 'PLAN-TV-ANTENNA', re: /milenco/i, toSku: 'ANT-MILENCO' },
  { fromSku: 'PLAN-KITCHEN-SINK', re: /black.*(drying|drain)|razor.*black|black.*razor/i, toSku: 'SINK-RAZOR-BLK-DRAIN' },
  { fromSku: 'PLAN-DOWN-LIGHTS', re: /^\s*black\b/i, toSku: 'LIGHT-DOWN-BLK' },
  { fromSku: 'PLAN-DOWN-LIGHTS', re: /^\s*white\b/i, toSku: 'LIGHT-DOWN-WHT' },
  // Round 2 (user-r1-2): texts that plainly name one catalogue part and nothing else.
  { fromSku: 'PLAN-BATHROOM-ENSUITE-BASIN', re: /^\s*white\s*\/\s*rectangle(?:\s*\/\s*razor)?(?:\s*\/?\s*\d{1,3})?\s*$/i, toSku: 'BASIN-RECT' },
  { fromSku: 'PLAN-BATHROOM-ENSUITE-BASIN', re: /\bpr\s*8235\b/i, toSku: 'BASIN-ROUND' },
  { fromSku: 'PLAN-COOKER', re: /^\s*induction\s+cooker\s*$/i, toSku: 'COOKER-INDUCTION' },
  { fromSku: 'PLAN-COOKER', re: /\bhawk\b.*\b(?:microwave|combi)\b/i, toSku: 'HAWK-COMBI' },
  { fromSku: 'PLAN-COOKER', re: /^\s*camec\s+microwave\s+28/i, toSku: 'MW-CAMEC-28' },
  { fromSku: 'PLAN-TOOL-BOX', re: /^\s*(?:premium\s+)?proline(?:\s+premium)?\s*\/?\s*\d{0,3}\s*$/i, toSku: 'TOOLBOX-PROLINE' },
  // Round 3 (user-r2-3): two parts the plan names often that were missing from the catalogue.
  // "Thedford 175 L Compressor Order 78" (any spelling of Thetford, 175 litres).
  { fromSku: 'PLAN-FRIDGE', re: /\bth[ea]?[dt]{1,2}ford\b.*\b175\s*(?:l|ltr|lt|litres?)?\b/i, toSku: 'FRIDGE-THET-175', r3: true },
  // White + round + Razor ("White / round / Razor / 41", "white instead of black Round / Razor /44"); not the
  // fluted / ribbed / cup-cake / PR82xx basins — those are other models.
  { fromSku: 'PLAN-BATHROOM-ENSUITE-BASIN', re: /^(?=.*\bwhite\b)(?=.*\bround(?:ed)?\b)(?=.*\brazor\b)(?!.*\b(?:fluted|ribbed|cup\s*cake|pr\s*\d{3,4})\b)/i,
    toSku: 'BASIN-ROUND-RAZOR', r3: true },
];

// Parts that keep coming up on the plan but had no item yet. Created only if the SKU doesn't exist.
// Trade is copied from the placeholder of the same plan column.
export const NEW_ITEMS = [
  { sku: 'OVEN-SWIFT-FULL', name: 'Swift full oven', category: 'Appliances', from: 'PLAN-COOKER' },
  { sku: 'GRILL-SWIFT-MINI', name: 'Swift mini grill', category: 'Appliances', from: 'PLAN-COOKER' },
  { sku: 'ANT-VINGUARD', name: 'Vinguard TV antenna (butterfly)', category: 'Electrical – 12V', from: 'PLAN-TV-ANTENNA' },
  { sku: 'ANT-MILENCO', name: 'Milenco Leisure Tech TV antenna', category: 'Electrical – 12V', from: 'PLAN-TV-ANTENNA' },
  { sku: 'TOILET-LOOSEAL', name: 'Looseal Elite auto waterless toilet', category: 'Bathroom & Kitchen', from: 'PLAN-TOILET' },
  { sku: 'TOILET-OGO', name: 'OGO Origin composting toilet', category: 'Bathroom & Kitchen', from: 'PLAN-TOILET' },
  { sku: 'AC-BELAIR-3400', name: 'Belair 3400 air conditioner', category: 'Appliances', from: 'PLAN-AIRCON' },
  { sku: 'SINK-RAZOR-BLK-DRAIN', name: 'Razor black sink with drainer', category: 'Bathroom & Kitchen', from: 'PLAN-KITCHEN-SINK' },
  { sku: 'LIGHT-DOWN-BLK', name: 'Down light black', category: 'Electrical – 12V', from: 'PLAN-DOWN-LIGHTS' },
  { sku: 'LIGHT-DOWN-WHT', name: 'Down light white', category: 'Electrical – 12V', from: 'PLAN-DOWN-LIGHTS' },
  // Round 3 (user-r2-3). The fridge is bought for one van (like the other fridges); the basin is shelf stock
  // like the white rectangle Razor basin. Supplier = the brand's supplier already in the list (office: check).
  { sku: 'FRIDGE-THET-175', name: 'Thetford 175L compressor fridge', category: 'Appliances', from: 'PLAN-FRIDGE', kind: 'per-van', supplier: 'Thetford' },
  { sku: 'BASIN-ROUND-RAZOR', name: 'Vanity basin white round (Razor)', category: 'Bathroom & Kitchen', from: 'PLAN-BATHROOM-ENSUITE-BASIN', supplier: 'Razor' },
];

// Spelling fixes for placeholder display names (the plan column header keeps its original text,
// so the Excel export still matches the spreadsheet).
export const NAME_FIXES = [
  [/Servise/g, 'Service'],
  [/Seperating Bunk Aeria/gi, 'Separating bunk area'],
  [/Seperate/g, 'Separate'],
  [/Barthroom/g, 'Bathroom'],
  [/tpilet/gi, 'toilet'],
  [/Roof Baw/g, 'Roof Bow'], // follow-up round 1 (planner-r3-4)
];

// Part codes renamed to fix a typo (follow-up round 1, planner-r3-4; the start-up clean-up step 'sku_fix'
// renames the part). The old code still finds the part everywhere a code is looked up: a production plan
// re-import (its column is still headed "Roof Baw", which makes "PLAN-ROOF-BAW"), a stock count sheet,
// and older notes / history that name the old code ("was PLAN-ROOF-BAW", "Re-linked from PLAN-ROOF-BAW").
export const SKU_RENAMES = [['PLAN-ROOF-BAW', 'PLAN-ROOF-BOW']];
export function skuNow(sku) {
  const s = String(sku ?? '').trim();
  const r = SKU_RENAMES.find(([from]) => from === s.toUpperCase());
  return r ? r[1] : s;
}
// A code and every older code it replaced ("PLAN-ROOF-BOW" → ["PLAN-ROOF-BOW", "PLAN-ROOF-BAW"]).
export function skuNames(sku) {
  const now = skuNow(sku);
  return [now, ...SKU_RENAMES.filter(([, to]) => to === now).map(([from]) => from)];
}

export const isPlaceholderSku = sku => /^PLAN-/i.test(String(sku || ''));

// Which real SKU a placeholder line's plan text points at ('' = none).
export function relinkTarget(fromSku, spec) {
  fromSku = skuNow(fromSku);
  const r = RELINKS.find(x => x.fromSku === fromSku && x.re.test(String(spec || '')));
  return r ? r.toSku : '';
}

// Create the recurring parts that don't exist yet. Returns the SKUs created.
export function ensureNewItems() {
  const made = [];
  for (const n of NEW_ITEMS) {
    if (get('SELECT 1 FROM items WHERE sku = ?', n.sku)) continue;
    const ph = get('SELECT * FROM items WHERE sku = ?', n.from);
    const sameCol = ph?.plan_column
      ? get(`SELECT trade FROM items WHERE plan_column = ? AND placeholder = 0 AND sku NOT LIKE 'PLAN-%' AND trade <> '' LIMIT 1`, ph.plan_column) : null;
    run(`INSERT INTO items(sku, name, category, supplier, unit, kind, plan_column, trade, notes)
         VALUES(?, ?, ?, ?, 'ea', ?, ?, ?, 'Added by the stock clean-up: comes up often on the production plan')`,
        n.sku, n.name, n.category, n.supplier || '', n.kind || 'stock', ph?.plan_column || '', sameCol?.trade || ph?.trade || '');
    made.push(n.sku);
  }
  return made;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fmt = n => (Number.isInteger(Number(n)) ? String(Number(n)) : String(Math.round(Number(n) * 100) / 100));
const appendNote = (note, add) => (String(note || '').includes(add) ? note : [note, add].filter(Boolean).join(' · '));
// The plan line in words for notes and history (round 3, user-r2-3: never a line number):
// its plan column ("Sliding Door Pelmet"), else the catch-all's name without "(as per plan)".
export const planLineName = (planColumn, itemName) =>
  String(planColumn || '').trim() || String(itemName || '').replace(/\s*\(as per plan\)\s*$/i, '').trim() || 'a plan line';
// "Clearly the same need": the van's existing line needs at least as many, and its text is blank, the same,
// or one contains the other. Then linking merges into it; otherwise it is only a possible duplicate.
const sameNeed = (existing, l) => existing.qty >= l.qty && (!norm(existing.spec) || norm(existing.spec) === norm(l.spec)
  || norm(existing.spec).includes(norm(l.spec)) || norm(l.spec).includes(norm(existing.spec)));
export const dupFlag = (toName, existing) => `possible duplicate of this van's "${toName}" line${existing.plan_column ? ` (for: ${existing.plan_column})` : ''}`;

// Round 4 (check-r3-1): stock was received for this van on the line — some of it is locked to the van
// (reserved_firm > 0), or its plan cell is grey / blue (set aside + fitted cover the whole need).
const gotStock = x => !!x && ((Number(x.reserved_firm) || 0) > 1e-9
  || (Number(x.qty) > 0 && (Number(x.reserved) || 0) + (Number(x.issued) || 0) >= Number(x.qty) - 1e-9));
// Both lines already had a delivery for this van: two parts arrived, so they are most likely different
// parts. Never offered as "same thing?" and never merged without the office saying so.
export const bothReceived = (a, b) => gotStock(a) && gotStock(b);
export const DIFFERENT_TEXT = 'Two deliveries were received for this van – probably different parts';
export const diffFlag = (toName, existing) =>
  `two deliveries were received for this van – probably not the same part as this van's "${toName}" line${existing.plan_column ? ` (for: ${existing.plan_column})` : ''}`;
// Small fixes & phone round 1 (check-r4-1): a "merge all" that would move nothing.
export const NOTHING_MOVED = 'Nothing moved – both lines already have a part for this van; the plan line stays to check';
const NOTHING_MOVED_NOTE = (toName, existing) =>
  `to check: merge with this van's "${toName}" line${existing.plan_column ? ` (for: ${existing.plan_column})` : ''} asked, but nothing moved – both lines already have a part for this van`;
// The bits of a plan line's note that warn about ANOTHER line of the van (possible duplicate, probably not the
// same part, what stayed after a merge, a merge where nothing moved). They are never copied onto that line.
const FLAG_BIT = /^(possible duplicate of |two deliveries were received for this van|to check: )/i;
export const withoutFlags = note => String(note || '').split(' · ').filter(b => b.trim() && !FLAG_BIT.test(b.trim())).join(' · ');

// Round 4 (check-r3-3): plan columns merged into a line (van_lines.merged_cols, a JSON list).
export function mergedCols(s) {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.map(String).filter(Boolean) : []; } catch { return []; }
}
// The list with `cols` added (blank ones, `own` — the line's own column — and repeats left out).
export function withMergedCols(s, own, ...cols) {
  const list = mergedCols(s);
  for (const c of cols.flat()) {
    const t = String(c || '').trim();
    if (t && t !== String(own || '').trim() && !list.includes(t)) list.push(t);
  }
  return list.length ? JSON.stringify(list) : '';
}

// The numbers of a merge (shared by linkLine and linkPreview so the warning says exactly what happens).
// Round 4 (check-r3-2): the van's line keeps the LARGER need of the two (never less than what is fitted
// plus what it already has set aside, so nothing it holds is dropped). Only what that line still has
// room for moves off the plan line (`want`); the rest stays on the plan line (check-r3-1).
function mergeSums(e, l) {
  const issued = e.issued + l.issued;
  const qty = Math.max(e.qty, l.qty, issued + e.reserved);
  const room = Math.max(0, qty - issued - e.reserved);
  return { issued, qty, want: Math.min(Math.max(0, l.reserved), room) };
}
// Would a merge move nothing at all? Nothing set aside moves (no room on the van's line, or nothing on the
// placeholder's shelf figure), nothing on the plan line is fitted, and the plan line holds its whole need —
// so it would stay exactly as it is (check-r4-1).
const nothingMoves = (m, l) => Math.max(0, Math.min(m.want, Number(l.from_on_hand) || 0)) <= 1e-9 && l.issued <= 1e-9
  && l.qty > 1e-9 && Math.max(0, l.reserved) >= l.qty - 1e-9;

// Move one placeholder line onto a real item. Steps (all in one transaction, all logged):
//  1. The van already has a line for that item: if it's clearly the same need (its qty >= this line's
//     and its spec is blank or the same), this line is merged into it (note "merged from the plan line
//     Sliding Door Pelmet ("Nikpol 13")"); otherwise this line stays on the placeholder, marked
//     "possible duplicate of this van's "Sliding door rail + pelmet" line" for the office to decide.
//     The screens ask before any merge (linkPreview).
//  2. Otherwise the line's item changes (spec and plan column kept, note "was PLAN-X").
//  3. Only the stock set aside on the line moves from the placeholder's shelf figure to the real
//     item (two adjust movements). Parts already fitted (issued) are not moved: they left the shelf.
//  4. Open PO lines for this van on the placeholder move to the real item.
// Returns { result: 'linked' | 'merged' | 'duplicate' | 'skipped', into?, moved? }.
export function linkLine(lineId, toItemId, { reason = 'link', worker = '', force = false, why = '' } = {}) {
  return tx(() => {
    const l = get(`SELECT l.*, i.sku AS from_sku, i.name AS from_name, i.on_hand AS from_on_hand, i.placeholder, v.chassis,
                     i.plan_column AS from_col, i.category AS from_cat
                   FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id WHERE l.id = ?`, lineId);
    if (!l) throw Object.assign(new Error('That part line no longer exists — refresh'), { status: 404 });
    if (!l.placeholder && !isPlaceholderSku(l.from_sku)) return { result: 'skipped' };
    const to = get('SELECT * FROM items WHERE id = ?', toItemId);
    if (!to) throw Object.assign(new Error('Pick a part from the list'), { status: 400 });
    if (to.id === l.item_id || to.placeholder || isPlaceholderSku(to.sku)) throw Object.assign(new Error('Pick a real part, not another "as per plan" one'), { status: 400 });
    const base = { van_id: l.van_id, item_id: l.item_id, line_id: l.id, worker };

    // 3. stock: only what is set aside on this line, never more than the placeholder has.
    const moveStock = qty => {
      const q = Math.max(0, Math.min(qty, l.from_on_hand));
      if (q <= 0) return 0;
      const note = `Re-linked from ${l.from_sku}`;
      run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', q, l.item_id);
      run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', q, to.id);
      run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'adjust', ?, ?, ?, ?)`, l.item_id, -q, l.van_id, l.chassis, `${note} to ${to.sku}`, worker);
      run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'adjust', ?, ?, ?, ?)`, to.id, q, l.van_id, l.chassis, note, worker);
      logAlloc(reason, { ...base, field: 'on_hand moved', before: `${l.from_sku} ${q}`, after: `${to.sku} +${q}` });
      return q;
    };
    // 4. open PO lines for this van
    const movePOs = () => {
      const n = run('UPDATE po_lines SET item_id = ? WHERE van_id = ? AND item_id = ?', to.id, l.van_id, l.item_id).changes;
      if (n) logAlloc(reason, { ...base, field: 'po_lines', before: l.from_sku, after: to.sku, note: `${n} PO line(s) moved` });
    };

    // 1. double-demand check
    const existing = get('SELECT * FROM van_lines WHERE van_id = ? AND item_id = ? AND id <> ? ORDER BY id LIMIT 1', l.van_id, to.id, l.id);
    if (existing) {
      const into = { id: existing.id, name: to.name, sku: to.sku, qty: existing.qty, spec: existing.spec, plan_column: existing.plan_column };
      // Round 4 (check-r3-1): both lines already had a delivery for this van → probably different parts:
      // never merged unless the office says so (force), like a different amount or text.
      const different = bothReceived(l, existing);
      if ((!sameNeed(existing, l) || different) && !force) {
        const flag = different ? diffFlag(to.name, existing) : dupFlag(to.name, existing);
        if (!String(l.note).includes(flag)) {
          run('UPDATE van_lines SET note = ? WHERE id = ?', appendNote(l.note, flag), l.id);
          logAlloc(reason, { ...base, field: 'flag', before: l.from_sku, after: to.sku, note: `${flag} (${to.sku}, ${existing.qty} needed there) – left as "to confirm"` });
        }
        return { result: 'duplicate', into: existing.id, into_line: into, different: different ? 1 : 0 };
      }
      // Round 4 (check-r3-2): the van's line keeps the larger need. Only what it still has room for moves
      // across (check-r3-1): anything more set aside on the plan line is NOT turned into free shelf stock of
      // this part — it stays on the plan line (need = what it holds), marked "to check".
      const m = mergeSums(existing, l);
      // Small fixes & phone round 1 (check-r4-1): nothing would move (the van's line has no room and nothing
      // on the plan line is fitted) and the whole plan line would stay — that is not a merge. The van's line
      // is not touched (no "merged from" note, no merged plan column, no "merged" history row); the plan line
      // stays "to confirm" with one plain note, and the office is told why.
      if (nothingMoves(m, l)) {
        const flag = NOTHING_MOVED_NOTE(to.name, existing);
        if (!String(l.note || '').includes(flag)) run('UPDATE van_lines SET note = ? WHERE id = ?', appendNote(l.note, flag), l.id);
        logAlloc(reason, { ...base, field: 'flag', before: l.from_sku, after: to.sku,
          note: `merge asked${why ? ` (${why})` : ''}: ${NOTHING_MOVED} – left as "to confirm"` });
        return { result: 'kept', into: existing.id, into_line: into, moved: 0, kept: l.reserved, message: NOTHING_MOVED };
      }
      const moved = moveStock(m.want);
      const firmMoved = Math.min(l.reserved_firm, moved);
      const { issued, qty } = m;
      const reserved = existing.reserved + moved;
      const keep = Math.max(0, l.reserved - moved);
      const keepFirm = Math.min(keep, Math.max(0, l.reserved_firm - firmMoved));
      const from = planLineName(l.plan_column, l.from_name);
      const fromText = `plan line ${from}${l.spec ? ` ("${l.spec}")` : ''}`;
      // The plan line's own warnings ("possible duplicate of this van's … line", "probably not the same part
      // as …", "to check: …") are about the line it is merged into — never copied onto it (check-r4-1).
      const note = appendNote(appendNote(existing.note, `merged from the ${fromText}`), withoutFlags(l.note));
      // Round 4 (check-r3-3): the plan line's column is coloured from this line from now on.
      const ownCol = existing.plan_column || to.plan_column || to.category;
      const cols = withMergedCols(existing.merged_cols, ownCol, l.plan_column || l.from_col || l.from_cat, mergedCols(l.merged_cols));
      run(`UPDATE van_lines SET qty = ?, issued = ?, reserved = ?, reserved_firm = MIN(?, reserved_firm + ?), note = ?,
             po_ref = CASE WHEN po_ref = '' THEN ? WHEN ? = '' OR instr(po_ref, ?) > 0 THEN po_ref ELSE po_ref || ', ' || ? END,
             urgent = MAX(urgent, ?), merged_cols = ? WHERE id = ?`,
          qty, issued, reserved, reserved, firmMoved, note, l.po_ref, l.po_ref, l.po_ref, l.po_ref, l.urgent || 0, cols, existing.id);
      const keptText = keep > 1e-9 ? `${fmt(keep)} ${keepFirm > 1e-9 ? 'received for this van' : 'set aside'} stays on the plan line – to check` : '';
      logAlloc(reason, { ...base, line_id: existing.id, item_id: to.id, field: 'merged',
        before: `${fromText} on ${l.from_sku}: need ${l.qty}, set aside ${l.reserved}, fitted ${l.issued}`,
        after: `this van's ${to.name} line${existing.plan_column ? ` (for: ${existing.plan_column})` : ''}: need ${existing.qty} → ${qty}, set aside ${reserved}, fitted ${issued}`,
        note: [why, keptText].filter(Boolean).join(' · '),
        // when the plan line stays, its history stays with it: say here what this line gained
        ...(keep > 1e-9 ? { change: moved, firm_change: firmMoved } : {}) });
      movePOs();
      if (keep > 1e-9) {
        // Kept, holding what the van's line has no room for: not free stock, not handed to another van
        // (locked part stays locked), listed with the special parts to confirm until someone decides.
        const keepNote = appendNote(l.note, `to check: ${fmt(keep)} ${keepFirm > 1e-9 ? 'received for this van' : 'set aside'} stays on this line – merged with this van's "${to.name}" line, but probably a different part`);
        run('UPDATE van_lines SET qty = ?, reserved = ?, reserved_firm = ?, issued = 0, note = ? WHERE id = ?', keep, keep, keepFirm, keepNote, l.id);
        if (moved > 1e-9 || l.issued > 1e-9 || Math.abs(keep - l.qty) > 1e-9) logAlloc(reason, { ...base, field: 'reserved', before: l.reserved, after: keep, change: keep - l.reserved, firm_change: keepFirm - l.reserved_firm,
          note: `need ${fmt(l.qty)} → ${fmt(keep)}, fitted ${fmt(l.issued)} → 0 (moved to this van's ${to.name} line); ${keptText}` });
        return { result: 'merged', into: existing.id, into_line: into, moved, kept: keep };
      }
      run('UPDATE allocation_log SET line_id = ? WHERE line_id = ?', existing.id, l.id);
      run('DELETE FROM van_lines WHERE id = ?', l.id);
      return { result: 'merged', into: existing.id, into_line: into, moved };
    }

    // 2. re-point the line
    const moved = moveStock(l.reserved);
    const reserved = Math.min(l.reserved, moved); // can't keep more set aside than actually moved
    run(`UPDATE van_lines SET item_id = ?, reserved = ?, note = ? WHERE id = ?`, to.id, reserved, appendNote(l.note, `was ${l.from_sku}`), l.id);
    logAlloc(reason, { ...base, field: 'item', before: `${l.from_sku}${l.spec ? ` (${l.spec})` : ''}`, after: `${to.sku} – ${to.name}`,
      note: `need ${l.qty}, set aside ${reserved}, fitted ${l.issued}${why ? ` · ${why}` : ''}` });
    movePOs();
    return { result: 'linked', moved };
  });
}

// What linking these lines to `itemId` would do, without changing anything (round 3, user-r2-3: warn before
// merging). Per line: 'link' (the line just becomes that part), 'merge' (the van already has a line for that
// part with the same need: this line is folded into it — one part ordered, not two), 'duplicate' (the van
// already has a line for that part with a different amount or text: left "to confirm" unless the office
// says merge anyway) or 'skipped' (already a real part). `into` describes the van's existing line.
export function linkPreview(lineIds, itemId) {
  const to = get('SELECT id, sku, name, placeholder FROM items WHERE id = ?', itemId);
  if (!to) throw Object.assign(new Error('Pick a part from the list'), { status: 400 });
  return lineIds.map(id => {
    const l = get(`SELECT l.*, i.sku AS from_sku, i.name AS from_name, i.on_hand AS from_on_hand, i.placeholder, v.chassis
                   FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id WHERE l.id = ?`, id);
    if (!l) return { line_id: id, result: 'gone' };
    const out = { line_id: l.id, van_id: l.van_id, chassis: l.chassis, plan_line: planLineName(l.plan_column, l.from_name), spec: l.spec, qty: l.qty };
    if (!l.placeholder && !isPlaceholderSku(l.from_sku)) return { ...out, result: 'skipped' };
    const e = get('SELECT * FROM van_lines WHERE van_id = ? AND item_id = ? AND id <> ? ORDER BY id LIMIT 1', l.van_id, to.id, l.id);
    if (!e) return { ...out, result: 'link' };
    // Same sums as linkLine (mergeSums): the van's line keeps the larger need (`qty_after`, round 4
    // check-r3-2: "need 1 → need 3"); what it has room for moves across (`moved`); the rest stays on the
    // plan line marked "to check" (`kept`, check-r3-1) — it never becomes free shelf stock of the part.
    // `different`: both lines already had a delivery for this van — probably different parts.
    const m = mergeSums(e, l);
    const moved = Math.max(0, Math.min(m.want, l.from_on_hand));
    const kept = Math.max(0, l.reserved - moved);
    const different = bothReceived(l, e);
    // nothing = 1: a merge would move nothing and keep the whole plan line (check-r4-1) — linkLine then
    // leaves both lines as they are and says so.
    return { ...out, result: sameNeed(e, l) && !different ? 'merge' : 'duplicate', different: different ? 1 : 0,
      nothing: nothingMoves(m, l) ? 1 : 0, moved, kept, kept_firm: Math.min(kept, Math.max(0, l.reserved_firm - Math.min(l.reserved_firm, moved))), freed: 0, qty_after: m.qty,
      into: { id: e.id, name: to.name, sku: to.sku, qty: e.qty, spec: e.spec, plan_column: e.plan_column, issued: e.issued, reserved: e.reserved,
        reserved_firm: e.reserved_firm } };
  });
}

// ───────── suggestions for "Special parts to confirm" (round 2, user-r1-2) ─────────

// "Same text" for "Link all N lines with this same text": same catch-all, same words (case, spaces and
// punctuation ignored). Numbers are kept: "121 / NCE" and "114 / NCE" are different order numbers.
export const sameTextKey = (sku, spec) => `${sku}|${norm(spec)}`;

const STOP = new Set(['order', 'ordered', 'yes', 'with', 'and', 'the', 'for', 'per', 'only', 'from', 'van', 'vans', 'each', 'one',
  'as', 'in', 'on', 'to', 'of', 'x', 'plan', 'customer', 'request', 'must', 'match', 'new', 'std', 'standard', 'set', 'kit']);
const WEAK = new Set(['white', 'black', 'grey', 'gray', 'gold', 'chrome', 'silver', 'brush', 'brushed', 'stainless', 'matt', 'matte', 'gloss',
  'large', 'small', 'double', 'single', 'round', 'square', 'full', 'mini', 'front', 'rear', 'top', 'side', 'smooth', 'frost', 'nickel']);
const ATTRS = [new Set(['white', 'black', 'grey', 'gray', 'gold', 'chrome', 'silver', 'gunmetal', 'nickel', 'stainless']),
  new Set(['round', 'rectangle', 'rect', 'square', 'oval'])];
const words = s => norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d{1,3}$/.test(w));
// Model numbers: letters and digits together, 4+ characters ("pr8235", "cs11r", "c263", "il054c").
const codes = s => [...new Set(norm(s).split(' ').concat(norm(String(s || '').replace(/[\s-]+/g, '')).split(' '))
  .filter(w => w.length >= 4 && /\d/.test(w) && /[a-z]/.test(w)))];
// Sizes / model numbers in a text: every run of 2–4 digits ("220 ltr" → 220, "175L" → 175, "x300" → 300).
const sizes = s => [...new Set((String(s || '').match(/\d+/g) || []).filter(n => n.length >= 2 && n.length <= 4).map(n => String(Number(n))))];
const near1 = (a, b) => { // at most one letter different (typos like "Thedford")
  if (Math.abs(a.length - b.length) > 1 || a.length < 6) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
};
const wordHit = (w, list) => list.some(x => x === w || (w.length >= 4 && x.length >= 4 && (x.startsWith(w) || w.startsWith(x))) || near1(w, x));

// Real parts a catch-all may be linked to (not catch-alls, not one-off parts made for one van).
export const linkableItems = () => all(`SELECT id, sku, name, supplier, plan_column, category FROM items
  WHERE active = 1 AND placeholder = 0 AND sku NOT LIKE 'PLAN-%' AND sku NOT LIKE 'ONEOFF-%'`);

// What people linked before: catch-all + same text → one part (only when they always picked the same one).
export function learnedLinks() {
  const by = new Map();
  for (const r of all(`SELECT a.before, a.after, v.chassis FROM allocation_log a LEFT JOIN vans v ON v.id = a.van_id
                       WHERE a.reason IN ('link', 'link many') AND a.field = 'item' ORDER BY a.id`)) {
    const m = /^(PLAN-[^\s(]+)(?: \((.*)\))?$/s.exec(String(r.before || ''));
    const to = /^(\S+) – /.exec(String(r.after || ''));
    if (!m || !to) continue;
    const k = sameTextKey(skuNow(m[1]), m[2] || '');
    if (!by.has(k)) by.set(k, { skus: new Set(), chassis: r.chassis || '' });
    by.get(k).skus.add(to[1]);
  }
  const out = new Map();
  for (const [k, v] of by) if (v.skus.size === 1) out.set(k, { sku: [...v.skus][0], chassis: v.chassis });
  return out;
}

// Parts the same plan cell already became on this van (the import split "Roller Rocker + DO35" into the
// DO35 hitch + a suspension catch-all): never suggested for the catch-all — it is the OTHER part.
export function cellSiblings(lineIds) {
  const out = new Map();
  if (!lineIds.length) return out;
  for (const r of all(`SELECT l.id, o.item_id FROM van_lines l JOIN van_lines o ON o.van_id = l.van_id AND o.id <> l.id
                         AND o.plan_column = l.plan_column AND o.spec = l.spec
                       WHERE l.id IN (${lineIds.map(() => '?').join(',')})`, ...lineIds)) {
    if (!out.has(r.id)) out.set(r.id, new Set());
    out.get(r.id).add(r.item_id);
  }
  return out;
}

// Best real part for one catch-all line ({id, sku, spec, plan_column}), or null.
// sure = true only for: the reviewed list, the same text linked the same way before, or a model number
// that is in exactly one part's name / SKU in a text that names one thing (no "+", "&", "and").
// Those may be linked automatically; anything else is only shown as "Suggested" and needs a click.
// `exclude`: item ids the same plan cell already became on this van (cellSiblings).
// `onVan`: the van's other real parts (vanParts) — a part the van already has is never suggested
// (round 3, user-r2-3: it would be ordered twice); suggestFor() says "This van already has … – same thing?".
export function suggestLink(line, items = linkableItems(), learned = learnedLinks(), exclude = line.id ? cellSiblings([line.id]).get(line.id) : null, onVan = null) {
  return suggestFor(line, { items, learned, exclude, onVan }).suggest;
}

// { suggest, already } for one catch-all line.
//   suggest: the real part it most likely is (see suggestLink), never one the van already has.
//   already: the van's existing line for the part it most likely is — "This van already has Sliding door
//            rail + pelmet – same thing?" — when the best match is on the van already, or when nothing else
//            fits and one of the van's own parts does (here a brand + the same kind of thing is enough:
//            "Nikpol 13" in the Sliding Door Pelmet column vs the van's Nikpol "Sliding door rail + pelmet").
export function suggestFor(line, { items = linkableItems(), learned = learnedLinks(), exclude = null, onVan = null } = {}) {
  if (exclude?.size) items = items.filter(i => !exclude.has(i.id));
  const best = bestMatch(line, items, learned);
  const has = id => !!onVan?.has(id);
  // Round 4 (check-r3-1): when stock was already received for this van on BOTH lines, two parts arrived —
  // probably different parts: no "same thing?", say so instead (`different`).
  const onVanAnswer = (itemId, why) => {
    const a = { ...onVan.get(itemId), why };
    return bothReceived(line, a) ? { suggest: null, already: null, different: a } : { suggest: null, already: a, different: null };
  };
  if (best && has(best.item_id)) return onVanAnswer(best.item_id, best.why);
  if (best) return { suggest: best, already: null, different: null };
  if (onVan?.size) {
    const mine = items.filter(i => has(i.id));
    const top = scoreWords(line, mine, { loose: true });
    if (top.length && !(top[1] && top[1].score >= top[0].score)) return onVanAnswer(top[0].i.id, `words match: ${top[0].hit.join(', ')}`);
  }
  return { suggest: null, already: null, different: null };
}

function bestMatch(line, items, learned) {
  const bySku = new Map(items.map(i => [i.sku, i]));
  const pick = (it, why, sure) => (it ? { item_id: it.id, sku: it.sku, name: it.name, why, sure } : null);
  const reviewed = relinkTarget(line.sku, line.spec);
  if (reviewed && bySku.get(reviewed)) return pick(bySku.get(reviewed), 'on the reviewed list of plan texts', true);
  const l = learned.get(sameTextKey(line.sku, line.spec));
  if (l && bySku.get(l.sku)) return pick(bySku.get(l.sku), `the same text was linked to it before${l.chassis ? ` (${l.chassis})` : ''}`, true);
  const cs = codes(line.spec);
  if (cs.length) {
    const hits = items.filter(i => cs.some(c => prepItem(i).codes.includes(c)));
    const several = /\+|&|\band\b/i.test(String(line.spec || ''));
    if (hits.length === 1) return pick(hits[0], `model number ${cs.find(c => prepItem(hits[0]).codes.includes(c)).toUpperCase()} is in its name`, !several);
  }
  const scored = scoreWords(line, items);
  if (!scored.length || (scored[1] && scored[1].score >= scored[0].score)) return null; // nothing, or a tie
  return pick(scored[0].i, `words match: ${scored[0].hit.join(', ')}`, false);
}

// Words: at least half of the text's real (non-colour, non-size) words must be in the part, and either
// two of them or one plus the plan column (the part is for the same thing: "basin", "toilet"…).
// A brand in the text that is not the part's brand rules it out ("Hawk full oven" is not the Swift oven).
// Round 3 (user-r2-3): a supplier / brand name alone is never enough — at least one matching word must be
// in the part's own name or code and not be a supplier name ("Nikpol 13" does not make it the Nikpol
// sliding door kit). `loose` (only for "this van already has … – same thing?"): one real word, or a brand,
// plus the same kind of thing is enough.
function scoreWords(line, items, { loose = false } = {}) {
  const ws = words(line.spec);
  const strong = ws.filter(w => !WEAK.has(w));
  if (!strong.length) return [];
  const colWords = words(line.plan_column).filter(w => !WEAK.has(w));
  const brands = supplierNames().filter(s => brandRe(s).test(String(line.spec || '')));
  const brandWords = supplierWords();
  const textSizes = sizes(line.spec);
  return items.map(i => {
    const { own, name, thing, itemBrands, sizes: itemSizes } = prepItem(i);
    const hitIn = list => w => (/\d/.test(w) ? list.includes(w) : wordHit(w, list)); // model numbers only exactly
    const hit = ws.filter(hitIn(own));
    const strongHit = hit.filter(w => !WEAK.has(w));
    const realHit = strongHit.filter(w => !brandWords.has(w) && hitIn(name)(w));
    const sameThing = colWords.some(w => wordHit(w, thing));
    const clash = (brands.length && itemBrands.length && !brands.some(b => itemBrands.some(x => x.toLowerCase() === b.toLowerCase())))
      || ATTRS.some(set => { // a black basin is not the white one, a round one not the rectangle
        const a = ws.filter(w => set.has(w)), b = own.filter(w => set.has(w));
        return a.length && b.length && !a.some(w => b.includes(w));
      })
      // a size in both that doesn't match: "Thedford 220 ltr" is not the Thetford 175L fridge (round 3)
      || (textSizes.length && itemSizes.length && !textSizes.some(n => itemSizes.includes(n)));
    const enough = strongHit.length * 2 >= strong.length;
    // Round 4 (check-r3-1): loose also needs a word of the part's own name that is not a supplier name —
    // "Nikpol 13" in the pelmet column is not the van's Nikpol sliding door kit just because of "Nikpol".
    const ok = !clash && enough && realHit.length >= 1 && (loose
      ? sameThing
      : strongHit.length >= 2 || (strongHit.length === 1 && sameThing));
    return { i, hit, score: hit.reduce((s, w) => s + (WEAK.has(w) ? 0.5 : 1), 0) + (sameThing ? 1 : 0), ok };
  }).filter(x => x.ok).sort((a, b) => b.score - a.score);
}

// The real parts already on these vans, per van: vanId → Map(itemId → { line_id, item_id, name, sku, qty, spec,
// plan_column, reserved, reserved_firm, issued }) — the first line for each part (the one a merge goes into).
export function vanParts(vanIds) {
  const out = new Map();
  const ids = [...new Set(vanIds)].filter(x => x != null);
  if (!ids.length) return out;
  for (const r of all(`SELECT l.id AS line_id, l.van_id, l.item_id, l.qty, l.spec, l.plan_column, l.reserved, l.reserved_firm, l.issued, i.name, i.sku
                       FROM van_lines l JOIN items i ON i.id = l.item_id
                       WHERE l.van_id IN (${ids.map(() => '?').join(',')}) AND i.placeholder = 0 AND i.sku NOT LIKE 'PLAN-%'
                       ORDER BY l.id`, ...ids)) {
    if (!out.has(r.van_id)) out.set(r.van_id, new Map());
    const m = out.get(r.van_id);
    if (!m.has(r.item_id)) m.set(r.item_id, r);
  }
  return out;
}

// Suggestions for many catch-all lines at once ({id, van_id, sku, name, spec, plan_column}): Map lineId →
// { suggest, already, clash }. On top of suggestFor: the same part is never suggested for two lines of one
// van (round 3, user-r2-3) — both lose the suggestion and get `clash` (the part, and the other plan lines).
export function suggestionsFor(lines, { items = linkableItems(), learned = learnedLinks() } = {}) {
  const sib = cellSiblings(lines.map(l => l.id));
  const parts = vanParts(lines.map(l => l.van_id));
  const out = new Map();
  for (const l of lines) {
    const exclude = sib.get(l.id) || null;
    const mine = parts.get(l.van_id);
    const onVan = mine ? new Map([...mine].filter(([itemId]) => !exclude?.has(itemId))) : null;
    out.set(l.id, { ...suggestFor(l, { items, learned, exclude, onVan }), clash: null });
  }
  const byPart = new Map();
  for (const l of lines) {
    const s = out.get(l.id).suggest;
    if (!s) continue;
    const k = `${l.van_id}|${s.item_id}`;
    if (!byPart.has(k)) byPart.set(k, []);
    byPart.get(k).push(l);
  }
  for (const ls of byPart.values()) {
    if (ls.length < 2) continue;
    for (const l of ls) {
      const r = out.get(l.id);
      r.clash = { item_id: r.suggest.item_id, name: r.suggest.name, sku: r.suggest.sku,
        others: ls.filter(x => x.id !== l.id).map(x => planLineName(x.plan_column, x.name)) };
      r.suggest = null;
    }
  }
  return out;
}

// Per part: its words, its own name / code words, what it is (name + plan column), its brands.
// Worked out once per item row.
const prepped = new WeakMap();
function prepItem(i) {
  let p = prepped.get(i);
  if (!p) {
    p = { own: words(`${i.name} ${i.sku.replace(/-/g, ' ')} ${i.supplier} ${i.plan_column}`), name: words(`${i.name} ${i.sku.replace(/-/g, ' ')}`),
      sizes: sizes(`${i.name} ${i.sku.replace(/-/g, ' ')}`),
      thing: words(`${i.name} ${i.plan_column}`),
      codes: codes(`${i.name} ${i.sku}`),
      itemBrands: supplierNames().filter(s => s.toLowerCase() === String(i.supplier || '').trim().toLowerCase() || brandRe(s).test(i.name)) };
    prepped.set(i, p);
  }
  return p;
}
const reCache = new Map();
const brandRe = s => reCache.get(s) || reCache.set(s, new RegExp(`(?:^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}(?![a-z0-9])`, 'i')).get(s);
// Supplier names that are brands (4+ letters, not an ordinary word like "Gold"). Cached per second.
let supCache = { at: 0, list: [] };
function supplierNames() {
  if (Date.now() - supCache.at > 1000) {
    supCache = { at: Date.now(), list: all(`SELECT DISTINCT trim(supplier) AS s FROM items WHERE trim(supplier) <> ''
                                              UNION SELECT name FROM suppliers`).map(r => r.s)
      .filter(s => s && s.length >= 4 && !/^(gold|black|white|grey|silver|chrome|custom|plan|order)$/i.test(s)) };
  }
  return supCache.list;
}
// Every word of every supplier name ("nikpol", "coast", "camping"…): a match on these alone is not a
// match on the part (round 3). Cached per second like supplierNames().
let supWordCache = { at: 0, set: new Set() };
function supplierWords() {
  if (Date.now() - supWordCache.at > 1000) {
    const set = new Set();
    for (const r of all(`SELECT DISTINCT trim(supplier) AS s FROM items WHERE trim(supplier) <> '' UNION SELECT name FROM suppliers`)) {
      for (const w of words(r.s)) set.add(w);
    }
    supWordCache = { at: Date.now(), set };
  }
  return supWordCache.set;
}

// "Keep as a one-off special part for this van": the line gets its own part, made for this van only
// (kind 'per-van', SKU ONEOFF-…), so it no longer counts as "to confirm" but can be ordered, received
// and found on the floor like any other part. Stock and PO lines move with it (linkLine, logged).
export function makeOneOff(lineId, { supplier = '', name = '', worker = '' } = {}) {
  return tx(() => {
    const l = get(`SELECT l.*, i.sku, i.name AS item_name, i.unit, i.trade, i.placeholder, v.chassis
                   FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id WHERE l.id = ?`, lineId);
    if (!l) throw Object.assign(new Error('That part line no longer exists — refresh'), { status: 404 });
    if (!l.placeholder && !isPlaceholderSku(l.sku)) throw Object.assign(new Error('This line is already a real part'), { status: 400 });
    const base = String(name || '').trim()
      || `${String(l.item_name || l.plan_column || 'Special part').replace(/\s*\(as per plan\)\s*$/i, '')} – ${l.chassis} (one-off)`;
    let sku = `ONEOFF-${l.chassis}-${String(l.plan_column || l.sku).toUpperCase().replace(/^PLAN-/, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20)}`;
    for (let n = 2; get('SELECT 1 FROM items WHERE sku = ?', sku); n++) sku = `${sku.replace(/-\d+$/, '')}-${n}`;
    const itemId = Number(run(`INSERT INTO items(sku, name, category, supplier, unit, kind, plan_column, trade, notes)
                               VALUES(?, ?, 'Special (one-off)', ?, ?, 'per-van', ?, ?, ?)`,
      sku, base.slice(0, 120), String(supplier || '').trim(), l.unit || 'ea', l.plan_column || '', l.trade || '',
      `One-off special part for ${l.chassis}, from the plan text "${l.spec}"`).lastInsertRowid);
    logAlloc('one-off', { van_id: l.van_id, item_id: itemId, line_id: l.id, field: 'new item', before: '', after: `${sku} – ${base}`, worker,
      note: `kept as a one-off special part for ${l.chassis}${supplier ? ` (supplier ${supplier})` : ''}` });
    const r = linkLine(l.id, itemId, { reason: 'one-off', worker });
    return { ...r, item_id: itemId, sku };
  });
}

// ───────── one plan text that names several parts (Small fixes & phone round 1, user-r4-6) ─────────
// "induction cooker + CAMEC MICROWAVE 28LTR + AIR FRYER AND CONVECTION OVEN" is three parts, not one.
// The text is cut at "+", "&" and ";" (and at "and" only when both sides carry a model number:
// "pr7350 and pr7320"). A bit only counts as a part when it has a real word or a model number — so
// "White + Frost" (frame colour + glass), "L & S 150" (a supplier) and "3200ATM" (the van's rating) are
// one part, not two. Returns the bits when there are 2 or more, else [].
const ATM_RE = /^\d{3,4}\s*(?:kg\s*)?atm$/i;
// Model numbers written as one word ("pr7350", "do35") or with one space ("pr 7570") — stricter than codes(),
// which also joins whole phrases ("2 slides" → "2slides").
const realCodes = s => {
  const t = norm(s);
  const one = t.split(' ').filter(w => w.length >= 4 && /\d/.test(w) && /[a-z]/.test(w));
  const two = [...t.matchAll(/\b([a-z]{1,3}) (\d{3,})\b/g)].map(m => m[1] + m[2]);
  return [...one, ...two].filter(c => !ATM_RE.test(c));
};
const namesAPart = s => realCodes(s).length > 0 || words(s).some(w => !WEAK.has(w) && !ATM_RE.test(w));

// Follow-up round 1 (planner-r3-5): two different model numbers with nothing between them —
// "kitchen pr7350 vanitypr7155" is the kitchen tap PR7350 and the vanity tap PR7155. A model number here is one
// word of 1–3 letters then 3+ digits (up to 2 letters after: "pr7350", "gcc2404"). Never a model number: sizes
// ("x450MM", "345 H x 290 W", "28LTR", "3200ATM" – a number first or an x/h/w in front), a van ("ST0339"),
// "Order141". A model number stuck to a word ("vanitypr7155") only counts when another model number in the
// text starts with the same letters ("pr7350"): it is then cut off the word ("vanity pr7155"). Each part runs
// up to and including its model number; words after the last one stay with it. Only when 2+ DIFFERENT model
// numbers are found; otherwise the text is left as it is.
const CODE_TOKEN = /^([a-z]{1,3})(\d{3,})([a-z]{0,2})$/i;
const STUCK_TOKEN = /^([a-z]{4,})(\d{3,})([a-z]{0,2})$/i;
const NOT_A_MODEL = /^(?:[xhwld]\d|st\d{4}$)/i;
function splitModels(text) {
  const raw = String(text || '').trim().split(/\s+/).filter(Boolean);
  const bare = t => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
  const toks = raw.map(r => {
    const b = bare(r), m = CODE_TOKEN.exec(b);
    if (m && !NOT_A_MODEL.test(b) && !ATM_RE.test(b)) return { text: r, code: b.toLowerCase(), pre: m[1].toLowerCase() };
    return { text: r, stuck: STUCK_TOKEN.exec(b) };
  });
  const pres = [...new Set(toks.filter(t => t.code).map(t => t.pre))];
  const out = [];
  for (const t of toks) {
    const pre = t.stuck && pres.find(p => t.stuck[1].toLowerCase().endsWith(p));
    if (!pre) { out.push(t); continue; }
    const [, letters, digits, tail] = t.stuck;
    const code = letters.slice(-pre.length) + digits + tail;
    out.push({ text: letters.slice(0, -pre.length) }, { text: code, code: code.toLowerCase(), pre });
  }
  if (new Set(out.filter(t => t.code).map(t => t.code)).size < 2) return [text];
  const parts = [];
  let cur = [];
  for (const t of out) {
    cur.push(t.text);
    if (t.code) { parts.push(cur); cur = []; }
  }
  if (cur.length) parts[parts.length - 1].push(...cur);
  return parts.map(x => x.join(' '));
}

export function textParts(spec) {
  const out = [];
  for (const bit of String(spec || '').split(/[+&;]/)) {
    const and = bit.split(/\s+and\s+/i);
    const pieces = (and.length > 1 && and.every(p => realCodes(p).length) ? and : [bit]).flatMap(splitModels);
    for (const p of pieces) {
      const t = p.replace(/\s+/g, ' ').trim().replace(/^[,.\-–\s]+|[,.\-–\s]+$/g, '');
      if (t && namesAPart(t)) out.push(t);
    }
  }
  return out.length >= 2 ? out : [];
}

// Per bit of a multi-part text: { text, suggest, on_van } — on_van = the van already has a line for the
// part it most likely is (a part the same cell already became, or one added from here before), so it is
// done; suggest = the real part it most likely is (needs a click to add). `onVan`: vanParts() for the van.
export function partsFor(line, { items = linkableItems(), onVan = null } = {}) {
  const bits = textParts(line.spec);
  if (!bits.length) return null;
  const empty = new Map();
  // Bits added from here before (their line's note says "Part of the plan text: “…”"): done, whatever part was picked.
  const added = line.id == null ? [] : all(`SELECT o.note, o.item_id, i.name, i.sku FROM van_lines o JOIN items i ON i.id = o.item_id
      WHERE o.van_id = ? AND o.id <> ? AND o.plan_column = ? AND o.spec = ? AND o.note LIKE '%Part of the plan text:%'`,
    line.van_id, line.id, line.plan_column || '', line.spec || '');
  const out = [];
  for (const text of bits) {
    const r = suggestFor({ ...line, id: null, spec: text }, { items, learned: empty, exclude: null, onVan });
    const prev = added.find(a => [...a.note.matchAll(/Part of the plan text: “([^”]*)”/g)].some(m => m[1].split(' + ').includes(text)));
    const on = prev || r.already || r.different;
    const p = { text, suggest: on ? null : (r.suggest || null), on_van: on ? { item_id: on.item_id, name: on.name, sku: on.sku } : null };
    // Two bits that are the same real part ("CAMEC MICROWAVE 28LTR" + "AIR FRYER AND CONVECTION OVEN" = the
    // Camec 28L microwave / air fryer / convection unit) are one part: shown and added once.
    const id = (p.on_van || p.suggest)?.item_id;
    const same = id != null && out.find(o => (o.on_van || o.suggest)?.item_id === id);
    if (same) same.text = `${same.text} + ${text}`;
    else out.push(p);
  }
  return out.length >= 2 ? out : null;
}

// A plan cell that only holds the dealer's name ("CHASSIS: Caravan Treading Center") is not a part.
// `dealers`: every dealer name on the vans (both spellings are in the data). Returns the reason, or ''.
export function dealerNames() {
  const set = new Set();
  for (const r of all(`SELECT DISTINCT dealer FROM vans WHERE trim(dealer) <> ''`)) {
    set.add(norm(r.dealer));
    set.add(norm(String(r.dealer).replace(/treading/ig, 'trading')));
  }
  return set;
}
export function notAPart(spec, dealers = dealerNames()) {
  const t = norm(spec);
  return t && dealers.has(t) ? "the dealer's name, not a part" : '';
}

// "Add each part" (user-r4-6): the bits of one multi-part plan text become their own lines on the van —
// next to the plan line, same plan column and same plan text, as the import does when it can read the
// parts itself ("Roller Rocker + DO35" → the DO35 hitch + the suspension line). `parts`: [{ text, item_id }].
// When this covers every bit that is not on the van yet, the plan line itself becomes the first part
// (linkLine: its stock and van POs move with it) — otherwise it stays "to confirm" for the bits left.
// Logged as 'add part' (not 'link', so "same text was linked to … before" never learns from a part of a text).
export function addTextParts(lineId, parts, { worker = '' } = {}) {
  return tx(() => {
    const l = get(`SELECT l.*, i.sku, i.name AS item_name, i.placeholder, v.chassis FROM van_lines l JOIN items i ON i.id = l.item_id
                   JOIN vans v ON v.id = l.van_id WHERE l.id = ?`, lineId);
    if (!l) throw Object.assign(new Error('That part line no longer exists — refresh'), { status: 404 });
    if (!l.placeholder && !isPlaceholderSku(l.sku)) throw Object.assign(new Error('This line is already a real part'), { status: 400 });
    const list = (Array.isArray(parts) ? parts : []).map(p => ({ text: String(p.text || '').trim().slice(0, 200), item_id: Number(p.item_id) }))
      .filter(p => p.item_id);
    if (!list.length) throw Object.assign(new Error('Pick a part for at least one of them'), { status: 400 });
    const ids = list.map(p => p.item_id);
    if (new Set(ids).size !== ids.length) throw Object.assign(new Error('The same part is picked twice — pick a different part for each'), { status: 400 });
    const have = vanParts([l.van_id]).get(l.van_id) || new Map();
    for (const p of list) {
      const it = get('SELECT * FROM items WHERE id = ?', p.item_id);
      if (!it || it.placeholder || isPlaceholderSku(it.sku)) throw Object.assign(new Error('Pick a real part, not another "as per plan" one'), { status: 400 });
      if (have.has(it.id)) throw Object.assign(new Error(`${l.chassis} already has ${it.name} — use "Same thing?" / Link on the plan line instead`), { status: 409 });
      p.item = it;
    }
    const bits = partsFor(l, { onVan: have }) || [];
    const left = bits.filter(b => !b.on_van).length;
    const whole = left > 0 && list.length >= left; // every bit still open gets a part now
    const out = { added: 0, linked: 0, chassis: l.chassis, van_id: l.van_id, allocate: [] };
    const [first, ...rest] = whole ? list : [null, ...list];
    for (const p of rest) {
      const id = Number(run(`INSERT INTO van_lines(van_id, item_id, qty, spec, note, source, plan_column) VALUES(?,?,?,?,?, 'manual', ?)`,
        l.van_id, p.item_id, l.qty, l.spec, `Part of the plan text: “${p.text}”`, l.plan_column).lastInsertRowid);
      logAlloc('add part', { van_id: l.van_id, item_id: p.item_id, line_id: id, field: 'new line', before: `${l.sku} (${l.spec})`,
        after: `${p.item.sku} – ${p.item.name}`, worker, note: `“${p.text}” added as its own line from the ${planLineName(l.plan_column, l.item_name)} plan text` });
      out.allocate.push(p.item_id); // set aside by the caller (allocateItem lives in inventory.js)
      out.added++;
    }
    if (first) {
      run('UPDATE van_lines SET note = ? WHERE id = ?', appendNote(l.note, `Part of the plan text: “${first.text}”`), l.id);
      const r = linkLine(l.id, first.item_id, { reason: 'add part', worker, why: `“${first.text}” – the other parts of this plan text are their own lines` });
      out.linked = r.result === 'linked' || r.result === 'merged' ? 1 : 0;
      out.result = r.result;
      out.allocate.push(first.item_id);
    }
    out.left = Math.max(0, left - list.length);
    return out;
  });
}
