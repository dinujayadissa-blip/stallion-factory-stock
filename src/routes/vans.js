// Dealer orders, vans and their part lines (linking "as per plan" lines to real parts).
import express from 'express';
import { get, insert, run, syncSuppliers } from '../db.js';
import * as inv from '../inventory.js';
import * as layout from '../layout.js';
import { addTextParts, linkLine, linkPreview, makeOneOff } from '../relink.js';
import { OWN_TX, h, id, num, worker } from './common.js';

// The PDF reader (pdfjs) is big: loaded the first time it's needed, so a
// cold start of the Edge Function (whose CPU time counts) doesn't pay for them, and a library that won't load
// there breaks only its own route.
const pdfReader = () => import('../parseOrder.js');

export function vanRoutes(app) {
  // ── Dealer orders ──
  // (OWN_TX: reading the PDF takes a moment and changes nothing — not under the write lock)
  app.post('/api/orders/parse', express.raw({ type: 'application/pdf', limit: '25mb' }), h(async req => {
    if (!req.body?.length) throw inv.httpError(400, 'No PDF received');
    const { parseOrderPdf } = await pdfReader(); // (a library that won't load: an internal error, logged)
    let parsed;
    try { parsed = await parseOrderPdf(req.body); } catch { throw inv.httpError(400, "Couldn't read that PDF"); }
    if (!parsed.fields.length) throw inv.httpError(400, "That PDF doesn't look like a dealer order form");
    // from_plan: the van's parts come from the production plan, so saving won't re-run the rules.
    const existing = parsed.header.chassis ? await get(`SELECT id, status,
        (EXISTS(SELECT 1 FROM van_lines l WHERE l.van_id = vans.id AND l.source = 'plan'))::int AS from_plan
      FROM vans WHERE chassis = ?`, parsed.header.chassis) : null;
    return { ...parsed, existing: existing ?? null, preview: await inv.previewOrder(parsed.fields, parsed.header.chassis) };
  }, OWN_TX));
  // (a preview: changes nothing)
  app.post('/api/orders/preview', h(req => inv.previewOrder(req.body.fields || []), OWN_TX));

  // ── Vans ──
  app.get('/api/vans', h(req => inv.listVans({ status: req.query.status })));
  app.post('/api/vans', h(async req => {
    const vanId = await inv.createVan({ ...req.body, by: worker(req) || 'Office' }, { replace: !!req.body.replace });
    // "As per drawing" lines on the dealer order become reminders on the van.
    // Options the office marked "Customer supplies" that no parts rule covers: a reminder on the van (user-r4-9).
    return { id: vanId, drawingReminders: await layout.drawingReminders(vanId), customerReminders: await layout.customerReminders(vanId, req.body.customer_fields) };
  }));
  app.get('/api/vans/:id', h(req => inv.getVan(id(req))));
  // A van that was deleted meanwhile: a plain 404, not "Something went wrong".
  const vanThere = async req => { if (!await get('SELECT 1 FROM vans WHERE id = ?', id(req))) throw inv.httpError(404, 'That van no longer exists — refresh'); };
  app.put('/api/vans/:id', h(async req => {
    await vanThere(req);
    // A leading hand may only undo a van move (planned ↔ in production): the table in src/auth.js checks the
    // status asked for, this checks the van's status now (read under the write lock), so a finished or
    // cancelled van can't be brought back (its stock set aside again) from the floor.
    if (req.user.role === 'leadhand' && 'status' in (req.body || {})) {
      const v = await get('SELECT status FROM vans WHERE id = ?', id(req));
      if (!['planned', 'in_production'].includes(v.status)) throw inv.httpError(403, 'Only the office can reopen a finished or cancelled van');
    }
    return inv.updateVan(id(req), req.body, { by: worker(req) });
  }));
  app.delete('/api/vans/:id', h(async req => { await vanThere(req); return inv.deleteVan(id(req)); }));
  app.post('/api/vans/:id/rebuild', h(async req => {
    await vanThere(req);
    if (!await inv.applyRules(id(req))) {
      throw inv.httpError(400, 'This van came from the production plan, so its parts list is the plan — edit it on the van or plan page');
    }
  }));
  app.post('/api/vans/:id/issue', h(async req => ({ issued: await inv.issue(id(req), req.body.line_ids || null) })));
  app.post('/api/vans/:id/lines', h(req => inv.addLine(id(req), { ...req.body, item_id: Number(req.body.item_id), qty: Number(req.body.qty) })));
  app.put('/api/van-lines/:id', h(req => inv.updateLine(id(req), { ...req.body, qty: num(req.body.qty) })));
  app.delete('/api/van-lines/:id', h(req => inv.deleteLine(id(req))));
  app.post('/api/van-lines/:id/return', h(req => {
    const qty = num(req.body.qty);
    inv.checkQty(qty, 'Type how many to return, e.g. 2'); // never "return everything" by mistake
    return inv.returnLine(id(req), qty);
  }));
  app.post('/api/van-lines/:id/status', h(req => inv.setLineStatus(id(req), req.body.status, { po_no: req.body.po_no })));
  // "Quantity is right": the office checked an odd-looking quantity (stops the "please check" tag).
  app.post('/api/van-lines/:id/qty-ok', h(async req => {
    const l = await get('SELECT * FROM van_lines WHERE id = ?', id(req));
    if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
    if (!/qty-ok/.test(l.note)) await run('UPDATE van_lines SET note = ? WHERE id = ?', [l.note, 'qty-ok'].filter(Boolean).join(' · '), l.id);
  }));
  // Parts put in before go-live: close the lines (see inventory.markFitted).
  // done: the office went through this van's list (go-live checklist), even with nothing ticked.
  // "Already fitted…" quick start: parts received for this van (and when), to offer "tick everything received N weeks ago".
  app.get('/api/vans/:id/fitted-quick', h(req => inv.fittedQuickStart(id(req))));
  app.post('/api/vans/:id/fitted', h(req => inv.markFitted(id(req), Array.isArray(req.body.line_ids) ? req.body.line_ids : [], worker(req), { done: !!req.body.done })));
  // "Why?": every change to what is set aside for this line, with who / when / why.
  app.get('/api/van-lines/:id/log', h(req => inv.lineHistory(id(req))));
  // "As per plan" lines → a real part (an existing one, or a new part made from the plan text).
  app.get('/api/placeholders/count', h(req => inv.placeholderCounts({ vanId: Number(req.query.van) || null })));
  app.get('/api/placeholders', h(req => inv.placeholderLines({ vanId: Number(req.query.van) || null, onlyShort: req.query.short === '1' })));
  // A new per-van part made from a plan line's text (one free SKU worked out from the name).
  async function newPartFromPlanText(nu, l, { kind = 'per-van', supplier, note }) {
    const name = String(nu.name || '').trim().slice(0, 120);
    let sku = String(nu.sku || '').trim().toUpperCase() || name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
    if (/^PLAN-/.test(sku)) sku = sku.slice(5);
    for (let n = 2; await get('SELECT 1 FROM items WHERE sku = ?', sku); n++) sku = `${sku.replace(/-\d+$/, '')}-${n}`;
    return insert(`INSERT INTO items(sku, name, category, supplier, unit, kind, plan_column, trade, notes)
                   VALUES(?, ?, ?, ?, 'ea', ?, ?, ?, ?)`, sku, name, String(nu.category || 'General'), supplier,
                   kind, l.plan_column || l.col || '', l.trade || '', note);
  }
  app.post('/api/van-lines/:id/link', h(async req => {
    let itemId = Number(req.body.item_id) || null;
    const nu = req.body.new_item;
    if (!itemId && nu) {
      if (!String(nu.name || '').trim()) throw inv.httpError(400, 'Type a name for the new part');
      const l = await get('SELECT l.*, i.trade, i.plan_column AS col, i.category FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?', id(req));
      if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
      itemId = await newPartFromPlanText(nu, l, { supplier: String(nu.supplier || ''), note: `Made from the plan text "${l.spec}"` });
    }
    if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
    return linkLine(id(req), itemId, { reason: 'link', worker: worker(req) || 'Office', force: !!req.body.force });
  }));
  // "Link all N lines with this same text" (round 2, user-r1-2): one part (picked, or made once from the
  // text) for every line listed. Each line goes through the same safe linkLine; a van that already has a
  // line for that part with a different amount / text is left "to confirm" (reported back as duplicate).
  app.post('/api/van-lines/link-many', h(async req => {
    const ids = [...new Set((Array.isArray(req.body.line_ids) ? req.body.line_ids : []).map(Number).filter(Boolean))];
    if (!ids.length) throw inv.httpError(400, 'Which lines?');
    let itemId = Number(req.body.item_id) || null;
    const nu = req.body.new_item;
    if (!itemId && nu) {
      if (!String(nu.name || '').trim()) throw inv.httpError(400, 'Type a name for the new part');
      const l = await get('SELECT l.*, i.trade, i.plan_column AS col FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.id = ?', ids[0]);
      if (!l) throw inv.httpError(404, 'That part line no longer exists — refresh');
      // Bought for each van (it came from the plan as a per-van catch-all) unless the office says it's shelf stock.
      itemId = await newPartFromPlanText(nu, l, { kind: nu.kind === 'stock' ? 'stock' : 'per-van', supplier: String(nu.supplier || '').trim(),
        note: `Made from the plan text "${l.spec}" (${ids.length} line${ids.length === 1 ? '' : 's'})` });
    }
    if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
    const out = { linked: 0, merged: 0, duplicate: 0, skipped: 0, item_id: itemId };
    // force: the office saw the "already has this part" warning (link-preview) and said merge anyway.
    const force = !!req.body.force;
    for (const lineId of ids) {
      const r = await linkLine(lineId, itemId, { reason: 'link many', worker: worker(req) || 'Office', force, why: `linked with ${ids.length - 1} other line(s) with the same text` });
      out[r.result] = (out[r.result] || 0) + 1;
    }
    await syncSuppliers();
    return out;
  }));
  // What linking would do, before anything is changed (round 3, user-r2-3): per line 'link', 'merge' (the van
  // already has that part — one part, not two), 'duplicate' (it has it with a different amount / text) or
  // 'skipped'. The screens show this and ask before merging. (A preview: changes nothing.)
  app.post('/api/van-lines/link-preview', h(req => {
    const ids = [...new Set((Array.isArray(req.body.line_ids) ? req.body.line_ids : []).map(Number).filter(Boolean))];
    if (!ids.length) throw inv.httpError(400, 'Which lines?');
    const itemId = Number(req.body.item_id);
    if (!itemId) throw inv.httpError(400, 'Pick a part from the list');
    return linkPreview(ids, itemId);
  }, OWN_TX));
  // "Add each part" (Small fixes & phone round 1, user-r4-6): a plan text that names several parts
  // ("induction cooker + CAMEC MICROWAVE 28LTR + AIR FRYER…") — each picked part becomes its own line on the van.
  // { parts: [{ text, item_id }] }. The new lines get their stock set aside like any other line.
  app.post('/api/van-lines/:id/add-parts', h(async req => {
    const r = await addTextParts(id(req), req.body.parts, { worker: worker(req) || 'Office' });
    for (const itemId of r.allocate) await inv.allocateItem(itemId, r.van_id, { reason: 'add part', worker: worker(req) || 'Office' });
    await syncSuppliers();
    const { allocate, ...out } = r;
    return out;
  }));
  // "Keep as a one-off special part for this van": its own per-van part, still orderable (round 2, user-r1-2).
  app.post('/api/van-lines/:id/one-off', h(async req => {
    const r = await makeOneOff(id(req), { supplier: String(req.body.supplier || '').trim().slice(0, 60), name: String(req.body.name || '').slice(0, 120), worker: worker(req) || 'Office' });
    await syncSuppliers();
    return r;
  }));
}
