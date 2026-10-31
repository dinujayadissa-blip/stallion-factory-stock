// The floor screen for workers (/floor), and the factory floor map, notes and reminders.
import { all, get, run } from '../db.js';
import * as inv from '../inventory.js';
import * as layout from '../layout.js';
import { TRADES, isTrade } from '../trades.js';
import { h, id, num, worker } from './common.js';

export function floorRoutes(app) {
  // ── Floor screen for workers (/floor) ──
  // A worker only ever sees their own trade; everyone else picks a trade view on /floor ('all' = every trade).
  const floorTrade = (req, asked) => (req.user?.role === 'worker' ? req.user.trade : asked);
  // A worker may only undo their own take / delivery booking (the name saved on it = their login's name).
  // It goes by the login's id saved on the movement; only movements from before logins (no id) go by the name.
  async function ownMovementOnly(req, type) {
    if (req.user?.role !== 'worker') return;
    const m = await get('SELECT worker, user_id FROM movements WHERE id = ? AND type = ?', Number(req.body.movement_id), type);
    if (!m) return; // "Nothing to undo" from the undo itself
    const own = m.user_id != null ? Number(m.user_id) === Number(req.user.id)
      : String(m.worker || '').trim().toLowerCase() === String(req.user.name).trim().toLowerCase();
    if (!own) throw inv.httpError(403, 'Only the person who did it can undo it — ask the office');
  }

  app.get('/api/floor/vans', h(() => inv.floorVans()));
  app.get('/api/trades', h(() => TRADES));
  // The worker home screen: the floor map with badges for one trade.
  // `trade` in the answer: the trade really shown (a worker's own, whatever was asked).
  app.get('/api/floor/map', h(async req => { const t = floorTrade(req, String(req.query.trade || 'all')); return { ...await layout.floorMap(t), trade: isTrade(t) ? t : 'all' }; }));
  app.get('/api/floor/vans/:id', h(req => inv.floorVan(id(req))));
  app.get('/api/floor/stats', h(req => inv.floorStats({ userId: req.user.id, name: worker(req) })));
  // accept_borrow: true = the worker agreed to take another van's part, false = it's a new delivery.
  const acceptBorrow = v => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
  app.post('/api/floor/take', h(req => inv.takeForVan(Number(req.body.line_id), num(req.body.qty), worker(req),
    { seenIssued: num(req.body.seen_issued), acceptBorrow: acceptBorrow(req.body.accept_borrow) })));
  // put_back: "Put back on shelf" from the Done tab — a take from earlier today (phone round 1, C11).
  // line_id / van_id (sp-r1-5): what the phone is undoing — a movement for another line or van is refused.
  const optId = v => (v == null || v === '' ? null : Number(v));
  app.post('/api/floor/undo', h(async req => {
    await ownMovementOnly(req, 'issue');
    return inv.undoTake(Number(req.body.movement_id), { sameDay: req.body.put_back === true, lineId: optId(req.body.line_id), vanId: optId(req.body.van_id) });
  }));
  // Delivery screen (phone round 1, C11): what is still to come on open POs, Undo a booking, set where a part is kept.
  app.get('/api/floor/waiting', h(() => inv.floorWaiting()));
  // item_id (sp-r1-5): the part the phone booked in — a movement for another part is refused.
  app.post('/api/floor/receive/undo', h(async req => {
    await ownMovementOnly(req, 'receive');
    return inv.undoReceive(Number(req.body.movement_id), worker(req), { itemId: optId(req.body.item_id) });
  }));
  app.post('/api/floor/items/:id/place', h(req => inv.setItemPlace(id(req), req.body.area_id == null || req.body.area_id === '' ? null : Number(req.body.area_id),
    req.body.location, worker(req))));
  // A part that wasn't on the worker's list: tick off the van's open line for it, or add one and take it.
  app.post('/api/floor/extra', h(req => inv.floorExtra(Number(req.body.van_id), Number(req.body.item_id), Number(req.body.qty), worker(req),
    { seenTaken: num(req.body.seen_taken), acceptBorrow: acceptBorrow(req.body.accept_borrow) })));
  // A delivery booked on a phone carries a one-off id (rid): if the reply was lost and the worker taps again,
  // the same booking is answered again instead of booking the delivery twice. The answer is kept in
  // request_receipts for 24 hours, written in the same transaction as the delivery (and looked up under the
  // same write lock, so two taps at once book it once — on any server).
  const RECEIPT_MS = 24 * 60 * 60 * 1000;
  app.post('/api/floor/receive', h(async req => {
    const rid = String(req.body.rid || '').slice(0, 80);
    const at = Date.now();
    if (rid) {
      // (?::text::jsonb: a jsonb-typed parameter would be JSON-encoded twice by the postgres client)
      const seen = await get('SELECT out FROM request_receipts WHERE rid = ? AND at > ?', rid, at - RECEIPT_MS);
      if (seen) return seen.out;
    }
    const vanId = Number(req.body.van_id) || null;
    const r = await inv.receiveDelivery(Number(req.body.item_id), Number(req.body.qty), { ref: 'Delivery (floor)', vanId, by: worker(req) });
    // Which vans got it, to show the worker where it's going; movement_id lets the phone undo it (C11).
    const vans = (await all(`SELECT v.chassis FROM vans v WHERE v.status IN ('planned','in_production')
                  AND EXISTS (SELECT 1 FROM van_lines l WHERE l.van_id = v.id AND l.item_id = ? AND l.reserved > 0)
                ORDER BY ${inv.PRIORITY} LIMIT 6`, Number(req.body.item_id))).map(x => x.chassis);
    // to / shelf (follow-up round 1, worker-r3-4): where THIS delivery went — "1 → ST0380", or on the shelf.
    const out = { vans, movement_id: r.movement_id, to: r.to || [], shelf: r.shelf || 0 };
    if (rid) {
      // (?::text::jsonb: a jsonb-typed parameter would be JSON-encoded twice by the postgres client)
      // (old receipts go here as well as in the nightly clean-up, so a local run without it stays small)
      await run('DELETE FROM request_receipts WHERE at <= ?', at - RECEIPT_MS);
      await run(`INSERT INTO request_receipts(rid, out, at) VALUES(?, ?::text::jsonb, ?)
                 ON CONFLICT (rid) DO UPDATE SET out = excluded.out, at = excluded.at`, rid, JSON.stringify(out), at);
    }
    return out;
  }));

  // ── Factory floor map, notes, reminders ──
  app.get('/api/layout', h(() => layout.getLayout()));
  app.post('/api/layout/areas', h(req => layout.saveArea(null, req.body)));
  app.put('/api/layout/areas/:id', h(req => layout.saveArea(id(req), req.body)));
  app.delete('/api/layout/areas/:id', h(req => layout.deleteArea(id(req))));
  app.get('/api/layout/areas/:id/items', h(req => layout.areaItems(id(req))));
  // Push every van one bay along the loop (preview with GET, do it with POST).
  app.get('/api/layout/advance', h(req => layout.advanceLine({ nextVanId: Number(req.query.next) || null, dryRun: true })));
  app.post('/api/layout/advance', h(req => layout.advanceLine({ nextVanId: Number(req.body.next_van_id) || null, expect: Array.isArray(req.body.expect) ? req.body.expect : null })));
  app.post('/api/vans/:id/move', h(req => layout.moveVan(id(req), req.body.area_id == null || req.body.area_id === '' ? null : Number(req.body.area_id))));
  app.post('/api/vans/:id/leave', h(req => layout.leaveFactory(id(req))));
  app.get('/api/vans/:id/floor', h(req => layout.vanFloorInfo(id(req))));
  app.post('/api/vans/:id/notes', h(req => layout.addNote(id(req), req.body.text, worker(req))));
  app.delete('/api/notes/:id', h(req => layout.deleteNote(id(req))));
  app.get('/api/reminders', h(() => layout.openReminders()));
  app.post('/api/reminders', h(req => layout.addReminder({ ...req.body, van_id: Number(req.body.van_id) || null }, worker(req))));
  app.put('/api/reminders/:id', h(req => layout.setReminderDone(id(req), !!req.body.done)));
  app.delete('/api/reminders/:id', h(req => layout.deleteReminder(id(req))));
}
