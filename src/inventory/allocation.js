// Allocation: handing shelf stock out to vans in build order, trimming what is set aside when stock
// goes down, and re-prioritising everything.
import { all, get, inTx, logAlloc, logAllocMany, run, writeTx } from '../db.js';
import { ALLOCATABLE } from '../lineState.js';
import { ACTIVE_VAN, PRIORITY, httpError, vanRanks } from './shared.js';

// Hand any free stock of one item to the vans that are still short, soonest delivery first.
// Lines on a PO raised for a specific van (`preferVan`) are served first.
// Per-van items (cladding in a customer's colour, a chassis…) only ever go to the van they were
// received for — a spare one left over from another van is never handed on automatically.
// `firm`: this much of the stock was just received for `preferVan` (a PO for that van, a delivery
// booked for it): what goes to that van's lines is locked to it (reserved_firm) — first by locking
// what it already held from the shelf, then from the new stock.
// `reason`: written to the allocation log ('' = don't log, the caller logs the net change).
// `poRef` (follow-up round 1): the order number the stock arrived on — of `preferVan`'s lines, the one that
// names that order (plan "Coast Order 137") is filled first, so a van with the part on two lines (one on
// order, one still to order) gets it on the line that was ordered and never comes back in "Check: already
// ordered?". Only the order of that one van's lines changes; other vans are never touched by it.
export async function allocateItem(itemId, preferVan = null, opts = {}) {
  return writeTx(() => allocate(itemId, preferVan, opts));
}
async function allocate(itemId, preferVan = null, { firm = 0, reason = 'allocate', worker = '', poRef = '' } = {}) {
  const item = await get('SELECT on_hand, kind FROM items WHERE id = ?', itemId);
  if (!item) return;
  let firmLeft = preferVan != null ? Math.max(0, firm) : 0;
  const ref = String(poRef ?? '').trim();
  const log = async (l, field, before, after, extra = {}) => {
    if (reason) await logAlloc(reason, { van_id: l.van_id, item_id: itemId, line_id: l.id, field, before, after, worker, ...extra });
  };
  if (firmLeft > 0) {
    for (const l of await all(`SELECT * FROM van_lines l WHERE van_id = ? AND item_id = ? AND reserved > reserved_firm AND ${ALLOCATABLE('l')}
                         ORDER BY CASE WHEN ? <> '' AND lower(trim(l.po_ref)) = lower(?) THEN 0 ELSE 1 END, id`, preferVan, itemId, ref, ref)) {
      if (firmLeft <= 0) break;
      const lock = Math.min(firmLeft, l.reserved - l.reserved_firm);
      await run('UPDATE van_lines SET reserved_firm = reserved_firm + ? WHERE id = ?', lock, l.id);
      await log(l, 'reserved_firm', l.reserved_firm, l.reserved_firm + lock, { change: 0, firm_change: lock });
      firmLeft -= lock;
    }
  }
  if (item.kind === 'per-van' && preferVan == null) return;
  const reserved = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id
                        WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r;
  let free = item.on_hand - reserved;
  if (!(free > 0) || !Number.isFinite(free)) return; // (a stock figure that is not a number hands out nothing)
  const lines = await all(`SELECT l.* FROM van_lines l JOIN vans v ON v.id = l.van_id
                     WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.qty > l.reserved + l.issued AND ${ALLOCATABLE('l')}
                       AND (? = 'stock' OR v.id = ?)
                     ORDER BY CASE WHEN v.id = ? THEN 0 ELSE 1 END,
                       CASE WHEN v.id = ? AND ? <> '' AND lower(trim(l.po_ref)) = lower(?) THEN 0 ELSE 1 END, ${PRIORITY}, l.id`,
                    itemId, item.kind, preferVan ?? -1, preferVan ?? -1, preferVan ?? -1, ref, ref);
  for (const l of lines) {
    if (free <= 0) break;
    const take = Math.min(free, l.qty - l.reserved - l.issued);
    const lock = l.van_id === preferVan ? Math.min(firmLeft, take) : 0;
    await run('UPDATE van_lines SET reserved = reserved + ?, reserved_firm = reserved_firm + ? WHERE id = ?', take, lock, l.id);
    await log(l, lock ? 'reserved (locked)' : 'reserved', l.reserved, l.reserved + take, { change: take, firm_change: lock });
    firmLeft -= lock;
    free -= take;
  }
}

// Set-aside stock that may move: what was held from the shelf, not what was received for the van.
const FLEX = 'GREATEST(0, l.reserved - l.reserved_firm)';

// If a count shows less on the shelf than is set aside, take the flexible part back from the vans
// built last. Parts received for a van (locked) are never taken here — the count screen asks about
// those. Returns how much is still over (locked stock the shelf doesn't have).
export async function trimReservations(itemId, { reason = 'trim', worker = '' } = {}) {
  const item = await get('SELECT on_hand FROM items WHERE id = ?', itemId);
  let over = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id
                  WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r - Math.max(0, item.on_hand);
  if (over <= 0) return 0;
  const ranks = await vanRanks();
  const lines = (await all(`SELECT l.*, ${FLEX} AS flex FROM van_lines l JOIN vans v ON v.id = l.van_id
                     WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.reserved > l.reserved_firm`, itemId))
    .sort((a, b) => (ranks.get(b.van_id) ?? 0) - (ranks.get(a.van_id) ?? 0) || b.id - a.id);
  for (const l of lines) {
    if (over <= 0) break;
    const give = Math.min(over, l.flex);
    await run('UPDATE van_lines SET reserved = reserved - ? WHERE id = ?', give, l.id);
    await logAlloc(reason, { van_id: l.van_id, item_id: itemId, line_id: l.id, field: 'reserved', before: l.reserved, after: l.reserved - give, worker });
    over -= give;
  }
  return Math.max(0, over);
}

// Every active line's set-aside amount: Map lineId → {van_id, item_id, reserved}.
async function reservedSnapshot() {
  return new Map((await all(`SELECT l.id, l.van_id, l.item_id, l.reserved FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE ${ACTIVE_VAN} ORDER BY l.id`))
    .map(r => [r.id, r]));
}

// Hand the flexible shelf stock out again in build order. Only reserved - reserved_firm moves:
// parts received for a van stay with it, and per-van parts are never moved to another van.
async function runReprioritise() {
  await run(`UPDATE van_lines SET reserved = reserved_firm
       WHERE reserved > reserved_firm AND van_id IN (SELECT id FROM vans v WHERE ${ACTIVE_VAN})
         AND item_id IN (SELECT id FROM items WHERE kind = 'stock')`);
  // Every stock item's free stock in one query, and allocate() only where there is some to hand out (it reads
  // it again itself). Asking allocate() for every item was two queries each even when nothing was free.
  // Handing out one item only changes that item's lines, so reading all of them up front gives the same answer.
  const free = await all(`SELECT i.id, i.on_hand, COALESCE(r.r, 0) AS r FROM items i
                     LEFT JOIN (SELECT l.item_id, SUM(l.reserved) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id
                                WHERE ${ACTIVE_VAN} GROUP BY l.item_id) r ON r.item_id = i.id
                     WHERE i.kind = 'stock' ORDER BY i.id`);
  for (const { id, on_hand, r } of free) if (on_hand - r > 0) await allocateItem(id, null, { reason: '' });
}

// Per van: the parts it would gain and lose (net, per item).
async function reprioritiseDiff(before, after) {
  const net = new Map(); // `${van}|${item}` → delta
  for (const [id, b] of before) {
    const d = (after.get(id)?.reserved ?? 0) - b.reserved;
    if (Math.abs(d) < 1e-9) continue;
    const k = `${b.van_id}|${b.item_id}`;
    net.set(k, (net.get(k) || 0) + d);
  }
  const vans = new Map();
  const names = new Map((await all('SELECT id, sku, name, unit FROM items')).map(i => [i.id, i]));
  const chassis = new Map((await all('SELECT id, chassis FROM vans')).map(v => [v.id, v.chassis]));
  const ranks = await vanRanks();
  for (const [k, d] of net) {
    if (Math.abs(d) < 1e-9) continue;
    const [vanId, itemId] = k.split('|').map(Number);
    if (!vans.has(vanId)) vans.set(vanId, { van_id: vanId, chassis: chassis.get(vanId), gains: [], loses: [] });
    const it = names.get(itemId) || {};
    vans.get(vanId)[d > 0 ? 'gains' : 'loses'].push({ item_id: itemId, sku: it.sku, name: it.name, unit: it.unit, qty: Math.abs(d) });
  }
  return [...vans.values()].sort((a, b) => (ranks.get(a.van_id) ?? 0) - (ranks.get(b.van_id) ?? 0));
}

// What "Re-prioritise" would do, without doing it: done inside a write transaction (so nobody changes the
// stock meanwhile) that is then rolled back — nothing is kept and data_version is not bumped.
const ROLLBACK = Symbol('roll back the preview');
export async function reprioritisePreview() {
  if (inTx()) throw httpError(409, 'Busy — try again');
  let diff;
  try {
    await writeTx(async () => {
      const before = await reservedSnapshot();
      await runReprioritise();
      diff = await reprioritiseDiff(before, await reservedSnapshot());
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return diff;
}

export async function reprioritiseAll({ by = '' } = {}) {
  return writeTx(async () => {
    const before = await reservedSnapshot();
    await runReprioritise();
    const after = await reservedSnapshot();
    const log = [];
    for (const [id, b] of before) {
      const a = after.get(id)?.reserved ?? 0;
      if (Math.abs(a - b.reserved) > 1e-9) log.push(['reprioritise', { van_id: b.van_id, item_id: b.item_id, line_id: id, field: 'reserved', before: b.reserved, after: a, worker: by }]);
    }
    await logAllocMany(log);
    return reprioritiseDiff(before, after);
  });
}
