// How each column of the production plan spreadsheet turns into part lines.
//
// Every cell is free text like "2 x 110 Amp Lithium Order 98" or "7 Capral 44". For the columns
// below we recognise the actual stock item and quantity. Any other column (or text we don't
// recognise) becomes a line for a per-van "as per plan" item named after the column, keeping the
// original text — so nothing on the plan is lost.
//
// A handler gets (text, row) where row.get('Invertor') reads another column of the same van,
// and returns:
//   null            → not a part (e.g. "No", "Flat floor", information only)
//   [{sku, qty}]    → these stock items
//   undefined       → fall back to the generic "as per plan" item for the column

const t = s => String(s || '');
const has = (s, re) => re.test(t(s));

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
export function lead(s, def = 1) {
  return leadInfo(s, def).qty;
}

// Metres for a roll item (vinyl): "7.6m", "7.2 m", "8mtr" — a number followed by m / mtr and then a
// space or the end. A code like "634M" or "990m" is more than any van needs (over 15 m) and is skipped.
export const MAX_METRES = 15;
export function metresInfo(s, def) {
  let rejected = '';
  for (const m of t(s).matchAll(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s?(?:m|mtr)(?=\s|$|[,;)])/gi)) {
    const n = +m[1];
    if (n > 0 && n <= MAX_METRES) return { qty: n, check: rejected ? `ignored "${rejected}" (too long for one van)` : '' };
    if (n > MAX_METRES && !rejected) rejected = `${m[1]}m`;
  }
  return { qty: def, check: rejected ? `ignored "${rejected}" (too long for one van)` : '' };
}

// Highest sensible quantity per van for a column, before the import asks someone to check it.
// Columns not listed: 'ea' items 10 (unless the column normally uses more), others no cap.
export const COLUMN_CAPS = [['VINYL', MAX_METRES], ['ROOF BAW', 4]];
export function capFor(header, unit = 'ea', usual = 0) {
  const H = normHeader(header);
  for (const [prefix, cap] of COLUMN_CAPS) if (H.startsWith(prefix)) return cap;
  if ((unit || 'ea') === 'ea') return Math.max(10, usual || 0);
  return Infinity;
}
// "N x" anywhere: "24v 3 x 230Amp" → 3
export function nx(s, def = 1) {
  const m = /(?:^|[^\d])(\d{1,2})\s*x\s*(?=\d|[a-z])/i.exec(t(s));
  return m ? +m[1] : def;
}
const one = (sku, qty = 1) => [{ sku, qty }];
const yes = s => /^\s*(\d+\s*)?(x\s*)?yes|^\s*\d+\s*$|^\s*\d+\s*(order|arizon|\/)/i.test(t(s));
const noInverter = row => !row.get('Invertor') || /^\s*(no|provision)/i.test(row.get('Invertor'));

// Text that never means "we need a part".
export const NOT_A_PART = /^\s*(no\b|no\.|none|nil|n\/a|-+$|`$|provision|always flat floor|flat floor|customer supply|customer suply|customer$|not required|different van)/i;

// Order / PO reference written in the cell: "Order 98", "Ordered 131", or a trailing
// supplier-number like "Capral 46", "Arizon 24", "E time 35", "Battery Stop 200", "Onex 08".
// Never an order number (round 2, user-r1-1):
//   - dates: "Urban republic Order 29/06/2026" → '' ("Order 34 16/04/2026" → 34)
//   - quantities: "Ordered 2 and need to order 2", "1 Ordered 4 Need to be ordered", "8 x 225 or 9", "2 + Small 1"
//   - axles and sizes: "Dual Axel 2", "1 x 500 x 350" and codes glued to letters ("ATS4", "DO35")
//   - a bare single digit at the end ("Shiran 2"): the plan writes low order numbers with a 0 ("Onex 08")
const QTY_WORD = /^(?:or|and|small|large|medium|big|extra|more|need|needs|each|qty|of|x)$/i;
const AXLE_WORD = /^ax(?:le|el)s?$/i;
export function poRef(s) {
  const text = t(s).replace(/\b\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}\b/g, ' '); // dates out first
  for (const m of text.matchAll(/\border(?:ed)?\s*(?:no\.?\s*)?#?\s*\/?\s*(\d{1,4})\b/gi)) {
    const before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
    if (/\bneed(?:s)?\s*(?:to\s*)?(?:be\s*)?$/i.test(before)) continue;           // "need to order 2" = a quantity
    if (/^\s*(?:and\b|more\b|need|left\b|to go\b|x\b|of\b|pcs\b|ea\b|units?\b)/i.test(after)) continue; // "Ordered 2 and need…"
    return m[1];
  }
  // A supplier word with a 0-led number is the plan's way of writing a low order number ("Onex 08"),
  // even with more text after it: "5 / Black / Nikpol 09 - Ordered 2 and need to order 2" → 09.
  const z = /(?:^|[\s/])([a-z][a-z&]{2,})\s*\/?\s*(0\d)(?![\d.,])/i.exec(text);
  if (z && !AXLE_WORD.test(z[1]) && !QTY_WORD.test(z[1])) return z[2];
  const trimmed = text.trim();
  // "121 / NCE": the order number, then who it is with (leadInfo reads these as "not a quantity" too).
  // A single digit is a count ("5 / Black"); a second number after it ("25 / NCE / 111") is read below.
  const lead2 = /^(\d{2,3})\s*\/\s*([a-z][a-z&.'-]*(?:\s+[a-z][a-z&.'-]*)?)$/i.exec(trimmed);
  if (lead2 && +lead2[1] < 400 && !QTY_WORD.test(lead2[2]) && !AXLE_WORD.test(lead2[2])) return lead2[1];
  // Glued to letters: "SP33", "O10", "Ranger102" are order numbers; product codes are not
  // ("ATS4", "EV1", "DO35" hitch, "MSRA60" stereo, "SLMKIT04").
  const g = /(?:^|[\s/])([a-z]+)(\d{2,3})$/i.exec(trimmed);
  if (g) {
    const ok = /^(sp|o|po)$/i.test(g[1]) || /^[A-Z]?[a-z]{3,}$/.test(g[1]);
    return ok && +g[2] < 400 ? g[2] : '';
  }
  // Trailing "<word> NN" / "<word> / NN".
  const m = /(?:^|\s|\/)([^\s/]*(?:[a-wyz)]|[a-z]x))(?:\s+|\s*\/\s*)(\d{1,3})$/i.exec(trimmed);
  if (!m || +m[2] >= 400) return '';
  if (/^[1-9]$/.test(m[2])) return '';                      // "Shiran 2", "Small 1", "or 9", "Dual Axel 2"
  if (QTY_WORD.test(m[1]) && +m[2] <= 20 && !/^0/.test(m[2])) return ''; // "or 12"; "Small 126" is an order
  if (AXLE_WORD.test(m[1]) && m[2].length < 3) return '';   // "Dual Axel 12"; "Double Axel 141" is an order
  return m[2];
}
// The reader used before round 2 — only for the clean-up step that re-reads stored numbers (tidy.js),
// so it changes a line only when its number came from this reader and not from a person.
export function poRefV1(s) {
  const text = t(s);
  let m = /\border(?:ed)?\s*(?:no\.?\s*)?#?\s*\/?\s*(\d{1,4})\b/i.exec(text);
  if (m) return m[1];
  m = /(?:[a-wyz)]|[a-z]x)\s*\/?\s*(\d{1,3})\s*$/i.exec(text.trim());
  if (m && +m[1] < 400) return m[1];
  return '';
}

// [header prefix (upper case), handler]. Matched against the start of the column header.
export const COLUMNS = [
  ['CHASSIS', s => has(s, /road\s*king/i) ? one('CH-RK6') : undefined],
  ['SUSPENSION', s => {
    const out = [];
    if (has(s, /atx/i)) out.push({ sku: 'SUS-CM-ATX-45', qty: 1 });
    else if (has(s, /\bair/i)) out.push({ sku: 'SUS-CM-XT-AIR', qty: 1 });
    else if (has(s, /\bxt\b/i)) out.push({ sku: 'SUS-CM-XT', qty: 1 });
    else out.push({ generic: true, qty: 1 });
    if (has(s, /d[o0]\W?35/i)) out.push({ sku: 'HITCH-DO35', qty: 1 });
    if (has(s, /d[o0]\W?45/i)) out.push({ sku: 'HITCH-DO45', qty: 1 });
    return out;
  }],
  ['WHEEL BOX', s => has(s, /^\s*(flat|always|no)\b/i) ? null : undefined],
  ['ALKO ESC', s => has(s, /tus/i) ? one('ESC-TUSON') : has(s, /yes/i) ? one('ESC-ALKO') : null],
  ['1 PIECE FLOOR', s => has(s, /honey/i) ? one('FLOOR-HONEYCOMB') : undefined],
  ['VINYL', s => { const r = metresInfo(s, 7); return [{ sku: 'VINYL', qty: r.qty, check: r.check }]; }],
  ['SPLASHBACK', () => one('SPLASHBACK')],
  ['SHOWER ', s => has(s, /cs13f/i) ? one('SHOWER-CS13F') : has(s, /cs11r/i) ? one('SHOWER-CS11R') : undefined],
  ['KITCHEN MAIN PARTITION', s => has(s, /^\s*yes/i) ? undefined : null],
  ['WALLS', () => one('WALLS')],
  ['FURNITURE', () => one('FURNITURE')],
  ['DOORS AND DRAWERS', () => one('DOORS-DRAWERS')],
  ['BENCHTOPS', () => one('BENCHTOP')],
  ['PRESSING SHEETS', () => one('PRESS-TRP3')],
  ['INTERNAL DOOR HANDLES', () => one('HANDLES')],
  ['WHITE ALICOM', s => one('ALICOM-WHITE', lead(s))],
  ['BATTERY ', s => {
    const q = nx(s, lead(s));
    if (has(s, /\b110\s*a/i)) return one('BAT-110', q);
    if (has(s, /\b100\s*a/i)) return one('BAT-100', q);
    if (has(s, /\b135/i)) return one('BAT-AGM-135', q);
    if (has(s, /\b200\s*a/i)) return one('BAT-200', q);
    if (has(s, /\b230\s*a/i)) return one('BAT-230-24', q);
    if (has(s, /\b300\s*a/i)) return one('BAT-300', q);
    if (has(s, /\b460\s*a/i)) return one('BAT-460', q);
    return undefined;
  }],
  // CHARGER and Solar Controler are summary columns; the parts have their own columns further
  // along. Only when those are still blank do we take the parts from the summary.
  ['CHARGER', (s, row) => {
    const out = [];
    if (!row.get('AC CHARGER') && noInverter(row) && has(s, /ac charger/i)) out.push({ sku: has(s, /\b30\s*a/i) ? 'AC-CHG-30' : 'AC-CHG-120', qty: 1 });
    if (!row.get('DC TO DC') && has(s, /dc-?dc/i)) out.push({ sku: noInverter(row) ? 'DCDC-30' : 'DCDC-50', qty: 1 });
    return out.length ? out : null;
  }],
  ['SOLAR CONTROLER', (s, row) => {
    const out = [];
    if (has(s, /100\/80/)) out.push({ sku: 'MPPT-100-80', qty: nx(s) });
    if (has(s, /100\/50/) && !row.get('100/50')) out.push({ sku: 'MPPT-100-50', qty: nx(s) });
    if (has(s, /bmv/i) && !row.get('BATTERY MONITOR')) out.push({ sku: 'BMV-712', qty: 1 });
    if (has(s, /cerbo/i) && !row.get('CERBO')) out.push({ sku: has(s, /touch\s*70/i) ? 'CERBO-70' : 'CERBO-50', qty: 1 }, { sku: 'SMART-SHUNT', qty: 1 });
    return out.length ? out : null;
  }],
  ['INVERTOR', s => has(s, /5000/) ? one('INV-5000') : has(s, /3000/) ? one('INV-3000') : undefined],
  ['EXTRA ANDERSON PLUG', s => yes(s) ? one('ANDERSON') : null],
  ['SOLAR PANELS', s => {
    const q = nx(s, lead(s));
    if (has(s, /225/)) return one('SOLAR-225', q);
    if (has(s, /160/)) return one('SOLAR-160', q);
    if (has(s, /200/)) return one('SOLAR-200', q);
    return undefined;
  }],
  ['100/30', s => one('MPPT-100-30', lead(s))],
  ['100/50', s => one('MPPT-100-50', has(s, /^\s*2\s*x/i) ? 2 : lead(s))],
  ['DC TO DC', (s, row) => {
    if (has(s, /30\s*a/i)) return one('DCDC-30');
    if (has(s, /50|orion\s*xs/i)) return one('DCDC-50');
    return one(noInverter(row) ? 'DCDC-30' : 'DCDC-50');
  }],
  ['AC CHARGER', (s, row) => one(has(row.get('CHARGER'), /\b30\s*a/i) ? 'AC-CHG-30' : 'AC-CHG-120', lead(s))],
  ['BATTERY PROTECTOR', (s, row) => {
    if (has(s, /\b65/)) return one('BP-65');
    if (has(s, /\b100/)) return one('BP-100');
    return one(noInverter(row) ? 'BP-65' : 'BP-100');
  }],
  ['MULTY CONTROL', s => one('MULTI-CTRL', lead(s))],
  ['BATTERY MONITOR', s => one('BMV-712', lead(s))],
  ['CERBO', s => [{ sku: has(s, /70/) ? 'CERBO-70' : 'CERBO-50', qty: lead(s) }, { sku: 'SMART-SHUNT', qty: lead(s) }]],
  ['INSULATION', s => has(s, /blue|xps/i) ? one('INSUL-XPS') : undefined],
  ['FIBER GLASS ROOF', s => has(s, /sandwich/i) ? one('ROOF-SANDWICH') : one('ROOF-FIBREGLASS')],
  ['CLADDING SHEETS', s => has(s, /^\s*cladding\s*$/i) ? null : one('CLAD-ALICOM')],
  ['CHECKER PLATE', s => has(s, /^\s*cladding\s*$/i) ? null : one('CHECKER-BLK', 7)],
  ['J-MOULD', s => one('J-MOULD', lead(s, 7))],
  ['I MOULD', s => one('I-MOULD', lead(s, 1))],
  ['AWNING RAIL', s => one('AWNING-RAIL', lead(s, 1))],
  ['H MOULD', () => one('H-MOULD')],
  ['WINDOWS', () => one('WINDOW-SET')],
  ['AWNING SUPPORT', () => one('AWNING-SUPPORT')],
  ['AWNING PLATES', s => one('AWNING-PLATE', lead(s, 2))],
  ['AWNING', s => has(s, /carefree/i) ? undefined : one('AWNING-AT')],
  ['MAIN DOOR', s => has(s, /aussie/i) ? one('DOOR-TRILOCK', lead(s)) : undefined],
  ['SHOWER HATCHES', s => one('HATCH-RANGER', lead(s, 2))],
  ['SKYLIGHTS', s => {
    if (has(s, /700/)) return one('SKYLIGHT-700', lead(s));
    if (has(s, /450/)) return one('SKYLIGHT-450', lead(s));
    return undefined;
  }],
  ['12V PUMPS', s => one('PUMP-12V', lead(s))],
  ['TRIMS', s => has(s, /swift/i) ? one('TRIMS-SWIFT') : undefined],
  ['RANGEHOOD', s => has(s, /swift/i) ? one('RANGEHOOD') : undefined],
  ['MICROWAVE', s => has(s, /camec/i) ? one('MW-CAMEC-28') : has(s, /23\s*l/i) ? one('MW-NCE-23') : undefined],
  ['DISHWASHER', s => has(s, /kleenmaid/i) ? one('DW-KLEENMAID') : undefined],
  ['WASHING', s => {
    if (has(s, /nce/i)) return one('WM-NCE-COMBO');
    if (has(s, /front\s*loader/i)) return one('WM-AT-3KG');
    if (has(s, /top\s*loader/i)) return one('WM-AT-TOP');
    return undefined;
  }],
  ['STEREO', s => has(s, /fusion/i) ? one('STEREO-FUSION', has(s, /^\s*2\s*more/i) ? 2 : 1) : undefined],
  ['INTERNAL SPEAKERS', s => has(s, /fusion/i) ? one('SPK-FUSION-INT') : undefined],
  ['EXTERNAL SPEAKERS', s => has(s, /fusion/i) ? one('SPK-FUSION-EXT', lead(s)) : undefined],
  ['TV BRACKET', () => one('TV-BRACKET')],
  ['TV ANTENNA', () => undefined],
  ['TV', s => {
    const out = [];
    const n24 = (t(s).match(/24\s*''|24\s*"|24\s*inch/gi) || []).length;
    const n32 = (t(s).match(/32\s*''|32\s*"|32\s*inch/gi) || []).length * (has(s, /2\s*x\s*32/i) ? 2 : 1);
    if (n24) out.push({ sku: 'TV-24', qty: n24 });
    if (n32) out.push({ sku: 'TV-32', qty: n32 });
    return out.length ? out : undefined;
  }],
  ['FRIDGE', s => {
    if (has(s, /bushman|225/i)) return one('FRIDGE-BUSH-225');
    if (has(s, /thedford|thetford/i)) return undefined;
    if (has(s, /3\s*way/i)) return undefined;
    if (has(s, /220/)) return one('FRIDGE-DOM-220');
    if (has(s, /18[89]|190/)) return one('FRIDGE-DOM-190');
    return undefined;
  }],
  ['AIRCON', s => {
    if (has(s, /pro\b/i)) return one('AC-FRESHJET-PRO');
    if (has(s, /plus/i)) return one('AC-FRESHJET');
    return undefined;
  }],
  ['EXTRA HEATING', s => has(s, /au focus/i) && !has(s, /combo/i) ? one('HEATER-DIESEL') : undefined],
  ['FANS', s => {
    const q = lead(s, nx(s, 1));
    return one(has(s, /black/i) ? 'FAN-BLACK' : 'FAN-WHITE', q);
  }],
  ['DUST REDUCTION', s => has(s, /^\s*htp/i) ? one('HTP-12V') : undefined],
  ['SHOWER MIRRORS', s => has(s, /nbc/i) ? one('SHOWER-MIRROR') : undefined],
  ['SHOWER SCREENS', s => has(s, /white\s*\+?\s*mirror/i) ? one('SCREEN-MIRROR') : undefined],
  ['ENSUITE DOOR', s => has(s, /conc[e]?r?tina|concerina/i) ? one('DOOR-CONCERTINA') : has(s, /slid/i) ? null : undefined],
  ['SLIDING DOOR RAILING', s => one('SLIDE-DOOR-KIT', has(s, /^\s*5\s*more/i) ? 5 : 1)],
  ['SEPERATING BUNK', s => has(s, /conc|concerina/i) && !has(s, /-\d+\s+\d/) ? one('DOOR-CONCERTINA') : undefined],
  ['ENTRANCE GRAB', () => one('GRAB-ENTRY')],
  ['GRAB HANDLES', s => one(has(s, /gold/i) && !has(s, /black/i) ? 'GRAB-GOLD' : 'GRAB-BLACK', lead(s, 5))],
  ['TIK CUSHION', s => has(s, /yes/i) ? one('TIK-CUSHION') : null],
  ['LOUNGE ORDER', () => one('LOUNGE')],
  ['TABLE LEG', s => has(s, /telescopic/i) ? one('TABLE-LEG') : undefined],
  ['TOILET', s => {
    if (has(s, /ceramic/i)) return one('TOILET-C263');
    if (has(s, /plastic/i)) return one('TOILET-PLASTIC', has(s, /^\s*2\s*more/i) ? 2 : 1);
    return undefined;
  }],
  ['KITCHEN SINK', s => has(s, /white\s*no\s*drainer/i) ? one('SINK-WHITE-ND') : has(s, /pr8111/i) ? one('SINK-SQ-SATIN') : undefined],
  ['HWS', s => has(s, /reflex/i) ? one('HWS-REFLEX') : has(s, /swift/i) ? one('HWS-SWIFT') : undefined],
  ['EXTERNAL SHOWER', s => has(s, /yes/i) ? one('EXT-SHOWER') : null],
  ['BARTHROOM KIT', s => {
    if (has(s, /gold/i)) return one('BATHKIT-GOLD', nx(s, lead(s)));
    if (has(s, /black/i)) return one('BATHKIT-BLACK');
    if (has(s, /stainless|stainles/i)) return one('BATHKIT-BRUSHED');
    return undefined;
  }],
  ['TAPS', s => {
    if (has(s, /^\s*black\s*$/i)) return one('TAPS-BLACK');
    if (has(s, /^\s*gold\b/i) && !has(s, /customer/i)) return one('TAPS-GOLD');
    if (has(s, /^\s*(stainless|stainles|brushed nikel|brushed nickel)\s*$/i)) return one('TAPS-BRUSHED');
    return undefined;
  }],
  ['DECALS', () => one('DECALS')],
  ['BED FRAME', () => one('BED-FRAME')],
  ['MATTRESS', s => one('MATTRESS', has(s, /2\s*single/i) ? 2 : 1)],
  ['BOLSTER', s => has(s, /yes|king/i) ? one('BOLSTER') : null],
  ['PULL OUT PANTRY', s => has(s, /^\s*shelves\s*$/i) ? null : undefined],
  ['STEP', s => {
    if (has(s, /electric/i)) return one('STEP-ELECTRIC', lead(s));
    if (has(s, /^\s*double/i)) return one('STEP-DOUBLE');
    if (has(s, /single/i)) return one('STEP-SINGLE', lead(s));
    return undefined;
  }],
  ['WATER TANK 100L', s => {
    if (has(s, /stainless/i)) return undefined;
    const out = [];
    for (const m of t(s).matchAll(/(\d)\s*x\s*(\d{2,3})/gi)) {
      const size = +m[2];
      out.push({ sku: size >= 108 ? 'TANK-110' : size >= 95 ? 'TANK-105' : 'TANK-60', qty: +m[1] });
    }
    return out.length ? out : undefined;
  }],
  ['WATER TANK 50L', s => { const m = /(\d)\s*x\s*(\d{2})/i.exec(t(s)); return m ? one('TANK-60', +m[1]) : undefined; }],
  ['GRAY WATER TANK', s => has(s, /60/) ? one('TANK-60') : one('TANK-GREY', lead(s))],
  ['ENTERTAINMENT SYSTEM', s => has(s, /^\s*(yes|external)/i) ? one('ENT-BOX') : undefined],
  ['SERVICE DOOR FOR ENTERTAINMENT', s => has(s, /coas|^\s*yes/i) ? one('SVC-DOOR', lead(s)) : undefined],
  ['TOILET DOOR', s => has(s, /coas/i) ? one('SVC-DOOR-TOILET', lead(s)) : undefined],
  ['SERVISE DOORS TUNNEL BOOT', s => has(s, /coas/i) ? one('SVC-DOOR', lead(s, 2)) : undefined],
  ['TOOL BOX', s => has(s, /^\s*gold/i) ? one('TOOLBOX-GOLD') : undefined],
  ['WHEEL SPATS', s => has(s, /^\s*flat/i) ? null : undefined],
  ['WATER TANK COVER', s => one('TANK-COVER', lead(s, 3))],
  ['JERRY CANS', s => +t(s).trim() > 0 ? one('JERRY-HOLDER', +t(s).trim()) : null],
  ['BUMPER BAR', s => has(s, /road\s*king/i) ? one('BUMPER-RK-3ARM') : undefined],
  ['PICNIC TABLE', () => one('PICNIC-DROPDOWN')],
  ['REAR SPOILER', s => has(s, /yes/i) ? one('SPOILER') : null],
  ['GAS BOTTLES', s => has(s, /9\s*kg/i) ? one('GAS-9KG', nx(s, 2)) : undefined],
  ['TRAILER JACK', s => has(s, /ko/i) ? one('JACK-KO') : undefined],
  ['BLACK JACK', s => has(s, /black\s*jack/i) ? one('JACK-BLACKJACK') : null],
  ['STONE GUARD', s => has(s, /yes/i) ? one('STONE-GUARD') : null],
  ['BIN INSTALLATION', s => has(s, /yes/i) ? one('BIN-KIT') : null],
  ['BIKE RACK', s => has(s, /yes|grip/i) ? one('BIKE-RACK-4') : null],
  ['STARLINK', s => has(s, /yes/i) ? one('STARLINK-KIT') : null],
  ['BBQ', s => has(s, /alfresco/i) ? one('BBQ-SWIFT-ALFRESCO') : has(s, /swift.*sink/i) ? one('BBQ-SWIFT-SINK') : undefined],
  ['SWITCHES', s => has(s, /sphere/i) ? one('SWITCH-SPHERE') : has(s, /black/i) ? one('SWITCH-BLACK') : has(s, /white/i) ? one('SWITCH-WHITE') : undefined],
  ['ANNEXE LIGHTS', s => has(s, /all\s*round/i) ? one('LIGHT-ANNEX') : undefined],
  ['TUNNEL BOOT LIGHT', s => has(s, /yes/i) ? one('LIGHT-TUNNEL') : null],
  ['READING LIGHTS', s => {
    const m = /\b(\d{1,2})\b/.exec(t(s));
    const q = m && +m[1] <= 12 ? +m[1] : 6;
    if (has(s, /chrome/i)) return one('LIGHT-READ-CHROME', q);
    if (has(s, /black/i)) return one('LIGHT-READ-BLACK', q);
    if (has(s, /white/i)) return one('LIGHT-READ-WHITE', q);
    return undefined;
  }],
  ['LED STRIP', () => one('LED-STRIP')],
  ['WATER TANK MONITOR', () => one('TANK-MONITOR')],
  ['REVERSE CAMERA', s => has(s, /saf(e)?ty\s*dave/i) ? one('CAM-SD-AHD') : has(s, /^\s*no\b|customer/i) ? null : undefined],
  ['RCD BOX', () => one('RCD-BOX')],
  ['TRAILER SAFE', () => one('BRAKEAWAY')],
  ['WHEEL BRAZE', () => one('WHEEL-BRACE')],
  ['STOVE SWITCH', () => one('SW-STOVE')],
  ['ISO SWITCH', () => one('ISO-SWITCH')],
  ['HWS SWITCH', () => one('SW-HWS')],
  ['CABLE COVER', s => one('CABLE-COVER', lead(s, 2))],
  ['PUMP SWITCH', () => one('SW-PUMP')],
  ['AC SWITCH', () => one('SW-AC')],
  ['12 PIN PLUG', () => one('PLUG-12PIN')],
  ['REAR TAIL LIGHT', s => one('TAIL-LIGHT', lead(s, 2))],
  ['SLIDE MARKERS', () => one('SIDE-MARKER')],
  ['REFLECTERS', () => one('REFLECTOR-SET')],
  ['LED INTERIOR LIGHT', () => one('LED-INT')],
  ['SLIMLINE REAR LED', () => one('LED-REAR-SLIM')],
  ['RADIO ANTENNA', () => one('RADIO-ANT')],
];

// Columns that describe the van rather than parts: kept as van information.
export const INFO_COLUMNS = new Set([
  'DATE', 'CHASSIS #', 'VAN SIZE & TYPE', 'EXPECTED DELIVERY DATE', 'CUSTOMER NAME', 'FLAT FLOOR', 'DEALER',
  'CUSTOMER REQUESTS', 'VIN NUMBER', 'ELECTRICAL EXTRA', 'PLUMBING EXTRA', 'ALLUMINIUM EXTRA', 'OPTIONAL', 'ATM',
  'AXLE WEIGHT', 'BALL WEIGHT', 'WHEEL NUT TORQUE', 'TYRE PRESSURE', 'TRANSPORT COMPANY', 'INVOICE', 'WARRANTY',
  'REPAIRED ITEMS', 'REPAIRER', 'REPAIR COST', 'REPAIR DATE',
  'STATUS', // added by this app's Excel export
]);

export const normHeader = h => String(h || '').replace(/\s+/g, ' ').trim().toUpperCase();

export function handlerFor(header) {
  const H = normHeader(header) + ' ';
  // Longest matching prefix wins ("TV BRACKET" before "TV", "AWNING PLATES" before "AWNING").
  let best = null;
  for (const [prefix, fn] of COLUMNS) {
    if (H.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, fn];
  }
  return best?.[1] || null;
}

// Every SKU a column can produce → that column, so items added from dealer orders show up
// under the right column of the plan.
export function skuColumns(headers) {
  const map = new Map();
  const probe = ['yes', '1', '2 x 110 Amp', '2 x 100 Amp', '2 x 135 AGM', '2 x 200 Amp', '3 x 230 Amp', '2 x 300 Amp', '2 x 460 Amp',
    '3 x 200', '8 x 225', '5 x 160', '100/80', '5000', '3000', 'Double', 'Electric', 'Single', 'black', 'white', 'gold',
    'chrome', 'sphere', 'stainless', 'Ceramic', 'Plastic', 'CS13F', 'CS11R', '220', '190', 'Bushman 225', 'pro', 'plus',
    'Front loader', 'Top loader', 'NCE', 'Camec', '23L', 'Kleenmaid', 'Swift', 'Fusion', "Google Smart 24'' + 32''",
    'AU Focus', 'HTP', 'NBC', 'White + Mirror', 'Concertina', 'Road King', 'CM XT Air DO45', 'CM XT DO35', 'ATX',
    'Honeycomb', 'Sandwich', 'Aussie traveller', 'LED 450', 'LED 700', 'Coast', 'Safety Dave', 'All round', 'KO',
    'Black Jack', 'Grip', 'alfresco', 'Swift sink', '2 x 105', '2 x 110', '1 x 60', 'telescopic', '9kg', 'Tuson', 'Reflex',
    'blue', 'XPS', 'gold', 'Roadking', 'White no drainer', 'pr8111'];
  for (const h of headers) {
    const fn = handlerFor(h);
    if (!fn) continue;
    const row = { get: () => '' };
    for (const p of probe) {
      let r; try { r = fn(p, row); } catch { r = null; }
      for (const x of r || []) if (x.sku && !map.has(x.sku)) map.set(x.sku, h);
    }
  }
  return map;
}
