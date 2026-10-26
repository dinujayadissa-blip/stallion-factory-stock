// Fixes from the source-only security review (run-1): quantities that are not a real number, van status changes
// by a leading hand, Cache-Control on /api answers, and a log in racing a password reset.
// The real app, started in this process on a new, empty in-memory database (PGlite) and a free port — never on
// real data, never on port 3000.   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { get, run, insert, closeDb } from '../src/db.js';
import * as auth from '../src/auth.js';

let server, port;
const S = {}; // cookies by person

before(async () => {
  process.env.ALLOWED_HOSTS = '';
  delete process.env.TRUST_PROXY;
  delete process.env.CLOUD;
  await freshDb();
  const { createApp } = await import('../src/app.js');
  server = createApp({ cloud: false }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
  auth.setCookiePort(port);
  for (const [username, role, trade] of [['olive', 'office', ''], ['stu', 'stores', ''], ['lee', 'leadhand', ''], ['sam', 'worker', 'electrician']]) {
    await auth.createUser({ username, name: username.toUpperCase(), role, trade, password: `${username}-pass-1`, mustChange: false }, 'test');
    S[username] = await login(username, `${username}-pass-1`);
  }
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  await closeDb();
});

// One request. `raw`: the body is sent as it is (so a number like 1e400 reaches JSON.parse unchanged).
function call(method, p, { body, raw, as } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? Buffer.from(raw) : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      ...(as ? { Cookie: `fs_session_${port}=${as}` } : {}) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        const set = [res.headers['set-cookie'] || []].flat().map(c => new RegExp(`^fs_session_${port}=([^;]*)`).exec(c)?.[1]).filter(v => v != null).pop();
        resolve({ status: res.statusCode, headers: res.headers, json, text, cookie: set });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function login(username, password) {
  const r = await call('POST', '/api/login', { body: { username, password } });
  assert.equal(r.status, 200, `log in ${username}: ${r.text}`);
  return r.cookie;
}
const item = (sku, onHand = 5, kind = 'stock') => insert(`INSERT INTO items(sku, name, category, supplier, trade, kind, on_hand) VALUES(?, ?, 'General', 'Onex', 'electrician', ?, ?)`, sku, `Part ${sku}`, kind, onHand);
const van = (chassis, status) => insert(`INSERT INTO vans(chassis, status, eta) VALUES(?, ?, '2027-01-01')`, chassis, status);
const line = (vanId, itemId, qty) => insert(`INSERT INTO van_lines(van_id, item_id, qty, source) VALUES(?, ?, ?, 'manual')`, vanId, itemId, qty);
const onHand = async id => (await get('SELECT on_hand FROM items WHERE id = ?', id)).on_hand;

// ── 1. quantities ──

test('a worker booking in 1e400 (Infinity after JSON.parse) gets a 400 and the stock is unchanged', async () => {
  const it = await item('Q-INF', 5);
  const po = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('Q1', 'Onex')`);
  await insert('INSERT INTO po_lines(po_id, item_id, qty) VALUES(?, ?, 5)', po, it);
  for (const raw of [`{"item_id":${it},"qty":1e400}`, `{"item_id":${it},"qty":"Infinity"}`, `{"item_id":${it},"qty":100001}`]) {
    const r = await call('POST', '/api/floor/receive', { as: S.sam, raw });
    assert.equal(r.status, 400, raw);
    assert.match(r.json.error, /too many/);
  }
  assert.equal(await onHand(it), 5);
  assert.equal((await get('SELECT received FROM po_lines WHERE po_id = ?', po)).received, 0);
  assert.equal((await get(`SELECT status FROM purchase_orders WHERE id = ?`, po)).status, 'open');
  // a normal delivery still books in
  const ok = await call('POST', '/api/floor/receive', { as: S.sam, body: { item_id: it, qty: 2 } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(await onHand(it), 7);
});

test('every other way a quantity reaches stock or a PO refuses Infinity', async () => {
  const it = await item('Q-ALL', 5);
  const v = await van('QV1', 'in_production');
  const l = await line(v, it, 3);
  const inf = (body, key = 'qty') => JSON.stringify(body).replace(`"${key}":"INF"`, `"${key}":1e400`);
  const cases = [
    ['POST', '/api/floor/take', S.sam, inf({ line_id: l, qty: 'INF', accept_borrow: true })],
    ['POST', '/api/floor/extra', S.sam, inf({ van_id: v, item_id: it, qty: 'INF', accept_borrow: true })],
    ['POST', `/api/items/${it}/receive`, S.stu, inf({ qty: 'INF' })],
    ['POST', `/api/items/${it}/adjust`, S.stu, inf({ mode: 'set', qty: 'INF' })],
    ['POST', `/api/items/${it}/adjust`, S.stu, inf({ mode: 'add', qty: 'INF' })],
    ['POST', `/api/vans/${v}/lines`, S.olive, inf({ item_id: it, qty: 'INF' })],
    ['PUT', `/api/van-lines/${l}`, S.olive, JSON.stringify({ qty: 'NaN' })],
    ['PUT', `/api/van-lines/${l}`, S.olive, inf({ qty: 'INF' })],
    ['POST', '/api/pos', S.olive, JSON.stringify({ po_no: 'QX', supplier: 'Onex', lines: [{ item_id: it, qty: 'INF' }] }).replace('"qty":"INF"', '"qty":1e400')],
    ['POST', '/api/pos', S.olive, JSON.stringify({ po_no: 'QY', supplier: 'Onex', lines: [{ item_id: it, qty: 60000 }, { item_id: it, qty: 60000 }] })],
    ['POST', '/api/items', S.olive, inf({ sku: 'Q-NEW', name: 'New part', on_hand: 'INF' }, 'on_hand')],
    ['POST', `/api/items/${it}/assign`, S.olive, inf({ van_id: v, qty: 'INF' })],
  ];
  for (const [m, p, as, raw] of cases) {
    const r = await call(m, p, { as, raw });
    assert.equal(r.status, 400, `${m} ${p} ${raw}: ${r.text}`);
  }
  assert.equal(await onHand(it), 5);
  assert.equal((await get('SELECT qty, issued FROM van_lines WHERE id = ?', l)).qty, 3);
  assert.equal((await get('SELECT COUNT(*) AS n FROM van_lines WHERE van_id = ?', v)).n, 1);
  assert.equal((await get(`SELECT COUNT(*) AS n FROM purchase_orders WHERE po_no IN ('QX', 'QY')`)).n, 0);
  assert.ok(!await get(`SELECT 1 FROM items WHERE sku = 'Q-NEW'`));
  // a PO line receipt of Infinity
  const po = await insert(`INSERT INTO purchase_orders(po_no, supplier) VALUES('QZ', 'Onex')`);
  const pl = await insert('INSERT INTO po_lines(po_id, item_id, qty) VALUES(?, ?, 2)', po, it);
  const r = await call('POST', `/api/pos/${po}/receive`, { as: S.stu, raw: `{"lines":[{"id":${pl},"qty":1e400}]}` });
  assert.equal(r.status, 400, r.text);
  assert.equal(await onHand(it), 5);
  // a van line may still be set to 0 by the office (nothing needed any more)
  assert.equal((await call('PUT', `/api/van-lines/${l}`, { as: S.olive, body: { qty: 0 } })).status, 200);
});

test('a stock figure already Infinity / NaN in the database is put right by a count (adjust "set") or a saved count', async () => {
  const it = await item('Q-FIX', 5);
  const v = await van('QV2', 'planned');
  const l = await line(v, it, 3);
  await run(`UPDATE items SET on_hand = 'Infinity'::double precision WHERE id = ?`, it);
  assert.equal(await onHand(it), Infinity);
  // adding to it can't fix it: said plainly
  let r = await call('POST', `/api/items/${it}/adjust`, { as: S.stu, body: { mode: 'add', qty: 2 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /count it/);
  r = await call('POST', `/api/items/${it}/adjust`, { as: S.stu, body: { mode: 'set', qty: 4 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(await onHand(it), 4);
  const mv = await get(`SELECT qty, type, note FROM movements WHERE item_id = ? ORDER BY id DESC LIMIT 1`, it);
  assert.equal(mv.type, 'count');
  assert.equal(mv.qty, 0);
  assert.match(mv.note, /not a number \(Infinity\) — set to 4/);
  assert.equal((await get('SELECT reserved FROM van_lines WHERE id = ?', l)).reserved, 3); // the van gets its parts from the real figure

  // NaN, and "set shelf stock to zero" (clear-stock) on it
  await run(`UPDATE items SET on_hand = 'NaN'::double precision WHERE id = ?`, it);
  r = await call('POST', '/api/settings/clear-stock', { as: S.olive, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(await onHand(it), 0);
  assert.equal((await get('SELECT reserved FROM van_lines WHERE id = ?', l)).reserved, 0);

  // a count of the rack: opened while the figure was Infinity (written down as null), saved as counted
  const rack = await insert(`INSERT INTO floor_areas(kind, name, x, y, w, h) VALUES('rack', 'Rack Q', 0, 0, 2, 1)`);
  await run('UPDATE items SET area_id = ? WHERE id = ?', rack, it);
  await run(`UPDATE items SET on_hand = 'Infinity'::double precision WHERE id = ?`, it);
  const c = await call('POST', '/api/counts', { as: S.stu, body: { scope: `area:${rack}` } });
  assert.equal(c.status, 200, c.text);
  r = await call('POST', `/api/counts/${c.json.id}/save`, { as: S.stu, body: { counts: [{ item_id: it, qty: 6 }] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(await onHand(it), 6);
  assert.equal((await get('SELECT reserved FROM van_lines WHERE id = ?', l)).reserved, 3);
});
