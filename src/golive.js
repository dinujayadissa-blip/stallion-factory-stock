// Go-live checklist on the Dashboard (C10). In this order, each with a link and a done count:
//   a. clean-up done and the Clean-up report checked (C1)
//   b. due dates to check fixed (C1)
//   c. "Already fitted" done for every van in a bay (C3), and bought-for-van stock with no van assigned (C9)
//   d. "Check: already ordered?" answered (C5)
//   e. first full rack count: every rack / area plus "No rack yet" (C3)
//   f. reorder levels set (only after counting)
// Nothing here changes data; it only reads.
// On Postgres the clean-up (tidy.js) and the plan import (importPlan.js) are not part of the app: they were
// finished on the sqlite-final checkout before the move. So step a is marked done and there are no plan
// conflicts, in the cloud and locally alike, and neither module is imported here (both still use the old
// synchronous database layer and would break if they ran).
import { all, get } from './db.js';
import { datesToCheck, unassignedPerVan, checkOrdered, checkOrderedCount, reorderSuggestions, firstCountDone } from './inventory.js';

const COUNTABLE = `i.active = 1 AND i.kind = 'stock' AND i.placeholder = 0 AND i.sku NOT ILIKE 'PLAN-%'`;

export async function goLive() {
  const steps = [];
  // a
  steps.push({ key: 'a', title: 'Clean-up done and the Clean-up report checked', href: '#/cleanup',
    done: true, count: 'done on the original computer before the move' });
  // b
  const dates = await datesToCheck();
  steps.push({ key: 'b', title: 'Due dates to check fixed', href: '#/vans', done: dates.length === 0,
    count: dates.length ? `${dates.length} van(s): ${dates.slice(0, 6).map(v => v.chassis).join(', ')}${dates.length > 6 ? '…' : ''}` : 'every van has a due date' });
  // c
  const bays = await all(`SELECT v.id, v.chassis, a.name AS bay,
                      (EXISTS(SELECT 1 FROM allocation_log l WHERE l.van_id = v.id AND l.reason IN ('fitted', 'fitted: checked')))::int AS checked
                    FROM vans v JOIN floor_areas a ON a.id = v.area_id AND a.kind = 'bay'
                    WHERE v.status IN ('planned','in_production') ORDER BY a.sort`);
  const orphans = await unassignedPerVan();
  const baysDone = bays.filter(b => b.checked).length;
  steps.push({ key: 'c', title: '"Already fitted" done for every van in a bay, and bought-for-van stock with no van assigned', href: '#/factory',
    done: baysDone === bays.length && orphans.length === 0,
    count: `${baysDone} of ${bays.length} van(s) in a bay checked · ${orphans.length} bought-for-van part(s) with no van`,
    vans: bays.map(b => ({ id: b.id, chassis: b.chassis, bay: b.bay, checked: !!b.checked })), orphans: orphans.length });
  // d
  const groups = (await checkOrdered()).length;
  const lines = await checkOrderedCount();
  steps.push({ key: 'd', title: '"Check: already ordered?" answered', href: '#/purchasing', done: lines === 0,
    count: lines ? `${groups} order number(s), ${lines} part(s) still to answer` : 'all answered' });
  // e
  const areas = await all(`SELECT a.id, a.name, COUNT(i.id) AS items, SUM(CASE WHEN i.last_counted = '' THEN 1 ELSE 0 END) AS left
                     FROM floor_areas a JOIN items i ON i.area_id = a.id AND ${COUNTABLE} GROUP BY a.id, a.sort, a.name ORDER BY a.sort, a.name`);
  const norack = await get(`SELECT COUNT(*) AS items, COALESCE(SUM(CASE WHEN i.last_counted = '' THEN 1 ELSE 0 END), 0) AS left FROM items i WHERE ${COUNTABLE} AND i.area_id IS NULL`);
  const places = [...areas.map(a => ({ scope: `area:${a.id}`, name: a.name, items: a.items, left: a.left })),
    ...(norack.items ? [{ scope: 'norack', name: 'No rack yet', items: norack.items, left: norack.left }] : [])];
  const counted = await firstCountDone();
  steps.push({ key: 'e', title: 'First full rack count (every rack, plus "No rack yet")', href: '#/stock', done: counted,
    count: `${places.filter(p => !p.left).length} of ${places.length} place(s) counted · ${places.reduce((s, p) => s + p.left, 0)} part(s) not counted yet`, places });
  // f
  const sugg = await reorderSuggestions();
  const levels = await all(`SELECT i.id, i.reorder_level FROM items i WHERE ${COUNTABLE}`);
  const want = levels.filter(i => sugg.get(i.id)?.level > 0);
  const set = want.filter(i => i.reorder_level > 0).length;
  steps.push({ key: 'f', title: 'Set reorder levels (after counting)', href: '#/stock', locked: !counted,
    done: counted && set === want.length, count: `${set} of ${want.length} shelf part(s) with a suggested level have one` });
  const conflicts = 0; // see the note at the top
  return { steps, done: steps.every(s => s.done), conflicts, counted };
}
