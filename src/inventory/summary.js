// The home page summary (every count the nav badges show), worked out once per data version.
import { all, get } from '../db.js';
import { COUNTS_SHORT_CORR } from '../lineState.js';
import { ACTIVE_VAN, PRIORITY, listItems, nearVanSql, purchasingSettings } from './shared.js';
import { listVans } from './vans.js';
import { shortagesCached } from './shortages.js';
import { checkOrdered, checkOrderedCount } from './ordered.js';
import { decisionLines } from './special.js';
import { PO_TO_CHECK_SQL, datesToCheck, overdueLines, qtyChecks } from './pos.js';
import { stockChecksCount } from './checks.js';

// Dashboard. counts: the "Needs action this month" pieces (vans in production or due within the
// "coming up" weeks for the per-van lists; POs, deliveries and dates for everything).
// `checks`: a checkOrdered() answer already at hand (the Dashboard route shares one with the go-live checklist).
export async function summary({ checks: checksGiven } = {}) {
  const items = (await listItems()).filter(i => !i.placeholder); // "as per plan" catch-alls aren't counted as parts
  const vans = await listVans({ status: 'active' });
  const sh = await shortagesCached(); // listVans just worked it out for the "waiting on PO" split (owner-r3-2)
  const now = sh.rows.filter(r => r.group === 'now' && r.suggest > 1e-9 && !r.check);
  const near = await nearVanSql('v');
  const nearIds = new Set(vans.filter(v => v.near).map(v => v.id));
  const checks = checksGiven ?? await checkOrdered();
  const checksNear = checks.filter(g => g.near);
  const decisions = await decisionLines();
  const received = (await get(`SELECT COUNT(*) AS c FROM van_lines l JOIN vans v ON v.id = l.van_id
                        WHERE ${ACTIVE_VAN} AND l.state IN ('customer','tbd') AND l.reserved_firm > 0 AND l.issued < l.qty`)).c;
  // Waiting on parts: vans in production / due soon, with the names of what is missing.
  const waiting = await all(`SELECT v.id, v.chassis, v.eta, v.status, i.name FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
                       WHERE ${ACTIVE_VAN} AND ${near} AND l.qty > l.reserved + l.issued + 1e-9 AND ${COUNTS_SHORT_CORR('l')}
                         AND i.placeholder = 0 AND i.sku NOT ILIKE 'PLAN-%' ORDER BY ${PRIORITY}, i.name`);
  const wv = new Map();
  for (const r of waiting) {
    if (!wv.has(r.id)) wv.set(r.id, { van_id: r.id, chassis: r.chassis, eta: r.eta, status: r.status, parts: [] });
    if (!wv.get(r.id).parts.includes(r.name)) wv.get(r.id).parts.push(r.name);
  }
  const qc = await qtyChecks();
  const action = {
    // the one "order now" number: different parts (with its van lines alongside, user-r1-3)
    orderNow: sh.orderNow.parts, orderNowLines: sh.orderNow.lines, orderNowText: sh.orderNow.text, orderNowCheck: sh.orderNow.check,
    checkOrdered: checksNear.length, checkOrderedAll: checks.length,
    posToCheck: (await get(`SELECT COUNT(*) AS c FROM purchase_orders p WHERE ${PO_TO_CHECK_SQL}`)).c,
    overdue: (await overdueLines()).length,
    dates: (await datesToCheck()).length,
    decisions: decisions.filter(d => nearIds.has(d.van_id)).length, decisionsAll: decisions.length,
    qtyChecks: qc.length,
    received,
  };
  action.total = action.orderNow + action.checkOrdered + action.posToCheck + action.overdue + action.dates + action.decisions + action.qtyChecks + action.received;
  return {
    vans,
    settings: await purchasingSettings(),
    counts: {
      planned: vans.filter(v => v.status === 'planned').length,
      inProduction: vans.filter(v => v.status === 'in_production').length,
      // waiting on parts: vans in production / due soon only; lines waiting on an answer don't count
      vansShort: vans.filter(v => v.near && v.waiting_count > 0).length,
      vansNear: nearIds.size,
      itemsShort: items.filter(i => i.short > 0).length,
      itemsToOrder: sh.orderNow.parts, orderNow: sh.orderNow, orderNowText: sh.orderNow.text,
      comingUp: new Set(sh.rows.filter(r => r.group === 'soon' && !r.check).map(r => r.item_id)).size,
      toCheck: await checkOrderedCount(),
      lowStock: items.filter(i => i.low).length,
      openPOs: (await get(`SELECT COUNT(*) AS c FROM purchase_orders WHERE status = 'open'`)).c,
      posToCheck: action.posToCheck,
      stockChecks: await stockChecksCount(),
    },
    action,
    qtyChecks: qc.slice(0, 100).map(l => ({ id: l.id, van_id: l.van_id, chassis: l.chassis, name: l.name, plan_column: l.plan_column, qty: l.qty, unit: l.unit, why: l.why })),
    waiting: [...wv.values()],
    // "Order now" rows, most urgent first.
    toOrder: now.slice(0, 12),
    decisions,
    overdue: await overdueLines(),
    recent: await all(`SELECT m.*, i.sku, i.name, v.chassis FROM movements m JOIN items i ON i.id = m.item_id
                 LEFT JOIN vans v ON v.id = m.van_id ORDER BY m.id DESC LIMIT 12`),
  };
}
