// Parts rules ("when the order says X, the van needs item Y").
import { all, get, insert, run } from '../db.js';
import * as inv from '../inventory.js';
import { parseConditions, testRule } from '../rules.js';
import { OWN_TX, h, id } from './common.js';

export function ruleRoutes(app) {
  // ── Rules ──
  app.get('/api/rules', h(() => all(`SELECT r.*, i.sku, i.name AS item_name FROM rules r JOIN items i ON i.id = r.item_id ORDER BY r.sort, r.id`)));
  function checkRule(b) {
    parseConditions(b.conditions); // throws a readable error if malformed
    if (!b.item_id) throw inv.httpError(400, 'Pick the item this rule adds');
  }
  app.post('/api/rules', h(async req => {
    try { checkRule(req.body); } catch (e) { throw inv.httpError(400, e.message); }
    const sort = ((await get('SELECT MAX(sort) AS s FROM rules')).s || 0) + 10;
    const newId = await insert('INSERT INTO rules(name, conditions, item_id, qty, spec_fields, active, sort) VALUES(?,?,?,?,?,?,?)',
      req.body.name || '', req.body.conditions, Number(req.body.item_id), String(req.body.qty || '1'), req.body.spec_fields || '', req.body.active === false ? 0 : 1, sort);
    return { id: newId };
  }));
  app.put('/api/rules/:id', h(async req => {
    try { checkRule(req.body); } catch (e) { throw inv.httpError(400, e.message); }
    await run('UPDATE rules SET name=?, conditions=?, item_id=?, qty=?, spec_fields=?, active=? WHERE id=?',
      req.body.name || '', req.body.conditions, Number(req.body.item_id), String(req.body.qty || '1'), req.body.spec_fields || '', req.body.active === false ? 0 : 1, id(req));
  }));
  app.delete('/api/rules/:id', h(req => run('DELETE FROM rules WHERE id = ?', id(req))));
  // Try a rule against every active van and say which ones it would fire for. (Changes nothing.)
  app.post('/api/rules/test', h(async req => {
    try { checkRule({ ...req.body, item_id: 1 }); } catch (e) { throw inv.httpError(400, e.message); }
    return (await inv.activeVanFields()).map(v => {
      const r = testRule(req.body, v.fields);
      return { chassis: v.chassis, fired: r.fired, matched: r.fired ? [...r.pos].map(f => `${f.label}: ${f.value}`) : [] };
    });
  }, OWN_TX));
}
