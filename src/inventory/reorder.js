// Reorder suggestions (C10): levels from what was used.
import { all } from '../db.js';
import { AGE_SECS, COUNTABLE_ITEM, MELB, q } from './shared.js';
import { itemMedians } from './vans.js';

// Never saved by itself — shown with an "Apply" button. Van demand is already ordered per van (C6), so:
//   - a part that appears on van lines: the level is only a safety buffer of about one van's use
//     (median quantity per van);
//   - a floor consumable not on van lines (screws, silicone, tape): average use per week (from 'issue'
//     movements, once there are 4+ weeks of history) × (supplier lead time + 1 review week).
// Returns Map itemId → { level, why } (level null = no suggestion yet).
const WHOLE_UNITS = /^(ea|set|kit|pair|sheet|length|box|roll|pack|pkt|bag)$/i;
export async function reorderSuggestions(itemIds = null) {
  const items = (await all(`SELECT i.id, i.unit, i.supplier FROM items i WHERE ${COUNTABLE_ITEM} ORDER BY i.id`)).filter(i => !itemIds || itemIds.includes(i.id));
  const out = new Map();
  if (!items.length) return out;
  const onLines = new Set((await all('SELECT DISTINCT item_id FROM van_lines')).map(r => r.item_id));
  const med = await itemMedians(items.filter(i => onLines.has(i.id)).map(i => i.id));
  const lead = new Map((await all('SELECT name, lead_days FROM suppliers')).map(s => [s.name, s.lead_days]));
  const round = (n, unit) => (WHOLE_UNITS.test(unit || '') ? Math.ceil(n - 1e-9) : Math.round(n * 10) / 10);
  // Floor consumables: the parts taken, for all of them at once — two queries in all, not one or two per item.
  // First when each was first taken (days since then, worked out in SQL: `at` is Melbourne wall-clock time)…
  const rest = items.filter(i => !onLines.has(i.id));
  const firstTaken = new Map(rest.length ? (await all(`SELECT item_id, MIN(at) AS first, ${AGE_SECS('MIN(at)')} AS secs FROM movements
      WHERE item_id IN (${rest.map(() => '?').join(',')}) AND type = 'issue' GROUP BY item_id`, ...rest.map(i => i.id))).map(r => [r.item_id, r]) : []);
  const spans = new Map();
  for (const i of rest) {
    const h = firstTaken.get(i.id);
    const days = h?.first ? h.secs / 86400 : 0;
    if (days >= 28) spans.set(i.id, Math.min(days, 84));
  }
  // …then, for those with 4+ weeks of it, how many were taken in the last `span` days (up to 12 weeks).
  const usedOf = new Map(spans.size ? (await all(`SELECT (g.x->>'id')::int AS id, (SELECT COALESCE(SUM(m.qty),0) FROM movements m
        WHERE m.item_id = (g.x->>'id')::int AND m.type = 'issue' AND m.at >= to_char(${MELB} + (g.x->>'iv')::interval, 'YYYY-MM-DD HH24:MI:SS')) AS s
      FROM json_array_elements(?::text::json) AS g(x)`, JSON.stringify([...spans].map(([id, span]) => ({ id, iv: `-${Math.round(span)} days` })))))
    .map(r => [r.id, -r.s]) : []);
  for (const i of items) {
    if (onLines.has(i.id)) {
      const m = med.get(i.id) || 0;
      out.set(i.id, m > 0 ? { level: round(m, i.unit), why: `about one van's use (${q(m)} ${i.unit} per van) as a safety buffer — van orders cover the rest` }
        : { level: null, why: 'no van use yet' });
      continue;
    }
    if (!spans.has(i.id)) { out.set(i.id, { level: null, why: 'not enough history yet (needs 4 weeks of parts taken)' }); continue; }
    const span = spans.get(i.id);
    const used = usedOf.get(i.id);
    const perWeek = used / (span / 7);
    const ld = lead.get(String(i.supplier || '').trim()) ?? 14;
    const level = perWeek > 0 ? round(perWeek * (ld / 7 + 1), i.unit) : null;
    out.set(i.id, { level, why: level ? `${q(Math.round(perWeek * 10) / 10)} ${i.unit} a week × (${ld} days lead time + 1 week)` : 'not used in the last weeks' });
  }
  return out;
}
