// Items: the catalogue, stock corrections and deliveries, photos and stocktakes.
import { get, insert, logAlloc, run, syncSuppliers, writeTx } from '../db.js';
import * as inv from '../inventory.js';
import { deletePhoto, savePhoto } from '../photos.js';
import { assignMissingTrades, isTrade } from '../trades.js';
import { fetchWebImage } from '../webImage.js';
import { OWN_TX, h, id, now, worker } from './common.js';

export function itemRoutes(app) {
  // ── Items / stock ──
  const ITEM_FIELDS = ['sku', 'name', 'category', 'supplier', 'unit', 'kind', 'reorder_level', 'location', 'notes', 'active', 'plan_column', 'area_id', 'trade',
    'unit_size', 'order_up_to'];
  function itemValues(b) {
    const v = { ...b };
    if (v.sku != null) v.sku = String(v.sku).trim().toUpperCase();
    if (v.reorder_level != null) v.reorder_level = Math.max(0, Number(v.reorder_level) || 0);
    if (v.order_up_to != null) v.order_up_to = Math.max(0, Number(v.order_up_to) || 0);
    if (v.unit_size != null) v.unit_size = String(v.unit_size).trim().slice(0, 60);
    if (v.supplier != null) v.supplier = String(v.supplier).trim();
    if (v.active != null) v.active = v.active ? 1 : 0;
    if (v.area_id !== undefined) v.area_id = Number(v.area_id) || null;
    if (v.trade !== undefined && !isTrade(v.trade)) v.trade = '';
    if (v.kind !== undefined) v.kind = v.kind === 'per-van' ? 'per-van' : 'stock';
    return v;
  }
  app.get('/api/items', h(req => inv.listItems({ includeInactive: req.query.all === '1' })));
  app.get('/api/items/many-specs', h(() => inv.manySpecs(5)));
  // { item_id: qty } still to order for vans due soon, after what is on order (Stock page "Still to order").
  app.get('/api/items/still-to-order', h(() => inv.stillToOrderByItem()));
  app.get('/api/items/:id', h(req => inv.itemDetail(id(req))));
  app.post('/api/items', h(async req => {
    const v = itemValues(req.body);
    if (!v.sku || !v.name) throw inv.httpError(400, 'SKU and name are required');
    const opening = Number(req.body.on_hand);
    if (opening > 0) inv.checkQty(opening); // (blank / 0: no opening stock, as before; Infinity is refused)
    if (await get('SELECT 1 FROM items WHERE sku = ?', v.sku)) throw inv.httpError(409, `SKU ${v.sku} already exists`);
    const keys = ITEM_FIELDS.filter(k => v[k] != null);
    const newId = await insert(`INSERT INTO items(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => v[k]));
    if (opening > 0) await inv.receive(newId, opening, { note: 'Opening stock' });
    await assignMissingTrades(); // no trade picked → best guess from the name
    return { id: newId };
  }));
  app.put('/api/items/:id', h(async req => {
    const v = itemValues(req.body);
    const keys = ITEM_FIELDS.filter(k => v[k] !== undefined);
    if (v.sku && await get('SELECT 1 FROM items WHERE sku = ? AND id <> ?', v.sku, id(req))) throw inv.httpError(409, `SKU ${v.sku} already exists`);
    const before = await get('SELECT * FROM items WHERE id = ?', id(req));
    if (!before) throw inv.httpError(404, 'Item not found');
    if (keys.length) await run(`UPDATE items SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => v[k]), id(req));
    // Catalogue changes that matter for ordering / counting go into the item's history.
    for (const k of ['kind', 'supplier', 'area_id', 'reorder_level', 'order_up_to', 'unit', 'unit_size']) {
      if (v[k] === undefined || String(v[k] ?? '') === String(before[k] ?? '')) continue;
      await logAlloc('catalogue', { item_id: before.id, field: k === 'area_id' ? 'rack' : k.replace(/_/g, ' '), before: before[k] ?? '', after: v[k] ?? '', worker: worker(req) || 'Office' });
    }
    if (v.supplier !== undefined) await syncSuppliers();
    await assignMissingTrades(); // "guess from the name" picked → best guess straight away
  }));
  app.post('/api/items/:id/adjust', h(req => inv.adjust(id(req), { mode: req.body.mode, qty: Number(req.body.qty), note: req.body.note, by: worker(req) })));
  app.post('/api/items/:id/receive', h(req => inv.receiveDelivery(id(req), Number(req.body.qty),
    { ref: req.body.ref || '', note: req.body.note || '', vanId: Number(req.body.van_id) || null, by: worker(req) })));
  // Photos (OWN_TX: the picture is stored — a file, or an upload to Storage — outside the write lock; then
  // items.photo changes in a writeTx; the old picture is removed only once that is saved).
  const dropPhoto = async name => {
    try { await deletePhoto(name); } catch (e) { console.error(now(), `Couldn't remove the old picture ${name}:`, e); }
  };
  app.post('/api/items/:id/photo', h(async req => {
    const itemId = id(req);
    if (!await get('SELECT 1 FROM items WHERE id = ?', itemId)) throw inv.httpError(404, 'Item not found');
    const name = await savePhoto(itemId, req.body?.full, req.body?.thumb);
    let old;
    try {
      old = await writeTx(async () => {
        const item = await get('SELECT id, photo FROM items WHERE id = ?', itemId);
        if (!item) throw inv.httpError(404, 'Item not found'); // deleted meanwhile
        await run('UPDATE items SET photo = ? WHERE id = ?', name, item.id);
        return item.photo;
      });
    } catch (e) { await dropPhoto(name); throw e; }
    if (old) await dropPhoto(old);
    return { photo: name };
  }, OWN_TX));
  app.delete('/api/items/:id/photo', h(async req => {
    const itemId = id(req);
    const old = await writeTx(async () => {
      const item = await get('SELECT id, photo FROM items WHERE id = ?', itemId);
      if (!item) throw inv.httpError(404, 'Item not found');
      await run(`UPDATE items SET photo = '' WHERE id = ?`, item.id);
      return item.photo;
    });
    if (old) await dropPhoto(old);
  }, OWN_TX));
  // Download a picture from an internet link (or the main picture of a product page). Nothing is saved
  // (OWN_TX: the download is not done under the write lock).
  app.post('/api/web-image', h(async (req, res) => {
    const img = await fetchWebImage(req.body.url);
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'no-store');
    res.send(img.body);
  }, OWN_TX));
  app.post('/api/stocktake', h(req => inv.stocktake(req.body.rows || [], req.body.note, worker(req))));
}
