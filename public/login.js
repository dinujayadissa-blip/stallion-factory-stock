'use strict';
// Log in page: log in, the first-time "Create the owner login", and "Choose a new password" when the
// owner gave a temporary one. Works on a phone and in the installed worker app.

const $ = (s, r = document) => r.querySelector(s);
const card = $('#card');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);

// ?next= only to a page of this app (a path starting with one "/"), never another website.
function safeNext() {
  let n = params.get('next') || '';
  if (n && !n.includes('#') && location.hash) n += location.hash; // the #… part of the address the person opened
  if (!/^\/(?![/\\])[^\\\s\u0000-\u001f]*$/.test(n) || /^\/login\b/i.test(n)) return '';
  return n;
}
// Where to go after logging in: the page asked for, or the worker app for workers / leading hands.
// A leading hand goes back to the app they used last on this device (office app or worker app).
const lastApp = user => { try { return localStorage.getItem(`fs.lastApp.${user.username}`) || ''; } catch { return ''; } };
const home = user => safeNext() || (user.role === 'worker' ? '/floor' : user.role === 'leadhand' ? (lastApp(user) === '/' ? '/' : '/floor') : '/');
const go = user => location.replace(home(user));

async function call(method, url, body) {
  let res, data = {};
  try {
    res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    data = await res.json().catch(() => ({}));
  } catch {
    throw Object.assign(new Error('No connection to the office PC — check the Wi-Fi and try again'), { status: 0 });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong — try again'), { status: res.status, data });
  return data;
}

const pwField = (id, label, hint = '', auto = 'current-password') => `<label class="lg-field" for="${id}">${esc(label)}
  <span class="lg-pw"><input id="${id}" type="password" autocomplete="${auto}" required maxlength="200">
  <button type="button" class="lg-show" data-show="${id}" aria-label="Show the password">Show</button></span>${hint ? `<span class="lg-hint">${esc(hint)}</span>` : ''}</label>`;
function wireShow() {
  card.querySelectorAll('[data-show]').forEach(b => {
    b.onclick = () => {
      const i = document.getElementById(b.dataset.show);
      const show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-label', show ? 'Hide the password' : 'Show the password');
    };
  });
}
// "3:45 pm" — when a lock ends (this device's clock).
const clockAt = ms => { const d = new Date(ms); const h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
// The server's answer to a wrong try, in plain words: tries left before the lock, or when the lock ends.
function tryMessage(e) {
  const d = e.data || {};
  if (d.until) return `Too many tries — wait 15 minutes. You can try again at ${clockAt(d.until)}.`;
  if (e.status === 401 && d.left > 0 && d.left <= 2) return `${e.message} — ${d.left} tr${d.left === 1 ? 'y' : 'ies'} left, then a 15-minute wait.`;
  return e.message;
}
const ENDED = "You've been logged out — your login may have been changed or turned off. Ask the owner if you can't log in.";
const showError = msg => {
  let e = $('.lg-err', card);
  if (!e) { e = document.createElement('div'); e.className = 'lg-err'; e.setAttribute('role', 'alert'); card.querySelector('form').prepend(e); }
  e.textContent = msg;
};
// Run a form's save with the button turned off (no double taps).
function onSubmit(form, fn) {
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = $('button[type=submit]', form);
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } catch (e) { showError(e.message); } finally { btn.disabled = false; }
  };
}

// ── Log in ──
function loginForm(note = '', warn = '') {
  card.innerHTML = `<form id="f" novalidate>
      <h1>Log in</h1>
      ${note ? `<div class="lg-ok">${esc(note)}</div>` : ''}
      ${warn ? `<div class="lg-warn" role="status">${esc(warn)}</div>` : ''}
      <label class="lg-field" for="u">Username
        <input id="u" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required maxlength="64"></label>
      ${pwField('p', 'Password')}
      <button type="submit" class="lg-btn">Log in</button>
    </form>`;
  wireShow();
  const f = $('#f');
  $('#u').focus();
  onSubmit(f, async () => {
    const username = $('#u').value.trim(), password = $('#p').value;
    if (!username) { $('#u').focus(); throw new Error('Type your username'); }
    if (!password) { $('#p').focus(); throw new Error('Type your password'); }
    let r;
    try { r = await call('POST', '/api/login', { username, password }); }
    catch (e) { $('#p').value = ''; $('#p').focus(); throw new Error(tryMessage(e)); }
    if (r.user.mustChange) return changeForm(r.user, password);
    go(r.user);
  });
}

// ── Choose a new password (temporary password from the owner) ──
// `current`: the password just typed to log in (so it isn't asked twice).
function changeForm(user, current = '') {
  card.innerHTML = `<form id="f" novalidate>
      <h1>Choose a new password</h1>
      <p>Hi ${esc(user.name)}. You logged in with a temporary password — choose your own now. Only you will know it.</p>
      ${current ? '' : pwField('c', 'Password you logged in with')}
      ${pwField('n1', 'New password', 'At least 8 characters.', 'new-password')}
      ${pwField('n2', 'New password again', '', 'new-password')}
      <button type="submit" class="lg-btn">Save and continue</button>
      <button type="button" class="lg-link" id="out">Log out</button>
    </form>`;
  wireShow();
  ($('#c') || $('#n1')).focus();
  $('#out').onclick = logout;
  onSubmit($('#f'), async () => {
    const cur = current || $('#c').value, n1 = $('#n1').value, n2 = $('#n2').value;
    if (n1.length < 8) { $('#n1').focus(); throw new Error('Use at least 8 characters for the password'); }
    if (n1 !== n2) { $('#n2').value = ''; $('#n2').focus(); throw new Error("The two new passwords aren't the same — type them again"); }
    let r;
    try { r = await call('POST', '/api/me/password', { current: cur, password: n1 }); }
    catch (e) { throw new Error(tryMessage(e)); }
    go(r.user);
  });
}

// ── First time: create the owner login (only on the office PC itself) ──
function setupForm(here) {
  if (!here) {
    card.innerHTML = `<h1>No logins yet</h1>
      <p>Open this on the office PC itself to create the first login.</p>
      <p class="muted">On the office PC, open <b>http://localhost${location.port ? `:${esc(location.port)}` : ''}</b> in the browser. The owner login is made there; after that everyone else gets their login from the owner.</p>
      <button type="button" class="lg-btn" onclick="location.reload()">Try again</button>`;
    return;
  }
  card.innerHTML = `<form id="f" novalidate>
      <h1>Create the owner login</h1>
      <p>This is the first login for Factory Stock. The owner can do everything and makes the logins for the office, stores, leading hands and workers.</p>
      <label class="lg-field" for="nm">Your name <span class="lg-hint">Shown in the app, e.g. "Sam Stallion"</span>
        <input id="nm" autocomplete="name" required maxlength="40"></label>
      <label class="lg-field" for="u">Username <span class="lg-hint">What you type to log in, e.g. "sam" (no spaces)</span>
        <input id="u" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required maxlength="32"></label>
      ${pwField('n1', 'Password', 'At least 8 characters. Write it down somewhere safe.', 'new-password')}
      ${pwField('n2', 'Password again', '', 'new-password')}
      <button type="submit" class="lg-btn">Create the owner login</button>
    </form>`;
  wireShow();
  $('#nm').focus();
  onSubmit($('#f'), async () => {
    const name = $('#nm').value.trim(), username = $('#u').value.trim(), n1 = $('#n1').value, n2 = $('#n2').value;
    if (!name) { $('#nm').focus(); throw new Error('Type your name'); }
    if (!username) { $('#u').focus(); throw new Error('Type a username'); }
    if (n1.length < 8) { $('#n1').focus(); throw new Error('Use at least 8 characters for the password'); }
    if (n1 !== n2) { $('#n2').value = ''; $('#n2').focus(); throw new Error("The two passwords aren't the same — type them again"); }
    const r = await call('POST', '/api/setup', { name, username, password: n1 });
    location.replace(safeNext() || (r.user.role === 'worker' ? '/floor' : '/'));
  });
}

// Only the office PC can end the session (the cookie can't be removed from here): until it says so the
// person stays on this form and is told.
async function logout() {
  try { await call('POST', '/api/logout'); }
  catch (e) { return showError(e.status === 0 ? "Couldn't log out — no signal. Try again when you have signal." : `Couldn't log out — ${e.message}`); }
  location.replace('/login?out=1');
}

async function start() {
  try {
    const s = await call('GET', '/api/setup');
    if (s.needed) return setupForm(s.here);
  } catch (e) {
    card.innerHTML = `<h1>Can't reach the office PC</h1><p>${esc(e.message)}</p><button type="button" class="lg-btn" onclick="location.reload()">Try again</button>`;
    return;
  }
  // Already logged in on this browser: straight on (or the new-password step first).
  let ended = params.get('ended') === '1';
  try {
    const me = await call('GET', '/api/me');
    if (me.user.mustChange) return changeForm(me.user);
    return go(me.user);
  } catch (e) { if (e.data?.ended) ended = true; /* not logged in */ }
  loginForm(params.has('out') ? "You're logged out." : '', ended ? ENDED : '');
}
start();
