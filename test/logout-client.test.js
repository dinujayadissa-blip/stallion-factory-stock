// Log out in the pages (public/floor.js, public/app.js, public/login.js): only the office PC can end the session
// (the cookie is HttpOnly), so a log out that didn't reach it (no signal) or failed there must leave the person
// where they are, say so, and keep this browser's records — never go to "You're logged out" while the session
// may still work. The pages are plain browser scripts, not modules, so the functions are taken from the files
// as they are and run in a sandbox (node:vm) with a stand-in fetch / localStorage / location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The source of a top-level function: from "[async ]function name(" to the first "}" alone on a line.
function fnSource(file, name) {
  const src = fs.readFileSync(path.join(root, 'public', file), 'utf8');
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  assert.ok(m, `${name}() in ${file}`);
  const end = src.indexOf('\n}\n', m.index);
  assert.ok(end > 0, `end of ${name}() in ${file}`);
  return src.slice(m.index, end + 2);
}

// A sandbox: fetch answers `answer` (a status, or 'offline' = the request never got there).
function sandbox(answer, extra = {}) {
  const store = new Map([['floor.takes', '[1]'], ['floor.lastTake', '{}'], ['floor.lastBooking', '{}'], ['floor.lastVan', '{}'], ['officeName', 'x']]);
  const shown = [];
  const ctx = {
    fetch: async () => {
      if (answer === 'offline') throw new TypeError('Failed to fetch');
      return { ok: answer >= 200 && answer < 300, status: answer, json: async () => (answer >= 400 ? { error: 'Busy — try again in a moment' } : {}) };
    },
    localStorage: { getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k), setItem: (k, v) => store.set(k, String(v)) },
    sessionStorage: { cleared: false, clear() { this.cleared = true; } },
    location: { replaced: null, href: '', hash: '', replace(u) { this.replaced = u; } },
    caches: { keys: async () => ['floor-v1'], delete: async () => true },
    AbortController, setTimeout, clearTimeout,
    flash: (title, sub, o) => shown.push({ title, sub, error: !!o?.error }),
    toast: (msg, err) => shown.push({ title: msg, error: !!err }),
    showError: msg => shown.push({ title: msg, error: true }),
    ...extra,
  };
  ctx.window = ctx;
  return { ctx: vm.createContext(ctx), store, shown };
}
const load = (s, file, names) => { vm.runInContext(names.map(n => fnSource(file, n)).join('\n'), s.ctx); return s.ctx; };
const floorKeys = store => [...store.keys()].filter(k => k.startsWith('floor.'));

test('worker app: a log out that never reached the office PC, or failed there, keeps the person logged in here and says so', async () => {
  for (const answer of ['offline', 500, 403]) {
    const s = sandbox(answer);
    const ctx = load(s, 'floor.js', ['forgetPerson', 'logout']);
    const btn = { disabled: true };
    await ctx.logout(btn);
    assert.equal(ctx.location.replaced, null, `${answer}: stays on this screen`);
    assert.equal(floorKeys(s.store).length, 4, `${answer}: the records are kept`);
    assert.equal(btn.disabled, false, `${answer}: Log out can be tapped again`);
    assert.equal(s.shown.length, 1);
    assert.equal(s.shown[0].error, true);
    assert.match(s.shown[0].title, /Couldn't log out/);
    if (answer === 'offline') assert.match(`${s.shown[0].title} ${s.shown[0].sub}`, /no signal.*Try again when you have signal/);
  }
});

test('worker app: a log out the office PC confirmed clears this phone and goes to "logged out"', async () => {
  const s = sandbox(200);
  const ctx = load(s, 'floor.js', ['forgetPerson', 'logout']);
  await ctx.logout({ disabled: true });
  assert.equal(ctx.location.replaced, '/login?out=1');
  assert.deepEqual(floorKeys(s.store), []);
  assert.equal(s.shown.length, 0);
});

test('worker app: a session that ended (401) clears the person\'s records on the way to the log in page; a new password to choose does not', () => {
  let s = sandbox(200);
  let ctx = load(s, 'floor.js', ['forgetPerson', 'toLogin']);
  ctx.toLogin(true, true);
  assert.deepEqual(floorKeys(s.store), []);
  assert.match(ctx.location.href, /^\/login\?next=%2Ffloor&ended=1$/);
  s = sandbox(200);
  ctx = load(s, 'floor.js', ['forgetPerson', 'toLogin']);
  ctx.toLogin(false);
  assert.equal(floorKeys(s.store).length, 4);
  // api() passes "signed out" for a 401 only
  assert.match(fnSource('floor.js', 'api'), /toLogin\(!!data\.ended, res\.status === 401\)/);
});

test('office app: log out only goes on once the office PC confirmed it, and then clears the worker app\'s records too', async () => {
  for (const answer of ['offline', 500]) {
    const s = sandbox(answer);
    const ctx = load(s, 'app.js', ['logout']);
    await ctx.logout();
    assert.equal(ctx.location.replaced, null, String(answer));
    assert.equal(ctx.sessionStorage.cleared, false);
    assert.equal(s.store.get('officeName'), 'x');
    assert.equal(floorKeys(s.store).length, 4);
    assert.match(s.shown[0].title, /Couldn't log out/);
    assert.equal(s.shown[0].error, true);
  }
  const s = sandbox(200);
  const ctx = load(s, 'app.js', ['logout']);
  await ctx.logout();
  assert.equal(ctx.location.replaced, '/login?out=1');
  assert.equal(ctx.sessionStorage.cleared, true);
  assert.equal(s.store.has('officeName'), false);
  assert.deepEqual(floorKeys(s.store), []);
});

test('log in page ("choose a new password" → Log out): stays and says so unless the office PC confirmed it', async () => {
  for (const answer of ['offline', 500]) {
    const s = sandbox(answer);
    const ctx = load(s, 'login.js', ['call', 'logout']);
    await ctx.logout();
    assert.equal(ctx.location.replaced, null, String(answer));
    assert.match(s.shown[0].title, answer === 'offline' ? /Couldn't log out — no signal/ : /Couldn't log out — Busy/);
  }
  const s = sandbox(200);
  const ctx = load(s, 'login.js', ['call', 'logout']);
  await ctx.logout();
  assert.equal(ctx.location.replaced, '/login?out=1');
});
