// Excel export. The "Production Plan" sheet is laid out and coloured like the spreadsheet the
// factory already uses (white not ordered, pink ordered, grey received, blue finished), followed
// by detail sheets.
import ExcelJS from 'exceljs';
import { all } from './db.js';
import { listItems, shortages, planGrid, lineStatus, LINE_STATUS_TEXT, stillToOrderByItem } from './inventory.js';
import { INFO_COLUMNS, normHeader } from './planMap.js';
import { PO_OPEN, PO_IS_OPEN } from './lineState.js';

const FILL = { ordered: 'FFF4CCCC', received: 'FFD9D9D9', done: 'FF9FC5E8' };
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
// UTC midnight, so Excel gets a whole-day serial and shows the same date on any PC time zone.
const toDate = iso => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(`${iso}T00:00:00Z`) : null);

function addTable(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = fill('FFEEF1F5');
  ws.addRows(rows);
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

export async function exportWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Factory Stock';

  // ── Production Plan (all vans, finished ones too, like the original sheet) ──
  const grid = planGrid({ includeFinished: true });
  const ws = wb.addWorksheet('Production Plan', { views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }] });
  // Van details, so the sheet can be edited and imported again without losing them: dealer, customer
  // requests, then any other information columns the imported plan had (VIN, ATM…), in plan order.
  const vanInfo = new Map(all('SELECT id, dealer, notes FROM vans').map(v => [v.id, v]));
  const base = h => normHeader(h).replace(/ \(\d+\)$/, '');
  const infoOrder = [...INFO_COLUMNS];
  const own = ['CHASSIS #', 'VAN SIZE & TYPE', 'EXPECTED DELIVERY DATE', 'CUSTOMER NAME', 'DEALER', 'CUSTOMER REQUESTS', 'STATUS'];
  const otherInfo = [...new Set(grid.vans.flatMap(v => Object.keys(v.cells)))]
    .filter(h => INFO_COLUMNS.has(base(h)) && !own.includes(base(h)) && !grid.columns.includes(h))
    .sort((a, b) => infoOrder.indexOf(base(a)) - infoOrder.indexOf(base(b)) || a.localeCompare(b));
  const fixed = ['CHASSIS #', 'VAN SIZE & TYPE', 'EXPECTED DELIVERY DATE', 'CUSTOMER NAME', 'DEALER', 'CUSTOMER REQUESTS', ...otherInfo, 'STATUS'];
  const infoText = (v, label) => v.cells[Object.keys(v.cells).find(k => base(k) === label)]?.t || '';
  // Row 1: colour legend, as in the original.
  const legend = [['MATERIAL ORDERED', FILL.ordered], ['FINISHED VANS', FILL.done], ['MATERIAL RECEIVED', FILL.received]];
  legend.forEach(([text, argb], i) => { const c = ws.getCell(1, i + 2); c.value = text; c.fill = fill(argb); c.font = { bold: true }; });
  const header = ws.getRow(2);
  [...fixed, ...grid.columns].forEach((h, i) => { header.getCell(i + 1).value = h; });
  header.font = { bold: true };
  header.alignment = { wrapText: true, vertical: 'top' };
  header.height = 45;
  ws.columns = [12, 34, 14, 26, 18, 40, ...otherInfo.map(() => 18), 14, ...grid.columns.map(() => 24)].map(width => ({ width }));

  grid.vans.forEach((v, idx) => {
    const r = ws.getRow(idx + 3);
    const info = vanInfo.get(v.id) || {};
    r.getCell(1).value = v.chassis;
    r.getCell(2).value = `${v.length} ${v.model}`.trim();
    const eta = toDate(v.eta);
    if (eta) { r.getCell(3).value = eta; r.getCell(3).numFmt = 'dd/mm/yyyy'; }
    r.getCell(4).value = v.customer;
    r.getCell(5).value = info.dealer || infoText(v, 'DEALER');
    r.getCell(6).value = infoText(v, 'CUSTOMER REQUESTS') 
      || (String(info.notes || '').split('\n')[0].match(/^(?!Delivery:).*/) || [''])[0];
    otherInfo.forEach((h, i) => { r.getCell(7 + i).value = v.cells[h]?.t || ''; });
    r.getCell(fixed.length).value = { planned: 'Planned', in_production: 'In production', completed: 'Finished', cancelled: 'Cancelled' }[v.status] || v.status;
    if (v.status === 'completed') for (let c = 1; c <= fixed.length; c++) r.getCell(c).fill = fill(FILL.done);
    if (v.status === 'in_production') r.getCell(1).fill = fill(FILL.received);
    grid.columns.forEach((col, i) => {
      const cell = v.cells[col];
      if (!cell) return;
      const x = r.getCell(fixed.length + 1 + i);
      x.value = cell.t;
      if (cell.s && FILL[cell.s]) x.fill = fill(FILL[cell.s]);
    });
    r.alignment = { wrapText: true, vertical: 'top' };
  });

  // ── Van Parts: every part line for active vans ──
  const lines = all(`
    SELECT l.*, i.sku, i.name, i.category, i.supplier, i.unit, v.chassis,
      COALESCE(NULLIF(l.plan_column, ''), NULLIF(i.plan_column, ''), i.category) AS col,
      COALESCE((SELECT SUM(${PO_OPEN}) FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                WHERE ${PO_IS_OPEN} AND pl.item_id = l.item_id AND pl.van_id = l.van_id), 0) AS on_order_van,
      COALESCE((SELECT SUM(${PO_OPEN}) FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                WHERE ${PO_IS_OPEN} AND pl.item_id = l.item_id AND (pl.van_id IS NULL OR pl.van_id = l.van_id)), 0) AS on_order
    FROM van_lines l JOIN items i ON i.id = l.item_id JOIN vans v ON v.id = l.van_id
    WHERE v.status IN ('planned','in_production')
    ORDER BY CASE WHEN v.eta = '' THEN 1 ELSE 0 END, v.eta, v.chassis, i.category, i.name`);
  addTable(wb, 'Van Parts', [
    ['Chassis #', 'chassis', 11], ['Plan column', 'col', 22], ['SKU', 'sku', 16], ['Item', 'name', 38], ['Spec / plan text', 'spec', 50],
    ['Qty', 'qty', 7], ['Unit', 'unit', 7], ['Set aside', 'reserved', 9], ['Fitted', 'issued', 8], ['Status', 'status', 22],
    ['Supplier', 'supplier', 18], ['Order #', 'po_ref', 10],
  ], lines.map(l => ({ ...l, spec: [l.spec, l.note].filter(Boolean).join(' | '), status: LINE_STATUS_TEXT[lineStatus(l)] })));

  // ── To Order: what to order, most urgent first (same list as the Purchasing page) ──
  const sh = shortages();
  const GROUP = { now: 'Order now', soon: 'Coming up', later: 'Later', nodate: 'No date – check' };
  const toOrderWs = addTable(wb, 'To Order', [
    ['When', 'when', 14], ['Order by', 'order_by', 11], ['Supplier', 'supplier', 22], ['SKU', 'sku', 16], ['Item', 'name', 36],
    ['Description', 'po_spec', 44], ['For van', 'chassis', 10], ['Needed by', 'needed_by', 11], ['Suggested qty', 'suggest', 13], ['Unit', 'unit', 7],
    ['Already on order', 'on_order', 15], ['Lead days', 'lead', 10],
  ], sh.rows.map(r => ({ ...r, when: r.check ? `${GROUP[r.group]} – plan says ordered (${r.po_ref}), check` : GROUP[r.group],
    supplier: r.supplier || '(no supplier set)', chassis: r.topup ? 'shelf top-up' : r.chassis,
    // an order-by date already gone means "order today" (round 4, user-r3-2) — never an old date to chase
    order_by: toDate(r.order_by && r.order_by < sh.today ? sh.today : r.order_by), needed_by: toDate(r.needed_by), lead: `${r.lead_days}${r.lead_confirmed ? '' : ' (assumed)'}` })));

  // ── Open purchase orders, with what exactly was ordered ──
  const poLines = all(`SELECT p.po_no, p.supplier, p.ordered_at, COALESCE(NULLIF(pl.expected, ''), p.expected) AS expected,
      i.sku, i.name, pl.spec, v.chassis, pl.qty, pl.received, pl.closed, ${PO_OPEN} AS open, i.unit
    FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id JOIN items i ON i.id = pl.item_id LEFT JOIN vans v ON v.id = pl.van_id
    WHERE p.status = 'open' ORDER BY p.supplier, p.po_no, i.name`);
  const posWs = addTable(wb, 'Open POs', [
    ['PO #', 'po_no', 12], ['Supplier', 'supplier', 20], ['Ordered', 'ordered_at', 11], ['Expected', 'expected', 11], ['SKU', 'sku', 16],
    ['Item', 'name', 34], ['Description', 'spec', 44], ['For van', 'chassis', 10], ['Ordered qty', 'qty', 11], ['Received', 'received', 9],
    ['Cancelled', 'closed', 9], ['Still to come', 'open', 12], ['Unit', 'unit', 7],
  ], poLines.map(l => ({ ...l, chassis: l.chassis || 'shelf', ordered_at: toDate(l.ordered_at), expected: toDate(l.expected) })));
  for (const [ws, keys] of [[toOrderWs, ['order_by', 'needed_by']], [posWs, ['ordered_at', 'expected']]]) {
    for (const k of keys) ws.getColumn(k).numFmt = 'dd/mm/yyyy';
  }

  // ── Stock ──
  // "Still to order" is the Stock screen's column (Small fixes & phone round 2, sp-r1-3): short for vans in
  // production / due soon, netted per van against what is on order for that van and the shelf — the same as
  // Purchasing → To order. Blank for special ("as per plan") parts, and blank when nothing is short, as on screen.
  // It replaces the old "Suggested order" (short + reorder top-up − every PO for the part), which netted one van's
  // PO against another van's shortfall and so said to order less than the screen. Shelf top-ups are on "To Order".
  const toOrder = stillToOrderByItem();
  const r2 = n => Math.round(n * 1000) / 1000;
  addTable(wb, 'Stock', [
    ['SKU', 'sku', 16], ['Item', 'name', 40], ['Category', 'category', 22], ['Supplier', 'supplier', 18], ['Type', 'kind', 9],
    ['Unit', 'unit', 7], ['On hand', 'on_hand', 9], ['Set aside', 'reserved', 9], ['Free', 'available', 8], ['On order', 'on_order', 9],
    ['Short for vans', 'short', 13], ['Still to order', 'still_to_order', 13], ['Reorder level', 'reorder_level', 12], ['Location', 'location', 12],
  ], listItems().map(i => ({ ...i,
    still_to_order: i.placeholder ? '' : toOrder[i.id] > 1e-9 ? r2(toOrder[i.id]) : i.short > 0 ? 0 : '' })));

  return Buffer.from(await wb.xlsx.writeBuffer());
}
