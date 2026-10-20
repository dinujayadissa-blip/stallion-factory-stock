'use strict';

// ───────────────────────── small helpers ─────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const q = n => { const x = Number(n) || 0; return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); };
const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const daysUntil = iso => iso ? Math.round((new Date(iso + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000) : null;
// Today's date (YYYY-MM-DD) on this computer's clock, not UTC (UTC is still "yesterday" on a Victorian morning).
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Follow-up round 1 (owner-r3-1): a van that is still PLANNED but whose due date has passed has a date to check
// ("Date passed – check", the same rule as the server's build order): it is not counted or shown as "N days late",
// and its old date doesn't sort it to the top of lists, until the office fixes the date. Only a van in production
// past its due date is late.
const dateToCheck = v => !!v && v.status === 'planned' && !!v.eta && v.eta < localToday();
const vanLateDays = v => { if (!v || v.status !== 'in_production' || !v.eta) return 0; const d = daysUntil(v.eta); return d != null && d < 0 ? -d : 0; };
const lateDaysText = n => `${n} day${n === 1 ? '' : 's'} late`;
// "Order 29/06/2026" / "Ordered 3/6" in the plan text (owner-r3-7): the plan says it was ordered on a date (not an
// order number, so it is not on "Check: already ordered?"). Returns the date as written, or ''.
function planOrderedDate(text) {
  const m = /\border(?:ed)?\b[\s:.-]*(?:on\s+)?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?\b/i.exec(String(text || ''));
  if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) return '';
  return m[0].replace(/^\D+/, '');
}
const planOrderedTag = text => { const d = planOrderedDate(text);
  return d ? `<span class="chip check pv-tag" title="The plan text says this was ordered on ${esc(d)}, but there is no purchase order for it here. Check before ordering it again.">plan says ordered ${esc(d)} – check</span>` : ''; };

// ── Logins and job roles ──
// ME = { user: { id, username, name, role, trade }, can: { office, stock, floor, … }, roles, trades } from /api/me.
// can('office') etc. decide what the pages show; the server checks every request again (src/auth.js).
var ME = null;
const can = k => !!ME?.can?.[k];
// Not logged in (any more): to the log in page, and back to this same place afterwards.
// `ended`: the session ended on the office PC (turned off, new role, password reset…) — the log in page says so.
function toLogin(ended = false) {
  if (toLogin.going) return;
  toLogin.going = true;
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}${ended ? '&ended=1' : ''}`;
}
// A refused request: not logged in → the log in page. (A login that may not do it gets the server's plain
// "Your login can't do that — ask the owner", shown like any other message.)
function authCheck(res, data) {
  if (res.status === 401 || (res.status === 403 && data?.mustChange)) { toLogin(!!data?.ended); throw new Error('Please log in'); }
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof ArrayBuffer || body instanceof Blob) { opts.body = body; opts.headers['Content-Type'] = 'application/pdf'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { authCheck(res, data); throw new Error(data.error || `Request failed (${res.status})`); }
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
// A message with an Undo button, shown for 10 seconds (round 2 phone batch 1, owner-r1-3: moving a van).
function toastUndo(msg, onUndo, ms = 10000) {
  const t = document.createElement('div');
  t.className = 'toast toast-undo';
  t.setAttribute('role', 'status');
  t.innerHTML = `<span class="grow">${esc(msg)}</span><button type="button" class="btn small">Undo</button>`;
  const b = $('button', t);
  b.onclick = async () => {
    b.disabled = true;
    try { await onUndo(); t.remove(); toast('Undone'); } catch (e) { b.disabled = false; toast(e.message, true); }
  };
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// Run an async action from a button, show errors as toasts.
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, true); throw e; }
}

// Turn buttons off while a save is running so a double-click can't send it twice.
// On success the dialog/page usually re-renders; on error the buttons come back on.
async function busy(btns, fn) {
  btns = [btns].flat().filter(Boolean);
  if (btns.some(b => b.disabled)) return;
  btns.forEach(b => { b.disabled = true; });
  try { return await fn(); }
  finally { btns.forEach(b => { b.disabled = false; }); }
}

// ── Windows and the phone's Back button (phone batch 2, C8) ──
// Opening a window adds a history step ({modal: id}), so Back closes the window instead of changing the
// page. Closing it any other way (×, Cancel, Save, outside tap, Escape) takes that step back off again,
// quietly, so Back afterwards still goes where it used to. The address (#/…) never changes for a window.
history.scrollRestoration = 'manual'; // the app puts the scroll back itself (route keep / restoreScroll)
let modalSeq = 0, skipPops = 0;
const openModals = new Map(); // id → close function, oldest first
const quietBack = () => { skipPops++; history.back(); };
// A history step left by a window that is no longer open (e.g. Save, then another page was opened).
const deadModalStep = () => { const s = history.state?.modal; return !!s && !openModals.has(s); };
window.addEventListener('popstate', e => {
  if (skipPops > 0) { skipPops--; return; }
  // Back: close the windows opened after the step we are on now (normally just the top one).
  const keep = e.state?.modal || 0;
  for (const [id, close] of [...openModals].reverse()) if (id > keep) close({ fromPop: true });
});
if (history.state?.modal) quietBack(); // reloaded while a window was open: drop its step (same page under it)

function modal(title, bodyHtml, { wide = false, footer = '', footerClass = '' } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <header><h2>${esc(title)}</h2><button class="x" aria-label="Close">×</button></header>
    <div class="body">${bodyHtml}</div>${footer ? `<footer${footerClass ? ` class="${footerClass}"` : ''}>${footer}</footer>` : ''}</div>`;
  const id = ++modalSeq;
  const onKey = e => { if (e.key === 'Escape' && [...openModals.keys()].pop() === id) close(); };
  function close(opts) {
    const fromPop = opts?.fromPop === true; // also called as a click handler (opts = the click)
    if (!openModals.has(id)) return;
    openModals.delete(id);
    bg.remove();
    document.removeEventListener('keydown', onKey);
    if (fromPop) return;
    // Take our history step off again — after this tick, so code that closes the window and then opens
    // another page (location.hash = …) or another window is not undone by it.
    setTimeout(() => { if (history.state?.modal === id) quietBack(); }, 0);
  }
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  $('.x', bg).onclick = () => close();
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  openModals.set(id, close);
  // One step per window: a window opened straight after another one closed re-uses that step.
  if (deadModalStep()) history.replaceState({ modal: id }, ''); else history.pushState({ modal: id }, '');
  // Jump to the first box on a PC; on a phone that would pop the keyboard up over the window.
  const first = $('input, select, textarea', bg);
  // Phone round 1 (C10): not on a touch screen either (a tablet), where the keyboard would cover the window.
  if (first && !isPhone() && !matchMedia('(pointer: coarse)').matches) first.focus();
  return { el: bg, close };
}
// A page change (link, Back to another page) closes any window still open.
function closeAllModals() {
  for (const [, close] of [...openModals].reverse()) close({ fromPop: true });
  $$('.modal-bg').forEach(b => b.remove());
}

const STATUS_LABEL = { ready: 'In stock', issued: 'Issued', on_order: 'On order', to_order: 'To order',
  planned: 'Planned', in_production: 'In production', completed: 'Completed', cancelled: 'Cancelled', open: 'Open', closed: 'Closed' };
const chip = s => `<span class="chip ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

// ── item photos ──
const photoSrc = (name, thumb = false) =>
  name ? `/photos/${encodeURIComponent(thumb ? name.replace(/\.jpg$/, '-t.jpg') : name)}` : '';
const thumbImg = (name, size = 40) => name
  ? `<img class="thumb" src="${photoSrc(name, true)}" width="${size}" height="${size}" loading="lazy" alt="">`
  : `<span class="thumb empty" style="width:${size}px;height:${size}px" aria-hidden="true"></span>`;

// Shrink a camera photo in the browser before upload (5 MB → ~200 KB). `square` crops the centre
// for thumbnails.
async function shrinkImage(file, max, square = false) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (square) {
    const s = Math.min(sw, sh);
    sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s;
  }
  const scale = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height); // transparent PNGs get a white background
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.85);
}

async function uploadItemPhoto(itemId, file) {
  if (!file) return;
  let full, thumb;
  try {
    full = await shrinkImage(file, 1280);
    thumb = await shrinkImage(file, 240, true);
  } catch {
    throw new Error("Couldn't read that picture — try a JPG or PNG");
  }
  await api('POST', `/api/items/${itemId}/photo`, { full, thumb });
  itemsCache = null;
}

// Download a picture from a link via the server (websites don't let the browser read them directly).
async function getWebImage(url) {
  const res = await fetch('/api/web-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (!res.ok) { const data = await res.json().catch(() => ({})); authCheck(res, data); throw new Error(data.error || "Couldn't get that picture"); }
  return res.blob();
}

// Pick a photo from the internet: paste a picture link or a product page link, preview, then save.
function webPhotoDialog(item, onSave, startUrl = '') {
  const query = encodeURIComponent([item.name, item.supplier].filter(Boolean).join(' '));
  const m = modal('Photo from the internet', `
    <div class="stack">
      <label class="field">Picture link or product page link
        <div class="row"><input type="text" id="wp-url" class="grow" placeholder="https://…" value="${esc(startUrl)}"><button class="btn" id="wp-get">Get picture</button></div></label>
      <div class="hint">On a supplier's product page you can just copy the page address — the main product photo is used.
        For any other picture: right-click it → <em>Copy image address</em>. Or right-click → <em>Copy image</em>, close this and press Ctrl+V on the item.</div>
      <div><a class="btn small" href="https://www.google.com/search?tbm=isch&q=${query}" target="_blank" rel="noopener">Search Google Images for “${esc(item.name)}”</a></div>
      <div id="wp-preview"></div>
      <div class="hint">Pictures found online usually belong to the supplier or photographer — fine for your own stock records, but don't publish them.</div>
    </div>`, { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="wp-save" disabled>Use this photo</button>' });
  $('[data-close]', m.el).onclick = m.close;
  let blob = null;
  const get = async () => {
    const url = $('#wp-url', m.el).value.trim();
    if (!url) return;
    const out = $('#wp-preview', m.el);
    out.innerHTML = '<span class="muted">Downloading…</span>';
    $('#wp-save', m.el).disabled = true;
    try {
      blob = await getWebImage(url);
      out.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="" style="max-width:100%;max-height:300px;border-radius:8px;border:1px solid var(--line)">`;
      $('#wp-save', m.el).disabled = false;
    } catch (e) { blob = null; out.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  };
  $('#wp-get', m.el).onclick = get;
  $('#wp-url', m.el).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); get(); } };
  $('#wp-save', m.el).onclick = async () => { if (blob) { m.close(); await onSave(blob); } };
  if (startUrl) get();
}

function progress(ready, total, issued = 0) {
  if (!total) return '<span class="faint small">no parts</span>';
  const g = Math.round(((ready - issued) / total) * 100), s = Math.round((issued / total) * 100);
  return `<div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar grow" title="${ready}/${total} parts in stock or issued">
    <i class="s" style="width:${s}%"></i><i class="g" style="width:${g}%"></i></div>
    <span class="small muted nowrap">${ready}/${total}</span></div>`;
}

let itemsCache = null;
async function items(force = false) {
  if (!itemsCache || force) itemsCache = await api('GET', '/api/items');
  return itemsCache;
}
// Text box with type-ahead over the item catalogue; returns the chosen item id via data-id.
function itemPicker(name, selectedId) {
  const listId = 'items-dl';
  if (!$('#' + listId)) {
    const dl = document.createElement('datalist');
    dl.id = listId;
    document.body.append(dl);
  }
  const cur = itemsCache?.find(i => i.id === selectedId);
  return `<input type="text" name="${name}" list="${listId}" placeholder="Start typing SKU or name…" autocomplete="off"
           value="${cur ? esc(`${cur.sku} — ${cur.name}`) : ''}" style="width:100%">`;
}
function fillItemDatalist() {
  const dl = $('#items-dl');
  if (dl && itemsCache) dl.innerHTML = itemsCache.map(i => `<option value="${esc(`${i.sku} — ${i.name}`)}">`).join('');
}
function pickedItemId(input) {
  const sku = String(input.value).split(' — ')[0].trim().toUpperCase();
  return itemsCache?.find(i => i.sku === sku)?.id || null;
}

function formData(form) {
  const o = {};
  new FormData(form).forEach((v, k) => { o[k] = v; });
  return o;
}

// ───────────────────────── router ─────────────────────────

const routes = [
  [/^#?\/?$/, 'home', renderHome],
  [/^#\/import$/, 'import', renderImport],
  [/^#\/factory$/, 'factory', () => renderFactory()],
  [/^#\/plan$/, 'plan', renderPlan],
  [/^#\/vans$/, 'vans', renderVans],
  [/^#\/vans\/(\d+)$/, 'vans', renderVan],
  [/^#\/stock$/, 'stock', renderStock],
  [/^#\/purchasing(?:\/(order|check|special|po))?$/, 'purchasing', renderPurchasing], // tab in the hash: Back returns to it
  [/^#\/pos\/(\d+)$/, 'purchasing', renderPO],
  [/^#\/rules$/, 'rules', renderRules],
  [/^#\/settings$/, 'settings', renderSettings],
  [/^#\/cleanup$/, 'cleanup', renderCleanup],
  [/^#\/checks$/, 'checks', renderStockChecks],
  [/^#\/logins$/, 'logins', renderLogins],
];
// Pages a job role can't use (their menu items are hidden too — data-need in index.html). The server refuses anyway.
const PAGE_NEED = { import: 'office', purchasing: 'stock', checks: 'stock', rules: 'office', settings: 'settings', cleanup: 'office', logins: 'users' };

// keep = redraw the same page after a change (reload): the old page stays on screen until the new one is
// drawn, then the scroll position, filter boxes marked data-keep and the line you were looking at are put
// back — so working down a 100+ line van never jumps to the top (round 3, user-r2-4). Opening a page from
// a link (hashchange) starts at the top as before.
const ANCHOR_ATTRS = ['data-line', 'data-ph', 'data-grp', 'data-sup', 'data-key', 'data-pc', 'data-href'];
const attrSel = (el, attrs) => el.tagName.toLowerCase() + attrs.filter(a => el.hasAttribute(a))
  .map(a => `[${a}="${el.getAttribute(a).replace(/["\\]/g, '\\$&')}"]`).join('');
function scrollAnchors() {
  const out = [];
  for (const el of $$(ANCHOR_ATTRS.map(a => `[${a}]`).join(','), app)) {
    if (el.closest('.modal')) continue;
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= 0) continue;
    if (r.top >= window.innerHeight) break;
    out.push({ sel: attrSel(el, ANCHOR_ATTRS), top: r.top });
    if (out.length >= 12) break;
  }
  // Rows whose top is on screen first; big blocks that started above the screen only as a fallback.
  return out.sort((a, b) => (a.top < 0) - (b.top < 0));
}
function restoreScroll(anchors, y) {
  for (const a of anchors) {
    let el = null;
    try { el = app.querySelector(a.sel); } catch { el = null; }
    if (!el || !el.getBoundingClientRect().height) continue;
    window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - a.top);
    return;
  }
  window.scrollTo(0, y);
}

async function route({ keep = false } = {}) {
  const hash = location.hash || '#/';
  for (const [re, key, fn] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === key));
    if (PAGE_NEED[key] && !can(PAGE_NEED[key])) {
      setMenu(false);
      const pn0 = $('#page-name');
      if (pn0) pn0.textContent = PAGE_NAMES[key] || '';
      closeAllModals();
      app.innerHTML = '<div class="panel empty">Your login can\'t open this page — ask the owner. <a href="#/">Back to the Dashboard</a></div>';
      return;
    }
    // Phone top bar (phone batch 1): the page's name, and the menu closes after a pick.
    setMenu(false);
    const pn = $('#page-name');
    if (pn) pn.textContent = PAGE_NAMES[key] || '';
    const was = keep ? { y: window.scrollY, anchors: scrollAnchors(),
      inputs: $$('[data-keep][id]', app).map(i => ({ id: i.id, value: i.value })) } : null;
    // A page opened from a link starts at the top (on a phone the old page's scroll used to carry over).
    // A window left open over the old page closes with it; Back onto a step that a closed window left
    // behind skips that step quietly (phone batch 2, C8).
    if (!was) {
      closeAllModals();
      if (deadModalStep()) quietBack();
      app.innerHTML = '<div class="empty">Loading…</div>'; window.scrollTo(0, 0);
    }
    try { await fn(...m.slice(1)); }
    catch (e) { app.innerHTML = `<div class="panel empty">Couldn't load this page: ${esc(e.message)}</div>`; }
    if (was) {
      for (const k of was.inputs) {
        const i = document.getElementById(k.id);
        if (!i || i.value === k.value) continue;
        i.value = k.value;
        i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change'));
      }
      restoreScroll(was.anchors, was.y);
    }
    // A Dashboard link can ask for one part of the page ("POs to check", "Waiting on a decision"…).
    const to = sessionStorage.getItem('scrollTo');
    if (to) { sessionStorage.removeItem('scrollTo'); const el = document.getElementById(to); if (el) { if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ block: 'start' }); } }
    refreshNavCount();
    return;
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => route());

// ── Phone / tablet top bar (under 900px, phone batch 1 C2): Menu opens the full list, a pick closes it ──
const PAGE_NAMES = { home: 'Dashboard', import: 'New dealer order', factory: 'Factory floor', plan: 'Production plan', vans: 'Vans', stock: 'Stock',
  purchasing: 'Purchasing', checks: 'Stock checks', rules: 'Parts rules', settings: 'Settings', cleanup: 'Clean-up report', logins: 'Logins' };
function setMenu(open) {
  const side = $('.side'), btn = $('#menu-btn');
  if (!side || !btn) return;
  side.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-open', open);
}
$('#menu-btn')?.addEventListener('click', () => setMenu(!$('.side').classList.contains('open')));
// A link to the page already shown (no hashchange) or to the worker screen closes the menu too.
$('#nav')?.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  if (a.dataset.route === 'vans') sessionStorage.removeItem('vanFocus'); // the menu's Vans = every van, not a Dashboard filter
  setMenu(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('.side')?.classList.contains('open')) setMenu(false); });
window.matchMedia('(min-width: 901px)').addEventListener?.('change', m => { if (m.matches) setMenu(false); });
// A link can say which Purchasing tab to open (e.g. the van page's "Check: already ordered?" tile).
document.addEventListener('click', e => { const a = e.target.closest?.('[data-purtab]'); if (a) sessionStorage.setItem('purTab', a.dataset.purtab); }, true);
const reload = () => route({ keep: true });

async function refreshNavCount() {
  try {
    const s = await api('GET', '/api/summary');
    const el = $('#nav-order-count');
    // The same number as the Dashboard "Order now" row and the Purchasing "Order now" header.
    el.textContent = s.counts.itemsToOrder;
    el.title = `Order now: ${s.counts.orderNowText || ''}`;
    el.classList.toggle('hidden', !s.counts.itemsToOrder);
    const ck = $('#nav-check-count');
    if (ck) { ck.textContent = s.counts.stockChecks; ck.classList.toggle('hidden', !s.counts.stockChecks); }
    // Phone / tablet Menu button (follow-up round 1, planner-r3-6): the badge is the same number as Purchasing /
    // Dashboard "Order now" (not the two counts added up); stock checks waiting show as a small dot next to it.
    // The opened menu says it in words at the top: "107 to order on Purchasing · 1 on Stock checks".
    const mc = $('#menu-count'), md = $('#menu-dot'), ns = $('#nav-sum');
    // Only for a login that can open Purchasing / Stock checks (a leading hand can't).
    const nOrder = can('stock') ? s.counts.itemsToOrder || 0 : 0, nChk = can('stock') ? s.counts.stockChecks || 0 : 0;
    const sumText = [nOrder ? `${nOrder} to order on Purchasing` : '', nChk ? `${nChk} on Stock checks` : ''].filter(Boolean).join(' · ');
    if (mc) {
      mc.textContent = nOrder;
      mc.title = `Order now: ${nOrder} on Purchasing`;
      mc.classList.toggle('hidden', !nOrder);
    }
    if (md) {
      md.title = `${nChk} stock check${nChk === 1 ? '' : 's'} waiting (Stock checks)`;
      md.setAttribute('aria-label', md.title);
      md.classList.toggle('hidden', !nChk);
    }
    const mb = $('#menu-btn');
    if (mb) mb.title = sumText || 'Nothing waiting';
    if (ns) { ns.textContent = sumText; ns.classList.toggle('hidden', !sumText); }
  } catch { /* ignore */ }
}

// ───────────────────────── dashboard ─────────────────────────

// ── "Still missing" (phone batch 1, C4): one count for every screen, worked out on the server
// (stillMissingByVan): needed − set aside − issued, customer supplies / to be decided left out. ──
const NO_STILL = { missing: 0, order: 0, check: 0, special: 0, special_order: 0, special_check: 0 };
const stillOf = v => v?.still || NO_STILL;
const stillText = v => { const n = stillOf(v).missing; return n ? `${n} still missing` : 'nothing missing'; };
// "N of them special parts" — special parts are counted inside to order / to check by their status (round 2, sp-r1-2).
const specialNote = n => (n ? `${n} of them special part${n === 1 ? '' : 's'}` : '');
// What the number is made of: "47 to order / on order · 9 to check · 4 of them special parts" (order + check = missing).
// Follow-up round 1 (owner-r3-2): with the server's split of the same lines by the van page's own status
// (v.split: waiting on PO / still to order / to check) it says "18 waiting on PO · 29 still to order · 10 to check",
// the van page's words — only when the three add up to the still-missing number.
const splitText = v => { const p = v?.split, s = stillOf(v);
  if (!p || p.on_order + p.to_order + p.check !== s.missing || !s.missing) return '';
  return [p.on_order ? `${p.on_order} waiting on PO` : '', p.to_order ? `${p.to_order} still to order` : '', p.check ? `${p.check} to check` : ''].filter(Boolean).join(' · '); };
const stillDetail = v => { const s = stillOf(v); const sp = splitText(v);
  return [sp || [s.order ? `${s.order} to order / on order` : '', s.check ? `${s.check} to check` : ''].filter(Boolean).join(' · '),
    specialNote(s.special)].filter(Boolean).join(' · '); };
const stillHtml = v => `<div class="small still ${stillOf(v).missing ? 'still-n' : 'ok-text'}" title="${esc(stillDetail(v) || 'Every part is here for this van')}">${stillText(v)}</div>`;
// A van's due date in a few words for the phone cards: "due 18/9 · 30 days late" / "due 2/11 · in 14 days".
// A planned van whose date has passed says "due 8/2 · Date passed – check", never "253 days late" (owner-r3-1).
function dueShort(v) {
  if (!v.eta) return '<span class="dueflag">Due date missing</span>';
  if (dateToCheck(v)) return `due ${fmtShort(v.eta)} · ${dueFlag(v)}`;
  const d = daysUntil(v.eta);
  const when = d < 0 ? `<span class="late">${-d} day${d === -1 ? '' : 's'} late</span>` : d === 0 ? '<span class="late">due today</span>' : `in ${d} day${d === 1 ? '' : 's'}`;
  return `due ${fmtShort(v.eta)} · ${when}`;
}
const isPhone = () => window.matchMedia('(max-width: 600px)').matches;
// Van groups the Dashboard's "Today" tiles link to (the Vans page shows only those, with a "Show all" link).
const VAN_FOCUS = {
  // late = in production past its due date; a planned van with a passed date is a "date to check" (owner-r3-1)
  late: { label: 'late', test: (v, t) => !!v.eta && v.eta < t && !dateToCheck(v) },
  datecheck: { label: 'with a date to check (planned, but the due date has passed)', test: v => dateToCheck(v) },
  due2: { label: 'due in the next 2 weeks', test: (v, t) => !!v.eta && v.eta >= t && v.eta <= addDaysIso(t, 14) },
  waiting: { label: 'waiting on parts', test: v => !!v.near && v.waiting_count > 0 },
};

async function renderHome() {
  const [s, reminders] = await Promise.all([api('GET', '/api/summary'), api('GET', '/api/reminders')]);
  const today = localToday();
  const c = s.counts;
  const active = s.vans.filter(v => ['planned', 'in_production'].includes(v.status));
  const nLate = active.filter(v => VAN_FOCUS.late.test(v, today)).length;
  const nDateChk = active.filter(v => dateToCheck(v)).length; // planned, date passed: not late, a date to check (owner-r3-1)
  const nDue2 = active.filter(v => VAN_FOCUS.due2.test(v, today)).length;
  const stillBy = new Map(s.vans.map(v => [v.id, v]));
  // Reminders: late ones first (then today, then by date, then no date); the rest behind "Show all".
  // Follow-up round 1 (owner-r3-6): grouped under one heading per van (the van with the most urgent reminder
  // first) instead of "ST0367 ·" repeated in front of each one; the first 10 reminders show, the rest behind "Show all".
  const remRank = r => (r.due && r.due < today ? 0 : r.due === today ? 1 : r.due ? 2 : 3);
  const remSorted = [...reminders].sort((a, b) => remRank(a) - remRank(b) || String(a.due).localeCompare(String(b.due)));
  const remGroups = new Map();
  for (const r of remSorted) { const k = r.van_id || 0; if (!remGroups.has(k)) remGroups.set(k, []); remGroups.get(k).push(r); }
  const rems = [...remGroups.values()].flat();
  const remHtml = (r, i) => `<div class="rem ${i >= 10 ? 'rem-more hidden' : ''}" data-rid="${r.id}">
          <label class="rem-tick"><input type="checkbox" aria-label="Done"></label>
          <div class="grow"><div class="rem-text" title="Tap to see it all">${esc(r.text)}</div>
          <div class="small ${r.due && r.due <= today ? 'overdue' : 'muted'}">${r.due ? (r.due < today ? 'overdue · ' : r.due === today ? 'today · ' : '') + fmtDate(r.due) : 'no date'}</div></div>
          <button type="button" class="rem-del" data-rdel data-need="floor" aria-label="Delete this reminder" title="Delete this reminder">×</button></div>`;
  let remI = 0;
  const remGroupsHtml = [...remGroups.values()].map(list => {
    const first = remI, r0 = list[0];
    const rows = list.map(r => remHtml(r, remI++)).join('');
    const nLateR = list.filter(r => r.due && r.due < today).length;
    return `<div class="rem-grp ${first >= 10 ? 'rem-more hidden' : ''}"><div class="rem-van">${r0.van_id
      ? `<a href="#/factory" data-van="${r0.van_id}" class="rem-vlink"><b>${esc(r0.chassis)}</b></a>` : '<b>No van</b>'}
      <span class="small muted">${list.length} reminder${list.length === 1 ? '' : 's'}${nLateR ? ` · <span class="overdue">${nLateR} overdue</span>` : ''}</span></div>${rows}</div>`;
  }).join('');
  // Phone only (C3): the owner's first screen — which vans are in trouble. Each tile opens that list.
  const todayTiles = `<div class="today-tiles" id="today-tiles"><h2>Today</h2><div class="tt-row">
      <a class="tile tt ${nLate ? 'bad' : ''}" href="#/vans" data-focus="late"><div class="n">${nLate}</div><div class="l">van${nLate === 1 ? '' : 's'} late</div>${nDateChk
        ? `<div class="tt-sub">+ ${nDateChk} date${nDateChk === 1 ? '' : 's'} to check</div>` : ''}</a>
      <a class="tile tt ${nDue2 ? 'warn' : ''}" href="#/vans" data-focus="due2"><div class="n">${nDue2}</div><div class="l">due in 2 weeks</div></a>
      <a class="tile tt ${c.vansShort ? 'warn' : ''}" href="#/vans" data-focus="waiting"><div class="n">${c.vansShort}</div><div class="l">waiting on parts</div></a>
      <a class="tile tt ${s.overdue.length ? 'bad' : ''}" href="#/purchasing/po" data-scroll="overdue-box" data-need="stock"><div class="n">${s.overdue.length}</div><div class="l">deliveries overdue</div></a>
    </div></div>`;
  // Small fixes & phone round 3 (owner-r2-2): on a phone the lists below the vans fold to one line each with
  // their count ("Reminders 23 · 5 overdue"), opened with a tap (and kept open for this visit). The PC shows
  // them as before: same panels, same headings.
  const phone = isPhone();
  const panel = ({ k, cls, id = '', flush = true, head, title, count, body }) => phone
    ? `<details class="panel flush dash-fold ${cls}" ${id ? `id="${id}"` : ''} data-dfold="${k}" ${sessionStorage.getItem('dashFold.' + k) === '1' ? 'open' : ''}>
        <summary><h2>${title}</h2><span class="df-n">${count}</span></summary><div class="df-body${flush ? '' : ' df-pad'}">${body}</div></details>`
    : `<div class="panel ${flush ? 'flush ' : ''}${cls}" ${id ? `id="${id}"` : ''}><h2>${head}</h2>${body}</div>`;
  const DASH_VANS = 8; // vans shown on a phone before "Show all"
  const remLate = rems.filter(r => r.due && r.due < today).length;
  app.innerHTML = `
    ${s.demo ? `<div class="banner">Demo stock levels are loaded so you can try things out. Clear them under Settings before real use.</div>` : ''}
    <div class="page-head"><h1>Dashboard</h1>
      <div class="actions"><a class="btn primary" href="#/import" data-need="office">+ New dealer order</a>
      <a class="btn" href="/api/export/plan.xlsx" data-need="export">Export production plan (Excel)</a></div></div>
    <div class="dash">
    ${todayTiles}
    <div class="dash-action">${can('office') ? needsActionHtml(s, { late: nLate }) : roleTodoHtml(s, { late: nLate, rems, remLate })}</div>
    <div class="dash-golive">${can('office') ? goLiveHtml(s.golive) : ''}</div>
    <div class="grid2 dash-grid">
      <div class="panel flush dash-vans"><h2>Vans by delivery date</h2>
        <div class="table-wrap"><table class="cards-sm" id="dash-vans"><thead><tr><th>Chassis</th><th>Model</th><th>Due</th><th>Status</th><th style="width:30%">Parts</th></tr></thead><tbody>
        ${s.vans.length ? s.vans.map((v, i) => {
          const d = daysUntil(v.eta);
          return `<tr class="clickable${i >= DASH_VANS ? ' dv-more' : ''}" data-href="#/vans/${v.id}"><td class="vc-ch">${v.build_pos ? `<span class="sm-only vc-pos">#${v.build_pos}</span> ` : ''}<strong>${esc(v.chassis)}</strong></td>
            <td class="vc-model">${esc(v.model)}<div class="small muted">${esc(v.length)}</div></td>
            <td class="nowrap vc-due"><div class="lg-only">${fmtDate(v.eta) || '<span class="faint">—</span>'}${dueFlag(v) || (d != null ? `<div class="small ${d < 21 ? 'warn' : 'muted'}" style="${d < 21 ? 'color:var(--warn)' : ''}">${d < 0 ? `${-d} days late` : `in ${d} days`}</div>` : '')}</div>
              <span class="sm-only small">${dueShort(v)}</span></td>
            <td class="vc-st">${chip(v.status)}</td><td class="vc-parts">${progress(v.ready_count, v.line_count, v.issued_count)}${stillHtml(v)}</td></tr>`;
        }).join('') : `<tr><td colspan="5" class="empty">No vans yet. <a href="#/import">Load a dealer order</a> to get started.</td></tr>`}
        </tbody></table></div>
        ${s.vans.length > DASH_VANS ? `<button type="button" class="btn dv-all" id="dv-all" aria-expanded="false">Show all ${s.vans.length} vans</button>` : ''}</div>
      <div class="dash-right">
        ${rems.length ? panel({ k: 'rem', cls: 'dash-rem', id: 'rem-panel', flush: false, head: `Reminders (${rems.length})`, title: 'Reminders',
          count: `${rems.length}${remLate ? ` · <span class="overdue">${remLate} overdue</span>` : ''}`,
          body: `${remGroupsHtml}
          ${rems.length > 10 ? `<button type="button" class="btn small rem-all" id="rem-all" aria-expanded="false">Show all ${rems.length} (+ ${rems.length - 10} more)</button>` : ''}` }) : ''}
        ${panel({ k: 'wait', cls: 'dash-wait', id: 'waiting-panel', head: `Waiting on parts (${s.waiting.length} of ${c.vansNear} van${c.vansNear === 1 ? '' : 's'})`,
          // the Today tile above already says "N waiting on parts": on a phone this line names the parts instead
          title: 'Missing parts by van', count: `${s.waiting.length} van${s.waiting.length === 1 ? '' : 's'}`,
          body: `<p class="muted small" style="padding:0 16px;margin-top:-6px">Vans in production or due in the next ${s.settings.short_weeks} weeks, and the parts still to order or on order.
            “Still missing” also counts the parts waiting on “check: already ordered?” and special parts to confirm (customer supplies / to be decided never count).</p>
          <div class="table-wrap"><table class="wait-t"><tbody>
          ${s.waiting.length ? s.waiting.map(w => { const v = stillBy.get(w.van_id);
            // Follow-up round 1 (owner-r3-2): the van page's three groups, adding up to "N still missing":
            // "18 waiting on PO · 29 still to order · 10 to check"; then the parts to order / on order by name.
            const split = v ? splitText(v) : '';
            const head = split || `${v ? stillOf(v).order : w.parts.length} to order / on order${v && stillOf(v).check ? ` · ${stillOf(v).check} to check` : ''}`;
            return `<tr><td class="nowrap" style="vertical-align:top"><a href="#/vans/${w.van_id}" class="wait-vlink"><strong>${esc(w.chassis)}</strong></a>
              <div class="small muted">${w.status === 'in_production' ? `in production${vanLateDays(w) ? ` · <span class="late">${lateDaysText(vanLateDays(w))}</span>` : ''}` : `due ${fmtDate(w.eta)}`}</div>${v ? `<div class="small still-n" title="${esc(stillDetail(v))}">${stillText(v)}</div>` : ''}</td>
            <td class="small"><strong class="wait-split">${esc(head)}</strong><div class="wait-parts"><span class="muted">To order / on order:</span> ${w.parts.slice(0, 8).map(esc).join(', ')}${v && stillOf(v).special_order
              ? ` <span class="muted">(+ ${stillOf(v).special_order} special part${stillOf(v).special_order === 1 ? '' : 's'})</span>` : ''}${w.parts.length > 8
              ? ` <a href="#/vans/${w.van_id}" class="nowrap more-link">+ ${w.parts.length - 8} more</a>` : ''}</div></td></tr>`; }).join('')
            : '<tr><td class="empty">No van due soon is waiting on parts.</td></tr>'}
          </tbody></table></div>` })}
        ${!can('stock') ? '' : panel({ k: 'order', cls: 'dash-order', head: 'Order now', title: 'Order now', count: `${s.action.orderNow} part${s.action.orderNow === 1 ? '' : 's'}`,
          body: `<div class="table-wrap"><table><thead><tr><th>Part</th><th>For</th><th>Needed by</th><th class="num">Order</th></tr></thead><tbody>
          ${s.toOrder.length ? s.toOrder.map(r => `<tr><td>${esc(r.name)}${r.po_spec ? `<div class="small">${esc(r.po_spec)}</div>` : ''}<div class="small muted">${esc(r.supplier || 'no supplier')}</div></td>
            <td class="nowrap">${r.topup ? '<span class="small muted">shelf</span>' : `${r.build_pos ? `<span class="chip bo" title="Place in the build order">#${r.build_pos}</span> ` : ''}<a href="#/vans/${r.van_id}">${esc(r.chassis)}</a>`}${r.urgent ? ' <span class="chip urgent">borrowed</span>' : ''}</td>
            <td class="nowrap small">${r.van_status === 'in_production' ? '<strong class="need-now">now</strong>' : fmtDate(r.needed_by)}</td>
            <td class="num"><strong>${q(r.suggest)}</strong> <span class="small muted">${esc(r.unit)}</span>${r.not_counted && r.kind === 'stock' ? '<div class="small muted nowrap">not counted – check shelf first</div>' : ''}</td></tr>`).join('')
            : '<tr><td colspan="4" class="empty">Nothing to order right now.</td></tr>'}
          </tbody></table></div>
          <div style="padding:10px 16px"><a href="#/purchasing">Go to purchasing →</a>${c.itemsToOrder > 0 ? ` <span class="small muted">(order now: ${esc(c.orderNowText)}${c.comingUp ? ` · ${c.comingUp} part(s) coming up` : ''})</span>` : ''}</div>
        ` })}
        ${s.overdue.length && can('stock') ? panel({ k: 'overdue', cls: 'dash-overdue', head: `Overdue deliveries (${s.overdue.length})`, title: 'Overdue deliveries', count: `<span class="overdue">${s.overdue.length}</span>`,
          body: `${overduePanelHtml(s.overdue.slice(0, 10))}
          ${s.overdue.length > 10 ? `<div class="small muted" style="padding:6px 16px">+ ${s.overdue.length - 10} more on the Purchasing page</div>` : ''}` }) : ''}
        ${s.decisions.length && can('office') ? panel({ k: 'dec', cls: 'dash-dec', id: 'decisions-panel', head: `Waiting on a decision (${s.decisions.length})`, title: 'Waiting on a decision', count: s.decisions.length,
          body: `
          <p class="muted small" style="padding:0 16px;margin-top:-6px">Customer supplies / to be decided — reminders, not stock or orders.</p>${decisionsPanelHtml(s.decisions)}` }) : ''}
        ${panel({ k: 'recent', cls: 'dash-recent', head: 'Recent stock movements', title: 'Recent stock movements', count: s.recent.length ? `last ${s.recent.length}` : 'none',
          body: `
          <div class="table-wrap"><table><tbody>
          ${s.recent.length ? s.recent.map(m => `<tr><td class="small muted nowrap">${esc(m.at.slice(5, 16))}</td><td>${esc(m.name)}</td>
            <td class="small">${esc(m.type)}${m.chassis ? ` · ${esc(m.chassis)}` : ''}${m.ref && !m.chassis ? ` · ${esc(m.ref)}` : ''}</td>
            <td class="num" style="color:${m.qty < 0 ? 'var(--bad)' : 'var(--ok)'}">${m.qty > 0 ? '+' : ''}${q(m.qty)}</td></tr>`).join('')
            : '<tr><td class="empty">No movements yet.</td></tr>'}
          </tbody></table></div>` })}
      </div>
    </div>
    </div>`;
  $$('tr[data-href]').forEach(tr => tr.onclick = () => { location.hash = tr.dataset.href; });
  $$('[data-rid] input').forEach(cb => cb.onchange = async () => {
    await act(() => api('PUT', `/api/reminders/${cb.closest('[data-rid]').dataset.rid}`, { done: cb.checked }), 'Reminder done');
    reload();
  });
  // Delete sits at the far end of the row, away from the tick, and asks first.
  $$('[data-rdel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this reminder?')) return;
    await act(() => api('DELETE', `/api/reminders/${b.closest('[data-rid]').dataset.rid}`), 'Reminder deleted');
    reload();
  });
  // A long reminder shows 2 lines; tap it to see it all.
  $$('.rem-text').forEach(t => t.onclick = e => { if (!e.target.closest('a')) t.classList.toggle('open'); });
  const ra = $('#rem-all');
  if (ra) ra.onclick = () => {
    const open = ra.getAttribute('aria-expanded') !== 'true';
    $$('.rem-more').forEach(r => r.classList.toggle('hidden', !open));
    ra.setAttribute('aria-expanded', String(open));
    ra.textContent = open ? 'Show fewer' : `Show all ${rems.length} (+ ${rems.length - 10} more)`;
  };
  $$('[data-focus]').forEach(a => a.onclick = () => sessionStorage.setItem('vanFocus', a.dataset.focus));
  $$('a[data-van]').forEach(a => a.onclick = () => { factoryState.selected = { type: 'van', id: Number(a.dataset.van) }; });
  $$('details[data-dfold]').forEach(d => d.ontoggle = () => sessionStorage.setItem('dashFold.' + d.dataset.dfold, d.open ? '1' : '0'));
  const dv = $('#dv-all');
  if (dv) {
    const showAll = on => {
      $('#dash-vans').classList.toggle('show-all', on);
      dv.setAttribute('aria-expanded', String(on));
      dv.textContent = on ? `Show the first ${DASH_VANS} only` : `Show all ${s.vans.length} vans`;
      sessionStorage.setItem('dashVansAll', on ? '1' : '0');
    };
    if (sessionStorage.getItem('dashVansAll') === '1') showAll(true);
    dv.onclick = () => { const on = !$('#dash-vans').classList.contains('show-all'); showAll(on); if (!on) $('.dash-vans').scrollIntoView({ block: 'start' }); };
  }
  wireDashboardLinks(s);
}

// ── Dashboard: one "needs action this month" number, and the go-live checklist ──

// The headline is about vans (phone batch 1, C3): "4 vans late · 10 waiting on parts". The office's counts
// (parts, POs, order numbers…) are listed beside it under "Office to-do" — no longer added into one number.
function needsActionHtml(s, { late = 0 } = {}) {
  const a = s.action;
  const wk = s.settings.short_weeks;
  const rows = [
    [a.orderNow, 'Order now', `${a.orderNow === 1 ? 'part' : 'parts'} (${a.orderNowLines - (s.counts.orderNow?.topups || 0)} van lines${s.counts.orderNow?.topups ? ` + ${s.counts.orderNow.topups} shelf top-ups` : ''}) — same as Purchasing → Order now`, '#/purchasing', 'pur-order'],
    [a.checkOrdered, 'Check: already ordered?', `supplier order number(s) for vans in production or due in ${wk} weeks${a.checkOrderedAll > a.checkOrdered ? ` (${a.checkOrderedAll} in all)` : ''}`, '#/purchasing', 'chk'],
    [a.posToCheck, 'POs to check', 'purchase order(s) with no number, no supplier, a number used twice, no delivery date, or still coming for a finished van', '#/purchasing', 'po-chk-box'],
    [a.overdue, 'Overdue deliveries', 'PO line(s) that should have arrived', '#/purchasing', 'overdue-box'],
    [a.dates, 'Dates to check', 'van(s) with no due date or a date that has passed', '#/vans', ''],
    [a.decisions, 'Decisions waiting', `customer supplies / to be decided on vans due in ${wk} weeks${a.decisionsAll > a.decisions ? ` (${a.decisionsAll} in all)` : ''}`, '#/', 'decisions-panel'],
    [a.qtyChecks, 'Quantities to check', 'odd quantities on vans due soon', '', 'qty'],
    [a.received, 'Received but customer supplies / to be decided', 'line(s) with stock received for the van – check', '#/', 'decisions-panel'],
    [s.golive?.conflicts || 0, 'Plan changes to check', 'plan changed after parts were set aside', '#/settings', 'plan-conflicts'],
  ];
  const waiting = s.counts.vansShort || 0;
  return `<div class="panel action-panel"><div class="row" style="align-items:flex-start;gap:24px">
      <div class="action-total ${late || waiting ? 'bad' : ''}" aria-label="${late} vans late, ${waiting} waiting on parts">
        <a class="ah" href="#/vans" data-focus="late"><span class="n">${late}</span><span class="l">van${late === 1 ? '' : 's'} late</span></a>
        <a class="ah ah2" href="#/vans" data-focus="waiting"><span class="n">${waiting}</span><span class="l">waiting on parts</span></a></div>
      <div class="grow"><div class="todo-h">Office to-do</div><div class="action-list">${rows.map(([n, label, help, href, scroll]) => `<a class="action-row ${n ? '' : 'zero'}" href="${href || '#/'}" ${scroll ? `data-scroll="${scroll}"` : ''}>
          <span class="an">${n}</span><span><strong>${esc(label)}</strong> <span class="small muted">${esc(help)}</span></span></a>`).join('')}</div></div>
    </div>
    <div class="small muted" style="margin-top:8px">${s.counts.planned} vans planned · ${s.counts.inProduction} in production · ${s.counts.vansShort} of ${s.counts.vansNear} van(s) due soon waiting on parts · ${s.counts.openPOs} open purchase orders</div></div>`;
}

// Stores and leading hands (logins and job roles, issue #13): no office to-do or go-live checklist (they can't open
// those pages) — only what their job role can act on.
//   stores:       overdue deliveries, purchase orders to receive, stock checks, racks not counted yet
//   leading hand: vans late, reminders overdue / due today, reminders open
function roleTodoHtml(s, { late = 0, rems = [], remLate = 0 } = {}) {
  const today = localToday();
  const remToday = rems.filter(r => r.due === today).length;
  const notCounted = (s.golive?.steps || []).find(x => x.key === 'e')?.places?.reduce((n, p) => n + (p.left || 0), 0) || 0;
  const rows = can('stock') ? [
    [s.overdue.length, 'Overdue deliveries', 'PO line(s) that should have arrived — chase or book them in', '#/purchasing/po', 'overdue-box'],
    [s.counts.openPOs || 0, 'Purchase orders to receive', 'open POs — Receive… when a delivery comes', '#/purchasing/po', ''],
    [s.counts.stockChecks || 0, 'Stock checks', 'floor corrections, borrowings and count differences to look at', '#/checks', ''],
    [notCounted, 'Parts not counted yet', 'shelf parts on racks that were never counted — Count a rack', '#/stock', ''],
  ] : [
    [late, 'Vans late', 'in production past their due date', '#/vans', ''],
    [remLate, 'Reminders overdue', 'reminders past their date', '#/', 'rem-panel'],
    [remToday, 'Reminders due today', '', '#/', 'rem-panel'],
    [rems.length, 'Reminders open', 'on the Factory floor van panels too', '#/factory', ''],
  ];
  const head = can('stock') ? 'Stores to-do' : 'Floor to-do';
  return `<div class="panel action-panel"><div class="todo-h">${head}</div><div class="action-list">${rows.map(([n, label, help, href, scroll]) =>
    `<a class="action-row ${n ? '' : 'zero'}" href="${href}" ${scroll ? `data-scroll="${scroll}"` : ''}><span class="an">${n}</span><span><strong>${esc(label)}</strong> <span class="small muted">${esc(help)}</span></span></a>`).join('')}</div></div>`;
}

function goLiveHtml(g) {
  if (!g) return '';
  // On a phone it starts folded (lower down the page) unless it was opened (phone batch 1, C3).
  const open = !g.done && (isPhone() ? sessionStorage.getItem('goliveClosed') === '0' : sessionStorage.getItem('goliveClosed') !== '1');
  const nDone = g.steps.filter(x => x.done).length;
  // Follow-up round 1 (owner-r3-8): on a phone it looks like the other folded panels — "GO-LIVE CHECKLIST" with
  // "0 of 6 done" on the right; "work through it in this order" moves inside. The PC keeps its one line.
  if (isPhone()) return `<details class="panel flush dash-fold golive" ${open ? 'open' : ''} id="golive">
    <summary><h2>Go-live checklist</h2><span class="df-n">${nDone} of ${g.steps.length} done</span></summary>
    <div class="df-body df-pad"><div class="small muted gl-order">Work through it in this order.</div>${goLiveSteps(g)}</div></details>`;
  return `<details class="panel golive" ${open ? 'open' : ''} id="golive">
    <summary><strong>Go-live checklist</strong> <span class="small muted">${nDone} of ${g.steps.length} done — work through it in this order</span></summary>${goLiveSteps(g)}</details>`;
}
function goLiveSteps(g) {
  return `
    <ol class="golive-steps">${g.steps.map(st => `<li class="${st.done ? 'done' : st.locked ? 'locked' : ''}">
      <div class="row" style="flex-wrap:nowrap;align-items:flex-start"><span class="gl-tick">${st.done ? '✓' : st.key}</span>
        <div class="grow"><a href="${st.href}" data-gl="${st.key}"><strong>${esc(st.title)}</strong></a>
          <div class="small muted">${st.locked ? 'Do this after the first full count (e). ' : ''}${esc(st.count)}</div>
          ${st.key === 'c' && st.vans?.length ? `<div class="gl-vans">${st.vans.map(v => `<button class="btn small ${v.checked ? '' : 'primary'}" data-need="office" data-fitvan="${v.id}" title="${esc(v.bay)}">${v.checked ? '✓ ' : ''}${esc(v.chassis)} <span class="small">${esc(v.bay)}</span></button>`).join('')}
            ${st.orphans ? `<a class="btn small" href="#/stock" data-stocktab="pervan">${st.orphans} bought-for-van part(s) with no van →</a>` : ''}</div>` : ''}
          ${st.key === 'e' && st.places?.length ? `<div class="gl-vans">${st.places.map(p => `<span class="chip ${p.left ? 'notcounted' : 'ready'}">${esc(p.name)}: ${p.left ? `${p.left} of ${p.items} not counted` : 'counted'}</span>`).join(' ')}
            <button class="btn small" id="gl-count" data-need="stock">Count a rack…</button></div>` : ''}
        </div></div></li>`).join('')}</ol>`;
}

function wireDashboardLinks(s) {
  $$('[data-scroll]').forEach(a => a.onclick = e => {
    const id = a.dataset.scroll;
    if (id === 'qty') { e.preventDefault(); return qtyChecksDialog(s.qtyChecks || []); }
    if (id === 'po-chk-box') sessionStorage.setItem('poChkOpen', '1');
    sessionStorage.setItem('scrollTo', id);
    if (location.hash === a.getAttribute('href') || (a.getAttribute('href') === '#/' && (location.hash || '#/') === '#/')) {
      e.preventDefault();
      sessionStorage.removeItem('scrollTo');
      const el = document.getElementById(id);
      if (el?.tagName === 'DETAILS') el.open = true; // a folded panel on a phone opens
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  const gl = $('#golive');
  if (gl) gl.ontoggle = () => sessionStorage.setItem('goliveClosed', gl.open ? '0' : '1');
  $$('[data-fitvan]').forEach(b => b.onclick = () => alreadyFittedDialog(Number(b.dataset.fitvan)));
  $$('[data-stocktab]').forEach(a => a.onclick = () => sessionStorage.setItem('stockTab', a.dataset.stocktab));
  $$('[data-gl]').forEach(a => a.onclick = () => {
    if (a.dataset.gl === 'f') sessionStorage.setItem('stockTab', 'fix');
    if (a.dataset.gl === 'e') sessionStorage.setItem('stockTab', 'shelf');
  });
  const gc = $('#gl-count');
  if (gc) gc.onclick = () => countRackDialog();
}

function qtyChecksDialog(list) {
  const m = modal('Quantities to check', `
    <p class="muted" style="margin-top:0">Odd-looking quantities on vans in production or due soon. Open the van and press <strong>Quantity is right</strong>, or fix it with Edit.</p>
    <div class="table-wrap"><table><thead><tr><th>Van</th><th>Part</th><th class="num">Qty</th><th>Why</th></tr></thead><tbody>
    ${list.map(l => `<tr><td><a href="#/vans/${l.van_id}" data-close>${esc(l.chassis)}</a></td><td>${esc(l.name)}${l.plan_column ? `<div class="forcol">for: ${esc(l.plan_column)}</div>` : ''}</td>
      <td class="num nowrap">${q(l.qty)} ${esc(l.unit)}</td><td class="small">${esc(l.why)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing to check.</td></tr>'}
    </tbody></table></div>`, { wide: true });
  $$('[data-close]', m.el).forEach(a => { a.onclick = () => m.close(); });
}

// Item page (check-r4-3): van PO lines whose van no longer needs them — still coming, counted as spare for
// the next van short in build order — and the vans they cover. "PO 50 – ST0367's line is spare → covers ST0390".
function spareHtml(d) {
  const open = p => p.po_status === 'open' && p.qty - p.received - (p.closed || 0) > 1e-9;
  const list = (d.pos || []).filter(p => open(p) && (p.covers?.length || p.van_gone));
  if (!list.length) return '';
  return `<div class="spare-box"><h3>Coming on other vans' POs</h3>${list.map(p => `<div class="small">
    <a href="#/pos/${p.po_id}"><strong>PO ${esc(p.po_no)}</strong></a>${p.supplier ? ` <span class="muted">${esc(p.supplier)}</span>` : ''} –
    ${esc(p.chassis)}'s line${p.van_gone ? ` (van ${p.van_status === 'cancelled' ? 'cancelled' : 'finished'})` : ''} is spare${p.covers?.length
      ? ` → covers <strong>${esc(p.covers.join(', '))}</strong>` : ' – nothing waiting on it yet'}</div>`).join('')}
    <div class="small muted">The van on that PO line no longer needs it (it has its part, or is finished), so when it arrives it goes to the next van short in build order — Purchasing → To order counts it the same way.${list.some(p => p.van_gone) ? ' Lines for finished vans are also listed under Purchasing → POs to check.' : ''}</div></div>`;
}

// ───────────────────────── import dealer order ─────────────────────────

async function renderImport() {
  const settings = await api('GET', '/api/settings');
  app.innerHTML = `
    <div class="page-head"><h1>New dealer order</h1></div>
    <div class="panel">
      <label class="drop" id="drop">
        <strong>Drop the dealer's order PDF here</strong>
        <span class="muted mouse-only">or click to choose it. You can drop several at once.</span>
        <span class="muted touch-only">Tap to choose the PDF. You can pick several at once.</span>
        <input type="file" accept="application/pdf,.pdf" multiple hidden id="file">
      </label>
    </div>
    <div id="result"></div>`;
  const drop = $('#drop'), file = $('#file');
  const queue = [];
  const next = () => { if (queue.length) handle(queue.shift()); };
  const take = files => { queue.push(...[...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')); if (!$('#result').dataset.busy) next(); };
  file.onchange = () => take(file.files);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files); };

  async function handle(f) {
    const out = $('#result');
    out.dataset.busy = '1';
    out.innerHTML = `<div class="panel empty">Reading ${esc(f.name)}…</div>`;
    let data;
    try { data = await api('POST', '/api/orders/parse', await f.arrayBuffer()); }
    catch (e) { out.innerHTML = `<div class="panel empty" style="color:var(--bad)">${esc(f.name)}: ${esc(e.message)}</div>`; delete out.dataset.busy; next(); return; }
    await items();
    showPreview(out, data, f.name, settings.dealer, () => { delete out.dataset.busy; next(); });
  }
}

function showPreview(out, data, fileName, defaultDealer, done) {
  const h = data.header;
  const p = data.preview;
  const fromPlanVan = !!data.existing?.from_plan;
  // Customer-supplied parts (user-r4-9): the order says "customer sending / customer supply / supplied by customer"
  // on a line → "Customer supplies" is suggested there, one click to accept (or to undo). Plain "customer supply"
  // wording starts accepted, as before. Not for vans whose parts come from the production plan.
  const cust = new Map(fromPlanVan ? [] : p.lines.filter(l => l.customer).map(l => [l.item_id, l.customer === 'auto']));
  const isCust = l => cust.get(l.item_id) === true;
  const short = p.lines.filter(l => !isCust(l) && l.available < l.qty);
  // Same rule as the server: lines built as per a drawing, email or photo become reminders on the van.
  const refRe = /\b(drawings?|e-?mails?|photos?|pics?|pictures?)\b/i;
  const drawings = data.fields.filter(f => refRe.test(f.label) || refRe.test(f.value));
  const fromPlan = !!data.existing?.from_plan;
  out.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Order ${esc(h.chassis || '(no chassis number)')}</h2>
        <span class="muted small">from ${esc(fileName)}</span></div>
      ${fromPlan ? `<div class="banner">${esc(h.chassis)} is already in the system. This van's parts come from the production plan. Saving updates the order details and reminders only. Change parts on the van page.</div>`
        : data.existing ? `<div class="banner">${esc(h.chassis)} is already in the system. Saving will update its order details and re-run the parts list (anything already issued is kept).</div>` : ''}
      <form id="hdr" class="form-grid">
        <label class="field">Chassis #<input type="text" name="chassis" value="${esc(h.chassis)}" required></label>
        <label class="field">Customer<input type="text" name="customer" value="${esc(h.customer)}"></label>
        <label class="field">Dealer<input type="text" name="dealer" value="${esc(defaultDealer)}"></label>
        <label class="field">Model<input type="text" name="model" value="${esc(h.model)}"></label>
        <label class="field">Size<input type="text" name="length" value="${esc(h.length)}"></label>
        <label class="field">Floor plan<input type="text" name="floorPlan" value="${esc(h.floorPlan)}"></label>
        <label class="field">Order date<input type="date" name="orderDate" value="${esc(h.orderDate)}"></label>
        <label class="field">Expected delivery<input type="date" name="eta" value="${esc(h.eta)}"></label>
      </form>
    </div>
    <div class="grid2">
      <div class="panel flush"><h2>${fromPlan ? 'What the rules would give (not added)' : 'Parts list'} (${p.lines.length} lines<span id="short-count">${short.length ? `, <span style="color:var(--bad)">${short.length} not fully in stock</span>` : ''}</span>)</h2>
        ${cust.size ? `<div class="cs-banner" id="cs-banner"></div>` : ''}
        <div class="table-wrap" style="max-height:560px;overflow:auto"><table class="order-parts"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Free stock</th></tr></thead><tbody id="order-parts"></tbody></table></div></div>
      <div>
        <div class="panel"><h2>Check by hand (${p.review.length})</h2>
          <p class="muted small" style="margin-top:-6px">These requests aren't covered by a parts rule. Add any parts they need on the van page after saving.</p>
          ${p.review.length ? p.review.map((r, k) => `<div class="review-item"><div><div class="lbl">${esc(r.label)}</div><div>${esc(r.value)}</div>
            ${r.customer && !fromPlanVan ? `<div class="cs-sug" data-csr-box="${k}"></div>` : ''}</div></div>`).join('') : '<div class="muted">Nothing — every option on this order is covered.</div>'}
          ${p.errors.length ? `<div class="banner" style="margin-top:12px">Some rules have errors: ${p.errors.map(e => esc(e.error)).join('; ')}</div>` : ''}
        </div>
        ${drawings.length ? `<div class="panel"><h2>📐 Drawing / email / photo reminders (${drawings.length})</h2>
          <p class="muted small" style="margin-top:-6px">These lines are built “as per” a drawing, email or photo — each one becomes a reminder on the van so it gets checked.</p>
          ${drawings.map(f => `<div class="review-item"><div><div class="lbl">${esc(f.label)}</div><div>${esc(f.value)}</div></div></div>`).join('')}</div>` : ''}
        <div class="panel"><div class="row">
          <button class="btn primary" id="save">${fromPlan ? 'Update order details' : data.existing ? 'Update van & re-allocate stock' : 'Create van & allocate stock'}</button>
          <button class="btn" id="cancel">Discard</button></div>
          <p class="hint" style="margin-bottom:0">${fromPlan ? 'No stock is set aside or changed. The parts list stays as the production plan has it.'
            : 'Stock is set aside for this van straight away. Vans due sooner get priority when stock is short.'}</p></div>
      </div>
    </div>`;
  const drawParts = () => {
    $('#order-parts', out).innerHTML = groupBy(p.lines, 'category').map(([cat, ls]) => `<tr class="group"><td colspan="3">${esc(cat)}</td></tr>` + ls.map(l => {
      const c = cust.has(l.item_id) ? (isCust(l)
        ? `<div class="cs-sug on"><span class="chip cust">Customer supplies</span><span class="small muted">${l.customer === 'auto' ? 'the order says so' : 'accepted'} – not ordered, not set aside</span>
            <button class="btn small link" data-cs="${l.item_id}" data-v="0">Undo – we supply it</button></div>`
        : `<div class="cs-sug"><span class="small">The order says the customer ${l.customer === 'auto' ? 'supplies' : 'sends / supplies'} this.</span>
            <button class="btn small" data-cs="${l.item_id}" data-v="1">Customer supplies</button></div>`) : '';
      return `<tr class="${isCust(l) ? 'cs-row' : ''}"><td>${esc(l.name)} ${l.kind === 'per-van' ? '<span class="chip perv">order per van</span>' : ''}<div class="spec">${esc(l.spec)}</div>${c}</td>
          <td class="num">${q(l.qty)} ${esc(l.unit)}</td>
          <td class="num" style="color:${isCust(l) ? 'var(--faint)' : l.available >= l.qty ? 'var(--ok)' : 'var(--bad)'}">${isCust(l) ? '–' : q(Math.max(0, l.available))}</td></tr>`;
    }).join('')).join('');
    $$('[data-cs]', out).forEach(b => { b.onclick = () => { cust.set(Number(b.dataset.cs), b.dataset.v === '1'); drawParts(); }; });
    const ban = $('#cs-banner', out);
    if (ban) {
      const n = [...cust.values()].filter(Boolean).length, open = cust.size - n;
      ban.innerHTML = `<span>${cust.size} line${cust.size === 1 ? '' : 's'} on this order ${cust.size === 1 ? 'says' : 'say'} the customer supplies the part:
        <strong>${n} marked Customer supplies</strong>${open ? `, ${open} not yet` : ''}.</span>
        ${open > 1 ? `<button class="btn small" id="cs-all">Customer supplies – all ${open}</button>` : ''}`;
      const all = $('#cs-all', out);
      if (all) all.onclick = () => { for (const k of cust.keys()) cust.set(k, true); drawParts(); };
    }
    const sh = p.lines.filter(l => !isCust(l) && l.available < l.qty).length;
    const cnt = $('#short-count', out);
    if (cnt) cnt.innerHTML = sh ? `, <span style="color:var(--bad)">${sh} not fully in stock</span>` : '';
  };
  drawParts();
  // Options no rule covers that the customer supplies: one click → a "Customer supplies" reminder on the van.
  const custRev = new Map(p.review.map((r, k) => [k, false]).filter(([k]) => p.review[k].customer && !fromPlanVan));
  const drawRev = () => {
    for (const [k, on] of custRev) {
      const box = $(`[data-csr-box="${k}"]`, out);
      if (!box) continue;
      box.innerHTML = on ? `<span class="chip cust">Customer supplies</span><span class="small muted">a reminder goes on the van – nothing to order</span>
          <button class="btn small link" data-csr="${k}" data-v="0">Undo</button>`
        : `<span class="small">The order says the customer sends / supplies this.</span><button class="btn small" data-csr="${k}" data-v="1">Customer supplies</button>`;
    }
    $$('[data-csr]', out).forEach(b => { b.onclick = () => { custRev.set(Number(b.dataset.csr), b.dataset.v === '1'); drawRev(); }; });
  };
  drawRev();
  $('#cancel').onclick = () => { out.innerHTML = ''; done(); };
  $('#save').onclick = async e => {
    e.target.disabled = true;
    const hdr = formData($('#hdr'));
    // Customer supplies (user-r4-9): accepted suggestions, and plain "customer supply" lines the office undid.
    const customer_items = p.lines.filter(l => cust.get(l.item_id) === true && l.customer !== 'auto').map(l => l.item_id);
    const normal_items = p.lines.filter(l => cust.get(l.item_id) === false && l.customer === 'auto').map(l => l.item_id);
    try {
      const r = await act(() => api('POST', '/api/vans', { header: { ...h, ...hdr }, dealer: hdr.dealer, fields: data.fields, replace: !!data.existing,
        customer_items, normal_items, by: officeName(),
        customer_fields: [...custRev].filter(([, on]) => on).map(([k]) => ({ label: p.review[k].label, value: p.review[k].value })) }),
        `${hdr.chassis} saved`);
      const rem = [r.drawingReminders ? `${r.drawingReminders} drawing/email/photo reminder(s)` : '', r.customerReminders ? `${r.customerReminders} “customer supplies” reminder(s)` : ''].filter(Boolean);
      out.innerHTML = `<div class="panel row"><strong>${esc(hdr.chassis)}</strong> saved${rem.length ? ` with ${rem.join(' and ')}` : ''}. <a href="#/vans/${r.id}">Open the van →</a></div>`;
      done();
    } catch { e.target.disabled = false; }
  };
}

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = x[key] || 'Other'; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return [...m.entries()];
}

// ───────────────────────── production plan ─────────────────────────

// Same colours as the spreadsheet legend.
const PLAN_STATUS = {
  none: { label: 'Not ordered', cls: 'p-none' },
  ordered: { label: 'Material ordered', cls: 'p-ordered' },
  received: { label: 'Material received', cls: 'p-received' },
  done: { label: 'Fitted / finished', cls: 'p-done' },
};

// Round 2 phone batch 1 (owner-r1-4): on a phone the plan opens "By van" — one card per van with how many
// plan items are in each state and how late it is; a tap opens the van's plan items grouped by state.
// "Full grid" is still one tap away. The PC is unchanged.
// Small fixes & phone round 3 (owner-r2-1): "By van" counts PARTS with the van page's own status (sent by the
// server on each plan cell as `ps`), so the card and the van page agree: "Not ordered 29 · To check 10 · Ordered 18 ·
// Received 58". A part whose plan text gives an order number nobody has confirmed is "To check" (tagged
// "check: already ordered?"), not "Not ordered". (The old count was plan cells: two parts in one cell counted
// once, and a customer-supplies part with stock counted as received — hence 57 against the van page's 58.)
// The grid and the Excel export keep the spreadsheet's cell colours.
const PLAN_ORDER = ['to_order', 'check', 'on_order', 'ready', 'issued', 'decide'];
const PV_STATE = {
  to_order: { label: 'Not ordered', short: 'Not ordered', cls: 'p-none' },
  check: { label: 'Check: already ordered?', short: 'To check', cls: 'p-check' },
  on_order: { label: 'Material ordered', short: 'Ordered', cls: 'p-ordered' },
  ready: { label: 'Material received (set aside)', short: 'Received', cls: 'p-received' },
  issued: { label: 'Fitted / finished', short: 'Fitted', cls: 'p-done' },
  decide: { label: 'Waiting on a decision', short: 'To decide', cls: 'p-decide' },
};
const pvGroup = st => (st === 'customer' || st === 'tbd' ? 'decide' : st);
let planData = null; // the last /api/plan answer (the van sheet redraws from it after a change)
// Late = in production past the due date; a planned van whose date has passed shows "Date passed – check" (owner-r3-1).
const planLate = v => vanLateDays(v);
const lateText = n => (n ? '<span class="late">' + n + ' day' + (n === 1 ? '' : 's') + ' late</span>' : '');
const planCols = data => { const words = ($('#pc')?.value || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return data.columns.filter(c => !words.length || words.some(w => c.toLowerCase().includes(w))); };
// The van's parts in the shown columns, in column order: { id, col, cols, st, name }. A part merged from another
// plan line sits in both cells — counted once, under the first, with both column names.
function planParts(v, cols) {
  const out = new Map();
  for (const col of cols) {
    const cell = v.cells[col];
    if (!cell?.ids.length || !cell.ps) continue;
    cell.ids.forEach((id, i) => {
      const p = out.get(id);
      if (p) { p.cols.push(col); return; }
      out.set(id, { id, col, cols: [col], st: cell.ps[i], name: cell.pn ? cell.pn[i] : '', shared: cell.ids.length > 1 });
    });
  }
  return [...out.values()];
}
function planCounts(v, cols) {
  const n = Object.fromEntries(PLAN_ORDER.map(k => [k, 0]));
  for (const p of planParts(v, cols)) n[pvGroup(p.st)]++;
  return n;
}
// "Not ordered 29 · To check 10 · Ordered 18 · Received 58 · Fitted 0" (+ "To decide 1" only when there is one).
const planCountsHtml = (n, faint = true) => PLAN_ORDER.filter(k => k !== 'decide' || n[k])
  .map(k => `<span class="${faint && !n[k] ? 'faint' : ''}"><i class="pv-sw ${PV_STATE[k].cls}"></i>${PV_STATE[k].short} <b>${n[k]}</b></span>`).join('');
function planVanCardHtml(v, cols) {
  const n = planCounts(v, cols), late = planLate(v), tot = PLAN_ORDER.reduce((a, k) => a + n[k], 0);
  return `<div class="pv-card" role="button" tabindex="0" data-van="${v.id}" data-text="${esc((v.chassis + ' ' + v.model + ' ' + v.customer).toLowerCase())}">
    <div class="pv-top"><strong>${esc(v.chassis)}</strong><span class="muted small pv-model">${esc(v.length)} ${esc(v.model)}</span>${v.status === 'completed' ? chip('completed') : ''}</div>
    <div class="small pv-due">${v.eta ? 'due ' + fmtDate(v.eta) : ''}${late ? ' · ' + lateText(late) : ''}${v.eta ? (dueFlag(v) ? ' · ' + dueFlag(v) : '') : dueFlag(v)}</div>
    ${tot ? `<div class="pv-bar" aria-hidden="true">${PLAN_ORDER.filter(k => n[k]).map(k => `<i class="${PV_STATE[k].cls}" style="flex:${n[k]}"></i>`).join('')}</div>` : '<div class="small muted">No plan items</div>'}
    <div class="pv-counts small">${planCountsHtml(n)}</div>
    <span class="go-arrow" aria-hidden="true">›</span></div>`;
}
// The van's parts grouped by state (the van page's), in a full-screen window on a phone.
function planVanSheet(vanId) {
  const m = modal('Production plan', '<div class="pv-sheet"></div>', { footer: `<a class="btn" href="#/vans/${vanId}" id="pvs-open">Open the van's parts list</a>` });
  $('#pvs-open', m.el).onclick = () => m.close();
  const openGroups = new Set(['to_order', 'check', 'on_order']); // what is not here yet opens first
  const fill = () => {
    const v = planData?.vans.find(x => x.id === vanId);
    if (!v) return m.close();
    $$('details.pv-group', m.el).forEach(d => (d.open ? openGroups.add(d.dataset.st) : openGroups.delete(d.dataset.st)));
    $('header h2', m.el).textContent = v.chassis + ' — production plan';
    const cols = planCols(planData), late = planLate(v), n = planCounts(v, cols);
    const parts = planParts(v, cols);
    const notes = cols.filter(c => { const cell = v.cells[c]; return cell && !cell.ids.length && cell.t; });
    const groups = PLAN_ORDER.map(k => ({ k, ...PV_STATE[k], parts: parts.filter(p => pvGroup(p.st) === k) })).filter(g => g.k !== 'decide' || g.parts.length);
    const itemHtml = (g, p) => { const cell = v.cells[p.col];
      const tag = p.st === 'check' ? '<span class="chip check pv-tag">check: already ordered?</span>'
        : p.st === 'customer' ? '<span class="chip pv-tag">customer supplies</span>' : p.st === 'tbd' ? '<span class="chip pv-tag">to be decided</span>'
        : p.st === 'to_order' ? planOrderedTag(cell.t) : ''; // "Order 29/06/2026": the plan gives a date, not an order number (owner-r3-7)
      return `<button type="button" class="pv-item ${g.cls}" data-line="${p.id}" data-col="${esc(p.col)}">
        <span class="pv-col">${esc(p.cols.join(' + '))}</span><span class="pv-txt">${esc(cell.t || p.name)}</span>
        ${p.shared && p.name ? `<span class="small muted pv-part">${esc(p.name)}</span>` : ''}${tag}</button>`; };
    $('.pv-sheet', m.el).innerHTML = `
      <div class="muted small">${esc(v.length)} ${esc(v.model)}${v.customer ? ' · ' + esc(v.customer) : ''}</div>
      <div class="pv-due">${v.eta ? 'Due ' + fmtDate(v.eta) : dueFlag(v)}${late ? ' · ' + lateText(late) : ''}${v.eta && dueFlag(v) ? ' · ' + dueFlag(v) : ''}</div>
      <div class="pv-counts small" style="margin:8px 0 4px">${planCountsHtml(n, false)}</div>
      <div class="small muted">Counted in parts, the same as the van page.</div>
      ${cols.length < planData.columns.length ? `<div class="small muted">Only columns matching “${esc($('#pc')?.value || '')}”.</div>` : ''}
      <p class="muted small" style="margin:6px 0 10px">Tap an item to see it — nothing changes until you tap a button there twice.</p>
      ${groups.map(g => `<details class="pv-group" data-st="${g.k}" ${openGroups.has(g.k) && g.parts.length ? 'open' : ''}>
        <summary><span class="plan-chip ${g.cls}">${esc(g.label)}</span><b>${g.parts.length}</b></summary>
        ${g.k === 'check' && g.parts.length ? `<div class="small muted pv-help">The plan gives an order number, but nobody has said yet that it was really ordered.
          <a href="#/purchasing" data-purtab="check" class="pv-close">Answer in Purchasing → Check: already ordered?</a></div>` : ''}
        <div class="pv-items">${g.parts.map(p => itemHtml(g, p)).join('') || '<div class="small muted" style="padding:6px 2px">Nothing here.</div>'}</div></details>`).join('')}
      ${notes.length ? `<details class="pv-group" data-st="info" ${openGroups.has('info') ? 'open' : ''}>
        <summary><span class="plan-chip p-info">Plan notes (not parts)</span><b>${notes.length}</b></summary>
        <div class="pv-items">${notes.map(c => `<div class="pv-item p-info"><span class="pv-col">${esc(c)}</span><span class="pv-txt">${esc(v.cells[c].t)}</span></div>`).join('')}</div></details>` : ''}`;
    $$('.pv-close', m.el).forEach(a => a.onclick = () => m.close());
    $$('button.pv-item', m.el).forEach(b => b.onclick = () => {
      planCellDialog(v.id, [Number(b.dataset.line)], b.dataset.col, null, { onSaved: async () => { const y = window.scrollY; await renderPlan(); window.scrollTo(0, y); fill(); } });
    });
  };
  fill();
}

async function renderPlan() {
  const opts = JSON.parse(sessionStorage.getItem('planOpts') || '{}');
  const data = await api('GET', `/api/plan${opts.all ? '?all=1' : ''}`);
  planData = data;
  if (!data.columns.length && !data.vans.length) {
    app.innerHTML = `<div class="page-head"><h1>Production plan</h1></div>
      <div class="panel empty">Nothing here yet. Import your production plan spreadsheet under <a href="#/settings">Settings</a>, or load a dealer order.</div>`;
    return;
  }
  const phone = isPhone();
  const byVan = phone && sessionStorage.getItem('planView') !== 'grid';
  app.innerHTML = `
    <div class="page-head"><h1>Production plan</h1>
      ${phone ? `<div class="seg plan-view" id="pview"><button data-v="vans" class="${byVan ? 'on' : ''}">By van</button><button data-v="grid" class="${byVan ? '' : 'on'}">Full grid</button></div>` : ''}
      <div class="legend">${(byVan ? PLAN_ORDER.filter(k => k !== 'decide').map(k => PV_STATE[k]) : Object.values(PLAN_STATUS)).map(s => `<span class="${s.cls}">${s.label}</span>`).join('')}</div>
      <div class="actions"><a class="btn" href="/api/export/plan.xlsx" data-need="export">Export to Excel</a></div></div>
    <div class="panel flush">
      <div class="row plan-filters" style="padding:12px 16px">
        <input type="search" id="pv" placeholder="Find van…" style="width:180px" value="${esc(opts.v || '')}">
        <input type="search" id="pc" placeholder="Show columns matching… (e.g. battery, solar)" style="width:300px" value="${esc(opts.c || '')}">
        <label class="row"><input type="checkbox" id="pa" ${opts.all ? 'checked' : ''}> Include finished vans</label>
        <span class="grow"></span><span class="muted small mouse-only">${can('office') ? 'Click a cell to mark it ordered, received or fitted' : 'Click a cell to see it'}</span>
        <span class="muted small touch-only">${byVan ? 'Tap a van to see its parts by state (counted as on the van page)' : (can('office') ? 'Tap a cell to see it — nothing changes until you tap a button there twice' : 'Tap a cell to see it')}</span>
      </div>
      ${byVan ? '<div class="pv-list" id="pvlist"></div>' : `<div class="plan-wrap"><table class="plan" id="plan">
        <thead><tr><th class="stick c1"><span class="no-phone">Chassis</span><span class="ph-only">Van</span></th><th class="stick c2">Van</th><th class="stick c3">Due</th>
          ${data.columns.map((c, i) => `<th data-col="${i}" title="${esc(c)}">${esc(c.length > 34 ? c.slice(0, 32) + '…' : c)}</th>`).join('')}</tr></thead>
        <tbody>${data.vans.map(v => `<tr data-text="${esc((v.chassis + ' ' + v.model + ' ' + v.customer).toLowerCase())}">
          <td class="stick c1 ${v.status === 'completed' ? 'p-done' : ''}"><a href="#/vans/${v.id}"><strong>${esc(v.chassis)}</strong></a>
            <div class="c1-sub">${esc(v.model)}${v.eta ? `<br>due ${fmtDate(v.eta).slice(0, 5)}` : ''}${planLate(v) ? '<br>' + lateText(planLate(v)) : ''}</div></td>
          <td class="stick c2"><div class="clip">${esc(v.length)} ${esc(v.model)}</div><div class="small muted clip">${esc(v.customer)}</div></td>
          <td class="stick c3 nowrap small">${fmtDate(v.eta)}${dueFlag(v)}</td>
          ${data.columns.map((c, i) => {
            const cell = v.cells[c];
            if (!cell) return `<td data-col="${i}"></td>`;
            const st = cell.s ? PLAN_STATUS[cell.s].cls : 'p-info';
            return `<td data-col="${i}" class="${st}${cell.ids.length ? ' click' : ''}" data-van="${v.id}" data-ids="${cell.ids.join(',')}"
              title="${esc(c)}: ${esc(cell.t)}${cell.s ? ' — ' + PLAN_STATUS[cell.s].label : ''}"><div class="clip3">${esc(cell.t)}</div></td>`;
          }).join('')}</tr>`).join('')}
        </tbody></table></div>`}</div>`;

  const save = () => sessionStorage.setItem('planOpts', JSON.stringify({ v: $('#pv').value, c: $('#pc').value, all: $('#pa').checked }));
  $$('#pview button').forEach(b => b.onclick = () => { sessionStorage.setItem('planView', b.dataset.v); renderPlan(); });
  const filterVans = () => {
    const t = $('#pv').value.toLowerCase();
    $$(byVan ? '#pvlist .pv-card' : '#plan tbody tr').forEach(tr => tr.classList.toggle('hidden', !!t && !tr.dataset.text.includes(t)));
    save();
  };
  const filterCols = () => {
    if (byVan) {
      const cols = planCols(data);
      $('#pvlist').innerHTML = data.vans.map(v => planVanCardHtml(v, cols)).join('') || '<div class="empty">No vans.</div>';
      $('#pv').value && filterVans();
    } else {
      const words = $('#pc').value.toLowerCase().split(/[,\s]+/).filter(Boolean);
      const show = data.columns.map(c => !words.length || words.some(w => c.toLowerCase().includes(w)));
      $$('#plan [data-col]').forEach(el => el.classList.toggle('hidden', !show[el.dataset.col]));
    }
    save();
  };
  $('#pv').oninput = filterVans; $('#pc').oninput = filterCols;
  $('#pa').onchange = () => { save(); reload(); };
  filterCols(); filterVans();
  if (byVan) {
    const open = e => { const c = e.target.closest('.pv-card'); if (c) planVanSheet(Number(c.dataset.van)); };
    $('#pvlist').onclick = open;
    $('#pvlist').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } };
    return;
  }
  // Phone round 1 (C12): on a touch screen a tap that ends a scroll of the grid doesn't open a cell.
  let scrolledAt = 0;
  $('.plan-wrap').addEventListener('scroll', () => { scrolledAt = Date.now(); }, { passive: true });
  $('#plan tbody').onclick = e => {
    const td = e.target.closest('td.click');
    if (td && matchMedia('(pointer: coarse)').matches && Date.now() - scrolledAt < 350) return;
    if (td) planCellDialog(Number(td.dataset.van), td.dataset.ids.split(',').map(Number), data.columns[td.dataset.col], td);
  };
}

async function planCellDialog(vanId, ids, column, td, { onSaved } = {}) {
  const d = await api('GET', `/api/vans/${vanId}`);
  const lines = d.lines.filter(l => ids.includes(l.id));
  const lineStatus = l => l.issued >= l.qty ? 'done' : l.reserved + l.issued >= l.qty ? 'received' : l.on_order > 0 ? 'ordered' : 'none';
  const m = modal(`${d.van.chassis} — ${column}`, `
    <div class="stack">
      ${lines.map(l => {
        const st = lineStatus(l);
        return `<div class="panel" style="margin:0;padding:12px" data-line="${l.id}">
          <div class="row">${l.photo ? `<a href="${photoSrc(l.photo)}" target="_blank" rel="noopener">${thumbImg(l.photo, 56)}</a>` : ''}
            <strong>${q(l.qty)} ${esc(l.unit)} × ${esc(l.name)}</strong><span class="plan-chip ${PLAN_STATUS[st].cls}">${PLAN_STATUS[st].label}</span>${l.status === 'check'
              ? '<span class="chip check" title="The plan gives an order number nobody has confirmed — answer it in Purchasing → Check: already ordered?">check: already ordered?</span>'
              : l.status === 'to_order' ? planOrderedTag(l.spec || column) : ''}</div>
          ${l.spec ? `<div class="spec" style="max-width:none">${esc(l.spec)}</div>` : ''}
          <div class="small muted" style="margin-top:4px">${l.po_ref ? `Order ${esc(l.po_ref)} · ` : ''}${l.po_refs && st === 'ordered' ? `On PO ${esc(l.po_refs)} · ` : ''}set aside ${q(l.reserved)} · fitted ${q(l.issued)}</div>
          ${st === 'done' ? '' : `<div class="row" style="margin-top:10px" data-need="office">
            ${st === 'none' ? `<input type="text" class="po" placeholder="Order #" value="${esc(l.po_ref)}" style="width:110px"><button class="btn small" data-act="ordered">Mark ordered</button>` : ''}
            ${st !== 'received' ? '<button class="btn small" data-act="received">Mark received</button>' : ''}
            <button class="btn small primary" data-act="done">Mark fitted</button></div>`}
        </div>`;
      }).join('')}
      <div class="row"><a href="#/vans/${vanId}" id="pcd-open">Open ${esc(d.van.chassis)} →</a></div>
    </div>`, { wide: lines.length > 1 });
  $('#pcd-open', m.el).onclick = () => m.close();
  // Phone round 1 (C12): on a touch screen the first tap only asks ("Tap again: Mark fitted"), so a stray tap
  // while scrolling never changes the plan. A mouse click still works at once.
  const coarse = matchMedia('(pointer: coarse)').matches;
  $$('[data-act]', m.el).forEach(b => b.onclick = async () => {
    if (coarse && !b.dataset.armed) {
      $$('[data-armed]', m.el).forEach(x => { delete x.dataset.armed; x.textContent = x.dataset.label; x.classList.remove('armed'); });
      b.dataset.label = b.dataset.label || b.textContent;
      b.dataset.armed = '1';
      b.classList.add('armed');
      b.textContent = `Tap again: ${b.dataset.label}`;
      setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; b.classList.remove('armed'); } }, 4000);
      return;
    }
    const box = b.closest('[data-line]');
    const body = { status: b.dataset.act };
    if (body.status === 'ordered') {
      body.po_no = $('.po', box).value.trim();
      if (!body.po_no) return toast('Type the order number first', true);
    }
    await act(() => api('POST', `/api/van-lines/${box.dataset.line}/status`, body), 'Updated');
    m.close();
    if (onSaved) return onSaved(); // the phone's van window redraws itself (owner-r1-4)
    // Refresh just the plan so scroll position and filters stay put.
    const scroller = $('.plan-wrap');
    const pos = scroller ? [scroller.scrollLeft, scroller.scrollTop, window.scrollY] : null;
    await renderPlan();
    const s2 = $('.plan-wrap');
    if (pos && s2) { s2.scrollLeft = pos[0]; s2.scrollTop = pos[1]; window.scrollTo(0, pos[2]); }
  });
}

// ───────────────────────── vans ─────────────────────────

async function renderVans() {
  const filter = sessionStorage.getItem('vanFilter') || 'active';
  // A Dashboard "Today" tile asks for one group: late / due in 2 weeks / waiting on parts (phone batch 1, C3).
  const focus = VAN_FOCUS[sessionStorage.getItem('vanFocus') || ''] ? sessionStorage.getItem('vanFocus') : '';
  const got = await api('GET', `/api/vans${filter === 'all' && !focus ? '' : `?status=${focus ? 'active' : filter}`}`);
  const today = localToday();
  const vans = focus ? got.filter(v => VAN_FOCUS[focus].test(v, today)) : got;
  const dateChk = focus ? got.filter(v => dateToCheck(v)) : []; // owner-r3-1: named under "N vans late", not counted in it
  const help = `Listed in build order — <strong>#1 gets parts and deliveries first</strong>.
      Vans in production come first: any <strong>Build order</strong> number you give (1 = first, works for vans in the bays too),
      then the earliest due date (the most overdue van first); the bay only decides between vans due the same day (last bay first).
      Then planned vans: build order number, then due date. After changing numbers, press <em>Re-prioritise stock…</em> to move free shelf stock.`;
  app.innerHTML = `
    <div class="page-head"><h1>Vans</h1>
      <select id="vf"><option value="active">Planned & in production</option><option value="completed">Completed</option><option value="all">All</option></select>
      <div class="actions">${isPhone()
        // Phone round 1 (C12): on a phone the stock-moving button sits in "More actions", away from the thumb
        ? `<a class="btn primary" href="#/import" data-need="office">+ New dealer order</a>
          <details class="more-acts" data-need="office"><summary class="btn">More actions ▾</summary><div class="more-acts-body">
            <button class="btn" id="bo-edit" aria-pressed="false">Change build order</button>
            <div class="small muted">Shows a number box on each van: 1 = build first, blank = by due date.</div>
            <button class="btn" id="reprio">Re-prioritise stock…</button>
            <div class="small muted">Shows which free shelf stock would move first — nothing changes until you confirm.</div></div></details>`
        : `<button class="btn" id="reprio" data-need="office" title="See which free shelf stock would move to the vans built first, then confirm">Re-prioritise stock…</button>
      <a class="btn primary" href="#/import" data-need="office">+ New dealer order</a>`}</div></div>
    ${isPhone() ? `<details class="muted small how-help"><summary>How the build order works</summary><p>${help}</p></details>`
      : `<p class="muted small" style="margin:-6px 0 12px">${help}</p>`}
    ${focus ? `<div class="banner row"><span>Showing the <strong>${vans.length}</strong> van${vans.length === 1 ? '' : 's'} ${VAN_FOCUS[focus].label} (from the Dashboard).${focus === 'late' && dateChk.length
        ? ` Not counted as late: ${dateChk.map(v => `<a href="#/vans/${v.id}">${esc(v.chassis)}</a>`).join(', ')} – planned, but the due date has passed (date to check).` : ''}</span>
      <span class="grow"></span><button class="btn small" id="vfocus-off">Show all vans</button></div>` : ''}
    ${isPhone() ? `<div class="banner row hidden" id="bo-banner"><span class="small grow">Build order: 1 = build first, blank = by due date. Saved when you leave the box.</span>
      <button type="button" class="btn small" id="bo-done">Done</button></div>` : ''}
    <div class="panel flush"><div class="table-wrap"><table class="cards-sm" id="vans-table">
      <thead><tr><th title="Place in the build order: #1 gets stock first">#</th><th>Chassis</th><th>Model</th><th>Customer</th><th>Due</th><th>Status</th><th title="1 = build first. Blank = by due date">Build order</th><th style="width:22%">Parts in stock</th></tr></thead><tbody>
      ${vans.length ? vans.map(v => `<tr class="clickable" data-href="#/vans/${v.id}">
        <td class="nowrap vc-pos">${v.build_pos ? `<strong title="${esc(v.build_why)}">#${v.build_pos}</strong>` : ''}</td>
        <td class="vc-ch"><strong>${esc(v.chassis)}</strong>${v.build_why ? `<div class="small muted lg-only">${esc(v.build_why)}</div>` : ''}</td><td class="vc-model">${esc(v.model)}<div class="small muted">${esc(v.length)}${v.floor_plan ? ` · ${esc(v.floor_plan)}` : ''}</div></td>
        <td class="vc-cust">${esc(v.customer)}<div class="small muted">${esc(v.dealer)}</div></td>
        <td class="nowrap vc-due"><div class="lg-only">${fmtDate(v.eta)}${dueFlag(v)}</div><span class="sm-only small">${['planned', 'in_production'].includes(v.status) ? dueShort(v) : v.eta ? `due ${fmtShort(v.eta)}` : ''}</span></td>
        <td class="vc-st">${chip(v.status)}${v.reviewed ? '' : ' <span class="chip to_order" title="Custom requests not yet checked">check</span>'}</td>
        <td class="vc-bo" ${['planned', 'in_production'].includes(v.status) ? 'data-label="Build order"' : ''}>${['planned', 'in_production'].includes(v.status) ? `<input type="number" class="bo-input" min="1" step="1" data-bo="${v.id}" inputmode="numeric" value="${v.build_order ?? ''}" aria-label="Build order for ${esc(v.chassis)}">
          <span class="bo-text sm-only small muted">${v.build_order != null ? `build order no. ${v.build_order}` : ''}</span>` : ''}</td>
        <td class="vc-parts">${progress(v.ready_count, v.line_count, v.issued_count)}${['planned', 'in_production'].includes(v.status) ? stillHtml(v) : ''}</td></tr>`).join('')
        : '<tr><td colspan="8" class="empty">No vans here.</td></tr>'}
      </tbody></table></div></div>`;
  $('#vf').value = focus ? 'active' : filter;
  $('#vf').onchange = e => { sessionStorage.setItem('vanFilter', e.target.value); sessionStorage.removeItem('vanFocus'); reload(); };
  const vfo = $('#vfocus-off');
  if (vfo) vfo.onclick = () => { sessionStorage.removeItem('vanFocus'); reload(); };
  $('#reprio').onclick = () => reprioDialog();
  // Phone (owner-r3-5): the build order is plain text ("#1" on the card); the number boxes appear only after
  // More actions → "Change build order" (remembered for this visit), so a stray tap while looking changes nothing.
  const boEdit = $('#bo-edit');
  if (boEdit) {
    const setEdit = on => { $('#vans-table').classList.toggle('bo-editing', on); boEdit.setAttribute('aria-pressed', String(on)); $('#bo-banner')?.classList.toggle('hidden', !on);
      boEdit.textContent = on ? '✓ Done changing build order' : 'Change build order'; try { sessionStorage.setItem('boEdit', on ? '1' : '0'); } catch { /* private */ } };
    setEdit(sessionStorage.getItem('boEdit') === '1');
    boEdit.onclick = () => { const on = !$('#vans-table').classList.contains('bo-editing'); setEdit(on); boEdit.closest('details').open = false; };
    $('#bo-done').onclick = () => setEdit(false);
  }
  $$('[data-bo]').forEach(inp => {
    inp.onclick = e => e.stopPropagation();
    inp.onchange = async () => {
      await act(() => api('PUT', `/api/vans/${inp.dataset.bo}`, { build_order: inp.value.trim() }), 'Build order saved — press "Re-prioritise stock…" to move free shelf stock to match');
      reload();
    };
  });
  $$('tr[data-href]').forEach(tr => tr.onclick = () => { location.hash = tr.dataset.href; });
}

// Special parts in clear numbers: "1 still to order · 2 on order · 1 to check · 7 in all" (round 2, sp-r1-1: a line its van's PO
// already covers is on order, not still to order — the same rule as Purchasing → Special parts and the Stock tab).
// Round 2 (planner-r1-1): "· 1 not a part" too — a plan cell that only holds the dealer's name is listed but
// never counted as still to order, so the numbers add up.
function phSplit(lines) {
  return { short: lines.filter(l => l.is_short).length, on: lines.filter(l => l.is_on_order).length,
    chk: lines.filter(l => l.is_check).length, np: lines.filter(l => l.not_part).length };
}
function phCountText(lines) {
  const { short, on, chk, np } = phSplit(lines);
  return `${short} still to order${on ? ` · ${on} on order` : ''}${chk ? ` · ${chk} to check` : ''}${np ? ` · ${np} not a part` : ''} · ${lines.length} in all`;
}

let flashLine = null; // van line to light up after the next redraw
// The van page's "Missing" filter: parts not here yet (phone batch 2, C5).
const MISSING_ST = ['to_order', 'on_order', 'check'];
async function renderVan(vanId) {
  const [d, ph] = await Promise.all([api('GET', `/api/vans/${vanId}`), api('GET', `/api/placeholders?van=${vanId}`).catch(() => []), items()]);
  fillItemDatalist();
  const v = d.van;
  // Suggestions for the special parts ("Suggested: …", "This van already has … – same thing?").
  const phInfo = new Map(ph.flatMap(g => g.lines).map(l => [l.id, l]));
  const tab = sessionStorage.getItem('vanTab') || 'parts';
  const counts = { ready: 0, issued: 0, on_order: 0, to_order: 0, check: 0, customer: 0, tbd: 0 };
  d.lines.forEach(l => counts[l.status]++);
  const decisions = d.lines.filter(l => ['customer', 'tbd'].includes(l.status)).map(l => ({ ...l, chassis: v.chassis }));
  const canIssue = d.lines.some(l => l.reserved > 0);
  // One split for the whole page (round 2, sp-r1-2): the "Still missing" tile says what it is made of in the
  // same words as the tiles next to it (waiting on PO + still to order + to check = still missing), with the
  // special parts as an "of which" note — they are counted under their own status, as on the parts list.
  const stv = stillOf(v);
  const tileSum = counts.on_order + counts.to_order + counts.check;
  const phLines = d.lines.filter(l => l.placeholder && l.issued < l.qty)
    .map(l => ({ ...l, ...(phInfo.get(l.id) || {}), chassis: v.chassis, duplicate: LINK_FLAG_TEXT.test(l.note || '') }));
  // Round 2 phone batch 1 (owner-r1-1): one breakdown only. The special parts are counted inside the tiles'
  // own groups, and both the small line and the fold below say so with the tiles' words and the van line's
  // own status: "18 waiting on PO (incl. 2 special) · 29 still to order (incl. 1 special) · 10 to check (incl.
  // 1 special)", and the fold "4 still missing: 2 waiting on PO · 1 still to order · 1 to check · 3 set aside".
  const vanSt = new Map(d.lines.map(l => [l.id, l.status])); // (phLines' `status` is the special-parts one)
  const phIn = st => phLines.filter(l => vanSt.get(l.id) === st);
  const incl = st => { const ls = phIn(st), np = ls.filter(l => l.not_part).length, sp = ls.length - np;
    const bits = [sp ? `${sp} special` : '', np ? `${np} not a part` : ''].filter(Boolean);
    return bits.length ? ` (incl. ${bits.join(', ')})` : ''; };
  const STILL_GROUPS = [['on_order', 'waiting on PO'], ['to_order', 'still to order'], ['check', 'to check']];
  const vanStillDetail = tileSum === stv.missing
    ? STILL_GROUPS.filter(([st]) => counts[st]).map(([st, w]) => `${counts[st]} ${w}${incl(st)}`).join(' · ')
    : stillDetail(v);
  const phMissingN = phLines.filter(l => MISSING_ST.includes(vanSt.get(l.id))).length;
  const phAside = phLines.filter(l => ['ready', 'issued'].includes(vanSt.get(l.id))).length;
  const phDecide = phLines.filter(l => ['customer', 'tbd'].includes(vanSt.get(l.id))).length;
  const phFoldText = [phMissingN ? `${phMissingN} still missing: ${STILL_GROUPS.map(([st, w]) => [phIn(st), w])
      .filter(([ls]) => ls.length).map(([ls, w]) => { const np = ls.filter(l => l.not_part).length;
        return `${ls.length} ${w}${np ? ` (incl. ${np} not a part)` : ''}`; }).join(' · ')}` : 'nothing still missing',
    phAside ? `${phAside} set aside` : '', phDecide ? `${phDecide} waiting on a decision` : ''].filter(Boolean).join(' · ');
  // Phone batch 2 (C5): how late the van is (the Dashboard's wording), and on a phone the special-parts /
  // decision panels fold to one line each so the parts list starts on the first screen.
  const lateDays = vanLateDays(v); // planned with a passed date: "Date passed – check", not late (owner-r3-1)
  const phone = isPhone();
  const [fold, hOpen, hClose] = phone ? ['details', '<summary><h2>', '</h2></summary>'] : ['div', '<h2>', '</h2>'];
  // a panel opened on the phone stays open when the page redraws after a change
  const foldOpen = k => (phone && sessionStorage.getItem(`vanFold.${k}`) === '1' ? 'open' : '');

  app.innerHTML = `
    <div class="page-head van-head">
      <a href="#/vans" class="muted">← Vans</a>
      <h1>${esc(v.chassis)}</h1>${chip(v.status)}
      <span class="muted">${esc(v.model)} · ${esc(v.length)}</span>
      ${v.build_pos ? `<span class="chip" title="Place in the build order (#1 gets parts first): ${esc(v.build_why)}">#${v.build_pos} in build order</span>` : ''}
      <div class="actions">${phone ? '' : `
        <button class="btn primary" id="issue" data-need="issue" ${canIssue ? '' : 'disabled'}>Issue stock to floor</button>
        <button class="btn" id="fitted" data-need="office" title="Tick parts that were put in before the system was used">Already fitted…</button>`}
        <button class="btn no-phone" id="print">Print picking list</button>
        <button class="btn" id="more" data-need="${phone ? 'issue' : 'office'}">${phone ? 'More actions…' : 'More…'}</button>
      </div>
    </div>
    <div class="print-only"><h2>Picking list — ${esc(v.chassis)} · ${esc(v.model)} ${esc(v.length)} · due ${fmtDate(v.eta)}</h2></div>
    <div class="tiles van-tiles no-print">
      <div class="tile ${stillOf(v).missing ? 'bad' : ''}" title="The same number as the Dashboard, Vans list and factory map"><div class="n">${stillOf(v).missing}</div><div class="l">Still missing</div>
        ${vanStillDetail ? `<div class="small muted still-detail">${esc(vanStillDetail)}</div>` : ''}</div>
      <div class="tile"><div class="n">${counts.ready}</div><div class="l">Set aside, ready to issue</div></div>
      <div class="tile"><div class="n">${counts.issued}</div><div class="l">Issued to floor</div></div>
      <div class="tile"><div class="n">${counts.on_order}</div><div class="l">Waiting on PO</div></div>
      <div class="tile ${counts.to_order ? 'bad' : ''}"><div class="n">${counts.to_order}</div><div class="l">Still to order</div></div>
      ${counts.check ? `<a class="tile warn" href="#/purchasing" data-purtab="check"><div class="n">${counts.check}</div><div class="l">Check: already ordered?</div></a>` : ''}
      ${decisions.length ? `<div class="tile warn"><div class="n">${decisions.length}</div><div class="l">Waiting on a decision</div></div>` : ''}
      <div class="tile tile-due ${lateDays > 0 ? 'bad' : ''}"><div class="n">${fmtDate(v.eta) || '—'}</div><div class="l">Expected delivery</div>
        ${lateDays > 0 ? `<div class="late">${lateDaysText(lateDays)}</div>` : dateToCheck(v) ? `<div>${dueFlag(v)}</div>` : ''}</div>
    </div>
    <div class="tabs">
      <button data-tab="parts">Parts list</button>
      <button data-tab="review">Check by hand${d.review.length && !v.reviewed ? `<span class="badge">${d.review.length}</span>` : ''}</button>
      <button data-tab="order">Dealer order</button>
      <button data-tab="details">Van details</button>
    </div>
    <div id="tab"></div>`;

  const tabs = {
    parts: () => `
      ${phLines.length ? `<${fold} class="panel flush no-print van-fold" data-fold="ph" ${foldOpen('ph')}>${hOpen}Special parts to confirm <span class="ph-count" title="Counted inside the tiles above: still missing = waiting on PO + still to order + to check">${esc(phFoldText)}</span>${hClose}
        <p class="muted small" style="padding:0 16px;margin-top:-6px">These came from the production plan as text only (“as per plan”). Link each one to the real part so it can be ordered and counted.</p>
        <div id="ph-panel">${placeholderPanelHtml([{ van_id: v.id, chassis: v.chassis, eta: v.eta, status: v.status, lines: phLines }], { showVan: false })}</div></${fold}>` : ''}
      ${decisions.length ? `<${fold} class="panel flush no-print van-fold" data-fold="dec" ${foldOpen('dec')}>${hOpen}Waiting on a decision (${decisions.length})${hClose}
        <p class="muted small" style="padding:0 16px;margin-top:-6px">Customer supplies / to be decided: reminders, not stock or orders. Change it with the drop-down on the line once it's decided.</p>
        ${decisionsPanelHtml(decisions, { showVan: false })}</${fold}>` : ''}
      <div class="panel flush">
        <div class="row no-print lf-row" style="padding:12px 16px">
          <input type="search" id="lf" placeholder="Filter parts…" style="width:240px" data-keep>
          <select id="ls" data-keep><option value="">All statuses</option><option value="missing">Missing (not here yet)</option><option value="ready">In stock for this van</option><option value="to_order">Not ordered</option>
            <option value="check">Check: already ordered?</option><option value="on_order">Ordered</option><option value="customer">Customer supplies</option>
            <option value="tbd">To be decided</option><option value="issued">Fitted</option></select>
          <span class="grow"></span><button class="btn" id="add" data-need="office">+ Add part</button></div>
        <div class="lmiss no-print hidden" id="lmiss"></div>
        <div class="table-wrap"><table id="lines"><thead><tr>
          <th>Item</th><th class="num">Need</th><th class="num">Set aside</th><th class="num">Issued</th><th>Status</th><th class="no-print"></th></tr></thead><tbody>
        ${groupBy(d.lines, 'category').map(([cat, ls]) => `<tr class="group"><td colspan="6">${esc(cat)}</td></tr>` + ls.map(l => `
          <tr data-line="${l.id}" data-status="${l.status}" data-text="${esc((l.name + ' ' + l.sku + ' ' + l.spec + ' ' + l.note + ' ' + (l.plan_column || '')).toLowerCase())}">
            <td class="ln-item"><div class="item-cell">${thumbImg(l.photo, 36)}<div><strong>${esc(l.name)}</strong> <span class="small faint">${esc(l.sku)}</span>
              ${l.kind === 'per-van' ? '<span class="chip perv">per van</span>' : ''} ${l.source === 'manual' ? '<span class="chip issued">added by hand</span>' : ''}
              ${l.placeholder ? '<span class="chip tbc">to confirm</span>' : ''}
              ${l.urgent && l.status !== 'issued' && l.status !== 'ready' ? '<span class="chip urgent" title="Its part was taken for another van on the floor">Order now</span>' : ''}
              ${l.reserved_firm > 0 && l.status !== 'issued' ? `<span class="chip locked" title="Received for this van — re-prioritising never moves it">${q(l.reserved_firm)} kept for this van</span>` : ''}
              ${l.plan_column ? `<div class="forcol">for: ${esc(l.plan_column)}</div>` : ''}
              ${l.qty_check && l.status !== 'issued' ? (/^the plan text/.test(l.qty_check)
                ? `<div class="no-print" style="margin-top:3px"><span class="chip check" title="${esc(l.qty_check)}">Please check</span>
                  <span class="small muted">${esc(l.qty_check)}</span> <button class="btn small link" data-need="office" data-qtyok="${l.id}">It's right</button></div>`
                : `<div class="no-print" style="margin-top:3px"><span class="chip check" title="${esc(l.qty_check)}">Please check quantity</span>
                  <span class="small muted">${esc(l.qty_check)}</span> <button class="btn small link" data-need="office" data-qtyok="${l.id}">Quantity is right</button></div>`) : ''}
              ${l.spec ? `<div class="spec">${esc(l.spec)}</div>` : ''}${l.status === 'to_order' && planOrderedDate(l.spec) ? `<div>${planOrderedTag(l.spec)}</div>` : ''}${l.note ? `<div class="spec"><em>${esc(l.note.replace(/\s*·?\s*qty-ok/, ''))}</em></div>` : ''}</div></div></td>
            <td class="num" data-label="Need">${q(l.qty)} ${esc(l.unit)}</td><td class="num" data-label="Set aside">${q(l.reserved)}</td><td class="num" data-label="Issued">${q(l.issued)}</td>
            <td class="ln-st" style="min-width:150px">${lineStatusHtml(l)}</td>
            <td class="no-print nowrap ln-acts"><button class="btn small ln-more" data-more="${l.id}" aria-expanded="false">Change…</button>${l.status !== 'issued' ? `<select class="state-sel" data-need="office" data-state="${l.id}" aria-label="Who supplies it" title="Customer supplies / to be decided">
                <option value="">Normal</option><option value="customer" ${l.state === 'customer' ? 'selected' : ''}>Customer supplies</option>
                <option value="tbd" ${l.state === 'tbd' ? 'selected' : ''}>To be decided</option></select> ` : ''}<button class="btn small" data-need="office" data-edit="${l.id}">Edit</button>
              <button class="btn small link" data-why="${l.id}" title="Who moved what and when">Why?</button><span class="touch-hint">Why? = who moved what and when</span></td></tr>`).join('')).join('')}
        ${d.lines.length ? '' : '<tr><td colspan="6" class="empty">No parts on this van.</td></tr>'}
        </tbody></table></div></div>`,
    review: () => `
      <div class="panel">
        <p class="muted" style="margin-top:0">Options on the dealer order that no parts rule covers — usually custom requests.<span data-need="office"> Add parts for them with <strong>+ Add part</strong>, or teach the system with a new rule on the <a href="#/rules">Parts rules</a> page so it's automatic next time.</span></p>
        ${d.review.length ? d.review.map(r => `<div class="review-item"><div class="grow"><div class="lbl">${esc(r.label)}</div><div>${esc(r.value)}</div></div>
          <button class="btn small no-print" data-need="office" data-addfor="${esc(r.label + ': ' + r.value)}">+ Add part</button></div>`).join('') : '<div class="muted">Nothing to check.</div>'}
        <div class="row" style="margin-top:14px">
          <label class="row" data-need="office"><input type="checkbox" id="reviewed" ${v.reviewed ? 'checked' : ''}> All custom requests have been checked</label></div>
      </div>`,
    order: () => {
      let sec = '';
      return `<div class="panel"><div class="kv">${d.fields.map(f => {
        const head = f.section !== sec ? `<div class="sec">${esc((sec = f.section))}</div>` : '';
        return `${head}<div>${esc(f.label)}${f.note ? ` <span class="faint">(${esc(f.note)})</span>` : ''}</div><div>${esc(f.value) || '<span class="faint">—</span>'}</div>`;
      }).join('')}</div></div>`;
    },
    details: () => `
      <div class="panel"><form id="vform" class="form-grid">
        ${[['customer', 'Customer'], ['dealer', 'Dealer'], ['model', 'Model'], ['length', 'Size'], ['floor_plan', 'Floor plan'], ['colour', 'Colour'], ['atm', 'ATM'], ['quote_no', 'Quote #']]
          .map(([k, l]) => `<label class="field">${l}<input type="text" name="${k}" value="${esc(k === 'dealer' ? tidyWords(v[k]) : v[k])}"></label>`).join('')}
        <label class="field">Order date<input type="date" name="order_date" value="${esc(v.order_date)}"></label>
        <label class="field">Expected delivery<input type="date" name="eta" value="${esc(v.eta)}">${dueFlag(v)}</label>
        <label class="field">Build order (1 = build next; blank = by due date)<input type="number" name="build_order" min="1" step="1" value="${v.build_order ?? ''}"></label>
        <label class="field">Status<select name="status">${['planned', 'in_production', 'completed', 'cancelled'].map(s => `<option value="${s}" ${v.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
        <label class="field" style="grid-column:1/-1">Notes<textarea name="notes" rows="3">${esc(v.notes)}</textarea></label>
      </form>
      <div class="row" style="margin-top:12px" data-need="office"><button class="btn primary" id="vsave">Save details</button>
      <span class="hint" data-need="office">Completed: parts still set aside for this van are counted as used. Use Return for anything that came back to the shelf. Cancelled: they go back to the other vans.</span></div></div>`,
  };

  // The status filter, kept while switching tabs; on a phone the list opens on the parts still missing (C5).
  let lsVal = phone ? 'missing' : '';
  function showTab(name) {
    sessionStorage.setItem('vanTab', name);
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $('#tab').innerHTML = tabs[name]();
    wireTab(name);
  }
  $$('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  showTab(tabs[tab] ? tab : 'parts');

  function wireTab(name) {
    if (name === 'parts') {
      const apply = () => {
        const t = $('#lf').value.toLowerCase(), s = lsVal = $('#ls').value;
        const want = s === 'missing' ? MISSING_ST : s ? [s] : null;
        $$('#lines tbody tr[data-line]').forEach(tr => tr.classList.toggle('hidden', (t && !tr.dataset.text.includes(t)) || (want && !want.includes(tr.dataset.status))));
        // "Showing the 44 parts still missing · Show all 128" while the Missing filter is on.
        const lm = $('#lmiss'), nMiss = d.lines.filter(l => MISSING_ST.includes(l.status)).length;
        lm.classList.toggle('hidden', s !== 'missing');
        if (s === 'missing') lm.innerHTML = `${nMiss ? `<span title="Not ordered, on order, or to check">Showing the <b>${nMiss}</b> missing</span> ·` : '<span class="ok-text">Nothing missing – every part is here or fitted.</span>'}
          <button class="btn link" id="lall">Show all ${d.lines.length}</button>`;
        if (s === 'missing') $('#lall').onclick = () => { $('#ls').value = ''; apply(); };
        // hide category headings with nothing left under them
        $$('#lines tbody tr.group').forEach(g => {
          let n = g.nextElementSibling, any = false;
          while (n && !n.classList.contains('group')) { if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling; }
          g.classList.toggle('hidden', !any);
        });
      };
      $('#lf').oninput = apply; $('#ls').onchange = apply;
      $$('details[data-fold]').forEach(dt => dt.ontoggle = () => sessionStorage.setItem(`vanFold.${dt.dataset.fold}`, dt.open ? '1' : ''));
      $('#ls').value = lsVal;
      apply();
      // Phones: Customer supplies / Edit / Why? sit behind "Change…" on each line.
      $$('[data-more]').forEach(b => b.onclick = () => {
        const tr = b.closest('tr'), open = !tr.classList.contains('acts-open');
        tr.classList.toggle('acts-open', open);
        b.setAttribute('aria-expanded', String(open));
        b.textContent = open ? 'Close' : 'Change…';
      });
      $('#add').onclick = () => addPartDialog(vanId);
      if ($('#ph-panel')) wirePlaceholderPanel($('#ph-panel'), [{ lines: phLines }]);
      $$('[data-qtyok]').forEach(b => b.onclick = () => busy(b, async () => {
        await act(() => api('POST', `/api/van-lines/${b.dataset.qtyok}/qty-ok`), 'Noted — quantity is right'); flashLine = Number(b.dataset.qtyok); reload();
      }));
      $$('[data-edit]').forEach(b => b.onclick = () => editLineDialog(d.lines.find(l => l.id === Number(b.dataset.edit))));
      $$('[data-why]').forEach(b => b.onclick = () => whyDialog(Number(b.dataset.why)).catch(e => toast(e.message, true)));
      $$('[data-state]').forEach(sel => sel.onchange = async () => {
        const l = d.lines.find(x => x.id === Number(sel.dataset.state));
        const ok = await setLineStateFlow(l, sel.value);
        if (!ok) sel.value = ['customer', 'tbd'].includes(l.state) ? l.state : '';
        else { flashLine = l.id; reload(); }
      });
      // The line just changed lights up briefly, so it is easy to carry on from there (round 3, user-r2-4).
      if (flashLine) { $(`#lines tr[data-line="${flashLine}"]`)?.classList.add('flash'); flashLine = null; }
    }
    if (name === 'review') {
      $$('[data-addfor]').forEach(b => b.onclick = () => addPartDialog(vanId, b.dataset.addfor));
      $('#reviewed').onchange = e => act(() => api('PUT', `/api/vans/${vanId}`, { reviewed: e.target.checked ? 1 : 0 }), 'Saved');
    }
    if (name === 'details') {
      $('#vsave').onclick = async () => { await act(() => api('PUT', `/api/vans/${vanId}`, formData($('#vform'))), 'Van updated'); reload(); };
    }
  }

  $('#print').onclick = () => { showTab('parts'); $('#ls').value = ''; $('#lf').value = ''; window.print(); };
  // Follow-up round 1 (owner-r3-5): on a phone "Issue stock to floor" and "Already fitted…" (they change stock) are
  // not at the top of the screen where the thumb lands: they sit in "More actions…", with a line saying what they do.
  const issueStock = async () => {
    const n = d.lines.filter(l => l.reserved > 0).length;
    if (!confirm(`Issue the set-aside stock for ${n} part line(s) to the floor? This takes it off the shelf count.`)) return false;
    await act(() => api('POST', `/api/vans/${vanId}/issue`, {}), 'Stock issued');
    reload();
    return true;
  };
  if ($('#fitted')) $('#fitted').onclick = () => alreadyFittedDialog(vanId);
  if ($('#issue')) $('#issue').onclick = issueStock;
  $('#more').onclick = () => {
    const nAside = d.lines.filter(l => l.reserved > 0).length;
    const m = modal(`${v.chassis} — more actions`, `
      <div class="stack">${phone ? `
        <div data-need="issue"><button class="btn primary" id="m-issue" ${canIssue ? '' : 'disabled'}>Issue stock to floor</button>
          <div class="hint">${canIssue ? `Hands the stock set aside for ${nAside} part line(s) to the floor and takes it off the shelf count (asks first).` : 'Nothing is set aside for this van yet.'}</div></div>
        <div data-need="office"><button class="btn" id="m-fitted">Already fitted…</button>
          <div class="hint">Tick parts that were put in before the system was used.</div></div>
        <div data-need="office"><button class="btn" id="m-details">Change due date or build order…</button>
          <div class="hint">Opens Van details.</div></div>` : ''}
        <div data-need="office"><button class="btn" id="m-rebuild">Re-run parts rules</button>
          <div class="hint">Use after changing rules. Parts added or edited by hand, and anything already issued, are kept.</div></div>
        <div data-need="office"><button class="btn" id="m-done">Mark completed</button>
          <div class="hint">Parts still set aside for this van are counted as used. Use Return for anything that came back to the shelf.</div></div>
        <div data-need="office"><button class="btn danger" id="m-del">Delete van</button>
          <div class="hint">Removes the van and its parts list. Stock already issued stays issued.</div></div>
      </div>`);
    if (phone) {
      $('#m-issue', m.el).onclick = async () => { if (await issueStock()) m.close(); };
      $('#m-fitted', m.el).onclick = () => { m.close(); alreadyFittedDialog(vanId); };
      $('#m-details', m.el).onclick = () => { m.close(); showTab('details'); $('.tabs')?.scrollIntoView({ block: 'start' }); };
    }
    $('#m-rebuild', m.el).onclick = async () => { await act(() => api('POST', `/api/vans/${vanId}/rebuild`), 'Parts list rebuilt'); m.close(); reload(); };
    $('#m-done', m.el).onclick = async () => { await act(() => api('PUT', `/api/vans/${vanId}`, { status: 'completed' }), 'Van completed'); m.close(); reload(); };
    $('#m-del', m.el).onclick = async () => {
      if (!confirm(`Delete ${v.chassis}? This can't be undone.`)) return;
      await act(() => api('DELETE', `/api/vans/${vanId}`), 'Van deleted'); m.close(); location.hash = '#/vans';
    };
  };
}

function addPartDialog(vanId, forRequest = '') {
  const m = modal('Add part to van', `
    <form id="ap" class="stack">
      ${forRequest ? `<div class="review-item"><div>${esc(forRequest)}</div></div>` : ''}
      <label class="field">Item${itemPicker('item')}</label>
      <div class="form-grid"><label class="field">Quantity<input type="number" name="qty" value="1" min="0" step="any"></label></div>
      <label class="field">Spec / notes<input type="text" name="note" value="${esc(forRequest)}"></label>
      <div class="hint">Can't find it? Add the item on the <a href="#/stock">Stock</a> page first.</div>
    </form>`, { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ap-save">Add part</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $('#ap-save', m.el).onclick = e => {
    const f = $('#ap', m.el);
    const itemId = pickedItemId(f.item);
    if (!itemId) return toast('Pick an item from the list', true);
    return busy(e.currentTarget, async () => {
      await act(() => api('POST', `/api/vans/${vanId}/lines`, { item_id: itemId, qty: Number(f.qty.value), note: f.note.value }), 'Part added');
      m.close(); reload();
    });
  };
}

function editLineDialog(l) {
  const m = modal(`${l.name}`, `
    <form id="el" class="stack">
      <div class="muted small">${esc(l.sku)} · ${l.rule_name ? `added by rule “${esc(l.rule_name)}”` : 'added by hand'}</div>
      <div class="form-grid">
        <label class="field">Quantity needed<input type="number" name="qty" value="${q(l.qty)}" min="${q(l.issued)}" step="any"></label>
        <div class="field">Set aside / issued<div style="padding:8px 0">${q(l.reserved)} / ${q(l.issued)} ${esc(l.unit)}</div></div>
      </div>
      <label class="field">Spec<input type="text" name="spec" value="${esc(l.spec)}"></label>
      <label class="field">Note<input type="text" name="note" value="${esc(l.note)}"></label>
      ${l.issued > 0 ? `<div class="row"><button type="button" class="btn small" id="el-ret">Return issued stock to shelf…</button></div>` : ''}
    </form>`, { footer: `<button class="btn danger" id="el-del" ${l.issued > 0 ? 'disabled title="Return issued stock first"' : ''}>Remove</button><span class="grow"></span>
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="el-save">Save</button>` });
  $('[data-close]', m.el).onclick = m.close;
  $('#el-save', m.el).onclick = async () => {
    const f = formData($('#el', m.el));
    await act(() => api('PUT', `/api/van-lines/${l.id}`, f), 'Saved'); m.close(); flashLine = l.id; reload();
  };
  $('#el-del', m.el).onclick = async () => {
    if (!confirm('Remove this part from the van?')) return;
    await act(() => api('DELETE', `/api/van-lines/${l.id}`), 'Removed'); m.close(); reload();
  };
  const ret = $('#el-ret', m.el);
  if (ret) ret.onclick = async () => {
    const n = prompt(`How many to return to the shelf? (issued: ${q(l.issued)})`, q(l.issued));
    if (!n) return;
    const qn = Number(n);
    if (!(qn > 0)) return toast('Type how many to return, e.g. 2', true);
    await act(() => api('POST', `/api/van-lines/${l.id}/return`, { qty: qn }), 'Returned to stock'); m.close(); reload();
  };
}

// ───────────────────────── stock ─────────────────────────

async function renderStock() {
  let tab = sessionStorage.getItem('stockTab') || 'shelf';
  if (tab === 'list') tab = 'shelf';
  const [all, phGroups, orphans, toOrder] = await Promise.all([items(true), api('GET', '/api/placeholders'), api('GET', '/api/items/unassigned'),
    api('GET', '/api/items/still-to-order').catch(() => ({}))]);
  fillItemDatalist();
  const phCount = phGroups.reduce((s, g) => s + g.lines.length, 0);
  // Two clear numbers (user-r4-3): still to order = the Purchasing → Special parts list; in all = this tab.
  const phLabel = phCountText(phGroups.flatMap(g => g.lines));
  // Follow-up round 1 (planner-r3-1): the tab badge is the "still to order" number — the same badge as
  // Purchasing → Special parts (89 on both); "160 in all" stays in the heading and the hover text.
  const phShort = phSplit(phGroups.flatMap(g => g.lines)).short;
  const head = `
    <div class="page-head"><h1>Stock</h1>
      <div class="actions"><button class="btn" id="count" data-need="stock">Count a rack…</button><button class="btn" id="bought" data-need="stock">Check bought-for-van parts…</button>
        <button class="btn" id="stake" data-need="stock">Stocktake / bulk count</button><button class="btn primary" id="new" data-need="office">+ New item</button></div></div>
    ${orphans.length && tab !== 'pervan' ? `<div class="banner warn-banner"><strong>${orphans.length} bought-for-van part(s) on the shelf with no van.</strong>
      <a href="#/stock" id="orph-go">Assign to a van →</a></div>` : ''}
    <div class="tabs"><button data-st="shelf">Shelf stock</button><button data-st="pervan">Bought for vans${orphans.length ? `<span class="badge">${orphans.length}</span>` : ''}</button>
      <button data-st="fix">Fix the catalogue</button>
      <button data-st="ph">Special parts to confirm${phShort ? `<span class="badge quiet" title="${esc(phLabel)}">${phShort}</span>` : ''}</button>
      <button data-st="specs">Many different specs</button></div>`;
  const wireHead = () => {
    $$('[data-st]').forEach(b => { b.classList.toggle('active', b.dataset.st === tab); b.onclick = () => { sessionStorage.setItem('stockTab', b.dataset.st); reload(); }; });
    $('#count').onclick = () => countRackDialog();
    $('#bought').onclick = boughtForVanDialog;
    $('#stake').onclick = stocktakeDialog;
    $('#new').onclick = () => editItemDialog(null, [...new Set(all.map(i => i.category))].sort());
    const og = $('#orph-go');
    if (og) og.onclick = e => { e.preventDefault(); sessionStorage.setItem('stockTab', 'pervan'); reload(); };
  };
  if (tab === 'fix') {
    app.innerHTML = `${head}<div id="fix-cat"><div class="empty">Loading…</div></div>`;
    wireHead();
    await renderFixCatalogue($('#fix-cat'));
    return;
  }
  if (tab === 'ph') {
    app.innerHTML = `${head}<div class="panel flush"><h2>Special parts to confirm <span class="ph-count">${phCount ? esc(phLabel) : ''}</span></h2>
      <p class="muted small" style="padding:0 16px;margin-top:-6px">Lines that came from the production plan as text only (“as per plan”), grouped by van in build order.
      Link each to the real part (or create one from the text) so it can be ordered, counted and found on the floor.
      “Still to order” = the ones on Purchasing → Special parts; “On order” = their van’s PO already covers them; the rest already have their part set aside, or are waiting on an answer.</p>
      <div id="ph-all">${placeholderPanelHtml(phGroups)}</div></div>`;
    wireHead();
    wirePlaceholderPanel($('#ph-all'), phGroups);
    return;
  }
  if (tab === 'specs') {
    const many = await api('GET', '/api/items/many-specs');
    app.innerHTML = `${head}<div class="panel flush"><h2>Many different specs</h2>
      <p class="muted small" style="padding:0 16px;margin-top:-6px">Parts asked for with 5 or more different descriptions on vans still to build — often one item standing in for several real parts.</p>
      <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Different specs</th><th>Examples</th></tr></thead><tbody>
      ${many.map(r => `<tr class="clickable" data-id="${r.id}"><td><strong>${esc(r.name)}</strong> ${r.placeholder ? '<span class="chip tbc">as per plan</span>' : ''}<div class="small faint">${esc(r.sku)}</div></td>
        <td class="num">${r.specs} <span class="small muted">(${r.lines} vans)</span></td><td class="small">${r.examples.map(esc).join(' · ')}</td></tr>`).join('')
        || '<tr><td colspan="3" class="empty">None.</td></tr>'}</tbody></table></div></div>`;
    wireHead();
    $$('tr[data-id]').forEach(tr => tr.onclick = () => itemDialog(Number(tr.dataset.id)));
    return;
  }
  const cats = [...new Set(all.map(i => i.category))].sort();
  const st = JSON.parse(sessionStorage.getItem('stockFilter') || '{}');
  const shelfTab = tab === 'shelf';
  // Until every rack has been counted once, a "free" figure of a part nobody has counted is a guess.
  const firstCountDone = !all.some(i => i.not_counted);
  // "As per plan" catch-alls aren't real shelf parts: only shown when asked for (Bought for vans tab).
  const list = st.k === 'placeholder' && !shelfTab ? all.filter(i => i.placeholder)
    : all.filter(i => !i.placeholder && (shelfTab ? i.kind === 'stock' : i.kind !== 'stock'));
  const kOpts = shelfTab
    ? [['short', 'Short for vans due soon'], ['low', 'Below reorder level'], ['notcounted', 'Not counted yet'], ['nosupplier', 'No supplier set'], ['norack', 'No rack yet']]
    : [['unassigned', 'Unassigned (no van)'], ['short', 'Short for vans due soon'], ['nosupplier', 'No supplier set'], ['placeholder', '“As per plan” catch-alls']];
  const k0 = kOpts.some(([v]) => v === st.k) ? st.k : '';
  const where = i => [i.area_name, i.location].filter(Boolean).join(' · ');
  // One banner instead of a "Not counted yet" badge on every row (Small fixes & phone round 1, user-r4-3).
  const notCounted = shelfTab ? list.filter(i => i.not_counted).length : 0;
  // The search looks in both lists: matches in the other tab are offered as a link (user-r4-4).
  const otherTab = shelfTab ? 'pervan' : 'shelf', otherName = shelfTab ? 'Bought for vans' : 'Shelf stock';
  const otherList = all.filter(i => !i.placeholder && (otherTab === 'shelf' ? i.kind === 'stock' : i.kind !== 'stock'));
  const otherText = new Map(otherList.map(i => [i.id, (itemSearchText(i) + ' ' + (i.area_name || '')).toLowerCase()]));
  app.innerHTML = `${head}
    ${!shelfTab ? `<div id="orphans">${unassignedPanelHtml(orphans)}</div>` : ''}
    ${notCounted ? `<div class="banner row nc-banner"><span><strong>${notCounted} part${notCounted === 1 ? '' : 's'} not counted yet.</strong>
      <span class="nc-why">Their Free figure is a guess until the rack is counted.</span></span>
      <button class="btn small" id="nc-count" data-need="stock">Count a rack…</button><a href="#/stock" id="nc-show">Show them</a></div>` : ''}
    <div class="panel flush">
      <div class="row" style="padding:12px 16px">
        <input type="search" id="sf" placeholder="Search name, SKU, plan column, supplier… (aircon, oven…)" style="width:300px" value="${esc(st.t || '')}">
        <select id="sc"><option value="">All categories</option>${cats.map(c => `<option ${st.c === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="sk"><option value="">All items</option>${kOpts.map(([v, l]) => `<option value="${v}" ${k0 === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select id="str"><option value="">All trades</option>${Object.entries(TRADE_NAMES).map(([k, l]) => `<option value="${k}" ${st.r === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <span class="grow"></span><span class="muted small" id="scount"></span></div>
      <div class="other-hits hidden" id="other-hits"></div>
      <p class="muted small" style="padding:0 16px;margin-top:-4px">${shelfTab
        ? 'Parts kept on the shelf and shared by every van. Short = needed by vans in production or due soon and not yet set aside. Still to order = what is left of that after what is already on order (the same as Purchasing → To order).'
        : 'Parts bought for one particular van (fridges, aircons, furniture…). They only ever go to their own van; any on the shelf with no van shows as <strong>Unassigned</strong>.'}</p>
      <div class="table-wrap"><table id="stk" class="cards-sm"><thead><tr><th>Item</th><th>Supplier</th><th>Location</th><th class="num">On hand</th><th class="num">Set aside</th>
        <th class="num">${shelfTab ? 'Free' : 'No van'}</th><th class="num">On order</th><th class="num" title="Needed by vans in production or due soon, not yet set aside">Short</th><th class="num" title="Short, after what is already on order — the same as Purchasing → To order">Still to order</th>${shelfTab ? '<th class="num">Reorder at</th><th>Last counted</th>' : ''}<th></th></tr></thead><tbody>
      ${list.map(i => {
        const guess = shelfTab && i.not_counted && !firstCountDone;
        const unassigned = !shelfTab && i.available > 1e-9;
        return `<tr class="clickable" data-id="${i.id}" data-cat="${esc(i.category)}" data-short="${i.short > 0 ? 1 : 0}" data-low="${i.low ? 1 : 0}" data-trade="${esc(i.trade || '')}"
          data-nc="${i.not_counted ? 1 : 0}" data-nosup="${String(i.supplier || '').trim() ? 0 : 1}" data-norack="${i.area_id ? 0 : 1}" data-un="${unassigned ? 1 : 0}"
          data-text="${esc((itemSearchText(i) + ' ' + (i.area_name || '')).toLowerCase())}">
        <td class="sc-item"><div class="item-cell">${thumbImg(i.photo)}<div><strong>${esc(i.name)}</strong>
          ${unassigned ? `<span class="chip urgent" title="On the shelf, not set aside for any van">Unassigned ${q(i.available)}</span>` : ''}
<div class="small muted">${esc(i.sku)} · ${esc(i.category)}${TRADE_NAMES[i.trade] ? ` · ${esc(TRADE_NAMES[i.trade])}` : ''}${i.unit_size ? ` · ${esc(i.unit_size)}` : ''}</div></div></div></td>
        <td class="small sm-hide">${esc(i.supplier) || '<span class="faint">—</span>'}</td>
        <td class="small sm-hide">${esc(where(i)) || '<span class="faint">no rack yet</span>'}</td>
        <td class="num sc-n" data-label="On hand">${q(i.on_hand)} <span class="small muted">${esc(i.unit)}</span></td><td class="num sc-n sm-hide" data-label="Set aside">${q(i.reserved)}</td>
        <td class="num sc-n" data-label="${shelfTab ? 'Free' : 'No van'}" style="${guess || i.available <= 0 ? 'color:var(--faint)' : ''}" ${guess ? 'title="Not counted yet — a guess"' : ''}>${shelfTab ? q(i.available) : unassigned ? `<strong style="color:var(--warn)">${q(i.available)}</strong>` : ''}</td>
        <td class="num sc-n" data-label="On order">${i.on_order ? q(i.on_order) : ''}</td>
        <td class="num sc-n" data-label="Short">${i.short ? q(i.short) : ''}</td>
        <td class="num sc-n" data-label="Still to order" style="color:var(--bad);font-weight:600">${toOrder[i.id] > 1e-9 ? q(toOrder[i.id]) : i.short ? '<span class="small ok-text" title="What is on order covers it">0</span>' : ''}</td>
        ${shelfTab ? `<td class="num sm-hide ${i.low ? '' : 'faint'}" style="${i.low ? 'color:var(--bad);font-weight:600' : ''}">${i.reorder_level > 0 ? q(i.reorder_level) : ''}</td>
          <td class="small nowrap sm-hide">${i.last_counted ? fmtDate(i.last_counted) : '<span class="faint">never</span>'}</td>` : ''}
        <td class="nowrap sc-btn"><button class="btn small" data-need="stock" data-recv="${i.id}">Receive</button></td></tr>`;
      }).join('')}
      </tbody></table></div></div>`;
  if (!shelfTab) wireUnassignedPanel($('#orphans'), orphans);
  const apply = () => {
    const t = $('#sf').value.toLowerCase(), c = $('#sc').value, k = $('#sk').value, r = $('#str').value;
    sessionStorage.setItem('stockFilter', JSON.stringify({ t, c, k, r }));
    let n = 0;
    const flag = { short: 'short', low: 'low', notcounted: 'nc', nosupplier: 'nosup', norack: 'norack', unassigned: 'un' };
    $$('#stk tbody tr').forEach(tr => {
      const ok = (!t || searchMatch(tr.dataset.text, t)) && (!c || tr.dataset.cat === c) &&
        (!k || k === 'placeholder' || tr.dataset[flag[k]] === '1') && (!r || tr.dataset.trade === r);
      tr.classList.toggle('hidden', !ok); if (ok) n++;
    });
    $('#scount').textContent = `${n} of ${list.length} items`;
    // Matches in the other tab (search text only), e.g. "aircon" on Shelf stock → "3 matches in Bought for vans".
    const o = t.trim() ? otherList.filter(i => searchMatch(otherText.get(i.id), t)).length : 0;
    const box = $('#other-hits');
    box.classList.toggle('hidden', !o);
    box.innerHTML = o ? `${n ? 'Also ' : ''}<strong>${o} match${o === 1 ? '' : 'es'}</strong> in ${otherName} – <a href="#/stock" id="other-go">show</a>` : '';
    const go = $('#other-go');
    if (go) go.onclick = e => {
      e.preventDefault();
      sessionStorage.setItem('stockFilter', JSON.stringify({ t, c: '', k: '', r: '' }));
      sessionStorage.setItem('stockTab', otherTab); reload();
    };
  };
  // Switching to / from the catch-alls changes which items are on the page.
  const wasPh = st.k === 'placeholder' && !shelfTab;
  $('#sf').oninput = apply; $('#sc').onchange = apply; $('#str').onchange = apply;
  $('#sk').onchange = () => { apply(); if (($('#sk').value === 'placeholder') !== wasPh) reload(); };
  apply();
  wireHead();
  const ncc = $('#nc-count');
  if (ncc) ncc.onclick = () => countRackDialog();
  const ncs = $('#nc-show');
  if (ncs) ncs.onclick = e => { e.preventDefault(); $('#sk').value = 'notcounted'; apply(); };
  $$('#stk tbody tr').forEach(tr => tr.onclick = e => { if (!e.target.closest('button')) itemDialog(Number(tr.dataset.id)); });
  $$('[data-recv]').forEach(b => b.onclick = () => receiveDialog(list.find(i => i.id === Number(b.dataset.recv))));
}

async function receiveDialog(i) {
  // Per-van parts are received for one particular van.
  const waiting = i.kind === 'per-van' ? (await api('GET', `/api/items/${i.id}`)).usage.filter(u => u.qty > u.reserved + u.issued) : [];
  const m = modal(`Receive ${i.name}`, `
    <form id="rf" class="stack"><div class="form-grid">
      <label class="field">Quantity received (${esc(i.unit)})<input type="number" name="qty" min="0" step="any" required></label>
      <label class="field">Reference (delivery docket / PO)<input type="text" name="ref"></label>
      ${i.kind === 'per-van' ? `<label class="field">For van<select name="van_id"><option value="">Not for a particular van</option>
        ${waiting.map(u => `<option value="${u.van_id}">${esc(u.chassis)} (due ${fmtDate(u.eta)})</option>`).join('')}</select></label>` : ''}</div>
      <div class="hint">For deliveries against a purchase order, receive from the PO instead so it gets ticked off.
      ${i.kind === 'per-van' ? 'This part is made for a specific van, so it is only set aside for the van you pick.' : 'New stock goes to waiting vans, earliest delivery first.'}</div></form>`,
    { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="rf-save">Receive</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $('#rf-save', m.el).onclick = e => busy(e.currentTarget, async () => {
    const f = formData($('#rf', m.el));
    await act(() => api('POST', `/api/items/${i.id}/receive`, f), 'Stock received'); m.close(); reload();
  });
}

// Where a part is kept: rack + shelf / bin (issue #13 — stores can set it here; the server lets stores change only
// these two fields of a part). Shown on the worker app's Find a part, with the rack on the map.
async function placeDialog(i) {
  const lay = await api('GET', '/api/layout');
  const racks = lay.areas.filter(a => a.kind === 'storage').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const m = modal(`Where is ${i.name} kept?`, `<form id="plf" class="form-grid">
      <label class="field">Rack<select name="area_id"><option value="">— not on a rack —</option>${racks.map(a =>
        `<option value="${a.id}" ${a.id === i.area_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field">Shelf / bin<input type="text" name="location" maxlength="60" value="${esc(i.location || '')}" placeholder="e.g. Shelf 3"></label></form>
    <div class="hint" style="margin-top:8px">Workers see it on Find a part, with the rack on the map.</div>`,
  { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="plf-save">Save place</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $('#plf-save', m.el).onclick = e => {
    const f = formData($('#plf', m.el));
    return busy(e.currentTarget, async () => {
      await act(() => api('PUT', `/api/items/${i.id}`, { area_id: f.area_id ? Number(f.area_id) : null, location: String(f.location || '').trim().slice(0, 60) }), 'Place saved');
      itemsCache = null; m.close(); itemDialog(i.id);
    });
  };
}

async function itemDialog(itemId) {
  const d = await api('GET', `/api/items/${itemId}`);
  const i = d.item;
  // Receive / Count / Edit: inside the window on a PC; in the bottom bar on a phone, always in reach (C8).
  const itemActs = '<button class="btn" data-need="stock" data-ia="recv">Receive</button><button class="btn" data-need="stock" data-ia="count">Count / adjust</button><button class="btn" data-need="stock" data-ia="place">Place</button><button class="btn" data-need="office" data-ia="edit">Edit item</button>';
  const m = modal(i.name, `
    <div class="item-head">
      <div class="photo-box">${i.photo
        ? `<a href="${photoSrc(i.photo)}" target="_blank" rel="noopener" title="Open full size"><img src="${photoSrc(i.photo)}" alt="Photo of ${esc(i.name)}"></a>`
        : '<div class="photo-empty">No photo yet</div>'}
        <div class="row" style="margin-top:8px">
          <label class="btn small" data-need="stock">${i.photo ? 'Change photo' : 'Add photo'}<input type="file" accept="image/*" id="i-photo" hidden></label>
          <button class="btn small" id="i-photo-web" data-need="webImage">From internet…</button>
          ${i.photo ? '<button class="btn small link" id="i-photo-del" data-need="stock">Remove</button>' : ''}</div>
        <div class="hint mouse-only">Phone/tablet: <em>Add photo</em> opens the camera. Or copy a picture on any website (right-click → Copy image) and press Ctrl+V here.</div>
        <div class="hint touch-only"><em>Add photo</em> uses the camera. <em>From internet…</em> takes a picture link.</div>
      </div>
      <div class="grow">
        <div class="row" style="margin-bottom:12px"><span class="mono">${esc(i.sku)}</span><span class="muted">${esc(i.category)} · ${esc(i.supplier || 'no supplier')}</span>
          ${i.kind === 'per-van' ? '<span class="chip perv">ordered per van</span>' : ''}
          ${i.last_counted ? `<span class="small muted">Last counted ${esc(fmtDate(i.last_counted))}</span>` : i.not_counted ? '<span class="chip notcounted">Not counted yet</span>' : ''}</div>
        ${i.area_name || i.location ? `<div class="row" style="margin:-4px 0 12px"><span>📍 <b>${esc([i.area_name, i.location].filter(Boolean).join(' · '))}</b></span>
          ${i.area_id ? '<button class="btn small" id="i-map">Show on map</button>' : ''}</div>` : ''}
    <div class="tiles">
      <div class="tile"><div class="n">${q(i.on_hand)}</div><div class="l">On hand (${esc(i.unit)}${i.unit_size ? ` · ${esc(i.unit_size)}` : ''})</div></div>
      <div class="tile"><div class="n">${q(i.reserved)}</div><div class="l">Set aside for vans</div></div>
      ${i.kind === 'per-van'
        ? `<div class="tile ${d.unassigned ? 'warn' : ''}"><div class="n">${q(d.unassigned)}</div><div class="l">On the shelf with no van</div></div>`
        : `<div class="tile"><div class="n" style="${i.not_counted ? 'color:var(--faint)' : ''}">${q(i.available)}</div><div class="l">Free${i.not_counted ? ' — not counted yet' : ''}</div></div>`}
      <div class="tile"><div class="n">${q(i.on_order)}</div><div class="l">On order</div></div>
      <div class="tile ${i.short ? 'bad' : ''}"><div class="n">${q(i.short)}</div><div class="l">Short for vans due soon</div></div>
    </div>
    ${d.unassigned > 0 ? `<div class="warn-text" style="margin:-6px 0 10px">${q(d.unassigned)} ${esc(i.unit)} bought for a van but not set aside for any van${d.spare >= d.unassigned ? ' (kept as a spare)' : ''}.
      <a href="#/stock" id="i-orph">Assign to a van →</a></div>` : ''}
    ${i.kind === 'stock' && !i.placeholder ? `<div class="row small" style="margin:-4px 0 12px">Reorder at <strong>${i.reorder_level > 0 ? q(i.reorder_level) : 'not set'}</strong>${i.order_up_to > 0 ? `, order up to <strong>${q(i.order_up_to)}</strong>` : ''}
      ${d.reorder?.level ? `<span class="muted">· suggested ${q(d.reorder.level)} (${esc(d.reorder.why)})</span>${Number(d.reorder.level) !== Number(i.reorder_level) ? ' <button class="btn small" id="i-reo" data-need="office">Apply</button>' : ''}`
        : d.reorder ? `<span class="muted">· no suggestion: ${esc(d.reorder.why)}</span>` : ''}</div>` : ''}
    <div class="row sm-hide" style="margin-bottom:14px">${itemActs}</div>
      </div>
    </div>
    <div class="grid2">
      <div>${spareHtml(d)}<h3>Needed by vans</h3>${d.usage.length ? `<table class="usage-t"><thead><tr><th>Van</th><th>Due</th><th class="num">Need</th><th class="num">Aside</th><th class="num">Issued</th></tr></thead><tbody>
        ${d.usage.map(u => `<tr><td><a href="#/vans/${u.van_id}">${esc(u.chassis)}</a></td><td class="small">${fmtDate(u.eta)}</td><td class="num">${q(u.qty)}</td><td class="num">${q(u.reserved)}</td><td class="num">${q(u.issued)}</td></tr>${u.cover ? `<tr class="cover-row"><td colspan="5" class="small cover-note">${esc(u.chassis)}: coming on ${esc(u.cover.text)}</td></tr>` : ''}`).join('')}</tbody></table>`
        : '<div class="muted small">No active van needs this.</div>'}
        <h3 style="margin-top:16px">Rules that add it</h3>${d.rules.length ? d.rules.map(r => `<div class="small"><strong>${esc(r.name)}</strong> <span class="mono faint">${esc(r.conditions.replace(/\n/g, ' · '))}</span> × ${esc(r.qty)}</div>`).join('') : '<div class="muted small">None — only added by hand.</div>'}
      </div>
      <div><h3>History</h3>${d.movements.length ? `<table><tbody>${d.movements.map(mv => `<tr><td class="small muted nowrap">${esc(mv.at.slice(0, 16))}</td>
        <td class="small">${esc(mv.type)}${mv.chassis ? ` · ${esc(mv.chassis)}` : ''}${mv.ref && mv.ref !== mv.chassis ? ` · ${esc(mv.ref)}` : ''}${mv.worker ? ` · by ${esc(mv.worker)}` : ''}${mv.note ? `<div class="faint">${esc(mv.note)}</div>` : ''}</td>
        <td class="num" style="color:${mv.qty < 0 ? 'var(--bad)' : 'var(--ok)'}">${mv.qty > 0 ? '+' : ''}${q(mv.qty)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">No movements yet.</div>'}
      </div></div>
    <details style="margin-top:14px" ${d.history.length && d.history.length <= 8 ? 'open' : ''}><summary><h3 style="display:inline">Set-aside history</h3>
      <span class="small muted">${d.history.length} change(s) — who set aside, moved or used this part, and why</span></summary>
      ${d.history.length ? `<div class="table-wrap" style="max-height:320px;overflow:auto"><table><thead><tr><th>When</th><th>What</th><th>Change</th><th>Who</th></tr></thead>
        <tbody>${historyRows(d.history)}</tbody></table></div>` : '<div class="muted small">Nothing recorded yet.</div>'}</details>`, { wide: true, footer: itemActs, footerClass: 'sm-foot' });
  // After a photo change, refresh the page behind and show the item again with its new picture.
  const refresh = async msg => { m.close(); toast(msg); await reload(); itemDialog(itemId); };
  $('#i-photo', m.el).onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.closest('label').textContent = 'Uploading…';
    try { await uploadItemPhoto(itemId, file); await refresh('Photo saved'); }
    catch (err) { toast(err.message, true); m.close(); itemDialog(itemId); }
  };
  const saveBlob = async blob => {
    const box = $('.photo-box', m.el);
    if (box) box.classList.add('busy');
    try { await uploadItemPhoto(itemId, blob); await refresh('Photo saved'); }
    catch (err) { toast(err.message, true); if (box) box.classList.remove('busy'); }
  };
  $('#i-photo-web', m.el).onclick = () => webPhotoDialog(i, saveBlob);
  const mapBtn = $('#i-map', m.el);
  if (mapBtn) mapBtn.onclick = () => {
    m.close();
    sessionStorage.setItem('factoryHighlight', i.area_id);
    sessionStorage.setItem('factoryMode', '2d');
    factoryState.selected = null;
    location.hash = '#/factory';
  };

  // Ctrl+V a copied picture (or a picture link) while this item is open.
  const onPaste = e => {
    if (!m.el.isConnected) { document.removeEventListener('paste', onPaste); return; }
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const file = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith('image/'))?.getAsFile();
    if (file) { e.preventDefault(); saveBlob(file); return; }
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (/^https?:\/\//i.test(text || '')) { e.preventDefault(); webPhotoDialog(i, saveBlob, text); }
  };
  document.addEventListener('paste', onPaste);

  // Drag a picture from a website or a file onto the photo.
  const box = $('.photo-box', m.el);
  box.ondragover = e => { e.preventDefault(); box.classList.add('over'); };
  box.ondragleave = () => box.classList.remove('over');
  box.ondrop = e => {
    e.preventDefault();
    box.classList.remove('over');
    const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
    if (file) return saveBlob(file);
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
    if (/^https?:\/\//i.test(url)) webPhotoDialog(i, saveBlob, url);
  };

  const del = $('#i-photo-del', m.el);
  if (del) del.onclick = async () => {
    if (!confirm('Remove this photo?')) return;
    await act(() => api('DELETE', `/api/items/${itemId}/photo`));
    itemsCache = null;
    await refresh('Photo removed');
  };
  const reo = $('#i-reo', m.el);
  if (reo) reo.onclick = () => busy(reo, async () => {
    await act(() => api('PUT', `/api/items/${itemId}`, { reorder_level: d.reorder.level, by: officeName() }), `Reorder level set to ${q(d.reorder.level)}`);
    itemsCache = null; m.close(); await reload(); itemDialog(itemId);
  });
  const orph = $('#i-orph', m.el);
  if (orph) orph.onclick = () => { m.close(); sessionStorage.setItem('stockTab', 'pervan'); if (location.hash === '#/stock') reload(); };
  const onAct = (k, fn) => $$(`[data-ia="${k}"]`, m.el).forEach(b => { b.onclick = fn; });
  onAct('recv', () => { m.close(); receiveDialog(i); });
  onAct('place', () => { m.close(); placeDialog(i); });
  onAct('edit', async () => { m.close(); editItemDialog(i, [...new Set((await items()).map(x => x.category))].sort()); });
  onAct('count', () => {
    m.close();
    const a = modal(`Count / adjust ${i.name}`, `
      <form id="af" class="stack"><div class="form-grid">
        <label class="field">How<select name="mode"><option value="set">Set on-hand to counted quantity</option><option value="add">Add / subtract (use minus for write-off)</option></select></label>
        <label class="field"><span id="af-qlabel">Counted quantity</span><input type="number" name="qty" step="any" value="${q(i.on_hand)}"></label></div>
        <label class="field">Reason<input type="text" name="note" placeholder="e.g. stocktake, damaged, found"></label></form>`,
      { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="af-save">Save</button>' });
    $('[data-close]', a.el).onclick = a.close;
    // Switching mode must not leave the on-hand figure in the box (adding it would double the stock).
    $('#af [name=mode]', a.el).onchange = e => {
      const add = e.target.value === 'add';
      $('#af [name=qty]', a.el).value = add ? '' : q(i.on_hand);
      $('#af-qlabel', a.el).textContent = add ? 'Quantity to add (minus to remove)' : 'Counted quantity';
    };
    $('#af-save', a.el).onclick = e => {
      const f = formData($('#af', a.el));
      if (String(f.qty).trim() === '' || !Number.isFinite(Number(f.qty))) return toast('Type a quantity', true);
      return busy(e.currentTarget, async () => {
        await act(() => api('POST', `/api/items/${i.id}/adjust`, { ...f, qty: Number(f.qty), by: officeName() }), 'Stock updated'); a.close(); reload();
      });
    };
  });
}

async function editItemDialog(i, cats) {
  const isNew = !i;
  i = i || { sku: '', name: '', category: '', supplier: '', unit: 'ea', kind: 'stock', reorder_level: 0, location: '', notes: '', active: 1 };
  const racks = (await api('GET', '/api/layout')).areas.filter(a => a.kind === 'storage');
  const m = modal(isNew ? 'New item' : `Edit ${i.name}`, `
    <form id="itf" class="form-grid">
      <label class="field">SKU<input type="text" name="sku" value="${esc(i.sku)}" required></label>
      <label class="field" style="grid-column:span 2">Name<input type="text" name="name" value="${esc(i.name)}" required></label>
      <label class="field">Category<input type="text" name="category" list="cat-dl" value="${esc(i.category)}"><datalist id="cat-dl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="field">Supplier<input type="text" name="supplier" value="${esc(i.supplier)}"></label>
      <label class="field">Unit<input type="text" name="unit" value="${esc(i.unit)}" placeholder="ea, length, set, m…"></label>
      <label class="field">What one unit is<input type="text" name="unit_size" value="${esc(i.unit_size || '')}" placeholder="e.g. 1 length = 6.5 m, set = 1 van"></label>
      <label class="field">Type<select name="kind"><option value="stock" ${i.kind === 'stock' ? 'selected' : ''}>Kept on the shelf</option><option value="per-van" ${i.kind === 'per-van' ? 'selected' : ''}>Bought for one van</option></select></label>
      <label class="field">Reorder level (shelf parts)<input type="number" name="reorder_level" min="0" step="any" value="${q(i.reorder_level)}"></label>
      <label class="field">Order up to (blank = reorder level)<input type="number" name="order_up_to" min="0" step="any" value="${i.order_up_to > 0 ? q(i.order_up_to) : ''}"></label>
      <label class="field">Stored in (rack)<select name="area_id"><option value="">— not set —</option>
        ${racks.map(a => `<option value="${a.id}" ${a.id === i.area_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field">Shelf / bin<input type="text" name="location" value="${esc(i.location)}" placeholder="e.g. Shelf 3"></label>
      <label class="field">Trade (who fits it)<select name="trade"><option value="">— guess from the name —</option>
        ${Object.entries(TRADE_NAMES).map(([k, l]) => `<option value="${k}" ${k === i.trade ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field">Production plan column<input type="text" name="plan_column" value="${esc(i.plan_column || '')}" placeholder="e.g. Battery"></label>
      ${isNew ? '<label class="field">Opening stock<input type="number" name="on_hand" min="0" step="any" value="0"></label>' : ''}
      <label class="field" style="grid-column:1/-1">Notes<input type="text" name="notes" value="${esc(i.notes)}"></label>
      ${isNew ? '' : `<label class="row" style="grid-column:1/-1"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> Active (untick to retire this item — its rules stop adding it)</label>`}
    </form>`, { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="itf-save">Save</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $('#itf-save', m.el).onclick = e => busy(e.currentTarget, async () => {
    const f = formData($('#itf', m.el));
    if (!isNew) f.active = !!$('#itf [name=active]', m.el).checked;
    f.by = officeName();
    await act(() => isNew ? api('POST', '/api/items', f) : api('PUT', `/api/items/${i.id}`, f), 'Item saved');
    itemsCache = null; m.close(); reload();
  });
}

function stocktakeDialog() {
  const m = modal('Stocktake / bulk count', `
    <p class="muted" style="margin-top:0">Paste one line per item: <span class="mono">SKU, quantity</span>. You can copy two columns straight out of Excel.
    The on-hand count is set to what you enter; anything set aside for vans is adjusted to match.</p>
    <textarea id="st-rows" rows="12" class="mono" placeholder="BAT-110, 6&#10;SOLAR-200	14"></textarea>
    <label class="field" style="margin-top:10px">Note<input type="text" id="st-note" value="Stocktake ${new Date().toLocaleDateString('en-AU')}"></label>`,
    { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="st-save">Update counts</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $('#st-save', m.el).onclick = async () => {
    const rows = $('#st-rows', m.el).value.split(/\r?\n/).map(l => l.split(/[,\t;]/).map(s => s.trim())).filter(r => r[0] && r[1] !== undefined && r[1] !== '' && !isNaN(Number(r[1])))
      .map(([sku, qty]) => ({ sku, qty: Number(qty) }));
    if (!rows.length) return toast('Nothing to update — use "SKU, quantity" per line', true);
    const r = await act(() => api('POST', '/api/stocktake', { rows, note: $('#st-note', m.el).value }));
    toast(`Updated ${r.updated} item(s)${r.unknown.length ? ` — unknown SKUs: ${r.unknown.join(', ')}` : ''}`, r.unknown.length > 0);
    m.close(); reload();
  };
}

// ───────────────────────── purchasing ─────────────────────────
// Purchasing, purchase orders and line statuses are in purchasing.js.

// ───────────────────────── rules ─────────────────────────

const RULE_HELP = `
  <details class="small" style="margin-top:6px"><summary class="muted" style="cursor:pointer">How to write conditions</summary>
  <div style="padding:8px 0" class="stack">
    <div>One condition per line — all must be true. <strong>OPTION</strong> is the label on the dealer form (start of it is enough).</div>
    <div><span class="mono">BATTERIES ~ 110</span> — the option's text contains “110” (it's a pattern: <span class="mono">a|b</span> means a or b, <span class="mono">^yes</span> means starts with yes)</div>
    <div><span class="mono">INVERTER !~ ^no</span> — does <em>not</em> contain it (also true if the option isn't on the form)</div>
    <div><span class="mono">STARLINK ?</span> — filled in and not No / None / Remove / 0</div>
    <div><span class="mono">*</span> — always: a standard part on every van</div>
    <div><strong>Quantity</strong>: a number, or <span class="mono">n</span> = the “3 X” in “3 X 200 watt”, <span class="mono">num</span> = first number, <span class="mono">sumx</span> = all the “2x … 1x …” added up.
      Read another option with <span class="mono">n[FRESH WATER TANKS]</span>. Maths works: <span class="mono">n[FRESH WATER TANKS] + n[GREY WATER TANK]</span></div>
    <div><strong>Spec options</strong>: other options whose text is copied onto the part line (e.g. colours for the furniture order). They also stop those options showing up as “check by hand”.</div>
  </div></details>`;

async function renderRules() {
  const [rules] = await Promise.all([api('GET', '/api/rules'), items()]);
  fillItemDatalist();
  app.innerHTML = `
    <div class="page-head"><h1>Parts rules</h1><span class="muted">${rules.length} rules — how dealer order options turn into parts</span>
      <div class="actions"><button class="btn primary" id="new">+ New rule</button></div></div>
    <div class="panel flush">
      <div class="row" style="padding:12px 16px"><input type="search" id="rf" placeholder="Search rules, options, items…" style="width:300px"></div>
      <div class="table-wrap"><table id="rt"><thead><tr><th>Rule</th><th>When the order says</th><th>Add item</th><th class="num">Qty</th><th></th></tr></thead><tbody>
      ${rules.map(r => `<tr class="clickable" data-id="${r.id}" data-text="${esc((r.name + ' ' + r.conditions + ' ' + r.sku + ' ' + r.item_name).toLowerCase())}" style="${r.active ? '' : 'opacity:.5'}">
        <td><strong>${esc(r.name || '(unnamed)')}</strong>${r.active ? '' : ' <span class="chip closed">off</span>'}</td>
        <td class="mono">${esc(r.conditions).replace(/\n/g, '<br>')}</td>
        <td>${esc(r.item_name)}<div class="small faint">${esc(r.sku)}</div></td><td class="num mono">${esc(r.qty)}</td>
        <td><button class="btn small">Edit</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
  $('#rf').oninput = e => { const t = e.target.value.toLowerCase(); $$('#rt tbody tr').forEach(tr => tr.classList.toggle('hidden', t && !tr.dataset.text.includes(t))); };
  $$('#rt tbody tr').forEach(tr => tr.onclick = () => ruleDialog(rules.find(r => r.id === Number(tr.dataset.id))));
  $('#new').onclick = () => ruleDialog(null);
}

function ruleDialog(r) {
  const isNew = !r;
  r = r || { name: '', conditions: '', item_id: null, qty: '1', spec_fields: '', active: 1 };
  const m = modal(isNew ? 'New rule' : 'Edit rule', `
    <form id="ruf" class="stack">
      <label class="field">Rule name<input type="text" name="name" value="${esc(r.name)}" placeholder="e.g. Batteries 110Ah"></label>
      <label class="field">When the order says (one condition per line)<textarea name="conditions" rows="4" class="mono" placeholder="BATTERIES ~ 110">${esc(r.conditions)}</textarea></label>
      ${RULE_HELP}
      <label class="field">Add this item${itemPicker('item', r.item_id)}</label>
      <div class="form-grid">
        <label class="field">Quantity<input type="text" name="qty" class="mono" value="${esc(r.qty)}"></label>
        <label class="field" style="grid-column:span 2">Spec options (comma separated, optional)<input type="text" name="spec_fields" value="${esc(r.spec_fields)}"></label></div>
      <label class="row"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Rule is on</label>
      <div><button type="button" class="btn small" id="ru-test">Test against current vans</button><div id="ru-out" class="small" style="margin-top:8px"></div></div>
    </form>`, { wide: true, footer: `${isNew ? '' : '<button class="btn danger" id="ru-del">Delete</button>'}<span class="grow"></span>
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="ru-save">Save rule</button>` });
  $('[data-close]', m.el).onclick = m.close;
  const read = () => {
    const f = $('#ruf', m.el);
    return { name: f.name.value, conditions: f.conditions.value, item_id: pickedItemId(f.item), qty: f.qty.value, spec_fields: f.spec_fields.value, active: f.active.checked };
  };
  $('#ru-test', m.el).onclick = async () => {
    try {
      const res = await api('POST', '/api/rules/test', read());
      const hit = res.filter(x => x.fired);
      $('#ru-out', m.el).innerHTML = res.length
        ? `<strong>Would add the item to ${hit.length} of ${res.length} active vans.</strong>` + hit.map(x => `<div><span class="mono">${esc(x.chassis)}</span> <span class="muted">${esc(x.matched.join(' · '))}</span></div>`).join('')
        : 'No active vans to test against.';
    } catch (e) { $('#ru-out', m.el).innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  };
  $('#ru-save', m.el).onclick = e => {
    const body = read();
    if (!body.item_id) return toast('Pick the item from the list', true);
    return busy(e.currentTarget, async () => {
      await act(() => isNew ? api('POST', '/api/rules', body) : api('PUT', `/api/rules/${r.id}`, body),
        'Rule saved — use “Re-run parts rules” on a van to apply it to vans already loaded');
      m.close(); reload();
    });
  };
  const del = $('#ru-del', m.el);
  if (del) del.onclick = async () => { if (!confirm('Delete this rule?')) return; await act(() => api('DELETE', `/api/rules/${r.id}`), 'Rule deleted'); m.close(); reload(); };
}

// ───────────────────────── settings ─────────────────────────

async function renderSettings() {
  const s = await api('GET', '/api/settings');
  app.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="panel"><h2>Worker screen</h2>
      <p class="muted small" style="margin-top:0">A simple screen for the floor: pick the van, tap the part, done. No office menus.
      Open this address on the workers' phones or tablets (same Wi-Fi) and add it to the home screen:</p>
      ${s.floorUrls.map(u => `<div class="row" style="margin-bottom:6px"><span class="mono" style="font-size:16px">${esc(u)}</span>
        <button class="btn small" data-copy="${esc(u)}">Copy</button></div>`).join('') || '<div class="muted">Not connected to a network.</div>'}
      <div class="row" style="margin-top:8px"><a class="btn" href="/floor" target="_blank" rel="noopener">Open worker screen</a></div></div>
    <div class="panel" id="plan-import"><h2>Update from the production plan spreadsheet</h2>
      <p class="muted small" style="margin-top:0">Brings in what changed on the spreadsheet: new vans and part lines, new due dates and statuses, and deliveries
      (grey cells) and fitted parts (blue cells). <strong>You always see what will change first, and nothing happens until you press Confirm.</strong>
      A delivery is never booked twice, a part already set aside is never changed without asking, and nothing is deleted — vans or lines missing
      from the sheet are only marked “Not in latest plan – check”.</p>
      <div class="row"><input type="file" id="plan-file" accept=".xlsx,.xlsm"><button class="btn primary" id="plan-check" disabled>Check what will change</button></div>
      <div id="plan-out" style="margin-top:12px"></div>
      ${s.importHistory?.length ? `<details class="small" style="margin-top:12px"><summary class="muted" style="cursor:pointer">Last imports</summary>
        <table><tbody>${s.importHistory.map(h => `<tr><td class="nowrap">${esc(new Date(h.at).toLocaleString('en-AU'))}</td><td>${esc(h.mode === 'update' ? 'Update' : 'Start again')}</td>
          <td>${esc(h.file || '')}</td><td>${esc(h.by || '')}</td><td class="muted">${h.counts ? esc(Object.entries(h.counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')) : ''}</td></tr>`).join('')}</tbody></table></details>`
        : s.planImportedAt ? `<p class="muted small">Last imported ${esc(new Date(s.planImportedAt).toLocaleString('en-AU'))}.</p>` : ''}
    </div>
    <div id="plan-conflicts"></div>
    <div class="grid2">
      <div class="panel"><h2>Defaults</h2>
        <label class="field">Dealer name filled in on new orders<input type="text" id="dealer" value="${esc(s.dealer)}"></label>
        <div style="margin-top:12px"><button class="btn primary" id="save1">Save</button></div></div>
      <div class="panel"><h2>Options that never need parts</h2>
        <p class="muted small" style="margin-top:0">These order options are never listed under “check by hand”. One pattern per line, matched against the option label
        (<span class="mono">^MAKE$</span> = exactly MAKE). <span class="mono">^section:EXTRAS$</span> skips the whole EXTRAS section.</p>
        <textarea id="ignore" rows="10" class="mono">${esc(s.ignore.join('\n'))}</textarea>
        <div style="margin-top:12px"><button class="btn primary" id="save2">Save</button></div></div>
      <div class="panel"><h2>Export</h2><p class="muted small" style="margin-top:0">Production plan (one row per van), every part line, what to order by supplier, and the stock list.</p>
        <a class="btn" href="/api/export/plan.xlsx">Download Excel</a>
        ${s.lastBackup ? `<p class="muted small" style="margin-bottom:0">Last backup: ${esc(new Date(s.lastBackup).toLocaleString('en-AU'))}${Date.now() - new Date(s.lastBackup) > 2 * 864e5 ? ' — <strong>more than 2 days ago. Check the backup drive is plugged in.</strong>' : ''}</p>` : ''}</div>
      <div class="panel"><h2>Stock levels</h2>
        <p class="muted small" style="margin-top:0">${s.demo ? '<strong>Demo stock levels are loaded.</strong> ' : ''}Set every shelf stock count to zero, e.g. before your first real stocktake. Parts already received for a van stay with that van. Vans, rules and the stock history are kept.</p>
        <button class="btn danger" id="clear">Set shelf stock to zero</button></div>
      <div class="panel danger-zone"><h2>Start again from the spreadsheet</h2>
        <p class="muted small" style="margin-top:0">Only if the data has gone badly wrong. <strong>Wipes every van, part line, purchase order, stock figure and the stock
        history</strong>, and loads everything again from the spreadsheet chosen above. A full backup is made first, and you have to type RESET.
        Items, parts rules, and for each chassis on the sheet its dealer-order details, notes, reminders and bay are kept. The clean-up then runs again.</p>
        <button class="btn danger" id="plan-reset" disabled>Start again from spreadsheet…</button></div>
    </div>`;
  $$('[data-copy]').forEach(b => b.onclick = () => {
    navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied'), () => toast(b.dataset.copy));
  });
  const pf = $('#plan-file');
  pf.onchange = () => { $('#plan-check').disabled = !pf.files.length; $('#plan-reset').disabled = !pf.files.length; $('#plan-out').innerHTML = ''; };
  const send = async (url) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(pf.files[0].name) },
      body: await pf.files[0].arrayBuffer() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { authCheck(res, data); throw new Error(data.error || 'Import failed'); }
    return data;
  };
  const by = () => encodeURIComponent(officeName() || 'Office');
  $('#plan-check').onclick = async () => {
    const out = $('#plan-out');
    out.innerHTML = '<span class="muted">Reading… (nothing is changed yet)</span>';
    let p;
    try { p = await send('/api/import/plan/update/preview'); } catch (e) { out.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; return; }
    const c = p.counts;
    const list = (title, rows, fmt, cls = '') => rows.length ? `<details class="small" style="margin-top:6px" ${cls === 'warn' ? 'open' : ''}><summary style="cursor:pointer" class="${cls === 'warn' ? 'warn-text' : 'muted'}">${title} (${rows.length})</summary>
      <div class="table-wrap" style="max-height:240px;overflow:auto"><table><tbody>${rows.map(r => `<tr>${fmt(r)}</tr>`).join('')}</tbody></table></div></details>` : '';
    const nothing = !Object.entries(c).some(([k, v]) => k !== 'statusKept' && v);
    out.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="n">${c.newVans}</div><div class="l">New vans</div></div>
        <div class="tile"><div class="n">${c.newLines + c.newVanCells}</div><div class="l">New part lines${c.newVanCells ? ` (${c.newVanCells} on new vans)` : ''}</div></div>
        <div class="tile"><div class="n">${c.dates + c.statuses}</div><div class="l">Date / status changes</div></div>
        <div class="tile"><div class="n">${c.textUpdates}</div><div class="l">Lines with new text (nothing set aside yet)</div></div>
        <div class="tile"><div class="n">${c.receipts}</div><div class="l">Deliveries to book in (grey)</div></div>
        <div class="tile"><div class="n">${c.fitted}</div><div class="l">Parts to close as fitted (blue)</div></div>
        ${c.given ? `<div class="tile"><div class="n">${c.given}</div><div class="l">Given to a worker ("Gave to …") — booked out to the van</div></div>` : ''}
        <div class="tile ${c.conflicts ? 'warn' : ''}"><div class="n">${c.conflicts}</div><div class="l">Changed after parts were set aside</div></div>
        <div class="tile ${c.removedVans + c.removedLines ? 'warn' : ''}"><div class="n">${c.removedVans + c.removedLines}</div><div class="l">Not in the latest plan</div></div>
      </div>
      ${list('Plan changed after parts were set aside — these are NOT changed; you choose afterwards', p.conflicts, r => `<td>${esc(r.chassis)}</td><td>${esc(r.column)}</td><td>${esc(r.message)}</td>`, 'warn')}
      ${list('Not in the latest plan — will be marked “check”, never deleted', [...p.removedVans.map(v => ({ ...v, column: 'whole van' })), ...p.removedLines],
        r => `<td>${esc(r.chassis)}</td><td>${esc(r.column)}</td><td>${esc(r.name || '')} ${r.spec ? `<span class="muted">${esc(r.spec)}</span>` : ''}</td>`, 'warn')}
      ${list('New vans', p.newVans, r => `<td>${esc(r.chassis)}</td><td>${esc(r.model)}</td><td>${esc(STATUS_LABEL[r.status] || r.status)}</td><td>${fmtDate(r.eta)}</td><td>${r.cells} cells</td>`)}
      ${list('New part lines on vans already here', p.newLines, r => `<td>${esc(r.chassis)}</td><td>${esc(r.column)}</td><td>${esc(r.text)}</td><td>${esc(r.status === 'none' ? '' : r.status)}</td>`)}
      ${list('Date changes', p.dateChanges, r => `<td>${esc(r.chassis)}</td><td>${fmtDate(r.from) || 'no date'} → <strong>${fmtDate(r.to)}</strong></td>`)}
      ${list('Status changes', p.statusChanges, r => `<td>${esc(r.chassis)}</td><td>${esc(STATUS_LABEL[r.from])} → <strong>${esc(STATUS_LABEL[r.to])}</strong></td>`)}
      ${list('Lines with new text or quantity', p.textUpdates, r => `<td>${esc(r.chassis)}</td><td>${esc(r.column)}</td><td class="muted">${esc(r.was)}</td><td>→ ${esc(r.now)}</td>`)}
      ${list('Deliveries to book in (only up to what each line still needs)', p.receipts, r => `<td>${esc(r.chassis)}</td><td>${esc(r.column)}</td><td>${q(r.qty)} ${esc(r.unit || '')} ${esc(r.name)}</td>`)}
      ${list('Parts to close as fitted', p.fitted, r => `<td>${esc(r.chassis)}</td><td>${esc(r.column)}</td><td>${esc(r.name)}</td>`)}
      ${list('Given to a worker — closed as given out (anything set aside comes off the shelf figure)', p.given || [], r => `<td>${esc(r.chassis)}</td><td>${esc(r.column)}</td><td>${esc(r.name)}</td><td class="muted">${esc(r.text)}</td>`)}
      ${p.dealerVans?.length ? `<div class="small muted" style="margin-top:6px">${p.dealerVans.length} van(s) came from a dealer order (${esc(p.dealerVans.map(v => v.chassis).join(', '))}): only their date and status follow the sheet.</div>` : ''}
      ${c.statusKept ? `<div class="small muted" style="margin-top:6px">${c.statusKept} van(s) are further along here than on the sheet — kept as they are.</div>` : ''}
      <div class="row" style="margin-top:12px">${nothing ? '<span class="muted">Nothing to update — the system already matches this spreadsheet.</span>'
        : '<button class="btn primary" id="plan-apply">Confirm — update from spreadsheet</button><button class="btn" id="plan-cancel">Cancel</button>'}</div>`;
    const cancel = $('#plan-cancel');
    if (cancel) cancel.onclick = () => { out.innerHTML = ''; };
    const go = $('#plan-apply');
    if (go) go.onclick = () => busy(go, async () => {
      try {
        const r = await send(`/api/import/plan/update?by=${by()}`);
        toast(`Updated from ${pf.files[0].name}: ${r.counts.newVans} new van(s), ${r.counts.newLines + r.counts.newVanCells} new line(s), ${r.counts.receipts} deliveries booked${r.counts.conflicts ? `, ${r.counts.conflicts} to check` : ''}`);
        reload();
      } catch (err) { toast(err.message, true); }
    });
  };
  $('#plan-reset').onclick = async e => {
    if (!pf.files.length) return toast('Choose the spreadsheet first', true);
    let p;
    try { p = await send('/api/import/plan/preview'); } catch (err) { return toast(err.message, true); }
    const lo = p.lose || {};
    const lost = [
      `every van, part line and purchase order now in the system (${lo.purchaseOrders || 0} purchase orders, ${lo.setAside || 0} lines with parts set aside)`,
      lo.movements ? `${lo.movements} stock history entries (parts taken, deliveries, counts)` : '',
      lo.manualLines ? `${lo.manualLines} parts added to vans by hand` : '',
      lo.stockCounts ? `${lo.stockCounts} shelf stock figures (only the grey cells on the sheet come back)` : '',
      lo.vansNotOnSheet?.length ? `${lo.vansNotOnSheet.length} vans that are not on the sheet: ${lo.vansNotOnSheet.slice(0, 10).join(', ')}${lo.vansNotOnSheet.length > 10 ? '…' : ''}` : '',
      'every "last counted" date (the first full count has to be done again)',
    ].filter(Boolean);
    const word = prompt(`START AGAIN FROM "${pf.files[0].name}"?\n\nA full backup is made first. This will be lost:\n- ${lost.join('\n- ')}\n\nType RESET to go ahead.`);
    if (String(word || '').trim() !== 'RESET') return toast('Not started again (RESET was not typed)');
    e.target.disabled = true;
    try {
      const r = await send(`/api/import/plan/apply?confirm=RESET&by=${by()}`);
      toast(`Started again: ${r.vans} vans, ${r.lines} part lines. Backup in ${r.backup}`);
      location.hash = '#/cleanup';
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
  planConflictsPanel($('#plan-conflicts'));
  $('#save1').onclick = () => act(() => api('PUT', '/api/settings', { dealer: $('#dealer').value }), 'Saved');
  $('#save2').onclick = () => act(() => api('PUT', '/api/settings', { ignore: $('#ignore').value.split(/\r?\n/) }), 'Saved');
  $('#clear').onclick = async () => {
    if (!confirm('Set every shelf stock count to zero?\n\nParts already received for a van stay with that van, and the history is kept.')) return;
    await act(() => api('POST', '/api/settings/clear-stock'), 'Shelf stock set to zero'); reload();
  };
}

// ───────────────────────── logins and job roles ─────────────────────────

// "2026-10-20 14:05:09" (this PC's time) → "20/10/2026 2:05 pm"
const fmtDateTime = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
  if (!m) return String(s || '');
  const h = Number(m[4]);
  return `${m[3]}/${m[2]}/${m[1]} ${h % 12 || 12}:${m[5]} ${h < 12 ? 'am' : 'pm'}`;
};
// A temporary password that is easy to read out ("awning-4821"); the person chooses their own at first log in.
function suggestPassword() {
  const words = ['awning', 'chassis', 'annex', 'olive', 'limestone', 'stallion', 'caravan', 'hitch', 'outback', 'canopy'];
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  return `${words[r[0] % words.length]}-${String(1000 + (r[1] % 9000))}`;
}
const pwBox = (name, label, auto = 'new-password') => `<label class="field">${esc(label)}<input type="password" name="${name}" autocomplete="${auto}" maxlength="200"></label>`;

// My own password (sidebar / phone Menu → Change password). My other phones / PCs are logged out.
function changePasswordDialog() {
  const m = modal('Change your password', `<form id="cp" class="stack" autocomplete="off">
      ${pwBox('current', 'Your password now', 'current-password')}
      ${pwBox('n1', 'New password (at least 8 characters)')}
      ${pwBox('n2', 'New password again')}
      <div class="hint">Your other phones and PCs are logged out; this one stays logged in.</div></form>`,
  { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="cp-save">Change password</button>' });
  $('[data-close]', m.el).onclick = m.close;
  const save = e => {
    e?.preventDefault();
    const f = formData($('#cp', m.el));
    if (!f.current) return toast('Type your password now', true);
    if (f.n1.length < 8) return toast('Use at least 8 characters for the new password', true);
    if (f.n1 !== f.n2) return toast("The two new passwords aren't the same", true);
    return busy($('#cp-save', m.el), async () => {
      await act(() => api('POST', '/api/me/password', { current: f.current, password: f.n1 }), 'Password changed');
      m.close();
    });
  };
  $('#cp', m.el).onsubmit = save;
  $('#cp-save', m.el).onclick = save;
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* logged out on this browser anyway */ }
  try { sessionStorage.clear(); localStorage.removeItem('officeName'); } catch { /* private mode */ }
  location.replace('/login?out=1');
}

// The Logins page (owner only): add a login, change name / job role / trade, reset a password, turn a login
// off or on. The last owner can't be turned off or changed to another role; nobody can turn off themselves.
async function renderLogins() {
  const d = await api('GET', '/api/users');
  const roleName = r => d.roles[r]?.label || r;
  const tradeName = t => (d.trades[t] ? `${d.trades[t].icon} ${d.trades[t].label}` : '');
  app.innerHTML = `
    <div class="page-head"><h1>Logins</h1><div class="actions"><button class="btn primary" id="lg-add">+ Add login</button></div></div>
    <div class="panel"><p style="margin:0 0 6px">Everyone has their own login. What they can do depends on their job role:</p>
      <ul class="role-help">${Object.values(d.roles).map(r => `<li><b>${esc(r.label)}</b> — ${esc(r.about)}</li>`).join('')}</ul></div>
    <div class="panel flush"><div class="table-wrap"><table class="cards-sm" id="logins-t"><thead><tr><th>Name</th><th>Username</th><th>Job role</th><th>Trade</th><th>Last log in</th><th>Login</th><th></th></tr></thead><tbody>
      ${d.users.map(u => `<tr data-uid="${u.id}" class="${u.active ? '' : 'lg-off'}">
        <td><strong>${esc(u.name)}</strong>${u.id === ME.user.id ? ' <span class="chip planned">you</span>' : ''}</td>
        <td data-label="Username" class="mono">${esc(u.username)}</td>
        <td data-label="Job role">${esc(roleName(u.role))}</td>
        <td data-label="Trade">${u.trade ? esc(tradeName(u.trade)) : '<span class="faint">—</span>'}</td>
        <td data-label="Last log in" class="small">${u.last_login ? esc(fmtDateTime(u.last_login)) : '<span class="faint">never</span>'}${u.must_change ? '<div class="warn-text">must choose a new password</div>' : ''}</td>
        <td data-label="Login">${u.active ? '<span class="chip ready">On</span>' : '<span class="chip cancelled">Turned off</span>'}${u.locked_until
          ? `<div class="warn-text">Locked until ${esc(clockText(u.locked_until))} (wrong passwords)</div>` : ''}</td>
        <td class="lg-acts">${u.locked_until ? '<button class="btn small primary" data-uunlock>Unlock</button> ' : ''}<button class="btn small" data-uedit>Edit</button> <button class="btn small" data-upw>Reset password</button>
          ${u.id === ME.user.id ? '' : `<button class="btn small ${u.active ? 'danger' : ''}" data-uact>${u.active ? 'Turn off' : 'Turn on'}</button>`}</td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="panel small muted">Forgotten owner password? On the office PC itself: <span class="mono">npm run users -- reset &lt;username&gt;</span> (README → Logins and roles).</div>`;
  const user = tr => d.users.find(u => u.id === Number(tr.dataset.uid));
  $('#lg-add').onclick = () => loginDialog(d);
  $$('#logins-t tr[data-uid]').forEach(tr => {
    $('[data-uedit]', tr).onclick = () => loginDialog(d, user(tr));
    $('[data-upw]', tr).onclick = () => resetPasswordDialog(user(tr));
    const ul = $('[data-uunlock]', tr);
    if (ul) ul.onclick = e => busy(e.currentTarget, async () => {
      await act(() => api('POST', `/api/users/${user(tr).id}/unlock`), `${user(tr).name} can log in again`);
      reload();
    });
    const a = $('[data-uact]', tr);
    if (a) a.onclick = e => {
      const u = user(tr);
      if (u.active && !confirm(`Turn off ${u.name}'s login?\n\nThey are logged out straight away and can't log in until it is turned on again. Their name stays on everything they did.`)) return;
      return busy(e.currentTarget, async () => {
        await act(() => api('POST', `/api/users/${u.id}/active`, { active: !u.active }), u.active ? `${u.name}'s login is turned off` : `${u.name}'s login is on again`);
        reload();
      });
    };
  });
}

function loginDialog(d, u = null) {
  const isNew = !u;
  const m = modal(isNew ? 'Add a login' : `Change ${u.name}`, `<form id="lf" class="grid2" autocomplete="off">
      <label class="field">Name (shown in the app)<input type="text" name="name" maxlength="40" value="${esc(u?.name || '')}" placeholder="e.g. Sam Smith"></label>
      ${isNew ? '<label class="field">Username (to log in)<input type="text" name="username" maxlength="32" autocapitalize="none" spellcheck="false" placeholder="e.g. sam"></label>'
        : `<label class="field">Username<input type="text" value="${esc(u.username)}" disabled></label>`}
      <label class="field">Job role<select name="role" ${u && u.id === ME.user.id ? 'disabled' : ''}>${Object.entries(d.roles).map(([k, r]) => `<option value="${k}" ${(u?.role || 'worker') === k ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
        ${u && u.id === ME.user.id ? '<span class="hint">You can\'t change your own job role — another owner can.</span>' : ''}</label>
      <label class="field" id="lf-trade">Trade<select name="trade"><option value="">— pick the trade —</option>${Object.entries(d.trades).map(([k, t]) =>
        `<option value="${k}" ${u?.trade === k ? 'selected' : ''}>${esc(`${t.icon} ${t.label}`)}</option>`).join('')}</select></label>
      <div class="hint" style="grid-column:1/-1" id="lf-help"></div>
      ${isNew ? `<label class="field">Temporary password<input type="text" name="password" maxlength="200" value="${esc(suggestPassword())}" autocomplete="off" spellcheck="false"></label>
        <label class="row" style="grid-column:1/-1"><input type="checkbox" name="must_change" checked> They choose their own password the first time they log in</label>
        <div class="hint" style="grid-column:1/-1">Write the username and temporary password down for them, or tell them.</div>` : ''}
    </form>`, { footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="lf-save">${isNew ? 'Add login' : 'Save'}</button>` });
  $('[data-close]', m.el).onclick = m.close;
  const role = $('[name=role]', m.el);
  const sync = () => {
    $('#lf-trade', m.el).classList.toggle('hidden', role.value !== 'worker');
    $('#lf-help', m.el).textContent = `${d.roles[role.value]?.label}: ${d.roles[role.value]?.about || ''}.${role.value === 'worker' ? ' A worker only sees the parts and reminders of their trade.' : ''}`;
  };
  role.onchange = sync;
  sync();
  $('#lf-save', m.el).onclick = e => {
    const f = formData($('#lf', m.el));
    if (!f.role) f.role = role.value; // own login: the job role box is greyed out (a form doesn't send it)
    if (!f.name?.trim()) return toast("Type the person's name", true);
    if (f.role === 'worker' && !f.trade) return toast("Pick the worker's trade", true);
    if (isNew && !f.username?.trim()) return toast('Type a username', true);
    if (!isNew && u.role !== f.role && !confirm(`Change ${u.name} to ${d.roles[f.role]?.label}? They are logged out and log in again with the new job role.`)) return;
    return busy(e.currentTarget, async () => {
      if (isNew) {
        const must = $('[name=must_change]', m.el).checked;
        const nu = await act(() => api('POST', '/api/users', { name: f.name, username: f.username.trim(), role: f.role, trade: f.trade, password: f.password,
          must_change: must }), `Login added for ${f.name.trim()}`);
        m.close();
        handOverDialog(nu, f.password, must, d);
        return reload();
      } else {
        await act(() => api('PUT', `/api/users/${u.id}`, { name: f.name, role: f.role, trade: f.role === 'worker' ? f.trade : '' }), 'Saved');
      }
      m.close();
      reload();
    });
  };
}

// "3:45 pm" from a time in ms (this computer's clock).
const clockText = ms => { const d = new Date(ms); const h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };

// After Add login / Reset password: the username and temporary password to hand over — Copy, or Print a slip.
// (Shown once here; the app never shows a password again.)
async function handOverDialog(u, password, mustChange, d = null) {
  // The address to give them: on the office PC itself (localhost) the network address from Settings instead.
  let base = `${location.protocol}//${location.host}`;
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && can('settings')) {
    try { const lan = (await api('GET', '/api/settings')).floorUrls?.[0]; if (lan) base = lan.replace(/\/floor$/, ''); } catch { /* keep this address */ }
  }
  const where = `${base}${u.role === 'worker' || u.role === 'leadhand' ? '/floor' : '/'}`;
  const role = d?.roles?.[u.role]?.label || ME?.roles?.[u.role] || u.role;
  const lines = ['Stallion Caravans – Factory Stock', `Name: ${u.name}`, `Open: ${where}`, `Username: ${u.username}`, `Temporary password: ${password}`,
    ...(mustChange ? ['You choose your own password the first time you log in.'] : [])];
  const m = modal(`Login for ${u.name}`, `<div class="handover">
      <div class="ho-row"><span class="ho-l">Open</span><span class="mono">${esc(where)}</span></div>
      <div class="ho-row"><span class="ho-l">Username</span><span class="mono ho-big">${esc(u.username)}</span></div>
      <div class="ho-row"><span class="ho-l">Temporary password</span><span class="mono ho-big">${esc(password)}</span></div>
      <div class="hint">${esc(role)}. ${mustChange ? 'They choose their own password the first time they log in.' : 'They keep this password until they change it.'}
        Give it to them in person — it isn't shown again.</div></div>`,
  { footer: '<button class="btn" id="ho-print">Print</button><button class="btn" id="ho-copy">Copy</button><button class="btn primary" data-close>Done</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $('#ho-copy', m.el).onclick = async () => {
    const text = lines.join('\n');
    // navigator.clipboard needs https / localhost; on the office network the older way is used.
    try { await navigator.clipboard.writeText(text); toast('Copied'); return; } catch { /* fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    toast(ok ? 'Copied' : 'Could not copy — write it down', !ok);
  };
  $('#ho-print', m.el).onclick = () => {
    const w = window.open('', '_blank', 'width=480,height=600');
    if (!w) return toast('Allow pop-ups to print the slip', true);
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Login for ${esc(u.name)}</title>
      <body style="font:16px/1.6 Inter,Arial,sans-serif;padding:24px"><h2 style="margin:0 0 12px">${esc(lines[0])}</h2>
      <p>${lines.slice(1).map(l => esc(l)).join('<br>')}</p></body>`);
    w.document.close(); w.focus(); w.print();
  };
}

function resetPasswordDialog(u) {
  const m = modal(`Reset ${u.name}'s password`, `<form id="rp" class="stack" autocomplete="off">
      <label class="field">New temporary password<input type="text" name="password" maxlength="200" value="${esc(suggestPassword())}" autocomplete="off" spellcheck="false"></label>
      <label class="row"><input type="checkbox" name="must_change" checked> They choose their own password at the next log in</label>
      <div class="hint">${esc(u.name)} is logged out on every phone and PC. Tell them the new password.</div></form>`,
  { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="rp-save">Reset password</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $('#rp-save', m.el).onclick = e => {
    const pw = $('[name=password]', m.el).value;
    if (pw.length < 8) return toast('Use at least 8 characters for the password', true);
    return busy(e.currentTarget, async () => {
      const must = $('[name=must_change]', m.el).checked;
      const nu = await act(() => api('POST', `/api/users/${u.id}/password`, { password: pw, must_change: must }), `${u.name}'s password is reset`);
      m.close();
      handOverDialog(nu, pw, must);
      reload();
    });
  };
}

// Start: who is logged in, then the page. Not logged in → the log in page; a worker → the worker app.
async function boot() {
  try { ME = await api('GET', '/api/me'); }
  catch (e) {
    if (toLogin.going) return;
    app.innerHTML = `<div class="panel empty">Couldn't reach the office PC (${esc(e.message)}). <button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  if (ME.user.mustChange) return toLogin();
  if (!ME.can.officeApp) { location.replace('/floor'); return; }
  for (const [k, v] of Object.entries(ME.can)) document.body.classList.toggle(`can-${k}`, !!v);
  document.body.dataset.role = ME.user.role;
  try { localStorage.setItem(`fs.lastApp.${ME.user.username}`, '/'); } catch { /* private mode */ } // the log in page opens this app next time
  $('#who-name').textContent = ME.user.name;
  $('#who-role').textContent = ME.roles?.[ME.user.role] || ME.user.role;
  $('#who-box').hidden = false;
  $('#who-pw').onclick = () => { setMenu(false); changePasswordDialog(); };
  $('#who-out').onclick = logout;
  route();
}

boot();
