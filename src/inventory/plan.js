// The production plan grid, and moving one plan line forward (ordered / received / fitted).
import { all, get, getSetting, insert, logAlloc, run, syncSuppliers, writeTx } from '../db.js';
import { PO_IS_OPEN, PO_OPEN, specForPo, today } from '../lineState.js';
import { mergedCols } from '../relink.js';
import { ACTIVE_VAN, PRIORITY, httpError, lineStatus, q } from './shared.js';
import { issueLines } from './vans.js';
import { closePoIfDone } from './stock.js';
import { lineCover } from './shortages.js';

const RANK = { none: 0, ordered: 1, received: 2, done: 3 };

// The production plan grid: one row per van, one column per plan column, each cell coloured by
// the least-advanced part in it (white not ordered → pink ordered → grey received → blue done).
// `parts` (the plan page only — Small fixes & phone round 3, owner-r2-1): each cell with parts also gets `ps`,
// the status the van page shows for each of its part lines (same order as `ids`: lineStatus + the cover by a shelf
// PO or another van's spare PO line, as in getVan), and `pn` (the part names) when it holds more than one part —
// so the phone's "By van" counts parts the van page's way ("Not ordered 29 · To check 10 · Ordered 18 ·
// Received 58"). The cells' own colours (the spreadsheet's, also used by the Excel export) are unchanged.
export async function planGrid({ includeFinished = false, parts = false } = {}) {
  let columns = [];
  const rawColumns = await getSetting('plan_columns', '[]'); // (a database error is not "none yet")
  try { columns = JSON.parse(rawColumns); } catch { /* none yet */ }
  const where = includeFinished ? '' : `WHERE ${ACTIVE_VAN}`;
  const vans = await all(`SELECT v.id, v.chassis, v.model, v.length, v.customer, v.eta, v.status FROM vans v ${where}
                    ORDER BY CASE v.status WHEN 'in_production' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, ${PRIORITY}`);
  const vanIds = `SELECT v.id FROM vans v ${where}`;
  const onOrder = new Set((await all(`SELECT pl.van_id, pl.item_id FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                               WHERE ${PO_IS_OPEN} AND pl.van_id IN (${vanIds})`))
    .map(r => `${r.van_id}|${r.item_id}`));
  const lines = await all(`SELECT l.id, l.van_id, l.item_id, l.qty, l.reserved, l.issued, l.merged_cols, l.state, l.urgent, l.po_ref, i.name, i.unit,
                       COALESCE(NULLIF(l.plan_column, ''), NULLIF(i.plan_column, ''), i.category) AS col
                     FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.van_id IN (${vanIds}) ORDER BY l.id`);
  const texts = await all(`SELECT van_id, label, value FROM order_fields WHERE section = 'PRODUCTION PLAN' AND van_id IN (${vanIds}) ORDER BY id`);

  const byVan = new Map(vans.map(v => [v.id, { ...v, cells: {} }]));
  const cell = (vanId, col) => {
    const c = byVan.get(vanId).cells;
    return c[col] || (c[col] = { t: '', s: null, ids: [] });
  };
  for (const f of texts) cell(f.van_id, f.label).t = f.value;
  const extra = new Set();
  for (const l of lines) {
    const st = l.issued >= l.qty ? 'done' : l.reserved + l.issued >= l.qty ? 'received'
      : onOrder.has(`${l.van_id}|${l.item_id}`) ? 'ordered' : 'none';
    const c = cell(l.van_id, l.col);
    c.ids.push(l.id);
    c.s = c.s == null || RANK[st] < RANK[c.s] ? st : c.s;
    c._names = (c._names || []).concat(`${q(l.qty)} x ${l.name}`);
    if (!columns.includes(l.col)) extra.add(l.col);
    // Round 4 (check-r3-3): a plan line merged into this line still has its cell on the plan — coloured
    // from this line (with any line still left in that cell, the least advanced wins as usual).
    for (const mc of mergedCols(l.merged_cols)) {
      if (mc === l.col) continue;
      const m = cell(l.van_id, mc);
      if (!m.ids.includes(l.id)) m.ids.push(l.id);
      m.s = m.s == null || RANK[st] < RANK[m.s] ? st : m.s;
      if (!columns.includes(mc)) extra.add(mc);
    }
  }
  for (const v of byVan.values()) {
    for (const c of Object.values(v.cells)) {
      if (!c.t && c._names) c.t = c._names.join('; ');
      delete c._names;
    }
  }
  if (parts) {
    const vanQ = new Map(), shelfQ = new Map();
    for (const r of await all(`SELECT pl.item_id, pl.van_id, ${PO_OPEN} AS q FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                         WHERE ${PO_IS_OPEN} AND (pl.van_id IS NULL OR pl.van_id IN (${vanIds}))`)) {
      if (r.van_id == null) shelfQ.set(r.item_id, (shelfQ.get(r.item_id) || 0) + r.q);
      else { const k = `${r.van_id}|${r.item_id}`; vanQ.set(k, (vanQ.get(k) || 0) + r.q); }
    }
    const cov = await lineCover();
    const byId = new Map();
    for (const l of lines) {
      const mine = vanQ.get(`${l.van_id}|${l.item_id}`) || 0;
      let st = lineStatus({ ...l, on_order_van: mine, on_order: mine + (shelfQ.get(l.item_id) || 0) });
      const c = cov.get(l.id);
      if (st === 'to_order' && c && c.qty >= Math.max(0, l.qty - l.reserved - l.issued) - 1e-9) st = 'on_order';
      byId.set(l.id, { st, name: `${q(l.qty)}${l.unit && l.unit !== 'ea' ? ' ' + l.unit : ''} × ${l.name}` });
    }
    for (const v of byVan.values()) {
      for (const c of Object.values(v.cells)) {
        if (!c.ids.length) continue;
        c.ps = c.ids.map(id => byId.get(id)?.st || 'to_order');
        if (c.ids.length > 1) c.pn = c.ids.map(id => byId.get(id)?.name || '');
      }
    }
  }
  return { columns: [...columns, ...[...extra].sort()], vans: [...byVan.values()] };
}

// Book stock in against one particular part line (used when a plan cell is marked received).
async function receiveInto(line, qty, ref, { reason = 'receive', by = '', note = '' } = {}) {
  await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', qty, line.item_id);
  // Received for this van: locked to it.
  await run('UPDATE van_lines SET reserved = reserved + ?, reserved_firm = reserved_firm + ? WHERE id = ?', qty, qty, line.id);
  await logAlloc(reason, { van_id: line.van_id, item_id: line.item_id, line_id: line.id, field: 'reserved (locked)', before: '', after: `+${q(qty)}`, note: ref, worker: by,
    change: qty, firm_change: qty });
  await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'receive', ?, ?, ?, ?)`, line.item_id, qty, line.van_id, ref, note, by);
}

// Move one part line forward from the plan: 'ordered' (needs po_no), 'received', or 'done'
// (fitted — received if needed, then issued to the van).
export async function setLineStatus(lineId, status, { po_no = '' } = {}) {
  return writeTx(async () => {
    const l = await get(`SELECT l.*, i.supplier FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?`, lineId);
    if (!l) throw httpError(404, 'Part line not found');
    const short = async () => Math.max(0, (await get('SELECT qty - reserved - issued AS s FROM van_lines WHERE id = ?', lineId)).s);
    const openPoLines = async () => all(`SELECT pl.*, p.po_no FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                                   WHERE ${PO_IS_OPEN} AND pl.van_id = ? AND pl.item_id = ?
                                   ORDER BY pl.id`, l.van_id, l.item_id);

    if (status === 'ordered') {
      const ref = String(po_no || '').trim();
      if (!ref) throw httpError(400, 'Enter the order number');
      const need = (await short()) - (await openPoLines()).reduce((s, p) => s + p.qty - p.received - p.closed, 0);
      if (need > 0) {
        const po = await get(`SELECT id FROM purchase_orders WHERE status = 'open' AND po_no = ? AND supplier = ?`, ref, l.supplier || '');
        const poId = po ? po.id : await insert('INSERT INTO purchase_orders(po_no, supplier, ordered_at, needs_check) VALUES(?, ?, ?, ?)', ref, l.supplier || '', today(), l.supplier ? 0 : 1);
        await run('INSERT INTO po_lines(po_id, item_id, qty, van_id, spec) VALUES(?,?,?,?,?)', poId, l.item_id, need, l.van_id, specForPo(l.spec, ref));
        await syncSuppliers();
      }
      await run('UPDATE van_lines SET po_ref = ? WHERE id = ?', ref, lineId);
      return;
    }
    if (status !== 'received' && status !== 'done') throw httpError(400, 'Unknown status');

    // Anything on order for this van arrives first, then the rest is booked in directly.
    for (const pl of await openPoLines()) {
      const s = await short();
      if (s <= 0) break;
      const take = Math.min(s, pl.qty - pl.received - pl.closed);
      await run('UPDATE po_lines SET received = received + ? WHERE id = ?', take, pl.id);
      await receiveInto(l, take, `PO ${pl.po_no}`);
      await closePoIfDone(pl.po_id);
    }
    const rest = await short();
    if (rest > 0) await receiveInto(l, rest, l.po_ref ? `Order ${l.po_ref}` : 'Marked received on plan');
    if (status === 'done') await issueLines(l.van_id, [lineId]);
  });
}
