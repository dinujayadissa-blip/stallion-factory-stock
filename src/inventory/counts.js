// Counts, blind and rack by rack: what was expected, checking a count, saving it (and parts bought for
// a van that the count did not find).
import { ID_LIST, all, get, ids, insert, logAlloc, run, writeTx } from '../db.js';
import { ACTIVE_VAN, COUNTABLE_ITEM, MAX_QTY, NOW_SQL, PRIORITY, httpError, q, vanRanks } from './shared.js';
import { allocateItem, trimReservations } from './allocation.js';
import { markFitted } from './fitted.js';

// Parts set aside and locked for vans (received for them), for each of these items: total and per van
// (vans in build order).
async function lockedFor(itemIds) {
  const out = new Map(itemIds.map(id => [id, { total: 0, vans: [] }]));
  for (const r of await all(`SELECT l.item_id, v.chassis, SUM(l.reserved_firm) AS q FROM van_lines l JOIN vans v ON v.id = l.van_id
                    WHERE l.item_id IN ${ID_LIST} AND ${ACTIVE_VAN} AND l.reserved_firm > 0 GROUP BY l.item_id, v.id ORDER BY ${PRIORITY}`, ids(itemIds))) {
    const o = out.get(r.item_id);
    o.total += r.q;
    o.vans.push({ chassis: r.chassis, qty: r.q });
  }
  return out;
}

// What a count covers: one rack / area, items with no rack yet, or a whole trade. Each item has one
// place, so it is counted in exactly one rack. Per-van parts are checked on their own list instead.
async function countScope(scope) {
  const s = String(scope || '');
  if (s === 'norack') return { where: 'i.area_id IS NULL', args: [], label: 'No rack yet' };
  let m = /^area:(\d+)$/.exec(s);
  if (m) {
    const a = await get('SELECT name FROM floor_areas WHERE id = ?', Number(m[1]));
    if (!a) throw httpError(404, 'That rack no longer exists — refresh');
    return { where: 'i.area_id = ?', args: [Number(m[1])], label: a.name };
  }
  m = /^trade:([a-z]+)$/.exec(s);
  if (m) return { where: 'i.trade = ?', args: [m[1]], label: `Trade: ${m[1]}` };
  throw httpError(400, 'Pick a rack, "No rack yet" or a trade');
}

// What can be counted: racks with how many items each.
export async function countChoices() {
  const racks = await all(`SELECT a.id, a.name, a.kind, COUNT(i.id) AS items FROM floor_areas a JOIN items i ON i.area_id = a.id AND ${COUNTABLE_ITEM}
                     GROUP BY a.id ORDER BY a.sort, a.name`);
  const norack = (await get(`SELECT COUNT(*) AS c FROM items i WHERE ${COUNTABLE_ITEM} AND i.area_id IS NULL`)).c;
  const trades = await all(`SELECT i.trade, COUNT(*) AS items FROM items i WHERE ${COUNTABLE_ITEM} AND i.trade <> '' GROUP BY i.trade ORDER BY i.trade`);
  const open = await all(`SELECT id, label, opened_at, opened_by FROM count_sessions WHERE closed_at = '' ORDER BY id DESC LIMIT 10`);
  return { racks, norack, trades, open };
}

// Start a count: the expected figures are written down now but not shown to the counter.
export async function openCount(scope, by = '') {
  return writeTx(async () => {
    const sc = await countScope(scope);
    const items = await all(`SELECT i.id, i.sku, i.name, i.unit, i.location, i.photo, i.on_hand FROM items i
                       WHERE ${COUNTABLE_ITEM} AND ${sc.where} ORDER BY i.location, i.name`, ...sc.args);
    if (!items.length) throw httpError(400, 'Nothing to count there');
    const expected = Object.fromEntries(items.map(i => [i.id, i.on_hand]));
    const lastMove = (await get('SELECT COALESCE(MAX(id), 0) AS m FROM movements')).m;
    const id = await insert('INSERT INTO count_sessions(scope, label, opened_by, last_move_id, expected) VALUES(?,?,?,?,?)',
      scope, sc.label, by, lastMove, JSON.stringify(expected));
    return { id, label: sc.label, items: items.map(({ on_hand, ...i }) => i) }; // no expected figure: a blind count
  });
}

async function countSession(id) {
  const s = await get('SELECT * FROM count_sessions WHERE id = ?', id);
  if (!s) throw httpError(404, 'That count no longer exists — start again');
  if (s.closed_at) throw httpError(409, 'This count was already saved');
  return { ...s, expected: JSON.parse(s.expected || '{}') };
}

// Big difference: more than 10 % or more than 5 units (any difference when nothing was expected).
const bigDiff = (expected, counted) => {
  const d = Math.abs(counted - expected);
  return d > 1e-9 && (d > 5 || d > Math.abs(expected) * 0.1);
};

// After the counts are typed: what the books said when the count started (expected), what they say
// now (now — only different if stock moved while counting), the count, and what needs a second look.
//
// Stock that moved while counting (a floor take, a delivery…) must not be counted twice, so for such a
// part the office says when the shelf was counted — `timing` {itemId: 'before' | 'after'}:
//   after  (the safe default): the count already shows the movements → books = counted
//          (change = counted − now)
//   before: the movements happened after the shelf was counted → books = counted + what moved since
//          (change = counted − expected)
// The "kept for vans" check runs on that resulting book figure: shortfall = locked − books (never
// less than 0). shortfall_before / shortfall_after / big_before / big_after let the screen show the
// right question for either answer without asking the server again.
export async function checkCount(id, counts = [], { timing = {} } = {}) {
  const s = await countSession(id);
  const seen = new Set();
  const out = [];
  // (a part in this count: its key is there even when the figure is null — JSON writes Infinity / NaN as null)
  const rows = counts.filter(c => c.qty !== '' && c.qty != null && Number.isFinite(Number(c.qty)) && Object.hasOwn(s.expected, String(Number(c.item_id))))
    .filter(c => !seen.has(Number(c.item_id)) && seen.add(Number(c.item_id)));
  if (!rows.length) return out;
  // Every counted part's figures, locks and movements since the count started, in three statements.
  const itemIds = rows.map(c => Number(c.item_id));
  const items = new Map((await all('SELECT id, sku, name, unit, on_hand FROM items WHERE id IN ' + ID_LIST, ids(itemIds))).map(i => [i.id, i]));
  const lockedOf = await lockedFor(itemIds);
  const movesOf = new Map(itemIds.map(id => [id, []]));
  for (const { item_id, ...m } of await all(`SELECT m.item_id, m.at, m.type, m.qty, m.worker, m.note, v.chassis FROM movements m LEFT JOIN vans v ON v.id = m.van_id
                         WHERE m.item_id IN ${ID_LIST} AND m.id > ? ORDER BY m.id`, ids(itemIds), s.last_move_id)) movesOf.get(item_id).push(m);
  for (const c of rows) {
      const itemId = Number(c.item_id), counted = Number(c.qty), expected = s.expected[itemId];
      const it = items.get(itemId);
      const now = it ? it.on_hand : expected;
      // A stock figure that is not a number (then or now): the count is the only figure there is, so it is
      // taken as it stands ("after"), and nothing is worked out from the old figure.
      const broken = !Number.isFinite(now) || !Number.isFinite(expected);
      const moved = broken ? 0 : now - expected;
      const locked = lockedOf.get(itemId);
      const moves = movesOf.get(itemId);
      const changed = !broken && (moves.length > 0 || Math.abs(moved) > 1e-9);
      const said = ['before', 'after'].includes(timing[itemId]) ? timing[itemId] : '';
      const when = changed ? said || 'after' : 'after';
      const bookFor = w => w === 'before' ? counted + moved : counted;
      const shortFor = w => Math.max(0, locked.total - bookFor(w));
      const book = bookFor(when);
      const shortfall = shortFor(when);
      out.push({ item_id: itemId, sku: it?.sku, name: it?.name, unit: it?.unit, expected, now, moved, counted, moves,
        changed, timing: changed ? said : 'after', // '' = moved while counting and not answered yet
        book, diff: book - now, diff_before: counted - expected, diff_after: counted - now,
        big: broken ? false : when === 'before' ? bigDiff(expected, counted) : bigDiff(now, counted), big_before: bigDiff(expected, counted), big_after: bigDiff(now, counted),
        locked: locked.total, lockedVans: locked.vans,
        shortfall, shortfall_before: shortFor('before'), shortfall_after: shortFor('after'), belowLocked: shortfall > 1e-9 });
  }
  return out;
}

// Save a count. counts: [{item_id, qty, reason, recounted}]
// timing: {itemId: 'before' | 'after'} — only needed for parts that moved while counting (see checkCount).
//   ackMoves (older screens): "I've seen the movements" without a per-part answer = 'after'.
// elsewhere: {itemId: 'yes' | 'no'} — only for parts where the books would hold less than is kept for vans.
// elsewhereQty: {itemId: n} — with 'yes': how many are kept elsewhere (default: the whole shortfall);
//   fewer than the shortfall = the rest are missing and go back to short.
// Nothing is saved (all or nothing) unless every question is answered, and no save may leave more set
// aside for vans than the books hold.
export async function saveCount(id, { counts = [], elsewhere = {}, elsewhereQty = {}, timing = {}, ackMoves = false, by = '' } = {}) {
  return writeTx(async () => {
    const s = await countSession(id);
    const when = { ...timing };
    if (ackMoves) for (const c of counts) if (!['before', 'after'].includes(when[c.item_id])) when[c.item_id] = 'after';
    const rows = await checkCount(id, counts, { timing: when });
    if (!rows.length) throw httpError(400, 'Type at least one count');
    const byId = new Map(counts.map(c => [Number(c.item_id), c]));
    const problems = [];
    const awayOf = new Map();
    for (const r of rows) {
      const c = byId.get(r.item_id);
      const vans = r.lockedVans.map(v => v.chassis).join(', ');
      if (r.counted < 0) { problems.push(`${r.name}: a count can't be below 0`); continue; }
      if (r.counted > MAX_QTY) { problems.push(`${r.name}: that's too many — at most ${MAX_QTY}`); continue; }
      if (r.changed && !r.timing) { problems.push(`${r.name}: stock moved while counting — was the shelf counted before or after those movements?`); continue; }
      if (r.book < -1e-9) problems.push(`${r.name}: counted before the movements would leave the books below 0 — check the count or pick "after"`);
      if (r.big && !String(c.reason || '').trim() && !c.recounted) problems.push(`${r.name}: recount or give a reason`);
      if (r.belowLocked) {
        const ans = elsewhere[r.item_id];
        if (!['yes', 'no'].includes(ans)) { problems.push(`${r.name}: ${q(r.shortfall)} of the parts kept for ${vans} are not on the shelf — are they kept somewhere else?`); continue; }
        let away = 0;
        if (ans === 'yes') {
          const typed = elsewhereQty[r.item_id];
          away = typed === '' || typed == null ? r.shortfall : Number(typed);
          if (!Number.isFinite(away) || away < 0) { problems.push(`${r.name}: how many are kept elsewhere?`); continue; }
          if (away > r.shortfall + 1e-9) { problems.push(`${r.name}: at most ${q(r.shortfall)} can be kept elsewhere (the shelf count covers the rest)`); continue; }
        }
        awayOf.set(r.item_id, away);
      }
    }
    if (problems.length) throw Object.assign(httpError(400, problems[0]), { problems });
    let saved = 0;
    for (const r of rows) {
      const c = byId.get(r.item_id);
      const away = awayOf.get(r.item_id) || 0;        // kept elsewhere for vans (in the van, kit area)
      const missing = r.belowLocked ? Math.max(0, r.shortfall - away) : 0;
      const target = r.book + away;                   // on the books = shelf (+ what moved after it was counted) + kept elsewhere
      const nowOnHand = (await get('SELECT on_hand FROM items WHERE id = ?', r.item_id)).on_hand;
      // A stock figure that is not a number (Infinity / NaN, from before quantities were checked) is replaced
      // by the count: adding to it would stay Infinity / NaN. The movement's qty is 0 (that change has no size).
      const broken = !Number.isFinite(nowOnHand);
      const delta = broken ? 0 : target - nowOnHand;  // against the books right now, so nothing is counted twice
      const vans = r.lockedVans.map(v => v.chassis).join(', ');
      const note = [`Counted ${q(r.counted)} ${r.unit || ''}`.trim()
          + (r.changed ? ` (${r.timing === 'before'
            ? `before ${r.moved < 0 ? `${q(-r.moved)} went out` : r.moved > 0 ? `${q(r.moved)} came in` : 'the movements'} while counting — books = ${q(r.book)}`
            : 'after the stock that moved while counting'})` : '')
          + (away ? ` + ${q(away)} kept elsewhere for ${vans}` : ''),
        missing > 1e-9 ? `${q(missing)} kept for ${vans} missing — back to short` : '',
        broken ? `stock figure was not a number (${nowOnHand}) — set to ${q(target)}` : '',
        String(c.reason || '').trim(), c.recounted ? 'recounted' : '', `(${s.label})`].filter(Boolean).join(' · ');
      if (broken) await run(`UPDATE items SET on_hand = ?, last_counted = ${NOW_SQL} WHERE id = ?`, target, r.item_id);
      else await run(`UPDATE items SET on_hand = on_hand + ?, last_counted = ${NOW_SQL} WHERE id = ?`, delta, r.item_id);
      await run(`INSERT INTO movements(item_id, qty, type, ref, note, worker) VALUES(?, ?, 'count', ?, ?, ?)`, r.item_id, delta, `Count #${id}`, note, by);
      saved++;
      // More found than the books said: the extra shelf stock goes to vans waiting for it. Stock added
      // by a "kept elsewhere" answer is never handed out — it only covers what is already kept for vans.
      if ((delta > 1e-9 || broken) && !away) await allocateItem(r.item_id, null, { reason: 'count', worker: by });
      // Less: shelf stock merely held for the vans built last goes back first (logged)…
      await trimReservations(r.item_id, { reason: 'count', worker: by });
      // …then parts received for vans that aren't on the shelf or anywhere else go back to short.
      if (missing > 1e-9) await cutLocked(r.item_id, { reason: 'count: missing', worker: by });
      const over = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN}`, r.item_id)).r
        - Math.max(0, (await get('SELECT on_hand FROM items WHERE id = ?', r.item_id)).on_hand);
      if (over > 1e-9) {
        const msg = `${r.name}: this count would leave ${q(over)} more set aside for ${vans || 'vans'} than the books hold — say whether they are kept somewhere else`;
        throw Object.assign(httpError(400, msg), { problems: [msg] }); // nothing is saved
      }
    }
    await run(`UPDATE count_sessions SET closed_at = ${NOW_SQL} WHERE id = ?`, id);
    return { saved };
  });
}

// The shelf has less than is locked for vans and the parts are missing: take the set-aside back from
// the vans built last until it fits, so those lines show as short again (logged).
async function cutLocked(itemId, { reason, worker = '' }) {
  const onHand = Math.max(0, (await get('SELECT on_hand FROM items WHERE id = ?', itemId)).on_hand);
  let over = (await get(`SELECT COALESCE(SUM(l.reserved),0) AS r FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN}`, itemId)).r - onHand;
  if (over <= 0) return;
  const ranks = await vanRanks();
  const lines = (await all(`SELECT l.* FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.item_id = ? AND ${ACTIVE_VAN} AND l.reserved > 0`, itemId))
    .sort((a, b) => (ranks.get(b.van_id) ?? 0) - (ranks.get(a.van_id) ?? 0) || b.id - a.id);
  for (const l of lines) {
    if (over <= 0) break;
    const give = Math.min(over, l.reserved);
    await run('UPDATE van_lines SET reserved = reserved - ?, reserved_firm = GREATEST(0, reserved_firm - ?::double precision) WHERE id = ?', give, give, l.id);
    await logAlloc(reason, { van_id: l.van_id, item_id: itemId, line_id: l.id, field: 'reserved', before: l.reserved, after: l.reserved - give, worker, note: 'not on the shelf when counted — back to short' });
    if (l.reserved_firm > 0) await stillToOrder(l, reason, worker, 'received for it but not found when counted');
    over -= give;
  }
}

// A line whose part had arrived (so the plan's order number was used up) and is now gone again —
// borrowed, or not found in a check: it is a plain "still to order" line, so it shows under Order now
// instead of "Check: already ordered?" (round 2, check-r1-2). Only lines nobody has answered for.
async function stillToOrder(l, reason, worker, why) {
  if (l.state || !String(l.po_ref || '').trim()) return;
  if (!(await run(`UPDATE van_lines SET state = 'not_ordered' WHERE id = ? AND state = ''`, l.id)).changes) return;
  await logAlloc(reason, { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'state', before: '', after: 'not_ordered', worker,
    note: `plan order ${String(l.po_ref).trim()} already used — ${why}, still to order` });
}

// Parts bought for one van (per-van items) that arrived but aren't fitted yet: checked one by one
// ("Is ST0389's fridge here?") instead of in the rack counts.
export async function boughtForVanList() {
  const rows = await all(`SELECT l.id, l.van_id, l.item_id, l.qty, l.reserved, l.issued, l.spec, l.plan_column, v.chassis, i.sku, i.name, i.unit, i.photo, i.location,
                      (SELECT MAX(a.at) FROM allocation_log a WHERE a.line_id = l.id AND a.reason = 'check: here') AS checked_at
                    FROM van_lines l JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id
                    WHERE ${ACTIVE_VAN} AND (i.kind = 'per-van' OR i.placeholder = 1 OR i.sku ILIKE 'PLAN-%') AND l.reserved > 0 AND l.issued < l.qty
                    ORDER BY ${PRIORITY}, i.name, l.id`);
  const vans = new Map();
  for (const r of rows) {
    if (!vans.has(r.van_id)) vans.set(r.van_id, { van_id: r.van_id, chassis: r.chassis, lines: [] });
    vans.get(r.van_id).lines.push(r);
  }
  return [...vans.values()];
}

// answer: 'here' | 'missing' | 'fitted'
export async function checkBoughtLine(lineId, answer, by = '') {
  return writeTx(async () => {
    const l = await get(`SELECT l.*, v.chassis FROM van_lines l JOIN vans v ON v.id = l.van_id WHERE l.id = ?`, lineId);
    if (!l) throw httpError(404, 'That part line no longer exists — refresh');
    if (answer === 'fitted') return markFitted(l.van_id, [l.id], by);
    if (answer === 'here') {
      await logAlloc('check: here', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'checked', before: '', after: q(l.reserved), worker: by, note: `${l.chassis}'s part is here` });
      return { ok: true };
    }
    if (answer !== 'missing') throw httpError(400, 'Answer Yes, No or Already fitted');
    if (!(l.reserved > 0)) return { ok: true };
    const it = await get('SELECT on_hand FROM items WHERE id = ?', l.item_id);
    const cut = Math.min(l.reserved, Math.max(0, it.on_hand));
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', cut, l.item_id);
    await run('UPDATE van_lines SET reserved = 0, reserved_firm = 0 WHERE id = ?', l.id);
    if (cut > 0) await run(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'count', ?, ?, ?, ?)`,
        l.item_id, -cut, l.van_id, l.chassis, `Not found when checked (bought for ${l.chassis}) — back to short`, by);
    await logAlloc('check: missing', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'reserved', before: l.reserved, after: 0, worker: by, note: `${l.chassis}'s part not found — back to short` });
    await stillToOrder(l, 'check: missing', by, 'bought for it but not found when checked');
    return { ok: true };
  });
}
