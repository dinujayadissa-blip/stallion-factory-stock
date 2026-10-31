// The weekly "Stock checks" page (C11) and its ticks.
import { all, get, run, writeTx } from '../db.js';
import { PO_IS_OPEN, PO_OPEN } from '../lineState.js';
import { COUNTABLE_ITEM, MELB, httpError, q, vanRanks } from './shared.js';

// Everything that changed the books outside the normal flow, for the office to look at once a week:
// floor / office corrections, borrowings between vans, count differences, over deliveries and the
// "is the bought-for-van part here?" answers. Shown: everything not yet ticked, plus what was ticked
// in the last 7 days.
export async function stockChecks() {
  const recent = `(x.ack = 0 OR x.at >= to_char(${MELB} - interval '7 days', 'YYYY-MM-DD HH24:MI:SS'))`;
  const corrections = await all(`SELECT x.id, x.at, x.qty, x.note, x.ref, x.worker, x.ack, i.name, i.unit, v.chassis FROM movements x
                             JOIN items i ON i.id = x.item_id LEFT JOIN vans v ON v.id = x.van_id
                           WHERE x.type = 'adjust' AND ${recent} AND x.note NOT ILIKE 'Re-linked%' AND x.note NOT ILIKE 'Plan quantity corrected%'
                             AND x.note <> 'Demo stock level' ORDER BY x.id DESC`);
  const ranks = await vanRanks();
  const borrows = [];
  // (what is on order for the van that lost the part comes in the same query)
  for (const { on_order: onOrder, ...b } of await all(`SELECT x.id, x.at, x.worker, x.note, x.ack, x.before, x.after, x.line_id, x.van_id, x.item_id,
                         v.chassis, i.name, i.unit, l.qty, l.reserved, l.issued, l.urgent,
                         CASE WHEN x.van_id IS NULL THEN 0 ELSE (SELECT COALESCE(SUM(${PO_OPEN}), 0) FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                           WHERE ${PO_IS_OPEN} AND pl.van_id = x.van_id AND pl.item_id = x.item_id) END AS on_order
                       FROM allocation_log x JOIN items i ON i.id = x.item_id LEFT JOIN vans v ON v.id = x.van_id LEFT JOIN van_lines l ON l.id = x.line_id
                       WHERE x.reason = 'borrow' AND ${recent} ORDER BY x.id DESC`)) {
    const to = /\bfor (\S+)/.exec(b.note || '')?.[1] || '';
    const short = b.qty != null ? Math.max(0, b.qty - b.reserved - b.issued) : 0;
    const reordered = b.qty == null ? 'line gone' : short <= 1e-9 ? 'covered again' : onOrder >= short - 1e-9 ? `re-ordered (${q(onOrder)} on order)` : '';
    borrows.push({ ...b, to, qty_moved: Number(b.before) - Number(b.after), reordered, rank: ranks.get(b.van_id) ?? null });
  }
  const counts = await all(`SELECT x.id, x.at, x.qty, x.note, x.ref, x.worker, x.ack, i.name, i.unit, i.area_id FROM movements x JOIN items i ON i.id = x.item_id
                      WHERE x.type = 'count' AND abs(x.qty) > 1e-9 AND ${recent} ORDER BY x.id DESC`);
  const over = await all(`SELECT x.id, x.at, x.qty, x.note, x.ref, x.worker, x.ack, i.name, i.unit FROM movements x JOIN items i ON i.id = x.item_id
                    WHERE x.type = 'receive' AND x.note ILIKE '%more than ordered%' AND ${recent} ORDER BY x.id DESC`);
  const bought = await all(`SELECT x.id, x.at, x.reason, x.worker, x.note, x.ack, x.before, i.name, i.unit, v.chassis FROM allocation_log x
                        JOIN items i ON i.id = x.item_id LEFT JOIN vans v ON v.id = x.van_id
                      WHERE x.reason IN ('check: here','check: missing') AND ${recent} ORDER BY x.id DESC`);
  // Racks counted longest ago (never counted first): "Count these next".
  const areas = await all(`SELECT a.id, a.name, COUNT(i.id) AS items, SUM(CASE WHEN i.last_counted = '' THEN 1 ELSE 0 END) AS never,
                       MIN(NULLIF(i.last_counted, '')) AS oldest
                     FROM floor_areas a JOIN items i ON i.area_id = a.id AND ${COUNTABLE_ITEM}
                     GROUP BY a.id ORDER BY a.id`);
  const norack = await get(`SELECT COUNT(*) AS items, SUM(CASE WHEN i.last_counted = '' THEN 1 ELSE 0 END) AS never, MIN(NULLIF(i.last_counted, '')) AS oldest
                      FROM items i WHERE ${COUNTABLE_ITEM} AND i.area_id IS NULL`);
  const next = [...areas.map(a => ({ scope: `area:${a.id}`, name: a.name, items: a.items, never: a.never || 0, oldest: a.oldest || '' })),
    ...(norack.items ? [{ scope: 'norack', name: 'No rack yet', items: norack.items, never: norack.never || 0, oldest: norack.oldest || '' }] : [])]
    .sort((a, b) => (b.never > 0) - (a.never > 0) || (a.oldest || '').localeCompare(b.oldest || ''));
  return { corrections, borrows, counts, over, bought, next };
}

// How many rows on the Stock checks page nobody has ticked yet (nav badge).
export async function stockChecksCount() {
  return (await get(`SELECT
    (SELECT COUNT(*) FROM movements x WHERE x.ack = 0 AND ((x.type = 'adjust' AND x.note NOT ILIKE 'Re-linked%' AND x.note NOT ILIKE 'Plan quantity corrected%'
       AND x.note <> 'Demo stock level') OR (x.type = 'count' AND abs(x.qty) > 1e-9) OR (x.type = 'receive' AND x.note ILIKE '%more than ordered%')))
    + (SELECT COUNT(*) FROM allocation_log x WHERE x.ack = 0 AND x.reason IN ('borrow', 'check: here', 'check: missing')) AS n`)).n;
}

// Tick (or untick) one row of the Stock checks page. kind 'm' = a stock movement, 'a' = a log entry.
export async function ackCheck(kind, id, ack = true) {
  const table = kind === 'm' ? 'movements' : kind === 'a' ? 'allocation_log' : null;
  if (!table) throw httpError(400, 'Unknown row');
  // (Postgres refuses a non-number id outright; SQLite just found no row)
  if (!Number.isSafeInteger(Number(id))) throw httpError(404, 'That row no longer exists — refresh');
  return writeTx(async () => {
    if (!(await run(`UPDATE ${table} SET ack = ? WHERE id = ?`, ack ? 1 : 0, Number(id))).changes) throw httpError(404, 'That row no longer exists — refresh');
    return { ok: true };
  });
}
