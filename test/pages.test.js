// Cloudflare Pages: the pass-through to the Supabase function, the page gate and the office app manifest.
// The Pages Function files are plain ES modules, so they run here under Node with a fake env and a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forward } from '../functions/_forward.js';
import { onRequest as gate } from '../functions/_middleware.js';
import { build } from '../scripts/build-pages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_BASE = { API_ORIGIN: 'https://abc.supabase.co', PASS_SECRET: 'not-a-real-secret' };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// Runs fn with globalThis.fetch replaced; `seen` collects { url, init } of every call.
async function withFetch(impl, fn) {
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return impl(String(url), init); };
  try { return await fn(seen); } finally { globalThis.fetch = real; }
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
// A fake env.ASSETS: answers with the path it was asked for.
const assets = () => ({ fetch: async req => new Response(`asset:${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600' } }) });
const meOf = (role, extra = {}) => json(200, { user: { username: 'u', role, mustChange: false, ...extra }, can: { officeApp: role !== 'worker' }, cloud: true });
const page = (p, cookie = 'fs_session=abc') => new Request(`https://stallion-stock.pages.dev${p}`, { headers: cookie ? { cookie } : {} });
const next = async () => new Response('next');
const gateWith = (me, p, cookie) => withFetch(() => me, async seen => {
  const res = await gate({ request: page(p, cookie), env: { ...ENV_BASE, ASSETS: assets() }, next });
  return { res, seen };
});

test('pass-through keeps cookies and body bytes', async () => {
  const big = crypto.randomBytes(2 * 1024 * 1024);
  await withFetch(async (url, init) => {
    const got = Buffer.from(await new Response(init.body).arrayBuffer());
    const h = new Headers({ 'content-type': 'application/octet-stream', 'x-seen-sha': sha(got) });
    h.append('set-cookie', 'a=1; Path=/; HttpOnly');
    h.append('set-cookie', 'b=2; Path=/; Max-Age=0');
    return new Response(got, { status: 201, headers: h });
  }, async seen => {
    const req = new Request('https://stallion-stock.pages.dev/api/import/dealer?x=1&y=2', {
      method: 'POST', body: big, headers: { cookie: 'fs_session=tok', 'x-pass-secret': 'client-forged', 'content-type': 'application/pdf', 'cf-connecting-ip': '203.0.113.9' } });
    const res = await forward(req, ENV_BASE);
    assert.equal(res.status, 201);
    assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/; HttpOnly', 'b=2; Path=/; Max-Age=0']);
    assert.equal(res.headers.get('x-seen-sha'), sha(big), 'the upstream received identical bytes');
    assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(big), 'the browser receives identical bytes');
    // where it went, and with which headers
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://abc.supabase.co/functions/v1/api/api/import/dealer?x=1&y=2');
    const h = new Headers(seen[0].init.headers);
    assert.equal(h.get('x-pass-secret'), ENV_BASE.PASS_SECRET, 'a secret sent by the browser is replaced, never passed on');
    assert.equal(h.get('x-region'), 'ap-southeast-2');
    assert.equal(h.get('x-forwarded-host'), 'stallion-stock.pages.dev');
    assert.equal(h.get('x-forwarded-for'), '203.0.113.9');
    assert.equal(h.get('x-forwarded-proto'), 'https');
    assert.equal(h.get('cookie'), 'fs_session=tok');
    assert.equal(h.get('content-type'), 'application/pdf');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.redirect, 'manual');
  });
});

test('pass-through for photos, and without the shared secret nothing is sent', async () => {
  await withFetch(() => new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } }), async seen => {
    const res = await forward(page('/photos/abc.jpg'), ENV_BASE);
    assert.equal(await res.text(), 'jpeg');
    assert.equal(seen[0].url, 'https://abc.supabase.co/functions/v1/api/photos/abc.jpg');
    assert.equal(seen[0].init.body, undefined, 'a GET has no body');
    const none = await forward(page('/api/me'), { API_ORIGIN: ENV_BASE.API_ORIGIN });
    assert.equal(none.status, 500);
    assert.equal(seen.length, 1, 'not forwarded');
  });
});

test('worker opening / is sent to /floor', async () => {
  for (const p of ['/', '/index.html']) {
    const { res, seen } = await gateWith(meOf('worker'), p);
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get('location'), '/floor', p);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    // the session was checked with the browser's cookie and the pass-through headers
    assert.equal(seen[0].url, 'https://abc.supabase.co/functions/v1/api/api/me');
    const h = new Headers(seen[0].init.headers);
    assert.equal(h.get('cookie'), 'fs_session=abc');
    assert.equal(h.get('x-pass-secret'), ENV_BASE.PASS_SECRET);
  }
  // an office login gets the office app (no-store), /index.html goes to /
  const ok = await gateWith(meOf('owner'), '/');
  assert.equal(ok.res.status, 200);
  assert.equal(await ok.res.text(), 'asset:/');
  assert.equal(ok.res.headers.get('cache-control'), 'no-store');
  const canon = await gateWith(meOf('owner'), '/index.html');
  assert.equal(canon.res.status, 302);
  assert.equal(canon.res.headers.get('location'), '/');
  // the floor app is open to workers
  const floor = await gateWith(meOf('worker'), '/floor');
  assert.equal(floor.res.status, 200);
  assert.equal(await floor.res.text(), 'asset:/floor');
  assert.equal((await gateWith(meOf('worker'), '/floor.html')).res.headers.get('location'), '/floor');
});

test('not logged in opening /floor goes to /login?next=%2Ffloor', async () => {
  const { res } = await gateWith(json(401, { error: 'Please log in' }), '/floor', null);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2Ffloor');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await gateWith(json(401, { error: 'x' }), '/floor.html', null)).res.headers.get('location'), '/login?next=%2Ffloor');
  // the office app keeps where you were going
  assert.equal((await gateWith(json(401, {}), '/?tab=stock', null)).res.headers.get('location'), '/login?next=%2F%3Ftab%3Dstock');
  // a session that ended says so once, and its cookie clears
  const ended = await gateWith(json(401, { error: 'Please log in', ended: true }, { 'set-cookie': 'fs_session=; Max-Age=0; Path=/' }), '/floor');
  assert.equal(ended.res.headers.get('location'), '/login?next=%2Ffloor&ended=1');
  assert.deepEqual(ended.res.headers.getSetCookie(), ['fs_session=; Max-Age=0; Path=/']);
  assert.equal((await gateWith(json(401, { ended: true }), '/', 'fs_session=old')).res.headers.get('location'), '/login?next=%2F&ended=1');
  // must change the password first: same as logged out
  assert.equal((await gateWith(meOf('owner', { mustChange: true }), '/floor')).res.headers.get('location'), '/login?next=%2Ffloor');
  assert.equal((await gateWith(meOf('owner', { mustChange: true }), '/')).res.headers.get('location'), '/login?next=%2F');
});

test('the login page needs no login, other files pass on, odd addresses to the pages are gated', async () => {
  const noCall = () => { throw new Error('no session check expected'); };
  for (const p of ['/login', '/login.html']) {
    const res = await withFetch(noCall, () => gate({ request: page(p, null), env: { ...ENV_BASE, ASSETS: assets() }, next }));
    assert.equal(res.status, 200); assert.equal(await res.text(), 'asset:/login'); assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  for (const p of ['/app.js', '/api/me', '/photos/x.jpg', '/vendor/three/build/three.module.js']) {
    const res = await withFetch(noCall, () => gate({ request: page(p, null), env: { ...ENV_BASE, ASSETS: assets() }, next }));
    assert.equal(await res.text(), 'next', p);
  }
  for (const p of ['/%69ndex.html', '//index.html', '/index.html/', '/./index.html', '/%66loor.html']) {
    const { res } = await gateWith(json(401, {}), p, null);
    assert.equal(res.status, 302, p);
    assert.match(res.headers.get('location'), /^\/login\?next=/, p);
  }
  // the function server not answering: say so, never loop through the login page
  const down = await gateWith(json(500, { error: 'x' }), '/');
  assert.equal(down.res.status, 503);
  assert.equal(down.res.headers.get('cache-control'), 'no-store');
});

test('office manifest is valid JSON with a 512 icon', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'public', 'office.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Stallion Stock');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  const iconFile = i => path.join(root, 'public', i.src.replace(/^\//, ''));
  assert.ok(m.icons.some(i => i.sizes === '512x512' && fs.existsSync(iconFile(i))), 'a 512 icon that exists');
  assert.ok(m.icons.some(i => i.sizes === '192x192' && fs.existsSync(iconFile(i))), 'a 192 icon that exists');
  const index = fs.readFileSync(path.join(root, 'views', 'index.html'), 'utf8');
  assert.match(index, /<link rel="manifest" href="\/office\.webmanifest">/);
  for (const f of ['index', 'floor']) {
    const h = fs.readFileSync(path.join(root, 'views', `${f}.html`), 'utf8');
    assert.match(h, /apple-mobile-web-app-capable/); assert.match(h, /apple-mobile-web-app-title/); assert.match(h, /apple-touch-icon/);
  }
});

test('the Pages build has the screens at the top, three.js and _routes.json, and no views/ or functions/ folder', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  try {
    build(out);
    const has = p => fs.existsSync(path.join(out, p));
    for (const f of ['index.html', 'floor.html', 'login.html', 'app.js', 'office.webmanifest', 'floor.webmanifest', 'assets/app/icon-512.png',
      'vendor/three/build/three.module.js', 'vendor/three/addons/controls/OrbitControls.js', '_headers', '_routes.json']) assert.ok(has(f), f);
    assert.ok(!has('functions'), 'the root functions/ is what gets deployed, not a copy');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, '_routes.json'), 'utf8')), { version: 1,
      include: ['/', '/index.html', '/floor', '/floor.html', '/login', '/login.html', '/api/*', '/photos/*'], exclude: [] });
    assert.ok(!has('views'), 'views/ is not published as files');
    assert.equal(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), fs.readFileSync(path.join(root, 'views', 'index.html'), 'utf8'));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
