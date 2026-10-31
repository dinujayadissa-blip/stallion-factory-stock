// Purchasing: shortages, suppliers, "Check: already ordered?", decisions and purchase orders.
import { get, run } from '../db.js';
import * as inv from '../inventory.js';
import { h, id, worker } from './common.js';

export function purchasingRoutes(app) {
  // ── Purchasing ──
  // Order now / Coming up / Later / No date, netted against what is already on order.
  app.get('/api/shortages', h(() => inv.shortages()));
  app.get('/api/suppliers', h(() => inv.listSuppliers()));
  app.put('/api/suppliers', h(req => inv.setSupplierLead(req.body.name, req.body.lead_days)));
  app.put('/api/purchasing/settings', h(req => inv.savePurchasingSettings(req.body)));
  // "Check: already ordered?" — plan order numbers nobody has confirmed (display only until answered).
  app.get('/api/check-ordered', h(() => inv.checkOrdered()));
  app.post('/api/check-ordered', h(req => inv.answerOrdered(req.body.po_ref, String(req.body.answer || ''),
    { lineIds: Array.isArray(req.body.line_ids) ? req.body.line_ids : null, supplier: req.body.supplier || '', by: worker(req) || 'Office',
      group: typeof req.body.group === 'string' ? req.body.group : undefined, key: typeof req.body.key === 'string' ? req.body.key : undefined })));
  // "Yes, all on order" for one supplier: { supplier, groups: [{ key, po_ref, line_ids }] } — all or nothing.
  app.post('/api/check-ordered/all', h(req => inv.answerOrderedMany(req.body.groups, { supplier: req.body.supplier || '', by: worker(req) || 'Office',
    ordered_at: String(req.body.ordered_at || ''), expected: String(req.body.expected || '') })));
  // Customer supplies / to be decided, set or cleared on a van line; and the "waiting on a decision" list.
  app.post('/api/van-lines/:id/state', h(req => inv.setLineState(id(req), String(req.body.state ?? ''), { stock: String(req.body.stock || ''), by: worker(req) || 'Office' })));
  app.get('/api/decisions', h(req => inv.decisionLines({ vanId: Number(req.query.van) || null })));
  app.get('/api/pos', h(() => inv.listPOs()));
  app.get('/api/pos/to-check', h(() => inv.posToCheck()));
  app.get('/api/pos/overdue', h(() => inv.overdueLines()));
  app.get('/api/pos/:id', h(req => inv.getPO(id(req))));
  app.post('/api/pos', h(async req => ({ id: await inv.createPO(req.body) })));
  app.post('/api/pos/:id/receive', h(req => inv.receivePO(id(req), Array.isArray(req.body.lines) ? req.body.lines : [],
    { backorder: req.body.backorder || {}, closeBalance: Array.isArray(req.body.close_balance) ? req.body.close_balance : [], by: worker(req) })));
  app.post('/api/pos/:id/merge', h(req => inv.mergePO(id(req), Number(req.body.into), worker(req) || 'Office')));
  app.put('/api/pos/:id', h(async req => {
    const b = req.body || {};
    if (b.status) await inv.setPOStatus(id(req), b.status === 'closed' ? 'closed' : 'open', worker(req) || 'Office');
    const fields = ['po_no', 'supplier', 'ordered_at', 'expected', 'notes', 'checked'].filter(k => b[k] !== undefined);
    if (fields.length) return inv.updatePO(id(req), Object.fromEntries(fields.map(k => [k, b[k]])), worker(req) || 'Office');
  }));
  app.delete('/api/pos/:id', h(async req => {
    if ((await get('SELECT COALESCE(SUM(received),0) AS r FROM po_lines WHERE po_id = ?', id(req))).r > 0) {
      throw inv.httpError(400, 'Stock was already received against this PO — close it instead');
    }
    await run('DELETE FROM purchase_orders WHERE id = ?', id(req));
  }));
}
