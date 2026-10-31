// Go-live: parts already fitted to vans before the app was used.
import { all, get, ids, logAlloc, run, writeTx } from '../db.js';
import { today } from '../lineState.js';
import { skuNow } from '../relink.js';
import { buildOrderInfo, httpError, q } from './shared.js';

// Parts put in a van before the system was in use. Each ticked line is closed (issued = qty), so it
// is never short and never re-ordered. Only what was set aside for it leaves the shelf figure (that
// stock was in the books); nothing is taken from free stock. One 'issue' movement per item.
// `done`: the office went through the list for this van (go-live checklist step c) — also with
// nothing ticked ("nothing else is fitted").
export async function markFitted(vanId, lineIds, worker = '', { done = false } = {}) {
  if ((!Array.isArray(lineIds) || !lineIds.length) && !done) throw httpError(400, 'Tick the parts that are already fitted');
  lineIds = Array.isArray(lineIds) ? lineIds : [];
  return writeTx(async () => {
    const van = await get('SELECT id, chassis, status FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'Van not found');
    if (done) await logAlloc('fitted: checked', { van_id: vanId, field: 'checked', after: 'yes', worker, note: `${van.chassis}: already-fitted parts checked (${lineIds.length} ticked)` });
    if (!lineIds.length) return { closed: 0, movements: 0 };
    const ids = lineIds.map(Number);
    const lines = await all(`SELECT * FROM van_lines WHERE van_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND issued < qty ORDER BY id`, vanId, ...ids);
    const perItem = new Map();
    let closed = 0;
    for (const l of lines) {
      const fromStock = Math.max(0, Math.min(l.reserved, l.qty - l.issued));
      await run('UPDATE van_lines SET issued = qty, reserved = 0, reserved_firm = 0 WHERE id = ?', l.id);
      closed++;
      if (fromStock > 0) perItem.set(l.item_id, (perItem.get(l.item_id) || 0) + fromStock);
      await logAlloc('fitted', { van_id: vanId, item_id: l.item_id, line_id: l.id, field: 'issued', before: l.issued, after: l.qty, worker,
        change: -l.reserved, firm_change: -l.reserved_firm,
        note: fromStock >= l.qty - l.issued ? 'fitted before go-live, set-aside stock used'
          : fromStock > 0 ? `fitted before go-live: ${q(fromStock)} from set-aside stock, ${q(l.qty - l.issued - fromStock)} not from stock`
          : 'fitted before go-live, not from stock' });
    }
    for (const [itemId, n] of perItem) {
      await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', n, itemId);
      await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'issue', ?, ?, 'Already fitted (set up before go-live)', ?)`,
          itemId, -n, vanId, van.chassis, worker);
    }
    return { closed, movements: perItem.size };
  });
}

// "Already fitted…" quick start (round 2, user-r1-5): which open lines of this van were received FOR this
// van and are still kept for it in full, and when they arrived. The dialog offers "tick everything
// received more than N weeks ago (or before the system started)" so a van that has been in the bays a
// while takes minutes, not an hour. Nothing is ticked or saved here — the office still presses Save.
//   received_at  date of the last delivery booked for this van and part ('' if none)
//   before_start 1 = it came in with the production plan import (arrived before the system was used)
//   covered      1 = what is kept for the van covers everything the line still needs (only these are offered)
const PLAN_IMPORT_NOTE = 'Received for this van (production plan import)';
export async function fittedQuickStart(vanId) {
  const van = await get(`SELECT v.id, v.chassis, v.status, fa.name AS area_name, fa.kind AS area_kind FROM vans v
                   LEFT JOIN floor_areas fa ON fa.id = v.area_id WHERE v.id = ?`, vanId);
  if (!van) throw httpError(404, 'Van not found');
  const rec = new Map((await all(`SELECT item_id, MAX(substr(at, 1, 10)) AS last_at,
                             MAX(CASE WHEN note = ? THEN 0 ELSE 1 END) AS any_real
                           FROM movements WHERE van_id = ? AND type = 'receive' AND qty > 0 GROUP BY item_id`, PLAN_IMPORT_NOTE, vanId))
    .map(r => [r.item_id, r]));
  // A line moved off an "as per plan" catch-all onto the real part brought its received stock with it
  // (an 'adjust' "Re-linked from PLAN-X"): it arrived when the catch-all's delivery did.
  for (const m of await all(`SELECT m.item_id, substr(m.at, 1, 10) AS at, m.note FROM movements m
                       WHERE m.van_id = ? AND m.type = 'adjust' AND m.qty > 0 AND m.note ILIKE 'Re-linked from %' ORDER BY m.id`, vanId)) {
    const from = await get('SELECT id FROM items WHERE sku = ?', skuNow(String(m.note).slice('Re-linked from '.length).trim().split(/\s/)[0]));
    const src = from && rec.get(from.id);
    const cur = rec.get(m.item_id);
    const add = src || { last_at: m.at, any_real: 1 };
    rec.set(m.item_id, cur ? { last_at: cur.last_at > add.last_at ? cur.last_at : add.last_at, any_real: cur.any_real || add.any_real } : { ...add });
  }
  const lines = (await all(`SELECT id, item_id, qty, issued, reserved, reserved_firm, state FROM van_lines WHERE van_id = ? AND issued < qty ORDER BY id`, vanId))
    .map(l => {
      const r = rec.get(l.item_id);
      const open = l.qty - l.issued;
      return { id: l.id, received_at: r?.last_at || '', before_start: r && !r.any_real ? 1 : 0, kept: l.reserved_firm,
        covered: l.reserved_firm > 0 && l.reserved_firm >= open - 1e-9 && !['customer', 'tbd'].includes(l.state) ? 1 : 0 };
    });
  return { van: { ...van, build: (await buildOrderInfo()).get(van.id) || null }, today: today(), lines };
}
