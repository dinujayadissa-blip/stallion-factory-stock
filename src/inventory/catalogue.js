// Fixing the catalogue (C9): supplier suggestions, gaps, putting parts on a rack.
import { all, get, ids, logAlloc, run, writeTx } from '../db.js';
import { firstCountDone, httpError, listItems } from './shared.js';
import { NOT_A_BRAND, SUPPLIER_WORDS, reEsc } from './special.js';
import { reorderSuggestions } from './reorder.js';

export async function supplierSuggestions() {
  const out = new Map();
  const words = [...SUPPLIER_WORDS];
  for (const { name } of await all(`SELECT name FROM suppliers ORDER BY name`)) {
    if (name.length < 4 || NOT_A_BRAND.test(name) || words.some(([s]) => s.toLowerCase() === name.toLowerCase())) continue;
    words.push([name, new RegExp(`\\b${reEsc(name).replace(/\s+/g, '\\s*')}\\b`, 'i')]);
  }
  const rows = await all(`SELECT i.id, l.spec FROM items i JOIN van_lines l ON l.item_id = i.id
                    WHERE i.active = 1 AND trim(i.supplier) = '' AND trim(l.spec) <> '' ORDER BY l.id`);
  const blank = await all(`SELECT id, sku, name, category, kind FROM items WHERE active = 1 AND trim(supplier) = '' ORDER BY id`);
  const hits = new Map(); // itemId → Map(supplier → {n, where})
  const add = (id, text, where) => {
    for (const [sup, re] of words) if (re.test(text)) {
      if (!hits.has(id)) hits.set(id, new Map());
      const h = hits.get(id).get(sup) || { n: 0, where };
      h.n += where === 'name' ? 100 : 1; // the part's own name counts most
      hits.get(id).set(sup, h);
    }
  };
  for (const r of rows) add(r.id, r.spec, 'text');
  for (const r of blank) add(r.id, r.name, 'name');
  for (const [id, m] of hits) {
    const [sup, h] = [...m.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    out.set(id, { supplier: sup, why: h.n >= 100 ? `the part's name says "${sup}"` : `"${sup}" appears ${h.n} time(s) in the plan text for this part` });
  }
  // Shelf parts only: sister parts (same code start and category, e.g. TAPS-…) that all have the same
  // supplier. Not for bought-for-van parts — those are brands (an OGO toilet isn't from Thetford).
  const named = await all(`SELECT sku, category, trim(supplier) AS supplier FROM items WHERE active = 1 AND trim(supplier) <> '' AND placeholder = 0 ORDER BY id`);
  for (const b of blank) {
    if (out.has(b.id) || b.kind !== 'stock') continue;
    const stem = String(b.sku).split('-')[0];
    const sis = named.filter(n => n.category === b.category && String(n.sku).split('-')[0] === stem);
    const sups = [...new Set(sis.map(s => s.supplier))];
    if (sis.length >= 2 && sups.length === 1) out.set(b.id, { supplier: sups[0], why: `same supplier as ${sis.slice(0, 3).map(s => s.sku).join(', ')}` });
  }
  return out;
}

// Items with something missing: supplier; for shelf items a rack, a reorder level; a unit size where
// the unit isn't obvious (length, set, m…). With suggestions to accept.
export async function catalogueGaps() {
  const items = (await listItems()).filter(i => !i.placeholder);
  const sups = await supplierSuggestions();
  const reo = await reorderSuggestions();
  const needsSize = i => !/^(ea|pair)$/i.test(String(i.unit || '').trim()) && !String(i.unit_size || '').trim();
  const rows = items.map(i => {
    const shelf = i.kind === 'stock';
    const missing = [];
    if (!String(i.supplier || '').trim()) missing.push('supplier');
    if (shelf && !i.area_id) missing.push('rack');
    if (needsSize(i)) missing.push('unit size');
    if (shelf && !(i.reorder_level > 0)) missing.push('reorder level');
    return { id: i.id, sku: i.sku, name: i.name, category: i.category, trade: i.trade, kind: i.kind, supplier: i.supplier, unit: i.unit,
      unit_size: i.unit_size, area_id: i.area_id, area_name: i.area_name, location: i.location, reorder_level: i.reorder_level,
      order_up_to: i.order_up_to, on_hand: i.on_hand, not_counted: i.not_counted, last_counted: i.last_counted, photo: i.photo, missing,
      suggest_supplier: sups.get(i.id) || null, suggest_reorder: shelf ? (reo.get(i.id) || null) : null };
  });
  return {
    rows: rows.filter(r => r.missing.length),
    counts: ['supplier', 'rack', 'unit size', 'reorder level'].reduce((o, k) => ({ ...o, [k]: rows.filter(r => r.missing.includes(k)).length }), {}),
    racks: await all(`SELECT id, name FROM floor_areas WHERE kind = 'storage' ORDER BY sort, name`),
    suppliers: (await all('SELECT name FROM suppliers ORDER BY lower(name), name')).map(s => s.name),
    counted: await firstCountDone(),
  };
}

// Bulk "Put on rack": every ticked item goes to one storage area (logged).
export async function putOnRack(itemIds, areaId, by = '') {
  const ids = (itemIds || []).map(Number).filter(Boolean);
  if (!ids.length) throw httpError(400, 'Tick the parts to put on the rack');
  return writeTx(async () => {
    const a = areaId ? await get(`SELECT id, name FROM floor_areas WHERE id = ? AND kind = 'storage'`, Number(areaId)) : null;
    if (areaId && !a) throw httpError(404, 'That rack no longer exists — refresh');
    let n = 0;
    for (const id of ids) {
      const it = await get('SELECT id, area_id FROM items WHERE id = ?', id);
      if (!it || it.area_id === (a?.id ?? null)) continue;
      await run('UPDATE items SET area_id = ? WHERE id = ?', a?.id ?? null, id);
      await logAlloc('catalogue', { item_id: id, field: 'rack', before: it.area_id ? ((await get('SELECT name FROM floor_areas WHERE id = ?', it.area_id))?.name || '') : '', after: a?.name || '', worker: by });
      n++;
    }
    return { moved: n };
  });
}
