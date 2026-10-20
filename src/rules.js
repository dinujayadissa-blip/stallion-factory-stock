// Turns a parsed dealer order into a parts list using the rules table.
//
// Condition syntax (one per line, all must be true):
//   LABEL ~ regex     the option's value matches regex (case-insensitive)
//   LABEL !~ regex    the option's value does not match (or the option is missing)
//   LABEL ?           the option is filled in and isn't "No" / "None" / "Remove" / "0"
//   *                 always — a standard part on every van
// LABEL matches an order option exactly, else the option that starts with it, else one that
// contains it ("SOLAR PANELS" finds "SOLAR PANELS 9 if possible…").
//
// Quantity is a number or a small formula using values from the order:
//   n        the "N x" multiplier in the first condition's value ("3 X 200 watt" → 3), else a
//            leading count ("2 white" → 2), default 1
//   num      the first number in that value ("2" → 2), default 0
//   sumx     total of every "N x" in the value ("1x … and 2x …" → 3), else a leading count, default 1
//   n[LABEL] / num[LABEL] / sumx[LABEL]   the same, read from another option
// e.g.  n[FRESH WATER TANKS] + n[GREY WATER TANK]

const norm = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

const NO_RE = /^\s*(no\b|none\b|nil\b|n\/a\b|remove\b|not required\b|0\s*$|-\s*$|x\s*$)/i;
export const isSet = v => !!String(v || '').trim() && !NO_RE.test(String(v));
// Looser tests for showing a line to people: "Remove large bedroom hatch" or "NO OVEN replaced with
// 2 drawers" never orders a part (isSet), but it's still a request someone has to act on.
// hasText: anything but a bare "No" (part descriptions, e.g. the furniture order).
// asksForWork: for Check by hand, where a plain "no gas bottles" would only be noise.
const hasText = v => { const s = String(v || '').trim(); return !!s && !/^(no|none|nil|n\/a|not required|0|-|x)\s*[?.!]*$/i.test(s); };
const ASKS_RE = /^\s*remove\b|\b(but|replac\w*|instead|with|as per|drawings?|e-?mails?|photos?|chang\w*|swap\w*|mov\w*|add\w*|extra)\b/i;
const asksForWork = v => isSet(v) || ASKS_RE.test(String(v || ''));

export function findFields(fields, label) {
  const L = norm(label);
  let hit = fields.filter(f => norm(f.label) === L);
  if (!hit.length) hit = fields.filter(f => norm(f.label).startsWith(L));
  if (!hit.length) hit = fields.filter(f => norm(f.label).includes(L));
  return hit;
}

export function parseConditions(text) {
  return String(text || '')
    .split(/\r?\n|;/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => {
      if (line === '*') return { always: true, raw: line };
      const m = /^(.+?)\s*(!~|~|\?)\s*(.*)$/.exec(line);
      if (!m) throw new Error(`Can't read condition "${line}" — expected LABEL ~ text, LABEL !~ text or LABEL ?`);
      const [, label, op, pattern] = m;
      let re = null;
      if (op !== '?') {
        try { re = new RegExp(pattern.trim(), 'i'); } catch { throw new Error(`Bad pattern in "${line}"`); }
      }
      return { label: label.trim(), op, re, raw: line };
    });
}

const nx = v => [...String(v || '').matchAll(/(?:^|[\s(\-])(\d{1,2})\s*x(?=[\s\d]|$)/gi)].map(m => +m[1]);
// "2 white" (no "x") still means 2 — but not "12 volt", "200W", "9kg" and the like.
const lead = v => { const m = /^\s*(\d{1,2})(?![\d.,/"']|\s*(v|volts?|w|watts?|mm|kg|amps?|a|ah|l|lt|litres?|liters?|kw|inch(es)?)\b)/i.exec(String(v || '')); return m ? +m[1] : null; };
const metric = {
  n: v => nx(v)[0] ?? lead(v) ?? 1,
  num: v => { const m = /\d+(\.\d+)?/.exec(String(v || '')); return m ? +m[0] : 0; },
  sumx: v => { const a = nx(v); return a.length ? a.reduce((s, x) => s + x, 0) : lead(v) ?? 1; },
};

function evalQty(expr, firstValue, fields, usedFields) {
  let e = String(expr || '1').trim();
  e = e.replace(/\b(n|num|sumx)\[([^\]]+)\]/gi, (_, fn, label) => {
    const f = findFields(fields, label)[0];
    if (f) usedFields.add(f);
    return String(metric[fn.toLowerCase()](f?.value));
  });
  e = e.replace(/\b(n|num|sumx)\b/gi, (_, fn) => String(metric[fn.toLowerCase()](firstValue)));
  if (!/^[\d.\s+\-*/()]+$/.test(e)) throw new Error(`Quantity "${expr}" isn't a valid formula`);
  const v = Function(`"use strict"; return (${e});`)();
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// Returns { fired, used } for one rule against one order.
export function testRule(rule, fields) {
  const conds = parseConditions(rule.conditions);
  const used = new Set();
  const pos = new Set();   // options a positive condition matched — these describe the part
  let firstValue;
  for (const c of conds) {
    if (c.always) continue;
    const hits = findFields(fields, c.label);
    let ok;
    if (c.op === '?') {
      const f = hits.find(h => isSet(h.value));
      ok = !!f;
      if (f) { used.add(f); pos.add(f); firstValue ??= f.value; }
    } else if (c.op === '~') {
      const f = hits.find(h => c.re.test(h.value));
      ok = !!f;
      if (f) { used.add(f); pos.add(f); firstValue ??= f.value; }
    } else {
      ok = !hits.some(h => c.re.test(h.value));
      // a negative condition still means we looked at the option
      hits.forEach(h => used.add(h));
    }
    if (!ok) return { fired: false };
  }
  return { fired: true, used, pos, firstValue };
}

/**
 * @param fields  [{section,label,value,note}]
 * @param rules   rows from the rules table (active only)
 * @param ignore  regex strings for option labels that never need parts
 * @returns { lines: [{item_id, qty, spec, rule_id, rules:[names]}], review: [field], errors: [] }
 */
export function buildPartsList(fields, rules, ignore = []) {
  const byItem = new Map();
  const consumed = new Set();
  const errors = [];

  for (const rule of rules) {
    let res;
    try { res = testRule(rule, fields); } catch (e) { errors.push({ rule_id: rule.id, error: e.message }); continue; }
    if (!res.fired) continue;

    let qty;
    try { qty = evalQty(rule.qty, res.firstValue, fields, res.used); } catch (e) { errors.push({ rule_id: rule.id, error: e.message }); continue; }

    const specFields = String(rule.spec_fields || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean)
      .flatMap(l => findFields(fields, l).slice(0, 1));
    // A rule that works out 0 (e.g. "Yes" where a count was expected) leaves its options in
    // Check by hand, so nothing silently goes missing.
    if (qty <= 0) continue;
    specFields.forEach(f => res.used.add(f));
    res.used.forEach(f => consumed.add(f));

    const condFields = [...res.pos].filter(f => !specFields.includes(f) && hasText(f.value));
    const spec = [
      ...condFields.map(f => f.value),
      ...specFields.filter(f => hasText(f.value)).map(f => `${titleCase(f.label)}: ${f.value}`),
    ].join(' / ');

    const line = byItem.get(rule.item_id);
    if (line) {
      line.qty += qty;
      if (spec && !line.spec.includes(spec)) line.spec = line.spec ? `${line.spec}; ${spec}` : spec;
      line.rules.push(rule.name);
    } else {
      byItem.set(rule.item_id, { item_id: rule.item_id, qty, spec, rule_id: rule.id, rules: [rule.name] });
    }
  }

  const ignoreRes = ignore.map(s => { try { return new RegExp(s, 'i'); } catch { return null; } }).filter(Boolean);
  const review = fields.filter(f =>
    !consumed.has(f) && asksForWork(f.value) &&
    !ignoreRes.some(re => re.test(f.label.trim()) || re.test(`section:${f.section}`)));

  return { lines: [...byItem.values()], review, errors };
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
