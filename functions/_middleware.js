// The page gate. On the office PC, src/app.js decides who may open the office app (/) and the worker app (/floor);
// online, the same decisions are made here, before the page is handed out:
//   - GET /, /index.html        no login, or must change password -> /login?next=<where you were going> (+ &ended=1)
//                               a worker (no officeApp)            -> /floor
//                               /index.html                        -> /
//   - GET /floor, /floor.html   no login, or must change password -> /login?next=%2Ffloor (+ &ended=1)
//                               /floor.html                        -> /floor
//   - GET /login, /login.html   always served
// Every page answer is Cache-Control: no-store. Who is logged in comes from the server itself: GET /api/me with the
// browser's cookie (200 = user.mustChange + can.officeApp, 401 = not logged in, { ended: true } when the session
// had ended). Everything else (files, /api, /photos) passes on untouched.
import { apiUrl, upstreamHeaders, notConfigured, NOT_CONFIGURED, outsideError } from './_forward.js';

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };

// The address as a file look-up would see it: percent-escapes decoded, "." / ".." and doubled or trailing slashes
// removed, so /%69ndex.html, //index.html, /index.html/ and /./index.html are all the office app.
function canonical(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return '/' + parts.join('/');
}

function pageAnswer(res, cookies = []) {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(SECURITY)) headers.set(k, v);
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
const redirect = (location, cookies) => pageAnswer(new Response(null, { status: 302, headers: { Location: location } }), cookies);
const text = (status, msg) => pageAnswer(new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));

export async function onRequest({ request, env, next }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  const url = new URL(request.url);
  const path = canonical(url.pathname);
  const office = path === '/' || path === '/index.html';
  const floor = path === '/floor' || path === '/floor.html';
  const login = path === '/login' || path === '/login.html';
  if (!office && !floor && !login) return next();

  // The pages are fetched from the assets by their plain address (Pages answers /index.html with its own redirect).
  const serve = to => env.ASSETS.fetch(new Request(new URL(to, url), { method: 'GET', headers: request.headers }));
  if (login) return pageAnswer(await serve('/login'));

  if (notConfigured(env)) return text(500, NOT_CONFIGURED);
  // The function unreachable, Supabase answering in its place (a 5xx without the app's x-fs-app marker, see
  // _forward.js), the app's own error, or an answer that isn't a session check: one plain 503 page, whichever.
  let me = null, body = null;
  try {
    me = await fetch(apiUrl(env, '/api/me'), { method: 'GET', headers: upstreamHeaders(request, env), redirect: 'manual' });
    if (outsideError(me)) me = null;
    else if ([200, 401, 403].includes(me.status)) body = await me.json().catch(() => null);
  } catch { me = null; }
  if (!me || ![200, 401, 403].includes(me.status) || (me.status === 200 && !body?.user)) {
    return text(503, "Can't reach the Factory Stock server just now. Wait a minute and reload.");
  }
  // The session cookie the server sent along (30 more days, or cleared when the session had ended) goes to the browser.
  const cookies = me.headers.getSetCookie?.() ?? [];
  if (me.status !== 200 || body.user.mustChange) {
    const ended = me.status === 401 && body?.ended ? '&ended=1' : '';
    return redirect(floor ? `/login?next=%2Ffloor${ended}` : `/login?next=${encodeURIComponent(url.pathname + url.search)}${ended}`, cookies);
  }

  if (office) {
    if (!body.can?.officeApp) return redirect('/floor', cookies);   // workers: the worker app only
    if (url.pathname !== '/') return redirect('/', cookies);
    return pageAnswer(await serve('/'), cookies);
  }
  if (url.pathname !== '/floor') return redirect('/floor', cookies);
  return pageAnswer(await serve('/floor'), cookies);
}
