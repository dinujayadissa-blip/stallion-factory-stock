'use strict';
// Floor screen for workers: take parts for a van, book in deliveries, find a part.
// Deliberately simple: big buttons, photos, as few taps as possible.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const screen = $('#screen');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const q = n => { const x = Number(n) || 0; return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100); };
// A quantity with its unit, and what one unit is ("2 length (1 length = 6.5 m)").
const qu = (n, it) => `${q(n)} ${esc(it.unit || 'ea')}${it.unit_size ? ` <span class="unitsize">(${esc(it.unit_size)})</span>` : ''}`;
// Where it is kept: the rack, then the shelf / bin ("Rack B · Shelf 3").
const whereText = it => [it.area_name, it.location].filter(Boolean).join(' · ');
const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}` : ''; };
// Today's date on this device's clock (not UTC, which is still "yesterday" on a Victorian morning).
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Follow-up round 1 (worker-r3-2): late vans look late, in the office's words and by the office's rule (owner-r3-1):
// only a van IN PRODUCTION past its due date is late ("due 18/09 · 31 days late", red); a PLANNED van whose date
// has passed has a date to check ("due 08/02 · Date passed – check"), never "N days late".
const daysFromToday = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return null;
  const t = new Date(); return Math.round((new Date(+m[1], +m[2] - 1, +m[3]) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000); };
function dueHtml(v) {
  if (!v || !v.eta) return '';
  const d = daysFromToday(v.eta), when = `due ${fmtDate(v.eta)}`;
  if (v.status === 'planned' && d < 0) return `<span class="due-chk">${when} · Date passed – check</span>`;
  if (v.status === 'in_production' && d < 0) return `<span class="due-late">${when} · ${-d} day${d === -1 ? '' : 's'} late</span>`;
  if (v.status === 'in_production' && d === 0) return `<span class="due-late">due today</span>`;
  return when;
}
const photo = (name, thumb) => name ?`/photos/${encodeURIComponent(thumb ? name.replace(/\.jpg$/, '-t.jpg') : name)}` : '';

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('floor.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('floor.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
// Logins and job roles: who is logged in comes from the office PC (/api/me) — the name is no longer typed in.
// ME = { user: { id, username, name, role, trade }, can: { officeApp, pickTrade, … }, roles }.
let ME = null;
let me = ''; // the logged-in person's name: shown at the top, and on the takes / bookings this phone remembers
// The trade decides which parts and reminders are shown. A worker always sees their own trade (set on their
// login); everyone else picks a trade view, remembered on this phone for that login. 'all' = every trade.
const TRADES = {
  electrician: { label: 'Electrician', icon: '⚡' },
  builder: { label: 'Builder', icon: '🔨' },
  cladding: { label: 'Aluminium & cladding', icon: '🧱' },
  plumber: { label: 'Plumber', icon: '🚿' },
  finisher: { label: 'Finisher', icon: '✨' },
  all: { label: 'Stores / all trades', icon: '📦' },
};
let trade = '';
const tradeKey = () => `trade.${ME?.user?.username || ''}`;
const mine = l => trade === 'all' || l.trade === trade;                 // a part for this worker
const forMe = r => trade === 'all' || !r.trade || r.trade === trade;    // a reminder for this worker
const tradeName = t => (TRADES[t] ? `${TRADES[t].icon} ${TRADES[t].label}` : 'Everyone');
// Another trade's part ("Builder", "🔨"), for a part opened from Find a part → Needed by (worker-r3-7).
const otherTrade = l => (TRADES[l.trade] && l.trade !== 'all' ? TRADES[l.trade].label : 'Other trade');
const otherTradeIcon = l => (TRADES[l.trade] && l.trade !== 'all' ? TRADES[l.trade].icon : '🧰');

// Patchy Wi-Fi: give up after 15 s, and say plainly that a change may or may not have been saved.
async function api(method, url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let res, data;
  try {
    res = await fetch(url, { method, signal: ctl.signal, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    data = await res.json().catch(() => ({}));
  } catch {
    throw new Error(method === 'GET' ? 'No signal — check the Wi-Fi and try again' : 'No signal. Not sure it saved. Check the list before trying again.');
  } finally { clearTimeout(timer); }
  // Not logged in (any more), or a new password to choose first: the log in page, then back here.
  if (res.status === 401 || (res.status === 403 && data.mustChange)) toLogin();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong — try again'), { status: res.status, confirm: data.confirm });
  return data;
}
function toLogin() {
  if (toLogin.going) return;
  toLogin.going = true;
  location.href = `/login?next=${encodeURIComponent(`/floor${location.hash}`)}`;
}
// A one-off id for a request, so a retry isn't booked twice (crypto.randomUUID needs https).
const requestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// ── chrome ──
// Follow-up round 1 (worker-r3-5): on a narrow phone (360px and less, e.g. the 336px app preview) the title uses its
// short word ("Floor", "Delivery") and the name button only the trade icon + first name ("⚡ Sam"); floor.css swaps them.
const SHORT_TITLE = { 'Factory floor': 'Floor', 'Pick the van': 'Vans', 'What arrived?': 'Delivery', 'Find a part': 'Find' };
function setTop(title, back) {
  const short = SHORT_TITLE[title];
  $('#title').innerHTML = short ? `<span class="t-long">${esc(title)}</span><span class="t-short">${esc(short)}</span>` : esc(title);
  $('#title').setAttribute('title', title);
  $('#back').classList.toggle('hidden', !back);
  const [first, ...rest] = String(me || '').trim().split(/\s+/);
  $('#who').innerHTML = me ? `${TRADES[trade]?.icon || '👷'} ${esc(first)}${rest.length ? `<span class="who-rest"> ${esc(rest.join(' '))}</span>` : ''}` : '';
  $('#who').setAttribute('aria-label', me ? `${me} (${TRADES[trade]?.label || 'no trade'}) — change password or log out` : '');
  $('#who').classList.toggle('hidden', !me);
}
$('#back').onclick = () => history.back();
$('#who').onclick = () => { if (ME) whoSheet(); };

// The pop-up at the bottom ("2 × … → ST0367", Undo). Phone batch 2 (C6): above the iPhone home bar, a tap
// or a swipe puts it away, and it goes when the worker opens another screen.
let doneTimer, flashSeq = 0, flashAt = 0;
const hideFlash = () => { clearTimeout(doneTimer); $('#done').classList.add('hidden'); };
function flash(title, sub = '', { undo, error = false } = {}) {
  const el = $('#done');
  flashSeq++;
  flashAt = Date.now();
  el.className = 'done' + (error ? ' err' : '');
  el.innerHTML = `<div class="tick">${error ? '!' : '✓'}</div><div class="msg"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>${undo ? '<button id="undo">Undo</button>' : ''}`;
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => el.classList.add('hidden'), undo ? 9000 : error ? 6000 : 3500);
  if (undo) $('#undo').onclick = async () => { el.classList.add('hidden'); try { await undo(); } catch (e) { flash(e.message, '', { error: true }); } };
  if (navigator.vibrate) navigator.vibrate(error ? [80, 60, 80] : 40);
  return flashSeq;
}

{ // tap or swipe the pop-up away (the Undo button inside it still works)
  const el = $('#done');
  let x0 = null, y0 = null;
  el.addEventListener('click', e => { if (!e.target.closest('button')) hideFlash(); });
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 == null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = y0 = null;
    if (Math.abs(dx) > 40 || dy > 30) hideFlash();
  });
}

// ── Panels (bottom sheets) and the phone's Back button (phone batch 2, C6 + C8) ──
// Opening a panel adds a history step ({sheet: id}): Back closes the panel and the worker stays on the van.
// Closing it any other way takes that step off again quietly. Every panel gets a 48px × at the top right;
// its main button + Cancel (.sheet-actions) stay at the bottom of the screen.
history.scrollRestoration = 'manual'; // route() keeps the van list's scroll itself
let sheetSeq = 0, sheetId = 0, skipPops = 0;
const quietBack = () => { skipPops++; history.back(); };
const deadSheetStep = () => { const st = history.state?.sheet; return !!st && st !== sheetId; };
function closeSheet({ fromPop = false } = {}) {
  const id = sheetId;
  if (!id) return;
  sheetId = 0;
  $('#sheet').classList.add('hidden');
  document.body.classList.remove('sheet-open');
  if (!fromPop) setTimeout(() => { if (history.state?.sheet === id) quietBack(); }, 0);
}
window.addEventListener('popstate', e => {
  if (skipPops > 0) { skipPops--; return; }
  if (sheetId && e.state?.sheet !== sheetId) closeSheet({ fromPop: true });
});
if (history.state?.sheet) quietBack(); // reloaded with a panel open: drop its step (same screen under it)

function sheet(html) {
  const bg = $('#sheet');
  const el = $('.sheet', bg);
  // Round 2 (worker-r1-1): opening a panel always puts the last pop-up away, straight away — its Undo sat
  // right where the next panel's Take button is. The van's "Undo last" banner (and Delivery's "Undo last
  // booking") still undo it. A pop-up shown while a panel is open goes to the top (body.sheet-open).
  hideFlash();
  document.body.classList.add('sheet-open');
  el.innerHTML = `<button class="sheet-x" data-close aria-label="Close">×</button>${html}`;
  el.classList.toggle('has-actions', !!$('.sheet-actions', el));
  const wasOpen = !!sheetId;
  const id = sheetId = ++sheetSeq;
  bg.classList.remove('hidden');
  el.scrollTop = 0;
  // One step per panel: a panel opened from another one (or straight after one closed) re-uses its step.
  if (wasOpen || deadSheetStep()) history.replaceState({ sheet: id }, ''); else history.pushState({ sheet: id }, '');
  const close = () => { if (sheetId === id) closeSheet(); };
  bg.onclick = e => { if (e.target === bg) close(); };
  $$('[data-close]', bg).forEach(b => { b.onclick = close; });
  return { el, close };
}

function stepper(el, start, onChange) {
  const input = $('input', el);
  input.value = q(start);
  const set = v => { input.value = q(Math.max(0, v)); onChange?.(Number(input.value)); };
  $('[data-minus]', el).onclick = () => set(Number(input.value) - 1);
  $('[data-plus]', el).onclick = () => set(Number(input.value) + 1);
  input.oninput = () => onChange?.(Number(input.value));
  return () => Number(input.value);
}
const STEPPER = `<div class="stepper"><button data-minus aria-label="One less">−</button><input type="number" inputmode="decimal" min="0" step="any" aria-label="Quantity"><button data-plus aria-label="One more">+</button></div>`;

let itemsCache = null;
async function allItems() {
  if (!itemsCache) itemsCache = await api('GET', '/api/items');
  return itemsCache;
}
function itemSearch(list, text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter(i => words.every(w => `${i.name} ${i.sku} ${i.supplier} ${i.category}`.toLowerCase().includes(w)));
}
const partThumb = p => p ? `<img src="${photo(p, true)}" alt="" loading="lazy">` : '<div class="ph">📦</div>';

// Round 2 (worker-r1-3): a search box with a 48px "×" that shows while it has text (gloves can't select text).
const searchBox = (id, placeholder, attrs = '') => `<div class="search-wrap"><input class="search" id="${id}" type="search" placeholder="${esc(placeholder)}" ${attrs}>
  <button type="button" class="search-x hidden" aria-label="Clear search">×</button></div>`;
// Wires the box to `draw` (typing or ×). Returns sync(): call it after setting the value from code.
function wireSearch(input, draw) {
  const x = $('.search-x', input.parentElement);
  const sync = () => x.classList.toggle('hidden', !input.value);
  input.oninput = () => { sync(); draw(); };
  x.onclick = () => { input.value = ''; sync(); draw(); };
  sync();
  return sync;
}
// "No parts match "victron…"" + a big Clear search button (the button carries data-clear).
const noMatch = (text, where = '') => `No parts match "${esc(text.length > 24 ? text.slice(0, 24) + '…' : text)}"${where}<button type="button" class="clear-search" data-clear>× Clear search</button>`;

// ── screens ──
// Logins and job roles: the old "What's your name?" screen is gone — the name comes from the login.
// A worker's trade is fixed on their login. Everyone else (stores, leading hand, office, owner) picks which
// trade's parts to see the first time on this phone; the name button at the top changes it.
const tradeButtons = () => `<div class="trades" role="group" aria-label="Whose parts to show">${Object.entries(TRADES).map(([k, t]) =>
  `<button type="button" class="pick ${k === trade ? 'on' : ''}" data-t="${k}" aria-pressed="${k === trade}"><span class="ticon" aria-hidden="true">${t.icon}</span><b>${esc(t.label)}</b></button>`).join('')}</div>`;
function setTrade(t) {
  if (!TRADES[t] || ME?.user?.role === 'worker') return;
  trade = t;
  store.set(tradeKey(), t);
}
function tradeScreen() {
  if (ME.user.role === 'worker') { location.hash = '#home'; return; }
  setTop('Welcome', false);
  screen.innerHTML = `<div class="namebox card">
      <h2 style="margin-top:4px">Hi ${esc(me)}</h2>
      <div class="muted" style="margin-bottom:10px">Whose parts do you want to see? This phone remembers it — tap your name at the top to change it.</div>
      ${tradeButtons()}</div>`;
  $$('[data-t]').forEach(b => { b.onclick = () => { setTrade(b.dataset.t); location.hash = '#home'; }; });
}

// The name button at the top: who is logged in, the trade view (not for workers), Change password, Log out.
function whoSheet() {
  const u = ME.user;
  const s = sheet(`<h3>${esc(u.name)}</h3>
    <div class="info">${esc(ME.roles?.[u.role] || u.role)}${u.role === 'worker' ? ` · ${tradeName(u.trade)}` : ''}</div>
    ${ME.can?.pickTrade ? `<div class="info" style="margin:14px 0 8px">Show the parts of:</div>${tradeButtons()}` : ''}
    <div class="who-acts">
      ${ME.can?.officeApp ? '<a class="pick who-act" href="/">🖥 <b>Office app</b></a>' : ''}
      <button type="button" class="pick who-act" id="w-pw">🔑 <b>Change password</b></button>
      <button type="button" class="pick who-act" id="w-out">↪ <b>Log out</b></button></div>
    <button type="button" class="cancel" data-close>Close</button>`);
  $$('[data-t]', s.el).forEach(b => { b.onclick = () => { setTrade(b.dataset.t); s.close(); itemsCache = null; route(); }; });
  $('#w-pw', s.el).onclick = () => passwordSheet();
  $('#w-out', s.el).onclick = e => { e.currentTarget.disabled = true; logout(); };
}

function passwordSheet() {
  const s = sheet(`<h3>Change your password</h3>
    <label class="info" for="pw0" style="display:block;margin-top:10px">Your password now</label>
    <input class="search" id="pw0" type="password" autocomplete="current-password" maxlength="200">
    <label class="info" for="pw1" style="display:block;margin-top:10px">New password (at least 8 characters)</label>
    <input class="search" id="pw1" type="password" autocomplete="new-password" maxlength="200">
    <label class="info" for="pw2" style="display:block;margin-top:10px">New password again</label>
    <input class="search" id="pw2" type="password" autocomplete="new-password" maxlength="200">
    <div class="info" style="margin-top:8px">Your other phones and PCs are logged out; this phone stays logged in.</div>
    <div class="sheet-actions"><button type="button" class="go-btn" id="pw-save">Change password</button><button type="button" class="cancel" data-close>Cancel</button></div>`);
  $('#pw-save', s.el).onclick = async e => {
    const cur = $('#pw0', s.el).value, n1 = $('#pw1', s.el).value, n2 = $('#pw2', s.el).value;
    if (!cur) return flash('Type your password now', '', { error: true });
    if (n1.length < 8) return flash('Use at least 8 characters', 'for the new password', { error: true });
    if (n1 !== n2) return flash("The two new passwords aren't the same", '', { error: true });
    e.target.disabled = true;
    try { await api('POST', '/api/me/password', { current: cur, password: n1 }); s.close(); flash('Password changed'); }
    catch (err) { e.target.disabled = false; flash(err.message, '', { error: true }); }
  };
}

// Log out: the session ends on the office PC, and the screens kept on this phone for no-signal use are
// cleared, so the next person sees nothing of the last one.
async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* logged out here anyway */ }
  // What this phone remembered for the person (their takes / bookings to undo, the last van) goes too, so the
  // next person on a shared phone doesn't see it.
  for (const k of ['takes', 'lastTake', 'lastBooking', 'lastVan']) { try { localStorage.removeItem(`floor.${k}`); } catch { /* private mode */ } }
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch { /* none */ }
  location.replace('/login?out=1');
}

// Home: the factory floor map. Each van's red badge = parts left for my trade, orange = my reminders.
async function homeScreen() {
  setTop('Factory floor', false);
  const layout = await api('GET', `/api/floor/map?trade=${encodeURIComponent(trade)}`);
  const kinds = new Map(layout.areas.map(a => [a.id, a.kind]));
  const placed = new Set(layout.areas.filter(a => FactoryMap.PARK.has(a.kind)).map(a => a.id));
  const loose = layout.vans.filter(v => !placed.has(v.area_id));
  // Phones (phone batch 2, C7): "Back to my van", then the bay vans as cards in bay order, the badge key,
  // the map fitted to the screen behind "Show map", the yard, then "Not on the floor". A PC or tablet keeps
  // the map at the top (the phone-only pieces are hidden there by floor.css).
  const names = new Map(layout.areas.map(a => [a.id, a.name]));
  const sorted = byArea(layout.vans, names);
  const bayVans = sorted.filter(v => kinds.get(v.area_id) === 'bay');
  const yardVans = sorted.filter(v => kinds.get(v.area_id) === 'yard');
  const last = store.get('lastVan', null);
  const lastV = last && layout.vans.find(v => v.id === last.id);
  const showMap = store.get('homeMap', false);
  const where = v => names.get(v.area_id) || '';
  const legend = '<span><i style="background:#d92d20"></i>your parts left</span><span><i style="background:#e8890c"></i>reminders for you</span>';
  screen.innerHTML = `
    ${lastV ? `<button class="big primary back-van ph-only" data-id="${lastV.id}"><span class="ic">↩</span><span><span class="t">Back to ${esc(lastV.chassis)}${where(lastV) ? ` (${esc(where(lastV))})` : ''}</span>
      <span class="d">${lastV.missing ? `${lastV.missing} part${lastV.missing === 1 ? '' : 's'} left for you` : 'Nothing left for you'}</span></span></button>` : ''}
    <div class="hello"><div><b>Hi ${esc(me)}</b> <span class="muted">· ${tradeName(trade)}</span></div>
      <div class="small muted">You took <b id="s-me">–</b> part<span id="s-me-s">s</span> today · team took <b id="s-team">–</b></div></div>
    <div class="quick">
      <button data-go="#vans">📋 Van list</button><button data-go="#receive">📦 Delivery</button><button data-go="#find">🔍 Find a part</button></div>
    ${bayVans.length ? `<div class="ph-only bay-vans"><h2>In the bays</h2>${bayVans.map(v => vanCard(v, false, where(v))).join('')}</div>` : ''}
    <div class="maplegend small muted ph-only">${legend}</div>
    <button class="map-tog ph-only" id="maptog" aria-expanded="${showMap}">${showMap ? 'Hide map' : '🗺 Show map'}</button>
    <div class="card map-card ${showMap ? 'map-open' : ''}" style="padding:6px"><div id="vmap"></div></div>
    <div class="maplegend small muted pc-only">${legend}<span>Tap a van</span></div>
    ${yardVans.length ? `<div class="ph-only"><h2>In the yard</h2>${yardVans.map(v => vanCard(v, false, where(v))).join('')}</div>` : ''}
    ${loose.length ? `<h2>Not on the floor</h2>${loose.map(v => vanCard(v)).join('')}` : ''}`;
  // Follow-up round 1 (worker-r3-6): on a phone the map is fitted to the screen, so the van tags are drawn bigger
  // (no small "% fitted" line), a tap anywhere on a van's spot or within a 48px box round it opens it, and two
  // fingers zoom in. A PC / tablet keeps the full-size map as it was.
  const phoneMap = matchMedia('(max-width: 600px)').matches;
  FactoryMap.render($('#vmap'), layout, { mode: 'pick', onVan: v => { location.hash = `#van/${v.id}`; },
    ...(phoneMap ? { bigTags: true, minTap: 48, pinchZoom: true } : { minTap: 44 }) });
  $('#maptog').onclick = e => {
    const open = !$('.map-card').classList.contains('map-open');
    $('.map-card').classList.toggle('map-open', open);
    e.currentTarget.textContent = open ? 'Hide map' : '🗺 Show map';
    e.currentTarget.setAttribute('aria-expanded', String(open));
    store.set('homeMap', open);
  };
  $$('[data-go]').forEach(b => { b.onclick = () => { location.hash = b.dataset.go; }; });
  $$('.van[data-id], .back-van').forEach(b => { b.onclick = () => { location.hash = `#van/${b.dataset.id}`; }; });
  try {
    const s = await api('GET', '/api/floor/stats');
    // Phone round 1 (C9): "You took 2 parts today · team took 5" (takes only, not deliveries).
    $('#s-me').textContent = s.mine_took ?? s.mine; $('#s-team').textContent = s.team_took ?? s.team;
    $('#s-me-s').textContent = (s.mine_took ?? s.mine) === 1 ? '' : 's';
  } catch { /* stats are a bonus */ }
}

// Vans in bay / yard order (Bay 1, Bay 2 … Yard 1 …), then the ones not on the floor.
const byArea = (vans, names) => [...vans].sort((a, b) => (names.get(a.area_id) || 'zz').localeCompare(names.get(b.area_id) || 'zz', undefined, { numeric: true }));

// One van as a card: what's left for my trade and my reminders. `where` = its bay ("Bay 1 · ST0377").
// Round 2 (worker-r1-2): "25 parts left for you · 8 on shelf · 17 not on shelf" — the two numbers are the
// van screen's "Shelf" and "None" tabs, so they always add up to the parts left. Follow-up round 1 (worker-r3-9): on a
// phone that's two lines ("24 parts left for you" / "9 on shelf · 15 not on shelf") and the "⏰ 4 reminders" badge
// gets a line of its own, so nothing wraps under it or starts a line with "·" (floor.css).
function vanCard(v, withText = false, where = '') {
  const shelf = Math.min(v.ready || 0, v.missing || 0), notShelf = Math.max(0, (v.missing || 0) - shelf);
  return `<button class="van" data-id="${v.id}" ${withText ? `data-text="${esc((v.chassis + ' ' + v.model + ' ' + v.customer).toLowerCase())}"` : ''}>
    <div class="row1">${where ? `<span class="bay">${esc(where)} ·</span>` : ''}<span class="ch">${esc(v.chassis)}</span><span class="due">${dueHtml(v)}</span></div>
    <div class="m">${esc(v.length)} ${esc(v.model)}</div>
    <div class="nums"><span class="nums-parts">${v.missing ? `<span class="nleft"><b>${v.missing}</b> part${v.missing === 1 ? '' : 's'} left for you</span>${shelf || notShelf ? `<span class="nsep"> · </span><span class="nshelf">${shelf ? `<span class="ready">${shelf} on shelf</span>` : ''}${shelf && notShelf ? ' · ' : ''}${notShelf ? `<span class="still">${notShelf} not on shelf</span>` : ''}</span>` : ''}` : '✓ nothing left for you'}</span>
      ${v.reminders ? `<span class="rem-n">⏰ ${v.reminders} reminder${v.reminders > 1 ? 's' : ''}</span>` : ''}</div>
  </button>`;
}

async function vansScreen() {
  setTop('Pick the van', true);
  const layout = await api('GET', `/api/floor/map?trade=${encodeURIComponent(trade)}`);
  const names = new Map(layout.areas.map(a => [a.id, a.name]));
  const vans = byArea(layout.vans, names);
  screen.innerHTML = `${searchBox('vs', 'Search chassis or model…')}
    <div id="vl">${vans.map(v => vanCard(v, true).replace('<div class="m">', `<div class="m">${names.get(v.area_id) ? `📍 ${esc(names.get(v.area_id))} · ` : ''}`)).join('') || '<div class="empty">No vans in production.</div>'}</div>`;
  wireSearch($('#vs'), () => { const t = $('#vs').value.toLowerCase(); $$('#vl .van').forEach(b => b.classList.toggle('hidden', !!t && !b.dataset.text.includes(t))); });
  $$('#vl .van').forEach(b => { b.onclick = () => { location.hash = `#van/${b.dataset.id}`; }; });
}

// Customer supplies / to be decided: only "on the shelf" if something is actually kept for this van.
const lineState = l => l.issued >= l.qty ? 'done'
  : (l.reserved > 0 || (l.free > 0 && !['customer', 'tbd'].includes(l.state))) ? 'go' : 'none';
// Phone round 1 (C9): on the shelf, but every one is set aside for other vans (the server lists them).
// Told plainly — "set aside for ST0367, ST0380 — ask before taking" — instead of "none on the shelf".
const heldElsewhere = l => lineState(l) === 'none' && !['customer', 'tbd'].includes(l.state) && Array.isArray(l.held_by) && l.held_by.length > 0;
const heldText = l => `On shelf but set aside for ${l.held_by.slice(0, 3).join(', ')}${l.held_by.length > 3 ? ` +${l.held_by.length - 3} more` : ''} — ask before taking`;

// The last part this phone took, so a wrong take can still be undone once the worker is at the van.
const UNDO_MS = 15 * 60 * 1000; // the server allows Undo for 15 minutes
// Round 2 (worker-r1-4): each take remembers who took it (`by`); "Undo last" and "Taken from this phone
// today" only offer the takes of the name on the phone now — after Sam hands the phone to Ben, Ben doesn't
// see Sam's heater. Switching back to Sam brings them back. (Takes saved before this change have no name
// and are no longer offered.)
const lastTake = () => { const t = store.get('lastTake', null); return t && t.by === me && Date.now() - t.at < UNDO_MS ? t : null; };
// Every take from this phone today (phone round 1, C11): the Done tab offers "Put back on shelf" for them.
const todaysTakes = () => store.get('takes', []).filter(t => t && t.day === localToday());
const myTakes = () => todaysTakes().filter(t => t.by === me);
const forgetTake = id => {
  store.set('takes', todaysTakes().filter(t => t.movement_id !== id));
  if (store.get('lastTake', null)?.movement_id === id) store.set('lastTake', null);
};
const clock = at => { const d = new Date(at); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

// putBack: from the Done tab, for a take earlier today (the server allows it until the end of the day).
async function undoTake(t, { putBack = false } = {}) {
  // line_id / van_id too (sp-r1-5): the server refuses if that number is now some other take.
  await api('POST', '/api/floor/undo', { movement_id: t.movement_id, line_id: t.line_id, van_id: t.van_id, ...(putBack ? { put_back: true } : {}) });
  forgetTake(t.movement_id);
  flash(putBack ? 'Put back on the shelf' : 'Undone', `${q(t.qty)} × ${t.name} is back on the shelf`);
  route({ keep: true });
}

// Phone round 1 (C9): which tab the van opens on. Kept only while the worker stays on the same van (a
// redraw after a take, Back from a panel); another van — or a restart — opens on "On shelf" if it has any.
let vanView = { id: 0, filter: '', remsOpen: false };
// "Needed by" in Find a part: open that van with its search set to the part.
let pendingFind = null;

// `kept`: re-drawing the same van after a change — keep the search text and scroll position.
async function vanScreen(vanId, kept = null) {
  const data = await api('GET', `/api/floor/vans/${vanId}`);
  const van = data.van;
  const focus = pendingFind && pendingFind.van === van.id ? pendingFind : null;
  pendingFind = null;
  const same = vanView.id === van.id;
  // Only my trade's parts — and the part asked about from Find a part, whoever's it is. Follow-up round 1
  // (worker-r3-7): that part stays on this van's list while the worker is on it, so after taking it for another
  // trade it shows under Done (with its trade on it) instead of vanishing and the count dropping.
  const alsoItem = focus ? focus.item : same ? vanView.alsoItem || null : null;
  const lines = data.lines.filter(l => mine(l) || (alsoItem && l.item_id === alsoItem));
  const reminders = (data.reminders || []).filter(forMe);
  store.set('lastVan', { id: van.id, chassis: van.chassis });
  setTop(van.chassis, true);
  const counts = { go: 0, none: 0, done: 0 };
  lines.forEach(l => counts[lineState(l)]++);
  const others = lines.filter(l => !mine(l)); // another trade's part, opened from Find a part (worker-r3-7)
  let filter = same && vanView.filter ? vanView.filter : counts.go ? 'go' : counts.none ? 'none' : 'all';
  if (filter === 'go' && !counts.go) filter = counts.none ? 'none' : 'all';
  if (focus) filter = 'all';
  // findText: opened from Find a part → Needed by, with the search set to that part; a take clears it (worker-r1-3).
  vanView = { id: van.id, filter, remsOpen: same ? vanView.remsOpen : false, findText: focus ? focus.text : same ? vanView.findText || '' : '', alsoItem };
  const pct = lines.length ? Math.round(counts.done / lines.length * 100) : 0;
  const today = localToday();
  const undoable = lastTake();
  const lastHere = undoable && undoable.van_id === van.id ? undoable : null;
  const lateRems = reminders.filter(r => r.due && r.due <= today).length;
  // "⏰ 4 reminders · 1 due". Follow-up round 1 (worker-r3-1): re-counted straight after a tick, from the cards left.
  const remsLabel = (n, due) => n ? `⏰ ${n} reminder${n > 1 ? 's' : ''}${due ? ` · ${due} due` : ''}` : '✓ No reminders left';
  const recountRems = () => {
    const tog = $('#remtog');
    if (!tog) return;
    const left = $$('#rems .remcard'), due = left.filter(c => c.classList.contains('late')).length;
    $('.rems-n', tog).textContent = remsLabel(left.length, due);
    tog.classList.toggle('late', due > 0);
    tog.classList.toggle('none-left', !left.length);
    if (!left.length) { vanView.remsOpen = false; $('#rems').classList.remove('open'); tog.setAttribute('aria-expanded', 'false'); $('.chev', tog).textContent = ''; tog.disabled = true; }
  };
  const chip = (f, long, short) =>`<button type="button" data-f="${f}" aria-label="${esc(long)}"><span class="cl">${esc(long)}</span><span class="cs" aria-hidden="true">${esc(short)}</span></button>`;

  screen.innerHTML = `
    <div class="card"><div class="small muted">${esc(van.length)} ${esc(van.model)}${van.eta ? ` · ${dueHtml(van)}` : ''}</div>
      ${van.area_name ? `<div class="small" style="margin-top:4px">📍 <b>${esc(van.area_name)}</b></div>` : ''}
      <div class="bar" style="margin:10px 0 6px"><i style="width:${pct}%"></i></div>
      <div class="row-between"><div class="small"><b>${counts.done}</b> of ${lines.length} ${trade === 'all' ? '' : others.length ? '' : 'of your '}parts done${others.length
        ? ` <span class="muted">(${lines.length - others.length} yours + ${others.length === 1 ? `1 ${esc(otherTrade(others[0]))} part` : `${others.length} other trades' parts`})</span>` : ''}</div>
        <button type="button" class="notes-btn" id="notes">📝 Notes${van.notes ? ` (${van.notes})` : ''}</button></div></div>
    ${reminders.length ? `<button type="button" class="rems-tog ph-only ${lateRems ? 'late' : ''}" id="remtog" aria-expanded="${vanView.remsOpen}" aria-controls="rems">
        <span class="rems-n">${remsLabel(reminders.length, lateRems)}</span><span class="chev" aria-hidden="true">${vanView.remsOpen ? '▴' : '▾'}</span></button>
      <div class="rems ${vanView.remsOpen ? 'open' : ''}" id="rems">${reminders.map(r => `<div class="remcard ${r.due && r.due <= today ? 'late' : ''}" data-rid="${r.id}">
        <div class="grow"><div class="rtext">${esc(r.text)}</div>
          <div class="small muted">${r.due ? `${r.due < today ? 'overdue · ' : ''}${fmtDate(r.due)} · ` : ''}${r.trade ? tradeName(r.trade) : 'Everyone'}</div></div>
        <button type="button" class="remdone" aria-label="Mark done">✓</button></div>`).join('')}</div>` : ''}
    ${lastHere ? `<button type="button" class="undo-last" id="undolast">↩ Undo ${esc(me)}'s last take: ${q(lastHere.qty)} × ${esc(lastHere.name)} for ${esc(lastHere.chassis)}</button>` : ''}
    <div class="chips">
      ${chip('go', `On shelf · ${counts.go}`, `Shelf ${counts.go}`)}
      ${chip('none', `None for this van · ${counts.none}`, `None ${counts.none}`)}
      ${chip('done', `Done · ${counts.done}`, `Done ${counts.done}`)}
      ${chip('all', 'All', 'All')}</div>
    ${searchBox('ps', 'Search parts on this van…')}
    <div class="parts" id="pl"></div>
    <button type="button" class="add-extra" id="extra">+ I took a part that's not on this list</button>
    <button type="button" class="back-vans" id="backvans">‹ Back to vans</button>`;

  const draw = () => {
    $$('.chips button').forEach(b => { b.classList.toggle('on', b.dataset.f === filter); b.setAttribute('aria-pressed', String(b.dataset.f === filter)); });
    const t = $('#ps').value.toLowerCase();
    const shown = lines.filter(l => (filter === 'all' || lineState(l) === filter) &&
      (!t || `${l.name} ${l.sku} ${l.spec} ${l.col}`.toLowerCase().includes(t)));
    $('#pl').innerHTML = shown.map(l => {
      const st = lineState(l);
      const left = l.qty - l.issued;
      const tag = st === 'done' ? '<span class="tag done">✓ Taken</span>'
        : st === 'go' ? `<span class="tag go">On shelf${whereText(l) ? ` · ${esc(whereText(l))}` : ''}</span>`
        : l.state === 'customer' ? '<span class="tag none">Customer supplies</span>'
        : l.state === 'tbd' ? '<span class="tag none">To be decided – ask the office</span>'
        : heldElsewhere(l) ? '<span class="tag held">Set aside for other vans</span>'
        : l.order ? `<span class="tag oo">On order${l.order.expected ? ` · due ${fmtDate(l.order.expected)}` : ''}</span>` // worker-r3-3
        : l.plan_ordered ? '<span class="tag pcheck">Plan says ordered – ask the office</span>'
        : '<span class="tag none">Not in stock</span>';
      return `<button type="button" class="part ${st === 'done' ? 'isdone' : ''}" data-id="${l.id}">${partThumb(l.photo)}
        <div><div class="nm">${esc(l.name)}</div>
        ${l.plan_column ? `<div class="sub forcol">for: ${esc(l.plan_column)}</div>` : ''}
        ${mine(l) ? '' : `<div class="sub other-trade">${otherTradeIcon(l)} ${esc(otherTrade(l))} part${st === 'done' ? ' — on their list' : ''}</div>`}
        <div class="sub">${st === 'done' ? `${qu(l.issued, l)} taken` : `Need ${qu(left, l)}`}${l.spec && l.spec !== l.name ? ` · ${esc(l.spec.slice(0, 60))}` : ''}</div>${tag}</div></button>`;
    }).join('') || `<div class="empty">${!lines.length ? `No ${TRADES[trade]?.label.toLowerCase() || ''} parts on this van.`
      : t ? noMatch($('#ps').value.trim(), filter === 'all' ? '' : ' in this tab') // round 2 (worker-r1-3): the search hides them
      : filter === 'go' ? 'Nothing on the shelf for you on this van right now.' : 'Nothing here.'}</div>`;
    $$('#pl .part').forEach(b => { b.onclick = () => takeSheet(van, lines.find(l => l.id === Number(b.dataset.id))); });
    const clr = $('#pl [data-clear]');
    if (clr) clr.onclick = () => { $('#ps').value = ''; syncX(); draw(); };
  };
  $$('.chips button').forEach(b => { b.onclick = () => { filter = b.dataset.f; vanView.filter = filter; draw(); }; });
  const syncX = wireSearch($('#ps'), draw);
  $('#extra').onclick = () => extraSheet(van, data.lines);
  $('#notes').onclick = () => notesSheet(van);
  $('#backvans').onclick = () => { location.hash = '#vans'; };
  const tog = $('#remtog');
  if (tog) tog.onclick = () => {
    vanView.remsOpen = !vanView.remsOpen;
    $('#rems').classList.toggle('open', vanView.remsOpen);
    tog.setAttribute('aria-expanded', String(vanView.remsOpen));
    $('.chev', tog).textContent = vanView.remsOpen ? '▴' : '▾';
  };
  if (lastHere) $('#undolast').onclick = async e => {
    e.target.disabled = true;
    try { await undoTake(lastHere); }
    catch (err) {
      e.target.disabled = false;
      if (err.status === 400 || err.status === 404) { forgetTake(lastHere.movement_id); e.target.remove(); } // too late / already undone
      flash(err.message, '', { error: true });
    }
  };
  $$('.remcard').forEach(c => {
    // phones: one line each, tap the text to read it all
    $('.grow', c).onclick = () => c.classList.toggle('full');
    const btn = $('.remdone', c);
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('PUT', `/api/reminders/${c.dataset.rid}`, { done: true });
        c.remove();
        recountRems(); // worker-r3-1: "⏰ 3 reminders" straight away (Undo redraws the van with it back)
        flash('Reminder done', `on ${van.chassis}`, {
          undo: async () => { await api('PUT', `/api/reminders/${c.dataset.rid}`, { done: false }); flash('Reminder is back', `on ${van.chassis}`); route({ keep: true }); },
        });
      } catch (e) { btn.disabled = false; flash(e.message, '', { error: true }); }
    };
  });
  if (kept) $('#ps').value = kept.search;
  else if (focus) $('#ps').value = focus.text;
  syncX();
  draw();
  if (kept) window.scrollTo(0, kept.y);
  return data.lines;
}

// Follow-up round 1 (worker-r3-10): a note's time the way the rest of the worker screen writes dates — "19/10 3:05 pm"
// (saved in the office PC's local time, "2026-10-19 15:05:12"), then who wrote it.
const noteWhen = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
  if (!m) return String(s || '').slice(0, 16);
  const h = Number(m[4]);
  return `${m[3]}/${m[2]} ${h % 12 || 12}:${m[5]} ${h < 12 ? 'am' : 'pm'}`;
};
// Read and add notes for the van (shared with the office).
async function notesSheet(van) {
  const f = await api('GET', `/api/vans/${van.id}/floor`);
  const s = sheet(`<h3>Notes — ${esc(van.chassis)}</h3>
    <textarea id="nt" class="search" rows="3" placeholder="e.g. Window on door side is cracked, needs replacing" style="margin-top:10px;resize:vertical"></textarea>
    <button type="button" class="go-btn" id="nadd">Add note</button>
    <div style="margin-top:16px">${f.notes.map(n => `<div class="pick" style="display:block"><div>${esc(n.text).replace(/\n/g, '<br>')}</div>
      <div class="small muted" style="margin-top:4px">${esc(noteWhen(n.created_at))} · ${n.worker ? esc(n.worker) : 'name not saved'}</div></div>`).join('') || '<div class="empty">No notes yet.</div>'}
    ${f.reminders.filter(r => !r.done).map(r => `<div class="note">⏰ ${esc(r.text)}${r.due ? ` — ${fmtDate(r.due)}` : ''}</div>`).join('')}</div>
    <button type="button" class="cancel" data-close>Close</button>`);
  $('#nadd', s.el).onclick = async e => {
    const text = $('#nt', s.el).value.trim();
    if (!text) return $('#nt', s.el).focus();
    e.target.disabled = true;
    try { await api('POST', `/api/vans/${van.id}/notes`, { text }); s.close(); flash('Note saved', `on ${van.chassis}`); route({ keep: true }); }
    catch (err) { e.target.disabled = false; flash(err.message, '', { error: true }); }
  };
}

// Follow-up round 1 (worker-r3-3): is it coming? "1 on order from Onex · due 02/11" (or "due date not known"), so
// the worker knows to wait for it; "The plan says it was ordered (Onex 08) …" when the office hasn't confirmed it yet.
function orderNote(l) {
  const o = l.order;
  if (o) return `<div class="note oo">📦 <b>${q(o.qty)} on order${o.suppliers.length ? ` from ${esc(o.suppliers.join(' / '))}` : ''}</b> · ${o.expected ? `due ${fmtDate(o.expected)}` : 'due date not known'}</div>`;
  if (l.plan_ordered) return `<div class="note pcheck">The plan says it was ordered (“${esc(l.plan_ordered)}”), but the office hasn't confirmed the order yet. Ask the office if you need it now.</div>`;
  return '';
}

function takeSheet(van, l) {
  const left = Math.max(0, l.qty - l.issued);
  const st = lineState(l);
  const held = heldElsewhere(l);
  // Takes of this part from this phone today (phone round 1, C11): each can be put back on the shelf.
  const fromHere = myTakes().filter(t => t.line_id === l.id);
  // …and by someone else on this phone (round 2, worker-r1-4): named, not offered.
  const byOthers = [...new Set(todaysTakes().filter(t => t.line_id === l.id && t.by && t.by !== me).map(t => t.by))];
  const s = sheet(`
    ${l.photo ? `<img class="photo" src="${photo(l.photo)}" alt="">` : ''}
    <h3>${esc(l.name)}</h3>
    ${l.plan_column ? `<div class="info forcol">for: ${esc(l.plan_column)}</div>` : ''}
    <div class="info">${esc(l.sku)}</div>
    ${whereText(l) ? `<div class="info" style="font-size:18px;color:var(--ink)">📍 <b>${esc(whereText(l))}</b></div>` : ''}
    ${l.spec && l.spec !== l.name ? `<div class="info">${esc(l.spec)}</div>` : ''}
    ${mine(l) ? '' : `<div class="note other-trade">${otherTradeIcon(l)} This is a <b>${esc(otherTrade(l))}</b> part — you're taking it for them. It stays on this van's list under Done.</div>`}
    <div class="info">${st === 'done' ? `All ${qu(l.qty, l)} already taken` : `This van needs ${qu(left, l)} more`}</div>
    ${st !== 'done' ? orderNote(l) : ''}
    ${held ? `<div class="note held">${esc(heldText(l))}</div>`
      : st === 'none' ? `<div class="note">The system shows none on the shelf${l.order ? ' yet' : ''}. If you have it in your hand, take it anyway — the count gets fixed and the office sees it.</div>` : ''}
    ${fromHere.length ? `<div class="putback"><div class="info">Taken from this phone today:</div>
      ${fromHere.map(t => `<button type="button" class="pick pb" data-mv="${t.movement_id}"><span class="grow"><b>${q(t.qty)} × at ${clock(t.at)}</b></span>
        <span class="pb-act">↩ Put back on shelf</span></button>`).join('')}</div>`
      : byOthers.length ? `<div class="note">Taken by ${esc(byOthers.join(', '))} — only they can put it back from this phone. Or ask the office.</div>`
      : st === 'done' && l.issued > 0 ? '<div class="note">Taken earlier — too late to put it back from here. Ask the office.</div>' : ''}
    ${st === 'done' ? '<div class="info" style="margin-top:10px">Need another one (broken, lost)?</div>' : ''}
    ${STEPPER}
    <div class="sheet-actions"><button type="button" class="go-btn ${st === 'done' ? 'quiet' : ''}" id="take"></button>
    <button type="button" class="cancel" data-close>Cancel</button></div>`);
  // worker-r3-7: taken for another trade → the pop-up says where it went, so the take doesn't look lost
  const forThem = mine(l) ? '' : `Taken for ${TRADES[l.trade] && l.trade !== 'all' ? `the ${otherTrade(l)}` : 'another trade'} — it's on their list, and under Done here`;
  const label = n => `Take ${q(n)} ${l.unit && l.unit !== 'ea' ? `${l.unit} ` : ''}${st === 'done' ? 'more ' : ''}for ${van.chassis}`;
  const get = stepper(s.el, left || 1, n => { $('#take', s.el).textContent = label(n); $('#take', s.el).disabled = !(n > 0); });
  $('#take', s.el).textContent = label(get());
  $$('[data-mv]', s.el).forEach(b => { b.onclick = async () => {
    const t = fromHere.find(x => x.movement_id === Number(b.dataset.mv));
    $$('[data-mv]', s.el).forEach(x => { x.disabled = true; });
    try { await undoTake(t, { putBack: true }); }
    catch (err) {
      if (err.status === 400 || err.status === 404) { forgetTake(t.movement_id); s.close(); route({ keep: true }); }
      else $$('[data-mv]', s.el).forEach(x => { x.disabled = false; });
      flash(err.message, '', { error: true });
    }
  }; });
  $('#take', s.el).onclick = async e => {
    e.target.disabled = true;
    const body = { line_id: l.id, qty: get(), seen_issued: l.issued };
    try {
      // seen_issued: if this was already saved (lost reply) or a workmate took it, the server says so.
      const r = await api('POST', '/api/floor/take', body);
      s.close();
      celebrate(r, van, forThem);
    } catch (err) {
      e.target.disabled = false;
      if (err.confirm?.borrow) return borrowSheet(err.confirm, van, accept => api('POST', '/api/floor/take', { ...body, accept_borrow: accept }), forThem);
      flash(err.message, '', { error: true });
      if (err.status === 409) route({ keep: true }); // show the up-to-date list
    }
  };
}

// The only ones on the shelf are another van's. The worker can still take it (the books follow the
// shelf), but is told whose it is: that van's part gets re-ordered straight away.
function borrowSheet(c, van, send, note = '') {
  const s = sheet(`<h3>Whose part is this?</h3>
    <div class="note" style="font-size:17px">This is <b>${esc(c.from.join(' / '))}</b>'s – it will be re-ordered for them.</div>
    <div class="sheet-actions"><button type="button" class="go-btn" id="b-yes">Take it for ${esc(van.chassis)}</button>
    <button type="button" class="cancel" id="b-new" style="margin-top:8px">No — it's a new delivery for ${esc(van.chassis)}</button>
    <button type="button" class="cancel" data-close>Cancel</button></div>`);
  const go = accept => async e => {
    $$('button', s.el).forEach(b => { b.disabled = true; });
    try { const r = await send(accept); s.close(); celebrate(r, van, note); }
    catch (err) {
      $$('button', s.el).forEach(b => { b.disabled = false; });
      flash(err.message, '', { error: true });
      if (err.status === 409 && !err.confirm) { s.close(); route({ keep: true }); }
    }
  };
  $('#b-yes', s.el).onclick = go(true);
  $('#b-new', s.el).onclick = go(false);
}

// `note`: e.g. "Builder part — it's under Done" when taken for another trade (worker-r3-7).
async function celebrate(r, van, note = '') {
  const take = { movement_id: r.movement_id, line_id: r.line_id, name: r.name, qty: r.qty, chassis: van.chassis, van_id: van.id, at: Date.now(), day: localToday(), by: me };
  store.set('lastTake', take);
  store.set('takes', [...todaysTakes(), take].slice(-80)); // today's takes from this phone, everyone's (C11)
  // Opened from Find a part → Needed by: the part asked about is taken, so clear that search and go back to
  // the usual tab — otherwise the list says "nothing here" while the other parts are hidden (worker-r1-3).
  const ps = $('#ps');
  if (ps && vanView.id === van.id && vanView.findText && ps.value.trim().toLowerCase() === vanView.findText.trim()) {
    ps.value = '';
    vanView.findText = '';
    vanView.filter = '';
  }
  // Confirm straight away, then redraw the list with the new numbers (same search and scroll).
  const from = (r.borrowedFrom ? ` · Taken from ${r.borrowedFrom}'s set-aside` : '') + (note ? ` · ${note}` : '');
  const shown = flash(`${q(r.qty)} × ${r.name}`, `→ ${van.chassis}${from}`, { undo: () => undoTake(take) });
  const lines = await route({ keep: true });
  let sub = `→ ${van.chassis}${from}`;
  try {
    const s = await api('GET', '/api/floor/stats');
    const n = s.mine_took ?? s.mine;
    sub += ` · that's ${n} today${n >= 10 && n % 10 === 0 ? ' 💪' : ''}`;
  } catch { /* fine */ }
  // Every part on this van taken?
  if (Array.isArray(lines) && lines.length && lines.every(l => l.issued >= l.qty)) sub = `🎉 Every part for ${van.chassis} is taken!`;
  const span = $('#done .msg span');
  if (shown === flashSeq && span) span.textContent = sub; // only if that message is still showing
}

async function extraSheet(van, vanLines = []) {
  const items = await allItems();
  const s = sheet(`<h3>What did you take for ${esc(van.chassis)}?</h3>
    <div style="margin-top:10px">${searchBox('xs', 'Type part name…')}</div>
    <div id="xl"></div><button class="cancel" data-close>Cancel</button>`);
  const draw = () => {
    const t = $('#xs', s.el).value.trim();
    const hits = t ? itemSearch(items, t).slice(0, 12) : [];
    $('#xl', s.el).innerHTML = hits.map(i => `<button class="pick" data-id="${i.id}">${partThumb(i.photo)}<div><b>${esc(i.name)}</b><div class="small muted">${esc(i.sku)}</div></div></button>`).join('')
      || (t ? '<div class="empty">No part found — ask the office to add it.</div>' : '');
    $$('[data-id]', s.el).forEach(b => { b.onclick = () => {
      const it = items.find(i => i.id === Number(b.dataset.id));
      s.close();
      const s2 = sheet(`${it.photo ? `<img class="photo" src="${photo(it.photo)}" alt="">` : ''}<h3>${esc(it.name)}</h3>
        ${whereText(it) ? `<div class="info">📍 <b>${esc(whereText(it))}</b></div>` : ''}<div class="info">How many did you take? (${esc(it.unit || 'ea')}${it.unit_size ? ` — ${esc(it.unit_size)}` : ''})</div>
        ${STEPPER}<div class="sheet-actions"><button class="go-btn" id="xt"></button><button class="cancel" data-close>Cancel</button></div>`);
      const get = stepper(s2.el, 1, n => { $('#xt', s2.el).textContent = `Take ${q(n)} for ${van.chassis}`; });
      $('#xt', s2.el).textContent = `Take 1 for ${van.chassis}`;
      $('#xt', s2.el).onclick = async e => {
        e.target.disabled = true;
        // seen_taken: how many of this part the van had taken when the list was loaded (no double takes).
        const seen = vanLines.filter(l => l.item_id === it.id).reduce((n, l) => n + l.issued, 0);
        const body = { van_id: van.id, item_id: it.id, qty: get(), seen_taken: seen };
        try { const r = await api('POST', '/api/floor/extra', body); s2.close(); celebrate(r, van); }
        catch (err) {
          e.target.disabled = false;
          if (err.confirm?.borrow) return borrowSheet(err.confirm, van, accept => api('POST', '/api/floor/extra', { ...body, accept_borrow: accept }));
          flash(err.message, '', { error: true });
          if (err.status === 409) { s2.close(); route({ keep: true }); }
        }
      };
    }; });
  };
  wireSearch($('#xs', s.el), draw);
  $('#xs', s.el).focus();
}

async function pickItemScreen(title, onPick) {
  setTop(title, true);
  const items = await allItems();
  screen.innerHTML = `${searchBox('is', 'Part name, brand or code', 'autofocus')}
    <div class="parts" id="il"></div>`;
  const draw = () => {
    const t = $('#is').value.trim();
    const hits = (t ? itemSearch(items, t) : items.filter(i => i.photo)).slice(0, 40);
    $('#il').innerHTML = hits.map(i => `<button class="part" data-id="${i.id}">${partThumb(i.photo)}<div><div class="nm">${esc(i.name)}</div>
      <div class="sub">${qu(i.on_hand, i)} on shelf${whereText(i) ? ` · ${esc(whereText(i))}` : ''}</div></div></button>`).join('')
      || '<div class="empty">No part found.</div>';
    $$('#il .part').forEach(b => { b.onclick = () => onPick(items.find(i => i.id === Number(b.dataset.id))); });
  };
  wireSearch($('#is'), draw);
  draw();
  $('#is').focus();
}

// ── Delivery (phone round 1, C11) ──
// With nothing typed: "Waiting for" — the parts still to come on open purchase orders, with the supplier and
// how many. The amount starts at what is still on order. After Book in the worker stays here (search
// cleared) for the next part; the pop-up has Undo; "Done" goes home.
async function receiveScreen() {
  setTop('What arrived?', true);
  const [items, waiting] = await Promise.all([allItems(), api('GET', '/api/floor/waiting').catch(() => [])]);
  const onOrder = new Map(waiting.map(w => [w.id, w]));
  const lastB = lastBooking();
  screen.innerHTML = `<div class="rc-head">${searchBox('is', 'Part name or brand')}
      <button type="button" class="rc-done" id="rcdone">Done</button></div>
    ${lastB ? `<button type="button" class="undo-last" id="undobook">↩ Undo ${esc(me)}'s last booking: ${q(lastB.qty)} × ${esc(lastB.name)}</button>` : ''}
    <div id="rchint" class="small muted rc-hint"></div>
    <div class="parts" id="il"></div>`;
  // `withSup`: the supplier on the card too (search results; the "Waiting for" list has it as a heading)
  const card = (i, w, withSup = false) => `<button type="button" class="part" data-id="${i.id}">${partThumb(i.photo)}<div><div class="nm">${esc(i.name)}</div>
      ${w ? `<div class="sub"><b class="oo">${qu(w.to_come, i)} on order</b>${withSup && w.supplier ? ` · ${esc(w.supplier)}` : ''}${w.expected ? ` · due ${fmtDate(w.expected)}` : ''}</div>` : ''}
      <div class="sub">${qu(i.on_hand, i)} on shelf${whereText(i) ? ` · ${esc(whereText(i))}` : ''}</div></div></button>`;
  const draw = () => {
    const t = $('#is').value.trim();
    let html;
    if (t) {
      html = itemSearch(items, t).slice(0, 40).map(i => card(i, onOrder.get(i.id), true)).join('') || '<div class="empty">No part found — ask the office to add it.</div>';
      $('#rchint').textContent = '';
    } else {
      // one heading per supplier, so a truck's load is together
      let sup = null;
      html = waiting.map(w => {
        const i = items.find(x => x.id === w.id) || w;
        const head = (w.supplier || 'Supplier not known') !== sup ? `<h2 class="rc-sup">${esc(sup = w.supplier || 'Supplier not known')}</h2>` : '';
        return head + card(i, w);
      }).join('') || '<div class="empty">Nothing on order right now. Type the part name above.</div>';
      $('#rchint').textContent = waiting.length ? `Waiting for ${waiting.length} part${waiting.length === 1 ? '' : 's'} on order — tap one, or type a name.` : '';
    }
    $('#il').innerHTML = html;
    $$('#il .part').forEach(b => { b.onclick = () => { const id = Number(b.dataset.id); bookInSheet(items.find(i => i.id === id) || onOrder.get(id), onOrder.get(id)); }; });
  };
  wireSearch($('#is'), draw);
  $('#rcdone').onclick = () => { location.hash = '#home'; };
  if (lastB) $('#undobook').onclick = async e => {
    e.target.disabled = true;
    try { await undoBooking(lastB); }
    catch (err) {
      e.target.disabled = false;
      if (err.status === 400 || err.status === 404) e.target.remove(); // too late / already undone
      flash(err.message, '', { error: true });
    }
  };
  draw();
}

// Round 2 (worker-r1-1): opening the next part's panel puts the "Booked in" pop-up away, so the last booking
// (by this name, within the server's 15 minutes) can also be undone from a banner at the top of Delivery.
const lastBooking = () => { const b = store.get('lastBooking', null); return b && b.by === me && Date.now() - b.at < UNDO_MS ? b : null; };
async function undoBooking(b) {
  try { await api('POST', '/api/floor/receive/undo', { movement_id: b.movement_id, item_id: b.item_id }); }
  catch (err) { if (err.status === 400 || err.status === 404) store.set('lastBooking', null); throw err; }
  if (store.get('lastBooking', null)?.movement_id === b.movement_id) store.set('lastBooking', null);
  itemsCache = null;
  flash('Booking undone', `${q(b.qty)} × ${b.name} taken off again`);
  if (location.hash === '#receive' && !sheetId) route({ keep: true });
}

// Follow-up round 1 (worker-r3-4): where the box in the worker's hand goes — only the van(s) THIS delivery was set
// aside for, with how many each, and the part's place: "1 → ST0380 · Rack C · Shelf 2", "2 → ST0367, 1 → ST0380 ·
// Rack C", or "Goes on the shelf (not for a van yet) · Rack C". Not every van that holds the part.
function bookedWhere(r, vans, item, it) {
  const place = whereText(item || {}) || whereText(it || {});
  const at = place ? ` · ${place}` : '';
  if (!Array.isArray(r?.to)) return vans.length ? `Set aside for ${vans.join(', ')}` : 'On the shelf'; // an older server
  const to = r.to.map(x => `${q(x.qty)} → ${x.chassis}`).join(', '); // "1 → ST0380" never split over two lines
  if (!to) return `Goes on the shelf (not for a van yet)${at}`;
  return `${to}${r.shelf > 0 ? `, ${q(r.shelf)} on the shelf (not for a van yet)` : ''}${at}`;
}

async function bookInSheet(it, w) {
  const d = await api('GET', `/api/items/${it.id}`);
  const waitingVans = d.usage.filter(u => u.qty > u.reserved + u.issued);
  const perVan = (d.item.kind || it.kind) === 'per-van';
  const toCome = w ? Number(w.to_come) || 0 : 0;
  const s = sheet(`${it.photo ? `<img class="photo" src="${photo(it.photo)}" alt="">` : ''}<h3>${esc(it.name)}</h3>
    ${toCome ? `<div class="info"><b>${qu(toCome, it)} on order</b>${w.supplier ? ` from ${esc(w.supplier)}` : ''}</div>` : ''}
    <div class="info">How many arrived? (${esc(it.unit || 'ea')}${it.unit_size ? ` — ${esc(it.unit_size)}` : ''})</div>${STEPPER}
    ${perVan && waitingVans.length ? `<div class="info" style="margin-bottom:8px">Made for which van?</div>
      ${waitingVans.map((u, i) => `<button type="button" class="pick ${i === 0 ? 'on' : ''}" data-van="${u.van_id}"><b>${esc(u.chassis)}</b><span class="small muted">due ${fmtDate(u.eta)}</span></button>`).join('')}` : ''}
    <div class="sheet-actions"><button type="button" class="go-btn" id="rc">Book in</button><button type="button" class="cancel" data-close>Cancel</button></div>`);
  const get = stepper(s.el, toCome > 0 ? toCome : 1);
  const rid = requestId(); // same id if the worker taps again after "No signal": booked only once
  let vanId = perVan && waitingVans.length ? waitingVans[0].van_id : null;
  $$('[data-van]', s.el).forEach(b => { b.onclick = () => { vanId = Number(b.dataset.van); $$('[data-van]', s.el).forEach(x => x.classList.toggle('on', x === b)); }; });
  $('#rc', s.el).onclick = async e => {
    const n = get();
    if (!(n > 0)) return;
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/floor/receive', { item_id: it.id, qty: n, van_id: vanId, rid });
      const vans = Array.isArray(r) ? r : r.vans || [];
      itemsCache = null;
      s.close();
      const booking = r.movement_id ? { movement_id: r.movement_id, item_id: it.id, name: it.name, qty: n, at: Date.now(), by: me } : null;
      store.set('lastBooking', booking); // round 2: Delivery's "Undo last booking" banner (worker-r1-1)
      flash(`Booked in ${q(n)} × ${it.name}`, bookedWhere(r, vans, d.item, it), booking ? { undo: () => undoBooking(booking) } : {});
      // Stay on Delivery for the next part: search cleared, list up to date. (`keep`: the panel's history
      // step is taken off by close(), not a second time by the router.)
      if (location.hash === '#receive') { await route({ keep: true }); window.scrollTo(0, 0); } else location.hash = '#receive';
    } catch (err) { e.target.disabled = false; flash(err.message, '', { error: true }); }
  };
}

// ── Find a part ──
// Phone round 1 (C11): "Set place" — tap the rack on the small map (or its button) and type a shelf if
// wanted; saved as the part's rack + shelf. "Needed by" rows open that van with the search set to the part.
function findScreen() {
  pickItemScreen('Find a part', it => findSheet(it.id));
}

async function findSheet(itemId) {
  const [d, layout] = await Promise.all([api('GET', `/api/items/${itemId}`), api('GET', '/api/layout')]);
  const i = d.item;
  const area = layout.areas.find(a => a.id === i.area_id);
  const s = sheet(`${i.photo ? `<img class="photo" src="${photo(i.photo)}" alt="">` : ''}<h3>${esc(i.name)}</h3>
    <div class="info">${esc(i.sku)}</div>
    ${area || i.location ? `<div class="info" style="font-size:18px;color:var(--ink)">📍 <b>${esc([area?.name, i.location].filter(Boolean).join(' · '))}</b></div>` : '<div class="info">No storage place set yet.</div>'}
    ${area ? '<div class="minimap" id="mm"></div>' : ''}
    <button type="button" class="map-tog" id="setplace">📍 ${area || i.location ? 'Change place' : 'Set place'}</button>
    <div class="stats" style="margin:14px 0">
      <div class="s" style="background:var(--gray-soft)"><div class="n">${q(i.on_hand)}</div><div class="l">${esc(i.unit)} on the shelf</div></div>
      <div class="s" style="background:var(--gray-soft)"><div class="n">${q(Math.max(0, i.available))}</div><div class="l">not set aside</div></div></div>
    ${i.unit_size ? `<div class="info">1 ${esc(i.unit)}: ${esc(i.unit_size)}</div>` : ''}
    ${d.usage.length ? `<div class="info" style="margin-bottom:6px">Needed by (tap to open the van):</div>${d.usage.map(u => `<button type="button" class="pick need" data-van="${u.van_id}"><span class="grow"><b>${esc(u.chassis)}</b>
      <span class="small muted">${qu(u.qty - u.issued, i)} still needed${u.reserved ? ` · ${q(u.reserved)} set aside` : ''}</span></span><span class="go-arrow" aria-hidden="true">›</span></button>`).join('')}` : '<div class="info">No van is waiting for this.</div>'}
    <button type="button" class="cancel" data-close>Close</button>`);
  if (area) FactoryMap.render($('#mm', s.el), layout, { mode: 'pick', highlightArea: area.id });
  $$('[data-van]', s.el).forEach(b => { b.onclick = () => {
    pendingFind = { van: Number(b.dataset.van), item: i.id, text: i.name.toLowerCase() };
    s.close();
    location.hash = `#van/${b.dataset.van}`;
  }; });
  $('#setplace', s.el).onclick = () => placeSheet(i, layout);
}

function placeSheet(i, layout) {
  const racks = layout.areas.filter(a => a.kind === 'storage').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let pick = racks.some(a => a.id === i.area_id) ? i.area_id : null;
  const s = sheet(`<h3>Where is it kept?</h3>
    <div class="info">${esc(i.name)}</div>
    <div class="info" style="margin-top:8px">Tap the rack on the map, or below:</div>
    <div class="minimap" id="pm"></div>
    <div class="racks">${racks.map(a => `<button type="button" class="pick ${a.id === pick ? 'on' : ''}" data-area="${a.id}" aria-pressed="${a.id === pick}">${esc(a.name)}</button>`).join('')
      || '<div class="note">No racks are drawn on the factory map yet — ask the office.</div>'}</div>
    <label class="info" for="pl-loc" style="display:block;margin-top:6px">Shelf / bin (if you want)</label>
    <input class="search" id="pl-loc" maxlength="60" placeholder="e.g. Shelf 3" value="${esc(i.location || '')}">
    <div class="sheet-actions"><button type="button" class="go-btn" id="pl-save">Save place</button><button type="button" class="cancel" data-close>Cancel</button></div>`);
  const map = () => FactoryMap.render($('#pm', s.el), layout, { mode: 'pick', highlightArea: pick, onArea: a => { if (a.kind === 'storage') choose(a.id); } });
  const choose = id => {
    pick = id;
    $$('[data-area]', s.el).forEach(b => { const on = Number(b.dataset.area) === id; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    map();
  };
  map();
  $$('[data-area]', s.el).forEach(b => { b.onclick = () => choose(Number(b.dataset.area)); });
  $('#pl-save', s.el).onclick = async e => {
    const loc = $('#pl-loc', s.el).value.trim();
    if (!pick && !loc) return flash('Tap a rack first', '', { error: true });
    e.target.disabled = true;
    try {
      const r = await api('POST', `/api/floor/items/${i.id}/place`, { area_id: pick, location: loc });
      itemsCache = null;
      await findSheet(i.id).catch(() => s.close());// back to the part, now showing its place
      flash('Place saved', [r.area_name, r.location].filter(Boolean).join(' · ')); // after: opening a panel hides pop-ups
    } catch (err) { e.target.disabled = false; flash(err.message, '', { error: true }); }
  };
}

// ── router ──
// `keep`: re-draw the same screen after a change (keeps the van search and scroll position).
async function route({ keep = false } = {}) {
  const kept = keep ? { search: $('#ps')?.value || '', y: window.scrollY } : null;
  closeSheet();
  // Back onto a step that a closed panel left behind: skip it quietly (C8).
  if (!keep && deadSheetStep()) quietBack();
  if (!kept) window.scrollTo(0, 0);
  const h = location.hash || '#home';
  if (!ME) return; // boot() loads the login first
  // Not a worker and no trade view picked yet on this phone: pick one first.
  if (!TRADES[trade] && h !== '#trade') { location.hash = '#trade'; return; }
  try {
    if (h === '#trade') return tradeScreen();
    if (h === '#vans') return await vansScreen();
    const m = /^#van\/(\d+)$/.exec(h);
    if (m) return await vanScreen(Number(m[1]), kept);
    if (h === '#receive') return await receiveScreen();
    if (h === '#find') return findScreen();
    return await homeScreen();
  } catch (e) {
    if (kept) return; // only a refresh failed: leave the screen as it is
    screen.innerHTML = `<div class="empty">Couldn't load — check the Wi-Fi and try again.<br><br><button class="go-btn" onclick="location.reload()">Try again</button></div>`;
  }
}
window.addEventListener('hashchange', () => {
  // A pop-up from the last screen doesn't follow the worker (one shown just now, e.g. "Booked in", stays).
  if (Date.now() - flashAt > 1000) hideFlash();
  route();
});

// ── Start: who is logged in ──
async function boot() {
  try { ME = await api('GET', '/api/me'); }
  catch (e) {
    if (toLogin.going) return;
    screen.innerHTML = `<div class="empty">Couldn't load — check the Wi-Fi and try again.<br><br><button class="go-btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  if (ME.user.mustChange) return toLogin();
  me = ME.user.name;
  if (ME.user.role === 'worker') trade = ME.user.trade; // fixed: only their own trade
  else trade = store.get(tradeKey(), '') || store.get('trade', '') || ''; // (the trade picked on this phone before logins)
  if (location.hash === '#name') history.replaceState(history.state, '', '#home'); // the old "type your name" screen is gone
  route();
}
boot();
