// Builds a SYNTHETIC 3-page "dealer order" PDF (no real names or data) laid out the way
// src/parseOrder.js expects: header labels at the top of page 1, a details grid, then option rows with
// the label at x=45, an optional note at x=200 and the value at x=312, 24pt apart (wrapped text 13pt apart).
// Usage: node make-test-pdf.mjs   (writes sample-order.pdf next to this file)
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const W = 595, H = 842, SIZE = 9;

const pages = [doc.addPage([W, H]), doc.addPage([W, H]), doc.addPage([W, H])];
const text = (p, s, x, y, f = font) => p.drawText(s, { x, y, size: SIZE, font: f });

pages.forEach((p, i) => {
  text(p, `Chassis Number TEST-0001`, 40, 820);       // repeating page header (ignored by the parser, y > 780)
  text(p, `Page: ${i + 1} of 3`, 480, 20);
});

// ---- page 1 header ----
const p1 = pages[0];
text(p1, 'ORDER DATE:', 40, 760, bold);        text(p1, '12/03/2026', 150, 760);
text(p1, 'CHASSIS NUMBER:', 40, 745, bold);    text(p1, 'tst0001', 150, 745);
text(p1, 'QUOTE NUMBER:', 40, 730, bold);      text(p1, 'Q-TEST-001', 150, 730);
text(p1, 'ETA DELIVERY:', 40, 715, bold);      text(p1, '30/04/2026', 150, 715);
text(p1, 'PREPARED FOR', 40, 680, bold);
text(p1, 'Test Customer', 40, 665);
text(p1, 'Test Dealer', 40, 650);

// details grid (y between 280 and 500): label x=40 value x=140, label x=320 value x=420
const grid = [
  [['MODEL', 'Test Model 21'], ['LENGTH', '21 ft']],
  [['SIZE', '6400 x 2500'], ['ATM', '3200 kg']],
  [['TARE', '2450 kg'], ['COLOUR', 'Test White']],
  [['FLOOR PLAN', 'Test Layout A'], ['TOW VEHICLE', 'Test Ute']],
];
grid.forEach(([l, r], i) => {
  const y = 450 - i * 18;
  text(p1, l[0], 40, y, bold);  text(p1, l[1], 140, y);
  text(p1, r[0], 320, y, bold); text(p1, r[1], 420, y);
});

// ---- option rows ----
// [label, note, value, wrapped continuation of value?]
const sections = [
  ['CHASSIS', [
    ['Chassis type', '', 'Test Galvanised'], ['Suspension', '+40kg', 'Test Independent'],
    ['Brakes', '', 'Electric 12 inch'], ['Tyres', '', 'Test 16 inch alloy'], ['Hitch', '', 'Test Coupling', 'with safety chain'],
  ], 1, 270],
  ['FLOOR PLAN', [
    ['Floor plan', '', 'Test Layout A'], ['Bed', '', 'Test Queen island'], ['Dinette', '+15kg', 'Test Side dinette'],
    ['Wardrobe', '', 'Test Full height'], ['Door side', '', 'Test Left hand'], ['Bunks', '', 'None'],
    ['Flooring', '', 'Test Vinyl plank'],
  ], 2],
  ['COLOURS AND MATERIALS', [
    ['Exterior colour', '', 'Test White'], ['Cladding', '', 'Test Aluminium'], ['Cabinetry', '', 'Test Oak look'],
    ['Benchtop', '', 'Test Laminate'], ['Upholstery', '', 'Test Grey', 'two tone'], ['Curtains', '', 'Test Charcoal'],
    ['Window tint', '', 'Test Standard'],
  ], 2],
  ['APPLIANCES', [
    ['Fridge', '+25kg', 'Test 190L 3-way'], ['Cooktop', '', 'Test 3 burner gas'], ['Microwave', '', 'Test 25L'],
    ['Air conditioner', '+35kg', 'Test Roof mount 3.5kW'], ['Hot water', '', 'Test 20L gas/electric'], ['Awning', '', 'Test 4m roll out'],
    ['TV', '', 'Test 22 inch'], ['Range hood', '', 'Test Slimline'],
  ], 2],
  ['ELECTRICAL', [
    ['Battery', '', 'Test 200Ah lithium'], ['Inverter', '', 'Test 1500W'], ['Solar', '+12kg', 'Test 2 x 150W'],
    ['Lighting', '', 'Test LED throughout', 'with dimmers'], ['Power points', '', 'Test 8 x 240V'], ['USB', '', 'Test 6 ports'],
    ['Antenna', '', 'Test Digital'], ['Reverse camera', '', 'Test Wired'],
  ], 3],
  ['PLUMBING', [
    ['Fresh water', '', 'Test 2 x 95L'], ['Grey water', '', 'Test 60L'], ['Shower', '', 'Test Separate'],
    ['Toilet', '', 'Test Cassette'], ['Tap set', '', 'Test Mixer'], ['Outdoor shower', '', 'Test Yes'],
    ['Water filter', '', 'Test Inline'], ['Pump', '', 'Test 12V'],
  ], 3],
  ['EXTRAS', [
    ['Bike rack', '', 'Test Rear mount'], ['Spare wheel', '', 'Test Matching'], ['Stone guard', '', 'Test Yes'],
    ['Security screen', '', 'Test Door only'], ['Gas bottles', '', 'Test 2 x 4kg'], ['Annexe light', '', 'Test LED strip'],
    ['Delivery', '', 'Test Pickup', 'from factory'], ['Warranty', '', 'Test Standard'],
  ], 3],
];

// Lay sections out, moving to the next page when a section would run off the bottom.
let pi = 0, y = 270;
function startPage(n) { pi = n - 1; y = pi === 0 ? 270 : 770; }
startPage(1);
for (const [name, rows, pageNo] of sections) {
  if (pageNo !== pi + 1) startPage(pageNo);
  const p = pages[pi];
  text(p, name, 40, y, bold);
  y -= 24;
  for (const [label, note, value, more] of rows) {
    if (y < 60) { startPage(Math.min(pi + 2, 3)); text(pages[pi], name, 40, y, bold); y -= 24; }
    const pg = pages[pi];
    text(pg, label, 45, y);
    if (note) text(pg, note, 200, y);
    text(pg, value, 312, y);
    if (more) text(pg, more, 312, y - 13);
    y -= more ? 37 : 24;
  }
  y -= 10;
}

writeFileSync(new URL('./sample-order.pdf', import.meta.url), await doc.save());
console.log('wrote sample-order.pdf');
