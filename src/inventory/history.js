// History: "Why?" for a line or an item (C11).
import { all, get } from '../db.js';
import { httpError } from './shared.js';

const LOG_COLS = `a.id, a.at, a.reason, a.van_id, a.item_id, a.line_id, a.field, a.before, a.after, a.worker, a.note, a.change, a.firm_change, a.ack`;

// One van line: what is set aside for it now, and every change with who / when / why, plus the stock
// movements for that van and part.
export async function lineHistory(lineId) {
  const l = await get(`SELECT l.*, v.chassis, i.sku, i.name, i.unit FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id WHERE l.id = ?`, lineId);
  if (!l) throw httpError(404, 'That part line no longer exists — refresh');
  const log = await all(`SELECT ${LOG_COLS}, v.chassis FROM allocation_log a LEFT JOIN vans v ON v.id = a.van_id WHERE a.line_id = ? ORDER BY a.id`, lineId);
  // Borrows *for* this line are logged on the donor's line; show them here too.
  const borrowedFor = await all(`SELECT ${LOG_COLS}, v.chassis FROM allocation_log a LEFT JOIN vans v ON v.id = a.van_id
                           WHERE a.reason = 'borrow' AND a.item_id = ? AND a.van_id <> ? AND a.note ILIKE ? ORDER BY a.id`, l.item_id, l.van_id, `% for ${l.chassis}%`);
  const moves = await all(`SELECT m.id, m.at, m.type, m.qty, m.ref, m.note, m.worker FROM movements m WHERE m.van_id = ? AND m.item_id = ? ORDER BY m.id`, l.van_id, l.item_id);
  return { line: l, log, borrowedFor, moves };
}

export async function itemHistory(itemId) {
  return all(`SELECT ${LOG_COLS}, v.chassis FROM allocation_log a LEFT JOIN vans v ON v.id = a.van_id
              WHERE a.item_id = ? ORDER BY a.id DESC LIMIT 200`, itemId);
}
