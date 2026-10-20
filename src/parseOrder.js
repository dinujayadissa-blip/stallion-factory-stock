// Parses the dealer's "New Caravan Purchase Agreement" PDF into a header + list of option fields.
//
// The form is a fixed two-column layout: option labels sit at x≈45, an optional weight note
// (e.g. "+40kg") at x≈200 and the chosen value at x≈312. Wrapped text continues on lines ~13pt
// below, while a new option starts ~28pt below, so we group by both column and vertical gap.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const SECTIONS = new Set(['CHASSIS', 'FLOOR PLAN', 'COLOURS AND MATERIALS', 'APPLIANCES', 'ELECTRICAL', 'PLUMBING', 'EXTRAS']);
const VALUE_X = 290;      // anything right of this is the value column
const NOTE_X = 180;       // between label and value: weight/price notes
const NEW_ROW_GAP = 20;   // vertical gap (pt) that starts a new option row

async function readPages(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.filter(i => i.str.trim()).map(i => ({ x: i.transform[4], y: i.transform[5], s: i.str.trim() })));
  }
  return pages;
}

// Group text items that share a baseline into lines, top to bottom.
function toLines(items) {
  const lines = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find(l => Math.abs(l.y - it.y) <= 2.5);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
  return lines;
}

const join = items => items.map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();

// Page 1 header: "ORDER DATE:" style labels with the value to their right on the same line.
function parseHeader(lines) {
  const h = {};
  const grab = (label, key) => {
    for (const l of lines) {
      const idx = l.items.findIndex(i => i.s.toUpperCase().startsWith(label));
      if (idx >= 0 && l.items[idx + 1]) { h[key] = l.items[idx + 1].s; return; }
    }
  };
  grab('ORDER DATE', 'orderDate');
  grab('CHASSIS NUMBER', 'chassis');
  grab('QUOTE NUMBER', 'quoteNo');
  grab('ETA DELIVERY', 'eta');
  // Customer name is the first left-column line under "PREPARED FOR".
  const pf = lines.findIndex(l => l.items.some(i => i.s === 'PREPARED FOR'));
  if (pf >= 0) {
    const next = lines.slice(pf + 1).find(l => l.items.some(i => i.x < 100));
    if (next) h.customer = next.items.filter(i => i.x < 100).map(i => i.s).join(' ');
  }
  // "CARAVAN DETAILS" / "CAR DETAILS" grid: label/value pairs in two column blocks.
  const pairs = [[40, 140, 300], [320, 420, 600]];
  for (const l of lines) {
    if (l.y < 280 || l.y > 500) continue;
    for (const [lx, vx, end] of pairs) {
      const lab = l.items.filter(i => i.x >= lx && i.x < vx - 5);
      const val = l.items.filter(i => i.x >= vx - 5 && i.x < end);
      if (lab.length && val.length) h[join(lab).toLowerCase()] = join(val);
    }
  }
  return h;
}

export async function parseOrderPdf(buffer) {
  const pages = await readPages(buffer);
  const fields = [];
  let header = {};
  let section = 'GENERAL';
  let current = null;

  pages.forEach((items, pi) => {
    const lines = toLines(items);
    if (pi === 0) header = parseHeader(lines);
    // On page 1 the option table starts at the "CHASSIS" section heading.
    let started = pi > 0;
    current = null; // never continue a row across pages
    for (const line of lines) {
      const text = join(line.items);
      if (/^Page: \d+ of \d+$/.test(text)) continue;
      if (/^Chassis Number\b/i.test(text) && line.y > 780) continue; // repeating page header
      if (line.items.length === 1 && line.items[0].x < 42 && SECTIONS.has(text.toUpperCase())) {
        section = text.toUpperCase();
        started = true;
        current = null;
        continue;
      }
      if (!started) continue;

      const label = join(line.items.filter(i => i.x < NOTE_X));
      const note = join(line.items.filter(i => i.x >= NOTE_X && i.x < VALUE_X));
      const value = join(line.items.filter(i => i.x >= VALUE_X));
      const continues = current && current.lastY - line.y < NEW_ROW_GAP;

      if (continues) {
        if (label) current.label += ' ' + label;
        if (value) current.value = (current.value + ' ' + value).trim();
        if (note) current.note = (current.note + ' ' + note).trim();
        current.lastY = line.y;
      } else if (label) {
        current = { section, label, note, value, lastY: line.y };
        fields.push(current);
      }
    }
  });

  const clean = fields.map(({ lastY, ...f }) => ({
    ...f,
    label: f.label.replace(/\s+/g, ' ').replace(/[,:]+$/, '').trim(),
  }));

  // Caravan details not repeated in the option table (MODEL / SIZE already are) go in as fields
  // too, so rules can use them.
  const details = [['atm', 'ATM'], ['tare', 'TARE'], ['colour', 'VAN COLOUR'], ['vehicle', 'TOW VEHICLE']]
    .filter(([k]) => header[k])
    .map(([k, label]) => ({ section: 'CARAVAN DETAILS', label, note: '', value: header[k] }));
  clean.unshift(...details);

  const chassis = (header.chassis || '').toUpperCase();
  const fp = clean.find(f => f.label.toUpperCase() === 'FLOOR PLAN');
  return {
    header: {
      chassis,
      customer: header.customer || '',
      orderDate: toIsoDate(header.orderDate),
      eta: toIsoDate(header.eta),
      quoteNo: header.quoteNo || '',
      model: header.model || '',
      length: header.length || '',
      colour: header.colour || '',
      atm: header.atm || '',
      floorPlan: fp?.value || '',
    },
    fields: clean,
  };
}

// Dealer dates are d/m/yyyy.
export function toIsoDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s || '').trim());
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
