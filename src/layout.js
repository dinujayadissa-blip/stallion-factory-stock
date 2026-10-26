// Factory floor: the layout (bays, yard, gates, racks…), which van is where, and per-van notes
// and reminders. All sizes are in metres.
import { all, get, run, insert, writeTx, getSetting, setSetting } from './db.js';
import { httpError, useUpVan, stillMissingByVan, NO_MISSING, PRIORITY, buildOrderInfo } from './inventory.js';
import { guessLineTrade, isTrade } from './trades.js';

// Melbourne wall-clock text, the same format everything else in the database uses.
const MEL_DATE = `to_char(now() AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD')`;
const MEL_NOW = `to_char(now() AT TIME ZONE 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI:SS')`;

export const KINDS = {
  building: 'Building outline',
  bay: 'Van bay (inside)',
  yard: 'Yard space (outside)',
  gate_in: 'Gate — chassis in',
  gate_out: 'Gate — van out',
  office: 'Office',
  storage: 'Rack / storage',
  work: 'Workstation / table',
  wall: 'Wall / obstacle',
};
const PARKING = new Set(['bay', 'yard']);

// Starting layout, from the street photo and how the factory works: both roller doors are on the
// front (street side, bottom of the map) with the office between them. Chassis come in the left
// door and are pushed round a loop — up the left side, across the back, down the right side —
// and leave by the right door. The yard with 5 spaces is out the front, inside the fence.
// Everything can be dragged into place on the Factory floor page.
const DEFAULT = [
  ['building', 'Factory', 0, 0, 44, 30],
  ['gate_in', 'Chassis in', 3, 29.4, 6, 1.2],
  ['gate_out', 'Van out', 35, 29.4, 6, 1.2],
  ['office', 'Office', 16, 23, 12, 7],
  // the loop: Bay 1 just inside the left door … Bay 6 just inside the right door
  ['bay', 'Bay 1', 4.4, 16.5, 3.2, 9.2], ['bay', 'Bay 2', 4.4, 4, 3.2, 9.2],
  ['bay', 'Bay 3', 11, 1, 9.2, 3.2], ['bay', 'Bay 4', 24, 1, 9.2, 3.2],
  ['bay', 'Bay 5', 36.4, 4, 3.2, 9.2], ['bay', 'Bay 6', 36.4, 16.5, 3.2, 9.2],
  // the work area inside the loop
  ['work', 'Floor jig', 12, 7, 13, 3],
  ['work', 'Wall frame table', 12, 12, 13, 3],
  ['storage', 'Timber rack', 12, 16.5, 13, 1.6],
  ['storage', 'Probond / sheet stack', 27, 7, 4, 6],
  ['work', 'Panel saw', 27, 14.5, 4, 3],
  ['storage', 'Rack A', 0.4, 2, 1.6, 9],
  ['storage', 'Rack B', 0.4, 14, 1.6, 9],
  ['storage', 'Rack C', 42, 2, 1.6, 9],
  ['storage', 'Rack D', 42, 14, 1.6, 9],
  // front yard, inside the fence
  ['yard', 'Yard 1', 0.5, 33.5, 8.4, 3.2], ['yard', 'Yard 2', 9.3, 33.5, 8.4, 3.2], ['yard', 'Yard 3', 18.1, 33.5, 8.4, 3.2],
  ['yard', 'Yard 4', 26.9, 33.5, 8.4, 3.2], ['yard', 'Yard 5', 35.7, 33.5, 8.4, 3.2],
  ['wall', 'Front fence', -1, 38.5, 46, 0.3],
];

async function insertDefault() {
  for (const [i, [kind, name, x, y, w, h]] of DEFAULT.entries())
    await run('INSERT INTO floor_areas(kind, name, x, y, w, h, sort) VALUES(?,?,?,?,?,?,?)', kind, name, x, y, w, h, i);
}

export function seedLayout() {
  return writeTx(async () => {
    if (await getSetting('layout_seeded') === '1' || (await get('SELECT COUNT(*) AS c FROM floor_areas')).c > 0) {
      await upgradeUntouchedLayout();
      return;
    }
    await insertDefault();
    await setSetting('layout_seeded', '2');
  });
}

// The first version's starting layout (gates at the two ends) was a guess. If nobody has placed
// a van, located an item or moved anything yet, swap it for the front-doors loop layout.
async function upgradeUntouchedLayout() {
  if (await getSetting('layout_seeded') !== '1') return;
  const untouched = (await get('SELECT COUNT(*) AS c FROM floor_areas')).c === 23
    && !!(await get(`SELECT 1 AS ok FROM floor_areas WHERE kind = 'gate_in' AND x = -0.6 AND y = 7`))
    && !(await get('SELECT 1 FROM vans WHERE area_id IS NOT NULL'))
    && !(await get('SELECT 1 FROM items WHERE area_id IS NOT NULL'));
  if (untouched) { await run('DELETE FROM floor_areas'); await insertDefault(); }
  await setSetting('layout_seeded', '2');
}

// Bays in flow order (Bay 1, Bay 2, … by the number in the name).
async function baysInOrder() {
  const n = a => Number((/\d+/.exec(a.name) || [])[0] ?? 9999);
  return (await all(`SELECT * FROM floor_areas WHERE kind = 'bay'`)).sort((a, b) => n(a) - n(b) || a.id - b.id);
}

// "Move the line along": the van in the last bay goes out to the first free yard space, every
// other van moves forward one bay, and Bay 1 is free for the next chassis (nextVanId, optional).
// dryRun returns the moves without making them. `expect` (optional) is the moves list the user saw in
// the preview; if the floor has changed since (e.g. a second click already moved it), nothing is moved.
export async function advanceLine({ nextVanId = null, dryRun = false, expect = null } = {}) {
  const work = async () => {
    const bays = await baysInOrder();
    if (bays.length < 2) throw httpError(400, 'Add at least two bays to the layout first');
    const at = new Map((await all(`SELECT v.id, v.chassis, v.area_id FROM vans v WHERE v.area_id IS NOT NULL AND ${ACTIVE}`)).map(v => [v.area_id, v]));
    const moves = [];
    const move = async (van, area) => { moves.push({ chassis: van.chassis, from: null, to: area.name }); if (!dryRun) await run('UPDATE vans SET area_id = ? WHERE id = ?', area.id, van.id); };
    const last = bays[bays.length - 1];
    const leaving = at.get(last.id);
    if (leaving) {
      const yard = (await all(`SELECT * FROM floor_areas WHERE kind = 'yard' ORDER BY sort, id`)).find(a => !at.has(a.id));
      if (!yard) throw httpError(400, `The yard is full, so ${leaving.chassis} has nowhere to go — mark a yard van as gone out the gate first`);
      await move(leaving, yard); moves[moves.length - 1].from = last.name;
    }
    for (let i = bays.length - 2; i >= 0; i--) {
      const v = at.get(bays[i].id);
      if (v) { await move(v, bays[i + 1]); moves[moves.length - 1].from = bays[i].name; }
    }
    if (nextVanId) {
      const nv = await get(`SELECT v.id, v.chassis, v.area_id FROM vans v WHERE v.id = ? AND ${ACTIVE}`, nextVanId);
      if (!nv) throw httpError(404, 'That van is not active');
      if (nv.area_id) throw httpError(400, expect ? 'The line has already moved, check the map' : `${nv.chassis} is already on the floor`);
      await move(nv, bays[0]);
      if (!dryRun && (await get('SELECT status FROM vans WHERE id = ?', nv.id)).status === 'planned') await run(`UPDATE vans SET status = 'in_production' WHERE id = ?`, nv.id);
    }
    const key = list => JSON.stringify(list.map(m => [m?.chassis ?? null, m?.from ?? null, m?.to ?? null]));
    if (Array.isArray(expect) && key(expect) !== key(moves)) throw httpError(409, 'The line has already moved, check the map'); // tx rolls back
    return { moves, firstBay: bays[0].name, lastBay: last.name };
  };
  return dryRun ? work() : writeTx(work);
}

const ACTIVE = `v.status IN ('planned','in_production')`;
const ACTIVE_STATUS = ['planned', 'in_production']; // (the same, for a van already read)
// A line that counts as one of the van's parts: the Dashboard / Vans list bar (line_count in inventory.js
// listVans) — customer supplies / to be decided lines are reminders, not parts, unless already issued.
const COUNTED_PART = l => `${l}.state NOT IN ('customer','tbd') OR ${l}.issued >= ${l}.qty`;

// Everything the map needs in one go.
export async function getLayout() {
  const areas = await all('SELECT * FROM floor_areas ORDER BY sort, id');
  const vans = await all(`
    SELECT v.id, v.chassis, v.model, v.length, v.customer, v.eta, v.status, v.area_id,
      -- Parts counted the Dashboard's way (round 2 phone batch 1, owner-r1-2): customer supplies / to be decided
      -- lines are reminders, not parts, unless something was already issued for them.
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND (${COUNTED_PART('l')})) AS total,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND l.issued >= l.qty) AS done,
      (SELECT COUNT(*) FROM van_notes n WHERE n.van_id = v.id) AS notes,
      (SELECT COUNT(*) FROM reminders r WHERE r.van_id = v.id AND r.done = 0) AS reminders,
      (SELECT COUNT(*) FROM reminders r WHERE r.van_id = v.id AND r.done = 0 AND r.due <> '' AND r.due <= ${MEL_DATE}) AS due
    FROM vans v WHERE ${ACTIVE}
    -- Follow-up round 1 (owner-r3-1): in build order (the Vans page's #1, #2 …), not by due date — a planned van whose
    -- date has passed ("Date passed – check") no longer jumps to the top of "Not on the floor yet" / "Move the line along".
    ORDER BY ${PRIORITY}`);
  // The red badge: parts still missing, the same count as the Dashboard, Vans list and van page (phone batch 1).
  // It used to count customer supplies / to be decided lines too, so it was one more than the Vans list for a van
  // with one of those (ST0375, ST0393).
  const still = await stillMissingByVan();
  const bo = await buildOrderInfo();
  for (const v of vans) { v.still = still.get(v.id) || NO_MISSING; v.missing = v.still.missing; v.build_pos = bo.get(v.id)?.pos ?? null; }
  const stock = await all(`SELECT area_id, COUNT(*) AS n FROM items WHERE area_id IS NOT NULL AND active = 1 GROUP BY area_id`);
  return { areas, vans, kinds: KINDS, itemCounts: Object.fromEntries(stock.map(s => [s.area_id, s.n])) };
}

const num = v => { const n = Number(v); if (!Number.isFinite(n)) throw httpError(400, 'Sizes must be numbers'); return Math.round(n * 100) / 100; };

export async function saveArea(id, b) {
  if (b.kind && !KINDS[b.kind]) throw httpError(400, 'Unknown area type');
  const fields = { kind: b.kind, name: b.name != null ? String(b.name).trim().slice(0, 60) : undefined, notes: b.notes };
  for (const k of ['x', 'y', 'w', 'h']) if (b[k] != null) fields[k] = num(b[k]);
  if ((fields.w != null && fields.w < 0.3) || (fields.h != null && fields.h < 0.3)) throw httpError(400, 'Too small');
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (!id) for (const k of ['kind', 'x', 'y', 'w', 'h']) if (fields[k] == null) throw httpError(400, `Missing ${k}`);
  return writeTx(async () => {
    if (id) {
      if (!(await get('SELECT 1 FROM floor_areas WHERE id = ?', id))) throw httpError(404, 'Area not found');
      if (keys.length) await run(`UPDATE floor_areas SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => fields[k]), id);
      // An area that stops being a parking spot can't hold a van any more.
      const a = await get('SELECT kind FROM floor_areas WHERE id = ?', id);
      if (!PARKING.has(a.kind)) await run('UPDATE vans SET area_id = NULL WHERE area_id = ?', id);
      return { id };
    }
    const sort = ((await get('SELECT MAX(sort) AS s FROM floor_areas')).s || 0) + 1;
    const newId = await insert('INSERT INTO floor_areas(kind, name, x, y, w, h, sort, notes) VALUES(?,?,?,?,?,?,?,?)',
      fields.kind, fields.name || KINDS[fields.kind], fields.x, fields.y, fields.w, fields.h, sort, fields.notes || '');
    return { id: Number(newId) };
  });
}

export function deleteArea(id) {
  return writeTx(async () => {
    await run('UPDATE vans SET area_id = NULL WHERE area_id = ?', id);
    await run('UPDATE items SET area_id = NULL WHERE area_id = ?', id);
    await run('DELETE FROM floor_areas WHERE id = ?', id);
  });
}

// Park a van in a bay / yard space (or take it off the map with areaId = null).
// If another van is already there, the two swap places.
export function moveVan(vanId, areaId) {
  return writeTx(async () => {
    const van = await get('SELECT id, chassis, area_id, status FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'Van not found');
    // Only a van still being built goes on the map (as for "Move the line along"): a finished or cancelled one
    // would hold a bay nobody can see.
    if (!ACTIVE_STATUS.includes(van.status)) throw httpError(409, 'That van is not active');
    if (areaId == null) { await run('UPDATE vans SET area_id = NULL WHERE id = ?', vanId); return { swapped: null }; }
    const area = await get('SELECT * FROM floor_areas WHERE id = ?', areaId);
    if (!area) throw httpError(404, 'That spot no longer exists');
    if (!PARKING.has(area.kind)) throw httpError(400, `${area.name} isn't a van bay or yard space`);
    const other = await get(`SELECT id, chassis FROM vans v WHERE area_id = ? AND id <> ? AND ${ACTIVE}`, areaId, vanId);
    if (other) await run('UPDATE vans SET area_id = ? WHERE id = ?', van.area_id, other.id);
    await run('UPDATE vans SET area_id = ? WHERE id = ?', areaId, vanId);
    if (area.kind === 'bay' && van.status === 'planned') await run(`UPDATE vans SET status = 'in_production' WHERE id = ?`, vanId);
    return { swapped: other ? other.chassis : null };
  });
}

// The van has gone out the gate: finished, off the map, and parts still set aside for it are used up.
export function leaveFactory(vanId) {
  return writeTx(async () => {
    const van = await get('SELECT id, status FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'Van not found');
    // Only a van still being built can go out the gate: a cancelled one must not become "finished" (and use up
    // stock set aside for it), and a finished one already went.
    if (!ACTIVE_STATUS.includes(van.status)) throw httpError(409, 'That van is not active');
    await useUpVan(vanId);
    await run(`UPDATE vans SET status = 'completed', area_id = NULL WHERE id = ?`, vanId);
    await run(`UPDATE reminders SET done = 1, done_at = ${MEL_NOW} WHERE van_id = ? AND done = 0`, vanId);
  });
}

// Everything for the van panel: what's missing, notes, reminders.
export async function vanFloorInfo(vanId) {
  const van = await get('SELECT v.*, a.name AS area_name FROM vans v LEFT JOIN floor_areas a ON a.id = v.area_id WHERE v.id = ?', vanId);
  if (!van) throw httpError(404, 'Van not found');
  const lines = await all(`
    SELECT l.id, l.qty, l.reserved, l.issued, l.spec, l.state, i.name, i.sku, i.unit, i.photo, i.location, a.name AS area_name,
      (EXISTS(SELECT 1 FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
             WHERE p.status = 'open' AND pl.item_id = l.item_id AND pl.qty - pl.received - pl.closed > 1e-9 AND (pl.van_id IS NULL OR pl.van_id = l.van_id)))::int AS on_order
    FROM van_lines l JOIN items i ON i.id = l.item_id LEFT JOIN floor_areas a ON a.id = i.area_id
    WHERE l.van_id = ? AND l.issued < l.qty ORDER BY i.category, i.name`, vanId);
  // Round 2 phone batch 1 (owner-r1-2): the same total as the Dashboard bar and the map, the same "still
  // missing" as the badge, and how many customer supplies / to be decided lines are left out of the total.
  const total = await get(`SELECT SUM(CASE WHEN ${COUNTED_PART('l')} THEN 1 ELSE 0 END) AS t, SUM(CASE WHEN l.issued >= l.qty THEN 1 ELSE 0 END) AS d,
      SUM(CASE WHEN ${COUNTED_PART('l')} THEN 0 ELSE 1 END) AS r FROM van_lines l WHERE l.van_id = ?`, vanId);
  van.still = (await stillMissingByVan({ vanId })).get(vanId) || NO_MISSING;
  return {
    van,
    total: total.t || 0, done: total.d || 0, reminderLines: total.r || 0,
    // Customer supplies / to be decided are reminders, not missing parts.
    notInFactory: lines.filter(l => l.qty > l.reserved + l.issued && !['customer', 'tbd'].includes(l.state)),
    readyToFit: lines.filter(l => l.qty <= l.reserved + l.issued),
    waitingDecision: lines.filter(l => l.qty > l.reserved + l.issued && ['customer', 'tbd'].includes(l.state)),
    notes: await all('SELECT * FROM van_notes WHERE van_id = ? ORDER BY id DESC', vanId),
    reminders: await all('SELECT * FROM reminders WHERE van_id = ? ORDER BY done, CASE WHEN due = \'\' THEN 1 ELSE 0 END, due, id', vanId),
  };
}

export async function addNote(vanId, text, worker = '') {
  const t = String(text || '').trim();
  if (!t) throw httpError(400, 'Write something first');
  return writeTx(async () => {
    if (!(await get('SELECT 1 FROM vans WHERE id = ?', vanId))) throw httpError(404, 'Van not found');
    return { id: Number(await insert('INSERT INTO van_notes(van_id, text, worker) VALUES(?,?,?)', vanId, t.slice(0, 2000), worker)) };
  });
}
export const deleteNote = id => writeTx(() => run('DELETE FROM van_notes WHERE id = ?', id));

export async function addReminder({ van_id = null, text, due = '', trade = '' }, worker = '') {
  const t = String(text || '').trim();
  if (!t) throw httpError(400, 'What should we be reminded about?');
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw httpError(400, 'Pick a date');
  const tr = isTrade(trade) ? trade : '';
  return writeTx(async () => ({ id: Number(await insert('INSERT INTO reminders(van_id, text, due, worker, trade) VALUES(?,?,?,?,?)', van_id || null, t.slice(0, 500), due, worker, tr)) }));
}
// Dealer order lines that say to build something "as per drawing", "as per email" or "as per
// (client's) photo" need that reference checked first, so each one becomes a reminder on the van.
// Keyed by the order line, so loading the order again (or restarting) never adds it twice — and a
// reminder already ticked off stays done.
const REFS = [
  { re: /\bdrawings?\b/i, icon: '📐', word: 'drawing' },
  { re: /\be-?mails?\b/i, icon: '✉️', word: 'customer email' },
  { re: /\b(photos?|pics?|pictures?)\b/i, icon: '📷', word: 'photo' },
];
export const REF_RE = /\b(drawings?|e-?mails?|photos?|pics?|pictures?)\b/i;
const titleCase = s => String(s).toLowerCase().replace(/(^|\s)(\w)/g, (m, a, c) => a + c.toUpperCase());

export function drawingReminders(vanId) {
  return writeTx(() => drawingRemindersIn(vanId));
}
async function drawingRemindersIn(vanId) {
  // Dealer order form lines only (not the production plan spreadsheet cells).
  const fields = await all(`SELECT section, label, value FROM order_fields WHERE van_id = ? AND section <> 'PRODUCTION PLAN' ORDER BY sort`, vanId);
  let added = 0;
  const seen = new Map(); // a label can appear twice (e.g. two UPHOLSTERY lines): 2nd one is "#2"
  for (const f of fields) {
    const line = `${f.label} ${f.value}`;
    const kinds = REFS.filter(r => r.re.test(line));
    if (!kinds.length) continue;
    const nth = (seen.get(f.label) || 0) + 1;
    seen.set(f.label, nth);
    const key = `drawing:${f.label}${nth > 1 ? `#${nth}` : ''}`.slice(0, 200);
    const no = (/drawings?\s*(?:no\.?\s*)?(\d+)/i.exec(line) || [])[1];
    const what = kinds.map(k => k.word === 'drawing' && no ? `drawing ${no}` : k.word).join(' + ');
    const text = `${kinds[0].icon} Check ${what} — ${titleCase(f.label)}${f.value ? `: ${f.value}` : ''}`.slice(0, 500);
    const old = await get('SELECT id, text FROM reminders WHERE van_id = ? AND source = ?', vanId, key);
    if (old) {
      // A revised order changed this line: show the new wording and open it again.
      if (f.value && !old.text.includes(String(f.value).slice(0, 200))) {
        await run(`UPDATE reminders SET text = ?, done = 0, done_at = '' WHERE id = ?`, text, old.id);
      }
      continue;
    }
    await run(`INSERT INTO reminders(van_id, text, due, worker, source, trade) VALUES(?, ?, '', 'Dealer order', ?, ?)`,
        vanId, text, key, guessLineTrade(f.section, f.label, f.value));
    added++;
  }
  return added;
}

// "Customer supplies" accepted on the New dealer order screen for an option no parts rule covers (Small fixes &
// phone round 1, user-r4-9): "JOCKEY WHEEL: customer sending black Jack maxi". Nothing to order, but the floor has
// to know the part comes from the customer — a reminder on the van (once per option; a revised order updates it).
// `picked` = [{ label, value }] as shown; only options that are really on this van's order are used.
export async function customerReminders(vanId, picked) {
  if (!Array.isArray(picked) || !picked.length) return 0;
  return writeTx(async () => {
    const fields = await all(`SELECT section, label, value FROM order_fields WHERE van_id = ? AND section <> 'PRODUCTION PLAN' ORDER BY sort`, vanId);
    let added = 0;
    for (const p of picked) {
      const f = fields.find(x => x.label === String(p?.label || '') && x.value === String(p?.value ?? ''));
      if (!f) continue;
      const key = `customer:${f.label}`.slice(0, 200);
      const text = `Customer supplies — ${titleCase(f.label)}${f.value ? `: ${f.value}` : ''} (nothing to order – check it has arrived before fitting)`.slice(0, 500);
      const old = await get('SELECT id, text FROM reminders WHERE van_id = ? AND source = ?', vanId, key);
      if (old) { if (old.text !== text) await run(`UPDATE reminders SET text = ?, done = 0, done_at = '' WHERE id = ?`, text, old.id); continue; }
      await run(`INSERT INTO reminders(van_id, text, due, worker, source, trade) VALUES(?, ?, '', 'Dealer order', ?, ?)`,
          vanId, text, key, guessLineTrade(f.section, f.label, f.value));
      added++;
    }
    return added;
  });
}

// Run over every active van (on startup) — picks up orders loaded before this existed, and gives
// automatic reminders made before trades existed their trade.
export function drawingRemindersAll() {
  return writeTx(async () => {
    let added = 0;
    for (const { id } of await all(`SELECT id FROM vans v WHERE ${ACTIVE}`)) added += await drawingRemindersIn(id);
    for (const r of await all(`SELECT id, van_id, source FROM reminders WHERE trade = '' AND source ILIKE 'drawing:%'`)) {
      const f = await get(`SELECT section, label, value FROM order_fields WHERE van_id = ? AND label = ? AND section <> 'PRODUCTION PLAN'`, r.van_id, r.source.slice(8).replace(/#\d+$/, ''));
      if (f) await run('UPDATE reminders SET trade = ? WHERE id = ?', guessLineTrade(f.section, f.label, f.value), r.id);
    }
    return added;
  });
}

// The floor map for one trade: each van's badge counts that trade's parts still to fit and its
// open reminders (reminders for everyone count for every trade). trade 'all' = everything.
export async function floorMap(trade) {
  const t = isTrade(trade) ? trade : 'all';
  const layout = await getLayout();
  // `ready` = the van screen's "On shelf" tab (round 2, worker-r1-2): set aside for this van, or free stock on
  // the shelf (on hand − set aside for every active van) and not a customer-supplies / to-be-decided line.
  // The same test as lineState() in public/floor.js, so the card's "on shelf" matches the tab exactly.
  const left = new Map((await all(`WITH held AS (SELECT x.item_id, SUM(x.reserved) AS r FROM van_lines x JOIN vans hv ON hv.id = x.van_id
                                          WHERE hv.status IN ('planned','in_production') GROUP BY x.item_id)
                            SELECT l.van_id, COUNT(*) AS n,
                              SUM(CASE WHEN l.reserved > 0 OR (COALESCE(l.state, '') NOT IN ('customer','tbd')
                                         AND i.on_hand - COALESCE(held.r, 0) > 0) THEN 1 ELSE 0 END) AS ready
                            FROM van_lines l JOIN items i ON i.id = l.item_id LEFT JOIN held ON held.item_id = l.item_id
                            WHERE l.issued < l.qty AND (?::text = 'all' OR i.trade = ?) GROUP BY l.van_id`, t, t)).map(r => [r.van_id, r]));
  const rem = new Map((await all(`SELECT van_id, COUNT(*) AS n,
                             SUM(CASE WHEN due <> '' AND due <= ${MEL_DATE} THEN 1 ELSE 0 END) AS due
                           FROM reminders WHERE done = 0 AND (?::text = 'all' OR trade = '' OR trade = ?) GROUP BY van_id`, t, t)).map(r => [r.van_id, r]));
  // "Still missing" for this trade, counted the same way as the office screens (phone batch 1).
  const still = t === 'all' ? null : await stillMissingByVan({ trade: t });
  layout.vans = layout.vans.map(v => ({
    ...v,
    still: still ? still.get(v.id) || NO_MISSING : v.still,
    missing: left.get(v.id)?.n || 0,      // badge: parts left for this trade (to fit — not the same as still missing)
    ready: left.get(v.id)?.ready || 0,    // of those, on the shelf now (= the van's "On shelf" tab)
    reminders: rem.get(v.id)?.n || 0,
    due: rem.get(v.id)?.n || 0,           // any open reminder for this trade shows the orange badge
  }));
  return layout;
}

export function setReminderDone(id, done) {
  return writeTx(() => run(`UPDATE reminders SET done = ?, done_at = CASE WHEN ?::integer = 1 THEN ${MEL_NOW} ELSE '' END WHERE id = ?`, done ? 1 : 0, done ? 1 : 0, id));
}
// Automatic reminders (from "as per drawing" order lines) are ticked off instead of deleted, so the
// next restart doesn't bring them back.
export function deleteReminder(id) {
  return writeTx(async () => {
    if (await get(`SELECT 1 FROM reminders WHERE id = ? AND source ILIKE 'drawing:%'`, id)) return setReminderDone(id, true);
    return run('DELETE FROM reminders WHERE id = ?', id);
  });
}

// Open reminders across all vans, soonest first (dashboard).
export function openReminders() {
  return all(`SELECT r.*, v.chassis FROM reminders r LEFT JOIN vans v ON v.id = r.van_id
              WHERE r.done = 0 ORDER BY CASE WHEN r.due = '' THEN 1 ELSE 0 END, r.due, r.id LIMIT 50`);
}

export async function areaItems(areaId) {
  const area = await get('SELECT * FROM floor_areas WHERE id = ?', areaId);
  if (!area) throw httpError(404, 'Area not found');
  return { area, items: await all('SELECT id, sku, name, photo, on_hand, unit, location FROM items WHERE area_id = ? AND active = 1 ORDER BY name', areaId) };
}
