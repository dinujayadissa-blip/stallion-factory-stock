// Bought-for-van stock with no van (C9): assign it to a van or keep it as a spare.
import { ID_LIST, all, get, ids, logAlloc, run, writeTx } from '../db.js';
import { ALLOCATABLE } from '../lineState.js';
import { ACTIVE_VAN, checkQty, httpError, isPlaceholder, q, vanRanks } from './shared.js';

// A per-van part (fridge, aircon…) only ever goes to its own van. Stock of one that is on the shelf
// but not set aside for any van (on hand − set aside) would sit there unseen, so it is listed until
// the office either assigns it to a van or says "keep it on the shelf as a spare".
// The "spare" answer is a log entry (reason 'spare', after = how many were unassigned when answered);
// more stock arriving with no van brings the item back onto the list.

// The latest "spare" answer for each of these items (0 = never answered).
export async function spareAcks(itemIds) {
  const out = new Map(itemIds.map(id => [id, 0]));
  for (const r of await all(`SELECT DISTINCT ON (item_id) item_id, after FROM allocation_log
                             WHERE reason = 'spare' AND item_id IN ${ID_LIST} ORDER BY item_id, id DESC`, ids(itemIds))) out.set(r.item_id, Number(r.after) || 0);
  return out;
}

export async function unassignedPerVan({ all: everything = false } = {}) {
  const rows = (await all(`SELECT i.id, i.sku, i.name, i.unit, i.unit_size, i.photo, i.supplier, i.placeholder, i.on_hand,
                      i.on_hand - COALESCE((SELECT SUM(l.reserved) FROM van_lines l JOIN vans v ON v.id = l.van_id
                                            WHERE l.item_id = i.id AND ${ACTIVE_VAN}), 0) AS unassigned
                    FROM items i WHERE i.active = 1 AND i.kind = 'per-van' ORDER BY i.id`)).filter(r => r.unassigned > 1e-9);
  if (!rows.length) return [];
  const itemIds = rows.map(r => r.id);
  const ranks = await vanRanks();
  const spares = await spareAcks(itemIds);
  // the active vans still short of each part, in build order
  const vansOf = new Map(itemIds.map(id => [id, []]));
  for (const { item_id, ...v } of await all(`SELECT l.item_id, l.van_id, v.chassis, v.eta, v.status, SUM(l.qty - l.reserved - l.issued) AS short
                      FROM van_lines l JOIN vans v ON v.id = l.van_id
                      WHERE l.item_id IN ${ID_LIST} AND ${ACTIVE_VAN} AND l.qty > l.reserved + l.issued + 1e-9 AND ${ALLOCATABLE('l')}
                      GROUP BY l.item_id, l.van_id, v.id`, ids(itemIds))) vansOf.get(item_id).push(v);
  const out = rows.map(r => {
    const spare = spares.get(r.id);
    const vans = vansOf.get(r.id).sort((a, b) => (ranks.get(a.van_id) ?? 1e9) - (ranks.get(b.van_id) ?? 1e9));
    return { ...r, placeholder: isPlaceholder(r) ? 1 : 0, spare, needs_answer: r.unassigned > spare + 1e-9 ? 1 : 0, vans };
  });
  return out.filter(r => everything || r.needs_answer).sort((a, b) => a.name.localeCompare(b.name));
}

// Put unassigned bought-for-van stock to a van: set aside and locked to it (logged).
export async function assignToVan(itemId, vanId, qty, by = '') {
  return writeTx(async () => {
    const it = await get('SELECT * FROM items WHERE id = ?', itemId);
    if (!it) throw httpError(404, 'Part not found');
    const free = it.on_hand - (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r;
    if (!(qty == null || qty === '')) checkQty(Number(qty));
    const want = qty == null || qty === '' ? free : Math.min(Number(qty), free);
    if (!(want > 1e-9)) throw httpError(409, 'Nothing left to assign — refresh');
    const van = await get('SELECT chassis, status FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'That van no longer exists — refresh');
    // Stock locked to a finished or cancelled van would never be handed out again (and "gone out the gate"
    // would count it as used).
    if (!['planned', 'in_production'].includes(van.status)) throw httpError(409, 'That van is not active');
    let left = want;
    for (const l of await all(`SELECT * FROM van_lines l WHERE van_id = ? AND item_id = ? AND l.qty > l.reserved + l.issued + 1e-9 AND ${ALLOCATABLE('l')} ORDER BY id`, vanId, itemId)) {
      if (left <= 1e-9) break;
      const take = Math.min(left, l.qty - l.reserved - l.issued);
      await run('UPDATE van_lines SET reserved = reserved + ?, reserved_firm = reserved_firm + ? WHERE id = ?', take, take, l.id);
      await logAlloc('assign to van', { van_id: vanId, item_id: itemId, line_id: l.id, field: 'reserved (locked)', before: l.reserved, after: l.reserved + take, worker: by,
        change: take, firm_change: take, note: `bought-for-van stock with no van – assigned to ${van.chassis}` });
      left -= take;
    }
    if (left >= want - 1e-9) throw httpError(409, `${van.chassis} doesn't need this part any more — pick another van`);
    return { assigned: want - left };
  });
}

// "Keep on the shelf as a spare": the office has seen it; it stays visible as Unassigned.
export async function keepSpare(itemId, by = '') {
  return writeTx(async () => {
    const r = (await unassignedPerVan({ all: true })).find(x => x.id === Number(itemId));
    if (!r) throw httpError(409, 'Nothing unassigned for this part — refresh');
    await logAlloc('spare', { item_id: r.id, field: 'spare', before: q(r.spare), after: q(r.unassigned), worker: by, note: `${q(r.unassigned)} ${r.unit} kept on the shelf as a spare (no van)` });
    return { ok: true };
  });
}
