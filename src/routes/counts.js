// Counts (blind, rack by rack), bought-for-van parts, fixing the catalogue and the weekly Stock checks.
import * as inv from '../inventory.js';
import { h, id, num, worker } from './common.js';

export function countRoutes(app) {
  // ── Counts: blind, one rack / trade at a time; bought-for-van parts checked one by one ──
  app.get('/api/counts/choices', h(() => inv.countChoices()));
  app.post('/api/counts', h(req => inv.openCount(String(req.body.scope || ''), worker(req))));
  const plainObj = o => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  app.post('/api/counts/:id/check', h(req => inv.checkCount(id(req), Array.isArray(req.body.counts) ? req.body.counts : [],
    { timing: plainObj(req.body.timing) })));
  // timing {itemId: 'before'|'after'} for parts that moved while counting; elsewhere {itemId: 'yes'|'no'} and
  // elsewhere_qty {itemId: n} (how many are kept elsewhere) for parts below what is kept for vans.
  app.post('/api/counts/:id/save', h(req => inv.saveCount(id(req), { counts: Array.isArray(req.body.counts) ? req.body.counts : [],
    elsewhere: plainObj(req.body.elsewhere), elsewhereQty: plainObj(req.body.elsewhere_qty), timing: plainObj(req.body.timing),
    ackMoves: !!req.body.ack_moves, by: worker(req) })));
  app.get('/api/bought-for-van', h(() => inv.boughtForVanList()));
  // Bought-for-van stock with no van (C9): assign to a van, or keep on the shelf as a spare.
  app.get('/api/items/unassigned', h(req => inv.unassignedPerVan({ all: req.query.all === '1' })));
  app.post('/api/items/:id/assign', h(req => inv.assignToVan(id(req), Number(req.body.van_id), num(req.body.qty), worker(req) || 'Office')));
  app.post('/api/items/:id/spare', h(req => inv.keepSpare(id(req), worker(req) || 'Office')));
  // Fix the catalogue (C9) and bulk "Put on rack".
  app.get('/api/catalogue', h(() => inv.catalogueGaps()));
  app.post('/api/items/rack', h(req => inv.putOnRack(Array.isArray(req.body.ids) ? req.body.ids : [], req.body.area_id, worker(req) || 'Office')));
  // Weekly "Stock checks" (C11).
  app.get('/api/stock-checks', h(() => inv.stockChecks()));
  app.post('/api/stock-checks/ack', h(req => inv.ackCheck(String(req.body.kind || ''), Number(req.body.id), req.body.ack !== false)));
  app.post('/api/van-lines/:id/check', h(req => inv.checkBoughtLine(id(req), String(req.body.answer || ''), worker(req))));
}
