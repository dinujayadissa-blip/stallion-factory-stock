// Trades on the floor, and which trade each part / reminder belongs to. The guesses below fill in
// items that have no trade yet; the office can change any item's trade on the Stock page.
import { all, run } from './db.js';

export const TRADES = {
  electrician: { label: 'Electrician', icon: '⚡' },
  builder: { label: 'Builder', icon: '🔨' },
  cladding: { label: 'Aluminium & cladding', icon: '🧱' },
  plumber: { label: 'Plumber', icon: '🚿' },
  finisher: { label: 'Finisher', icon: '✨' },
};

// First match wins. Tested against "SKU name plan-column" (items) or the order line (reminders).
// The first few are specific cases that would otherwise be caught by a broader word further down
// (an LED skylight is fitted by cladding, an Apex fibreglass shower by the plumber, …).
const KEYWORDS = [
  ['cladding', /alicom|skylight|hatch|window|servi[cs]e door|toilet door|checker|trilock|entrance door|main door|stone guard|spoiler/i],
  ['builder', /\bbin\b/i],
  ['electrician', /switch/i],
  ['finisher', /bath ?room kit|bathkit|barthroom|towel/i],
  ['plumber', /apex|toilet|tapware|\btaps?\b|water pump|\bpumps?\b/i],
  ['electrician', /illuminat|\bled\b|light|lamp|camera|monitor|stereo|speaker|\btv\b|antenna|aerial|radio|solar|batter|inverter|charger|mppt|dc-?dc|cerbo|bmv|shunt|anderson|switch|power ?point|usb|socket|access point|pigeon|rcd|\biso\b|12.?pin|plug|cable|\besc\b|tuson|starlink|\bfans?\b|aircon|air ?con|freshjet|htp|dust|heater|heating|battery protect|multi ?control|breakaway|brake|trailer safe|theft|alarm|wiring/i],
  ['finisher', /grab|handle|mattress|bolster|\btik\b|cushion|starter kit|table leg|lounge|upholster|bath ?room kit|barthroom|bathkit|towel|mirror|shower (screen|door)|screen|decal|badge|curtain|blind|pocket/i],
  ['cladding', /clad|alicom|checker|mould|capping|spoiler|anti-?flap|awning|window|hatch|skylight|serv[is]i?se? door|trilock|entrance door|main door|tool ?box|stone guard|jerry|bumper|bike rack|\bsteps?\b|wheel spat|roof baw|l ?& ?s|fibre ?glass|fiber ?glass|\broof\b|trims?\b|sail track|rear (bar )?box|cover|fence/i],
  ['plumber', /toilet|shower|sink|basin|\btaps?\b|tapware|\btanks?\b|pump|\bhws\b|hot water|\bgas\b|bayonet|water|quick fill|\bsog\b|drain/i],
  ['builder', /furniture|wall|door|drawer|benchtop|splashback|vinyl|floor|insulation|pressing|\bbed\b|bunk|frame|pantry|partition|chassis|suspension|hitch|tyre|wheel|jockey|jack|microwave|fridge|washing|dishwasher|rangehood|cooker|oven|bbq|\bbin\b|concertina|sliding|picnic|entertainment|kitchen|cupboard|wardrobe/i],
];
const BY_CATEGORY = {
  'Electrical – Power': 'electrician', 'Lighting & Switches': 'electrician', Entertainment: 'electrician',
  'Plumbing & Gas': 'plumber', 'Bathroom & Kitchen': 'plumber',
  'Body & Aluminium': 'cladding', 'Doors, Windows & Awning': 'cladding',
  'Furniture & Interior': 'builder', 'Chassis & Running Gear': 'builder', Appliances: 'builder', 'As per plan': 'builder',
};
const BY_SECTION = { ELECTRICAL: 'electrician', PLUMBING: 'plumber', APPLIANCES: 'builder', CHASSIS: 'cladding', 'FLOOR PLAN': 'builder', 'COLOURS AND MATERIALS': 'builder' };

const byKeywords = text => KEYWORDS.find(([, re]) => re.test(text))?.[0] || '';

export function guessItemTrade(item) {
  return byKeywords(`${item.sku} ${item.name} ${item.plan_column || ''}`) || BY_CATEGORY[item.category] || 'builder';
}

// An order line → trade: the label says most ("Shower door"), then the text, then the section.
export function guessLineTrade(section, label, value) {
  return byKeywords(label || '') || byKeywords(value || '') || BY_SECTION[String(section || '').toUpperCase()] || '';
}

// Give every item without a trade its best guess (startup, after imports, new items).
export function assignMissingTrades() {
  const items = all(`SELECT id, sku, name, category, plan_column FROM items WHERE trade = ''`);
  for (const i of items) run('UPDATE items SET trade = ? WHERE id = ?', guessItemTrade(i), i.id);
  return items.length;
}

export const isTrade = t => Object.hasOwn(TRADES, t);
