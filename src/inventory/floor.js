// The floor screen (workers): taking parts for a van (borrowing from another van when needed), extras,
// undo, where parts are, and each van's list.
import { all, get, ids, insert, logAlloc, run, writeTx } from '../db.js';
import { PO_IS_OPEN, PO_OPEN, today } from '../lineState.js';
import { ACTIVE_VAN, AGE_SECS, PRIORITY, TODAY_SQL, checkQty, httpError, lineStatus, q, vanRanks } from './shared.js';
import { allocateItem, trimReservations } from './allocation.js';
import { addLine } from './vans.js';
import { bookPoLine } from './stock.js';
import { lineCover } from './shortages.js';

// A worker takes parts off the shelf for a van. Whatever the system thought, the parts are in their
// hand, so: use what's set aside for this van, then free stock, then (shelf stock only) stock set
// aside for vans due later; if the system still showed too few, the count was wrong and is
// corrected (and logged). A per-van part is never taken from another van: if the system showed
// none, it has arrived for this van and is ticked off this van's order.
// `extraLine`: the line was just added on the floor, so Undo removes it again.
// `seenIssued` (phone only): how many the phone showed as already taken. If that changed, this take
// was already saved (reply lost on bad Wi-Fi) or a workmate took it, so it isn't done twice.
// `acceptBorrow`: the only parts left are set aside for another van (received for it, or bought
// for it). Then the worker is asked first (an error with `confirm` comes back): true = take that
// van's part (it goes straight onto "Order now" for that van), false = no, these are a new delivery.
// The take is never refused because a part is locked: the books follow the shelf.
export async function takeForVan(lineId, qty, by = '', { extraLine = false, seenIssued, acceptBorrow } = {}) {
  return writeTx(async () => {
    const l = await get(`SELECT l.*, v.chassis, v.status AS van_status, v.area_id AS van_area, i.name, i.kind FROM van_lines l
                   JOIN vans v ON v.id = l.van_id JOIN items i ON i.id = l.item_id WHERE l.id = ?`, lineId);
    if (!l) throw httpError(404, 'Part not found');
    if (!['planned', 'in_production'].includes(l.van_status)) throw httpError(400, `${l.chassis} is finished — parts can't be taken for it`);
    if (seenIssued != null && Number(seenIssued) !== l.issued) throw httpError(409, 'Someone already took some of this. Check the list.');
    const take = qty == null ? l.qty - l.issued : Number(qty);
    checkQty(take, 'How many did you take?');
    // What this take changes, so Undo can put every bit of it back.
    const rec = { line: lineId, own: Math.min(l.reserved, take), ownFirm: l.reserved_firm, corr: 0, corrMv: null, borrowed: [], po: [], reopen: [], extraLine: !!extraLine };
    // Took more than the list said: the list grows to match.
    if (l.issued + take > l.qty) {
      rec.oldQty = l.qty;
      await run('UPDATE van_lines SET qty = ? WHERE id = ?', l.issued + take, lineId);
    }

    let need = Math.max(0, take - l.reserved);
    const donors = []; // chassis this take borrowed locked / bought-for-van parts from
    if (need > 0) {
      const { on_hand } = await get('SELECT on_hand FROM items WHERE id = ?', l.item_id);
      const reservedAll = (await get(`SELECT COALESCE(SUM(x.reserved),0) AS r FROM van_lines x JOIN vans v ON v.id = x.van_id
                               WHERE x.item_id = ? AND ${ACTIVE_VAN}`, l.item_id)).r;
      const free = Math.max(0, on_hand - reservedAll);
      const fromFree = Math.min(free, need);
      need -= fromFree;
      let borrowed = 0;
      const ranks = await vanRanks();
      const myRank = ranks.get(l.van_id) ?? Infinity;
      const others = async () => (await all(`SELECT x.id, x.van_id, x.reserved, x.reserved_firm, x.urgent, x.state, x.po_ref, v.chassis FROM van_lines x JOIN vans v ON v.id = x.van_id
                                WHERE x.item_id = ? AND x.van_id <> ? AND x.reserved > 0 AND ${ACTIVE_VAN}`, l.item_id, l.van_id))
        .sort((a, b) => (ranks.get(b.van_id) ?? 0) - (ranks.get(a.van_id) ?? 0) || b.id - a.id); // built last first
      const borrow = async (o, b, firmCut, urgent) => {
        await run('UPDATE van_lines SET reserved = reserved - ?, reserved_firm = GREATEST(0, reserved_firm - ?::double precision), urgent = CASE WHEN ?::integer = 1 THEN 1 ELSE urgent END WHERE id = ?',
            b, firmCut, urgent ? 1 : 0, o.id);
        // The donor's plan order number was used up when its part arrived: it is now a plain "still to
        // order" line (not "Check: already ordered?"), so it shows under Order now. Undo puts '' back.
        const toNotOrdered = urgent && !o.state && String(o.po_ref || '').trim() !== '';
        if (toNotOrdered) {
          await run(`UPDATE van_lines SET state = 'not_ordered' WHERE id = ? AND state = ''`, o.id);
          await logAlloc('borrow', { van_id: o.van_id, item_id: l.item_id, line_id: o.id, field: 'state', before: '', after: 'not_ordered', worker: by,
            note: `plan order ${String(o.po_ref).trim()} already used — part borrowed for ${l.chassis}, still to order for ${o.chassis}` });
          o.state = 'not_ordered';
        }
        rec.borrowed.push([o.id, b, firmCut, o.urgent, toNotOrdered ? '' : null]);
        await logAlloc('borrow', { van_id: o.van_id, item_id: l.item_id, line_id: o.id, field: 'reserved', before: o.reserved, after: o.reserved - b, worker: by,
          note: `borrowed from ${o.chassis} by ${by || 'a worker'} for ${l.chassis}${urgent ? ' — re-order for ' + o.chassis : ''}` });
        need -= b; borrowed += b;
      };
      // 1. Shelf stock merely held for vans built after this one (not received for them): they'll be
      //    supplied again by orders. Per-van parts are never handed on this way.
      if (need > 0 && l.kind === 'stock') {
        for (const o of await others()) {
          if (need <= 0) break;
          if ((ranks.get(o.van_id) ?? Infinity) <= myRank) continue;
          const flex = Math.max(0, o.reserved - o.reserved_firm);
          if (flex > 0) await borrow(o, Math.min(flex, need), 0, false);
        }
      }
      // 2. What's left is another van's own part (received or bought for it). The worker has it in
      //    their hand, so the books follow — but only after they've been told whose it is.
      if (need > 0) {
        const left = (await others()).filter(o => o.reserved > 0);
        const avail = left.reduce((s, o) => s + o.reserved, 0);
        if (avail > 0 && acceptBorrow == null) {
          // The vans it would actually come from (built last first), just enough to cover the take.
          const from = [];
          let cover = need;
          for (const o of left) {
            if (cover <= 0) break;
            if (!from.includes(o.chassis)) from.push(o.chassis);
            cover -= o.reserved;
          }
          throw Object.assign(httpError(409, `This is ${from[0]}'s – it will be re-ordered for them`), {
            confirm: { borrow: true, from, qty: Math.min(avail, need), message: `This is ${from.join(' / ')}'s – it will be re-ordered for them` },
          });
        }
        if (acceptBorrow === true) {
          for (const o of left) {
            if (need <= 0) break;
            const b = Math.min(o.reserved, need);
            const firmCut = Math.max(0, b - Math.max(0, o.reserved - o.reserved_firm));
            await borrow(o, b, firmCut, true);
            if (!donors.includes(o.chassis)) donors.push(o.chassis);
          }
        }
      }
      await run('UPDATE van_lines SET reserved = reserved + ? WHERE id = ?', fromFree + borrowed, lineId);
      if (need > 0) {
        let ref = l.chassis;
        let note = 'Taken from the shelf but the system showed none — count corrected';
        if (l.kind !== 'stock') {
          // It's in the worker's hand, so it has arrived for this van: tick it off this van's order.
          const pos = [];
          let left = need;
          for (const pl of await all(`SELECT pl.*, p.po_no FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                                WHERE ${PO_IS_OPEN} AND pl.van_id = ? AND pl.item_id = ?
                                ORDER BY pl.id`, l.van_id, l.item_id)) {
            if (left <= 0) break;
            const q = Math.min(left, pl.qty - pl.received - pl.closed);
            if (await bookPoLine(pl, q)) rec.reopen.push(pl.po_id);
            rec.po.push([pl.id, q]);
            left -= q;
            if (!pos.includes(pl.po_no)) pos.push(pl.po_no);
          }
          if (pos.length) ref = `PO ${pos.join(', ')}`;
          note = `Arrived for ${l.chassis} (booked on the floor)`;
        }
        await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', need, l.item_id);
        await run('UPDATE van_lines SET reserved = reserved + ? WHERE id = ?', need, lineId);
        const cm = await insert(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker) VALUES(?, ?, 'adjust', ?, ?, ?, ?)`,
                       l.item_id, need, l.van_id, ref, note, by);
        rec.corr = need;
        rec.corrMv = cm;
      }
    }
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', take, l.item_id);
    await run('UPDATE van_lines SET issued = issued + ?, reserved = GREATEST(0, reserved - ?::double precision) WHERE id = ?', take, take, lineId);
    const note = donors.length ? `borrowed from ${donors.join(', ')} by ${by || 'a worker'}` : '';
    // Follow-up round 1 (chk-r3-2): this take starts a planned van (it becomes "in production", moves up
    // the build order and gets first call on shelf stock). Noted in the undo record — with where the van
    // stood and the history mark — so an Undo / Put back can put it back to planned if nothing else
    // happened to it since. Takes saved before this have no note and Undo leaves the status as it is.
    if (l.van_status === 'planned') {
      rec.startedVan = { area: l.van_area ?? null, logMark: (await get('SELECT COALESCE(MAX(id), 0) AS n FROM allocation_log')).n };
    }
    const mv = await insert(`INSERT INTO movements(item_id, qty, type, van_id, ref, note, worker, undo) VALUES(?, ?, 'issue', ?, ?, ?, ?, ?)`,
                   l.item_id, -take, l.van_id, l.chassis, note, by, JSON.stringify(rec));
    // Set-aside history for this van's line: what the take used up (and where it came from).
    const after = await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', lineId);
    let lentBy = donors;
    if (rec.borrowed.length && !donors.length) {
      lentBy = [];
      for (const [id] of rec.borrowed) lentBy.push((await get('SELECT v.chassis FROM van_lines x JOIN vans v ON v.id = x.van_id WHERE x.id = ?', id))?.chassis);
    }
    const from = [rec.own ? `${q(rec.own)} set aside for it` : '', rec.borrowed.length ? `borrowed from ${[...new Set(lentBy.filter(Boolean))].join(', ')}` : '',
      rec.corr ? `${q(rec.corr)} the system didn't show (count corrected)` : ''].filter(Boolean).join(', ');
    await logAlloc('floor take', { van_id: l.van_id, item_id: l.item_id, line_id: lineId, field: 'issued', before: q(l.issued), after: q(l.issued + take), worker: by,
      change: after.reserved - l.reserved, firm_change: after.reserved_firm - l.reserved_firm,
      note: `taken on floor by ${by || 'a worker'}: ${q(take)}${from ? ` (${from})` : ''}` });
    if (l.van_status === 'planned') {
      await run(`UPDATE vans SET status = 'in_production' WHERE id = ?`, l.van_id);
      await logAlloc('floor take', { van_id: l.van_id, item_id: l.item_id, line_id: lineId, field: 'van status', before: 'planned', after: 'in production', worker: by,
        note: `${l.chassis} started: first part taken on the floor by ${by || 'a worker'}` });
    }
    return { line_id: lineId, qty: take, movement_id: mv, name: l.name, chassis: l.chassis,
             ...(donors.length ? { borrowedFrom: donors.join(', ') } : {}) };
  });
}

// A part taken on the floor that wasn't on the worker's own list. It's often on the van's list under
// another trade: then that line is ticked off. Only if the van has no open line for it is one added
// (and Undo removes it again). `seenTaken` (phone only): how many of this part the phone showed as
// taken for this van — if that changed, the take already went through, so it isn't done twice.
export async function floorExtra(vanId, itemId, qty, by = '', { seenTaken, acceptBorrow } = {}) {
  return writeTx(async () => {
    const van = await get('SELECT chassis, status FROM vans WHERE id = ?', vanId);
    if (!van) throw httpError(404, 'That van no longer exists — refresh');
    if (!['planned', 'in_production'].includes(van.status)) throw httpError(400, `${van.chassis} is finished — parts can't be taken for it`);
    if (!await get('SELECT 1 FROM items WHERE id = ?', itemId)) throw httpError(404, 'Part not found');
    checkQty(qty, 'How many did you take?');
    if (seenTaken != null) {
      const taken = (await get('SELECT COALESCE(SUM(issued),0) AS n FROM van_lines WHERE van_id = ? AND item_id = ?', vanId, itemId)).n;
      if (Number(seenTaken) !== taken) throw httpError(409, 'Someone already took some of this. Check the list.');
    }
    const open = await get(`SELECT id FROM van_lines WHERE van_id = ? AND item_id = ? AND issued < qty
                      ORDER BY CASE WHEN source = 'manual' THEN 1 ELSE 0 END, id LIMIT 1`, vanId, itemId);
    if (open) return takeForVan(open.id, qty, by, { acceptBorrow });
    const line = await addLine(vanId, { item_id: itemId, qty, note: `Added on the floor${by ? ` by ${by}` : ''}` });
    return takeForVan(line.id, qty, by, { extraLine: true, acceptBorrow });
  });
}

// Undo a take within a few minutes (wrong part / wrong van tapped): everything the take changed is
// put back — shelf count, parts borrowed from other vans, the order it was ticked off, the list.
// `sameDay` (phone round 1, C11 "Put back on shelf"): a take from earlier today can be put back too, as long
// as nothing else was booked in or counted for that part since; older ones still go to the office.
// `lineId` / `vanId` (small fixes round 2, sp-r1-5): what the phone thinks it is undoing. When they are
// sent and the movement is for another line or van, nothing is changed ("already undone").
export async function undoTake(movementId, { sameDay = false, lineId = null, vanId = null } = {}) {
  return writeTx(async () => {
    const m = await get(`SELECT * FROM movements WHERE id = ? AND type = 'issue'`, movementId);
    if (!m) throw httpError(404, 'Nothing to undo');
    if (lineId != null || vanId != null) {
      let recLine = null;
      try { recLine = m.undo ? JSON.parse(m.undo)?.line ?? null : null; } catch { recLine = null; }
      const lineOk = lineId == null || (recLine != null ? Number(recLine) === Number(lineId)
        : !!await get('SELECT 1 FROM van_lines WHERE id = ? AND van_id = ? AND item_id = ?', lineId, m.van_id, m.item_id));
      const vanOk = vanId == null || Number(m.van_id) === Number(vanId);
      if (!lineOk || !vanOk) throw httpError(404, 'Nothing to undo — it was already undone');
    }
    // (m.at is Melbourne wall-clock time: its age is worked out in SQL, so the server's own time zone doesn't matter)
    if ((await get(`SELECT ${AGE_SECS('?')} AS s`, m.at)).s > 15 * 60) {
      const isToday = String(m.at).slice(0, 10) === today();
      if (!sameDay || !isToday) throw httpError(400, 'Too late to undo — ask the office');
      if (await get(`SELECT 1 FROM movements WHERE item_id = ? AND id > ? AND type IN ('receive','count','adjust') LIMIT 1`, m.item_id, m.id))
        throw httpError(400, 'That part was booked in or counted since — ask the office');
    }
    const van = await get('SELECT status FROM vans WHERE id = ?', m.van_id);
    if (van && !['planned', 'in_production'].includes(van.status)) throw httpError(400, 'That van is finished — ask the office');
    const q = -m.qty;
    let rec = null;
    try { rec = m.undo ? JSON.parse(m.undo) : null; } catch { rec = null; }
    if (!rec) {
      // Taken before Undo kept a record: just put it back on the shelf for this van.
      const l = await get(`SELECT * FROM van_lines WHERE van_id = ? AND item_id = ? AND issued >= ? ORDER BY id DESC LIMIT 1`, m.van_id, m.item_id, q);
      if (!l) throw httpError(400, 'That part was changed since — ask the office');
      await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', q, m.item_id);
      await run('UPDATE van_lines SET issued = issued - ?, reserved = reserved + ? WHERE id = ?', q, q, l.id);
      await run('DELETE FROM movements WHERE id = ?', movementId);
      return;
    }
    const l = await get('SELECT * FROM van_lines WHERE id = ?', rec.line);
    if (!l || l.issued < q) throw httpError(400, 'That part was changed since — ask the office');
    // Back on the shelf, less anything the take added only to correct the count.
    await run('UPDATE items SET on_hand = on_hand + ? WHERE id = ?', q - (rec.corr || 0), m.item_id);
    if (rec.corrMv) await run('DELETE FROM movements WHERE id = ?', rec.corrMv);
    for (const [plId, n] of rec.po || []) await run('UPDATE po_lines SET received = GREATEST(0, received - ?::double precision) WHERE id = ?', n, plId);
    for (const poId of rec.reopen || []) await run(`UPDATE purchase_orders SET status = 'open' WHERE id = ?`, poId);
    // Parts borrowed from other vans go back to them (locked part and "order now" mark too).
    for (const [otherId, n, firmCut = 0, wasUrgent, wasState = null] of rec.borrowed || []) {
      await run(`UPDATE van_lines SET reserved = LEAST(reserved + ?::double precision, GREATEST(0, qty - issued)), reserved_firm = reserved_firm + ?,
             urgent = COALESCE(?, urgent) WHERE id = ?`, n, firmCut, wasUrgent ?? null, otherId);
      const o = await get('SELECT van_id, item_id, reserved, state FROM van_lines WHERE id = ?', otherId);
      if (o) await logAlloc('borrow undone', { van_id: o.van_id, item_id: o.item_id, line_id: otherId, field: 'reserved', before: o.reserved - n, after: o.reserved, note: 'take undone on the floor' });
      // The borrow turned the donor's plan order number into "still to order": put it back (only if
      // nobody has answered differently since).
      if (o && wasState != null && o.state === 'not_ordered') {
        await run('UPDATE van_lines SET state = ? WHERE id = ?', wasState, otherId);
        await logAlloc('borrow undone', { van_id: o.van_id, item_id: o.item_id, line_id: otherId, field: 'state', before: 'not_ordered', after: wasState, note: 'take undone on the floor' });
      }
    }
    const issued = l.issued - q;
    if (rec.extraLine && issued <= 0) {
      await run('DELETE FROM van_lines WHERE id = ?', l.id); // added on the floor by mistake
    } else {
      const newQty = rec.oldQty != null ? Math.max(rec.oldQty, issued) : l.qty;
      await run('UPDATE van_lines SET issued = ?, qty = ?, reserved = LEAST(reserved + ?::double precision, GREATEST(0, ?::double precision - ?::double precision)) WHERE id = ?',
          issued, newQty, rec.own || 0, newQty, issued, l.id);
      if (rec.ownFirm != null) await run('UPDATE van_lines SET reserved_firm = GREATEST(reserved_firm, LEAST(?::double precision, reserved)) WHERE id = ?', rec.ownFirm, l.id);
    }
    const now = await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', l.id);
    await logAlloc('floor take undone', { van_id: l.van_id, item_id: l.item_id, line_id: l.id, field: 'issued', before: l.issued, after: issued, worker: m.worker,
      change: (now?.reserved ?? 0) - l.reserved, firm_change: (now?.reserved_firm ?? 0) - l.reserved_firm, note: `take of ${q} undone on the floor` });
    // Follow-up round 1 (chk-r3-2): this take is what moved a planned van to "in production". Put it back to
    // planned — so it drops back to its place in the build order and loses first call on shelf stock — but
    // only while nothing else started it since: no other part taken / issued / marked fitted for it, the
    // office hasn't set its status by hand, and it hasn't been moved on the floor map.
    if (rec.startedVan) {
      const v = await get('SELECT chassis, status, area_id FROM vans WHERE id = ?', m.van_id);
      const otherIssue = await get(`SELECT 1 FROM movements WHERE van_id = ? AND type = 'issue' AND id > ? LIMIT 1`, m.van_id, m.id);
      const officeSet = await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'van status' AND id > ? LIMIT 1`, m.van_id, rec.startedVan.logMark ?? 0);
      // "Already fitted" on this van since the take (even with no stock used) also means work has started on it.
      const fittedSince = await get(`SELECT 1 FROM allocation_log WHERE van_id = ? AND reason = 'fitted' AND id > ? LIMIT 1`, m.van_id, rec.startedVan.logMark ?? 0);
      const sameSpot = v && (v.area_id ?? null) === (rec.startedVan.area ?? null);
      if (v && v.status === 'in_production' && !otherIssue && !officeSet && !fittedSince && sameSpot) {
        await run(`UPDATE vans SET status = 'planned' WHERE id = ?`, m.van_id);
        await logAlloc('floor take undone', { van_id: m.van_id, item_id: m.item_id, line_id: l.id, field: 'van status', before: 'in production', after: 'planned', worker: m.worker,
          note: `${v.chassis} back to planned: the take that started it was undone and nothing else was taken for it` });
      } else if (v && v.status === 'in_production' && otherIssue && !officeSet && !fittedSince && sameSpot) {
        // Another floor take came after this one: that take now carries the note, so undoing it as well
        // still puts the van back to planned. (Office issue / "Already fitted" have no undo record: the van stays.)
        const next = await get(`SELECT id, undo FROM movements WHERE van_id = ? AND type = 'issue' AND id > ? ORDER BY id LIMIT 1`, m.van_id, m.id);
        let nrec = null;
        try { nrec = next?.undo ? JSON.parse(next.undo) : null; } catch { nrec = null; }
        if (nrec && typeof nrec === 'object' && nrec.line != null && !nrec.startedVan) {
          nrec.startedVan = rec.startedVan;
          await run('UPDATE movements SET undo = ? WHERE id = ?', JSON.stringify(nrec), next.id);
        }
      }
    }
    await run('DELETE FROM movements WHERE id = ?', movementId);
    await allocateItem(m.item_id, m.van_id); // a per-van part goes back to its own van
  });
}

// Undo a delivery booked on the floor (phone round 1, C11): within 15 minutes, and only while nothing
// else happened to that part since (no take, count or other delivery) — then everything goes back:
// the shelf count, the purchase-order lines it ticked off (and any PO it closed), what it set aside.
// `itemId` (sp-r1-5): the part the phone booked in; a movement for another part is refused.
export async function undoReceive(movementId, by = '', { itemId = null } = {}) {
  return writeTx(async () => {
    const m = await get(`SELECT * FROM movements WHERE id = ? AND type = 'receive'`, movementId);
    if (!m) throw httpError(404, 'Nothing to undo');
    if (itemId != null && Number(m.item_id) !== Number(itemId)) throw httpError(404, 'Nothing to undo — it was already undone');
    if ((await get(`SELECT ${AGE_SECS('?')} AS s`, m.at)).s > 15 * 60) throw httpError(400, 'Too late to undo — ask the office');
    let rec = null;
    try { rec = m.undo ? JSON.parse(m.undo) : null; } catch { rec = null; }
    if (!rec || rec.kind !== 'receive') throw httpError(400, "This delivery can't be undone here — ask the office");
    if (await get('SELECT 1 FROM movements WHERE item_id = ? AND id > ? LIMIT 1', m.item_id, m.id)) throw httpError(400, 'That part was taken or booked since — ask the office');
    const item = await get('SELECT on_hand, name FROM items WHERE id = ?', m.item_id);
    if (!item) throw httpError(404, 'Part not found');
    await run('UPDATE items SET on_hand = on_hand - ? WHERE id = ?', m.qty, m.item_id);
    for (const [plId, n] of rec.po || []) await run('UPDATE po_lines SET received = GREATEST(0, received - ?::double precision) WHERE id = ?', n, plId);
    for (const poId of rec.reopen || []) await run(`UPDATE purchase_orders SET status = 'open' WHERE id = ?`, poId);
    for (const [lineId, d, df] of rec.alloc || []) {
      const l = await get('SELECT * FROM van_lines WHERE id = ?', lineId);
      if (!l) continue;
      await run('UPDATE van_lines SET reserved = GREATEST(0, reserved - ?::double precision) WHERE id = ?', d, lineId);
      await run('UPDATE van_lines SET reserved_firm = GREATEST(0, LEAST(reserved_firm - ?::double precision, reserved)) WHERE id = ?', df, lineId);
      const now = await get('SELECT reserved, reserved_firm FROM van_lines WHERE id = ?', lineId);
      await logAlloc('delivery undone', { van_id: l.van_id, item_id: l.item_id, line_id: lineId, field: 'reserved', before: l.reserved, after: now.reserved, worker: by,
        change: now.reserved - l.reserved, firm_change: now.reserved_firm - l.reserved_firm, note: `delivery of ${q(m.qty)} undone on the floor` });
    }
    await run('DELETE FROM movements WHERE id = ?', movementId);
    // The movement goes, so the part's history keeps a line saying a delivery was undone (sp-r1-5).
    await logAlloc('delivery undone', { item_id: m.item_id, field: 'on_hand', before: q(item.on_hand), after: q(item.on_hand - m.qty), worker: by,
      note: `delivery of ${q(m.qty)} booked at ${String(m.at).slice(11, 16)} undone on the floor${m.ref ? ` (${m.ref})` : ''}` });
    await trimReservations(m.item_id, { reason: 'delivery undone', worker: by });
    return { name: item.name, qty: m.qty };
  });
}

// What is still to come on open purchase orders, one row per part (the worker's "Waiting for" list).
export async function floorWaiting() {
  return (await all(`SELECT i.id, i.name, i.sku, i.photo, i.unit, i.unit_size, i.kind, i.on_hand, i.location, i.area_id,
                (SELECT fa.name FROM floor_areas fa WHERE fa.id = i.area_id) AS area_name,
                COALESCE(string_agg(DISTINCT NULLIF(trim(p.supplier), ''), ','), NULLIF(trim(i.supplier), '')) AS supplier,
                SUM(${PO_OPEN}) AS to_come,
                MIN(NULLIF(COALESCE(NULLIF(pl.expected, ''), p.expected), '')) AS expected
              FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id JOIN items i ON i.id = pl.item_id
              WHERE ${PO_IS_OPEN} AND i.active = 1
              GROUP BY i.id ORDER BY i.id`))
    // by supplier (a truck's load together), parts with no supplier known last
    .sort((a, b) => (!a.supplier - !b.supplier) || String(a.supplier || '').localeCompare(String(b.supplier || ''), undefined, { sensitivity: 'base' })
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Where a part is kept, set from the worker screen ("Set place"): a storage rack and an optional shelf / bin.
export async function setItemPlace(itemId, areaId, location, by = '') {
  return writeTx(async () => {
    const it = await get('SELECT id, area_id, location FROM items WHERE id = ?', itemId);
    if (!it) throw httpError(404, 'Part not found');
    const a = areaId ? await get(`SELECT id, name FROM floor_areas WHERE id = ? AND kind = 'storage'`, Number(areaId)) : null;
    if (areaId && !a) throw httpError(404, 'That rack no longer exists — refresh');
    const loc = String(location ?? '').trim().slice(0, 60);
    const oldName = it.area_id ? ((await get('SELECT name FROM floor_areas WHERE id = ?', it.area_id))?.name || '') : '';
    await run('UPDATE items SET area_id = ?, location = ? WHERE id = ?', a?.id ?? null, loc, itemId);
    if ((it.area_id ?? null) !== (a?.id ?? null)) await logAlloc('catalogue', { item_id: itemId, field: 'rack', before: oldName, after: a?.name || '', worker: by, note: 'set on the floor' });
    if ((it.location || '') !== loc) await logAlloc('catalogue', { item_id: itemId, field: 'location', before: it.location || '', after: loc, worker: by, note: 'set on the floor' });
    return { area_name: a?.name || '', location: loc };
  });
}

// Vans for the floor: soonest first, with how far along they are.
export async function floorVans() {
  return all(`
    SELECT v.id, v.chassis, v.model, v.length, v.customer, v.eta, v.status,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id) AS total,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND l.issued >= l.qty) AS done,
      (SELECT COUNT(*) FROM van_lines l WHERE l.van_id = v.id AND l.issued < l.qty AND l.reserved > 0) AS ready
    FROM vans v WHERE ${ACTIVE_VAN}
    ORDER BY CASE v.status WHEN 'in_production' THEN 0 ELSE 1 END, ${PRIORITY}`);
}

// Follow-up round 1 (worker-r3-3): for each part still short on the worker's van screen, whether it is on order —
// the van page's own rule (lineStatus with this van's and the shelf's open PO lines; a line fully covered by a
// shelf PO or another van's spare PO line counts as ordered too). Sets on each such line:
//   l.order = { qty, suppliers: [...], expected: 'YYYY-MM-DD' | '' }  → "On order" tag + "1 on order from Onex · due 2/11"
//   l.plan_ordered = 'Onex 08'  → the plan gives an order number but the office hasn't confirmed it ("Check: already ordered?")
async function floorOrderInfo(vanId, lines) {
  const short = l => Math.max(0, l.qty - l.reserved - l.issued);
  const open = lines.filter(l => short(l) > 1e-9 && !['customer', 'tbd'].includes(l.state));
  if (!open.length) return;
  const poRows = await all(`SELECT pl.item_id, pl.van_id, ${PO_OPEN} AS q, p.supplier, COALESCE(NULLIF(pl.expected, ''), p.expected) AS expected
                      FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
                      WHERE ${PO_IS_OPEN} AND (pl.van_id IS NULL OR pl.van_id = ?) ORDER BY pl.id`, vanId);
  const sum = rs => rs.reduce((s, p) => s + p.q, 0);
  let cov = null;
  const info = (from, need) => {
    const dates = from.map(p => p.expected || '');
    return { qty: Math.min(need, sum(from.map(p => ({ q: p.qty ?? p.q })))),
      suppliers: [...new Set(from.map(p => String(p.supplier || '').trim()).filter(Boolean))],
      // the latest date given; '' when any of them has none ("due date not known")
      expected: dates.some(d => !d) ? '' : dates.sort().pop() || '' };
  };
  for (const l of open) {
    const mine = poRows.filter(p => p.item_id === l.item_id && p.van_id === vanId);
    const shelf = poRows.filter(p => p.item_id === l.item_id && p.van_id == null);
    const st = lineStatus({ ...l, on_order_van: sum(mine), on_order: sum(mine) + sum(shelf) });
    if (st === 'on_order') { l.order = info(mine.length ? mine : shelf, short(l)); continue; }
    if (st === 'to_order') {
      cov ??= await lineCover({ vanId });
      const c = cov.get(l.id);
      if (c && c.qty >= short(l) - 1e-9) { l.order = info(c.from, short(l)); continue; }
    }
    if (st === 'check') l.plan_ordered = String(l.spec || l.po_ref || '').trim().slice(0, 60);
  }
}

export async function floorVan(vanId) {
  const van = await get(`SELECT v.id, v.chassis, v.model, v.length, v.customer, v.eta, v.status, a.name AS area_name,
                     (SELECT COUNT(*) FROM van_notes n WHERE n.van_id = v.id) AS notes
                   FROM vans v LEFT JOIN floor_areas a ON a.id = v.area_id WHERE v.id = ?`, vanId);
  if (!van) throw httpError(404, 'Van not found');
  const lines = await all(`
    SELECT l.id, l.item_id, l.qty, l.reserved, l.issued, l.spec, l.plan_column, l.state, l.urgent, l.po_ref, i.name, i.sku, i.unit, i.unit_size, i.photo, i.location, i.category, i.on_hand, i.trade,
      (SELECT fa.name FROM floor_areas fa WHERE fa.id = i.area_id) AS area_name,
      COALESCE(NULLIF(l.plan_column, ''), NULLIF(i.plan_column, ''), i.category) AS col,
      i.on_hand - COALESCE((SELECT SUM(x.reserved) FROM van_lines x JOIN vans v ON v.id = x.van_id
                            WHERE x.item_id = i.id AND ${ACTIVE_VAN}), 0) AS free
    FROM van_lines l JOIN items i ON i.id = l.item_id WHERE l.van_id = ?
    ORDER BY i.category, i.name`, vanId);
  // On the shelf but all set aside for other vans (phone round 1, C9): which vans, so the worker is told
  // "set aside for ST0367, ST0380 — ask before taking" instead of "none on the shelf".
  // One query for every such line (it was one per line: up to 22 on a big van, and the screen reloads after
  // each take); per item, the vans in build order, each named once.
  const heldLines = lines.filter(l => !(l.issued >= l.qty || l.reserved > 0 || !(l.on_hand > 0) || l.free > 0));
  if (heldLines.length) {
    const ids = [...new Set(heldLines.map(l => l.item_id))];
    const heldBy = new Map(ids.map(i => [i, new Set()]));
    for (const r of await all(`SELECT x.item_id, v.chassis FROM van_lines x JOIN vans v ON v.id = x.van_id
                                 WHERE x.item_id IN (${ids.map(() => '?').join(',')}) AND x.van_id <> ? AND x.reserved > 0 AND ${ACTIVE_VAN}
                                 ORDER BY x.item_id, ${PRIORITY}`, ...ids, vanId)) heldBy.get(r.item_id).add(r.chassis);
    for (const l of heldLines) l.held_by = [...heldBy.get(l.item_id)];
  }
  await floorOrderInfo(vanId, lines);
  const reminders = await all(`SELECT id, text, due, trade, worker FROM reminders WHERE van_id = ? AND done = 0
                         ORDER BY CASE WHEN due = '' THEN 1 ELSE 0 END, due, id`, vanId);
  return { van, lines, reminders };
}

// `by`: a name, or { userId, name } — the login (logins and job roles): its own movements by user id, and only
// movements saved before logins (no user id) by name, so two people with the same name are never mixed up.
export async function floorStats(by = '') {
  const { userId = null, name = '' } = typeof by === 'object' && by ? by : { name: by };
  const today = `substr(at, 1, 10) = ${TODAY_SQL}`;
  const mine = '(user_id = ? OR (user_id IS NULL AND worker = ?))';
  const row = await get(`SELECT
      COUNT(*) FILTER (WHERE ${mine}) AS mine,
      COUNT(*) AS team,
      COUNT(*) FILTER (WHERE ${mine} AND type = 'issue') AS mine_took,
      COUNT(*) FILTER (WHERE type = 'issue') AS team_took,
      COUNT(DISTINCT COALESCE(CAST(user_id AS TEXT), worker)) AS people
    FROM movements WHERE ${today} AND type IN ('issue','receive') AND worker <> ''`, userId ?? -1, name, userId ?? -1, name);
  return row;
}
