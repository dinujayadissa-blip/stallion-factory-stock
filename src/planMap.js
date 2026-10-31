// Reading the production plan spreadsheet's free text ("2 x 110 Amp Lithium Order 98", "7 Capral 44"):
// the quantity at the front of a cell, the most a van sensibly needs for a column, and which columns
// describe the van rather than parts. (The plan import itself stayed on SQLite — tag sqlite-final.)

const t = s => String(s || '');

// Leading count, with a reason when the text needs a person to check it.
//   "2 x Allytech" / "2x Allytech" / "5 / Black / Nikpol" → 2 / 2 / 5 (a count, then a description)
//   "1 Coast Order 146", "1Yes Shelflow"                     → 1 (a small count, then words)
//   "25 / NCE", "121 / NCE", "25 / NCE / 111"                → default: that's "order number / supplier"
//   sizes ("4.65m", "16''", "230 Amp") and numbers at the end are never taken as a count.
//   "Ordered 2 and need to order 2" (no count in front)       → 2 (the "need" number), flagged to check.
export function leadInfo(s, def = 1) {
  const text = t(s);
  // "N / SUPPLIER" or "N / SUPPLIER / NNN": an order number and who it's from, not a quantity.
  if (/^\s*\d+\s*\/\s*[a-z][a-z&.'-]*(?:\s+[a-z][a-z&.'-]*)?\s*(?:\/\s*\d*\s*)?$/i.test(text)) {
    return { qty: def, check: '' };
  }
  const need = /\bneed(?:s)?\s*(?:to\s*(?:order|get)\s*)?(?:another\s*)?(\d{1,2})\b/i.exec(text);
  // 'N x', 'Nx', 'N /' followed by a description.
  let m = /^\s*(\d{1,2})\s*(?:x(?=\s*\S)|\/(?=\s*[a-z]))/i.exec(text);
  // A small bare count followed by a word ("1 Coast", "7 Capral 38", "1Yes").
  if (!m) m = /^\s*(\d{1,2})(?![\d.,'"\/])(?!\s*(?:m|mm|mtr|cm|ft|kg|l|lt|ltr|litre|w|watt|v|volt|amp|a|ah|ah|inch|in|"|''|%)\b)(?=\s*[a-z])/i.exec(text);
  if (m && +m[1] > 0 && +m[1] <= 30) {
    return { qty: +m[1], check: need && +need[1] !== +m[1] ? `plan text also says "${need[0]}"` : '' };
  }
  if (need && +need[1] > 0) return { qty: +need[1], check: `quantity taken from "${need[0]}"` };
  return { qty: def, check: '' };
}
// The most metres of a roll item (vinyl) one van takes.
export const MAX_METRES = 15;

// Highest sensible quantity per van for a column, before the import asks someone to check it.
// Columns not listed: 'ea' items 10 (unless the column normally uses more), others no cap.
export const COLUMN_CAPS = [['VINYL', MAX_METRES], ['ROOF BAW', 4]];
export function capFor(header, unit = 'ea', usual = 0) {
  const H = normHeader(header);
  for (const [prefix, cap] of COLUMN_CAPS) if (H.startsWith(prefix)) return cap;
  if ((unit || 'ea') === 'ea') return Math.max(10, usual || 0);
  return Infinity;
}

// Columns that describe the van rather than parts: kept as van information.
export const INFO_COLUMNS = new Set([
  'DATE', 'CHASSIS #', 'VAN SIZE & TYPE', 'EXPECTED DELIVERY DATE', 'CUSTOMER NAME', 'FLAT FLOOR', 'DEALER',
  'CUSTOMER REQUESTS', 'VIN NUMBER', 'ELECTRICAL EXTRA', 'PLUMBING EXTRA', 'ALLUMINIUM EXTRA', 'OPTIONAL', 'ATM',
  'AXLE WEIGHT', 'BALL WEIGHT', 'WHEEL NUT TORQUE', 'TYRE PRESSURE', 'TRANSPORT COMPANY', 'INVOICE', 'WARRANTY',
  'REPAIRED ITEMS', 'REPAIRER', 'REPAIR COST', 'REPAIR DATE',
  'STATUS', // added by this app's Excel export
]);

export const normHeader = h => String(h || '').replace(/\s+/g, ' ').trim().toUpperCase();

