// Pass-through from Cloudflare Pages to the Supabase Edge Function that runs the Factory Stock server.
//   browser -> https://stallion-stock.pages.dev/api/stock?x=1
//           -> ${API_ORIGIN}/functions/v1/api/api/stock?x=1     (the function mounts the whole app under /functions/v1/api)
// Pages variables (set in the Cloudflare dashboard, never in this repo): API_ORIGIN (https://<project-ref>.supabase.co)
// and PASS_SECRET (the shared secret the Edge Function checks before it believes the forwarded headers).
// Pages Functions on the free plan get 10 ms of CPU per request: nothing here parses or buffers a body. It is
// streamed straight through, in both directions.

export const REGION = 'ap-southeast-2'; // Supabase runs the function in Sydney

export function apiUrl(env, pathname, search = '') {
  return `${String(env.API_ORIGIN).replace(/\/+$/, '')}/functions/v1/api${pathname}${search}`;
}

// The headers every call to the function carries: the browser's own (cookie, content-type...) minus anything it
// must not choose itself, plus ours. The visitor's address, the public host name and https go in our own
// x-fs-* headers, which the function reads only when the pass secret matches: the x-forwarded-* ones are not
// used, as Supabase's gateway may add to or replace them on the way.
const OURS = ['host', 'x-pass-secret', 'x-region', 'x-fs-host', 'x-fs-client-ip', 'x-fs-proto', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'];
export function upstreamHeaders(request, env) {
  const headers = new Headers(request.headers);
  for (const h of OURS) headers.delete(h);
  headers.set('x-pass-secret', env.PASS_SECRET);
  headers.set('x-region', REGION);
  headers.set('x-fs-host', new URL(request.url).host);
  headers.set('x-fs-proto', 'https'); // Pages is https only; the function's Secure-cookie decision needs it
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-fs-client-ip', ip);
  return headers;
}

// The function not reachable, or Supabase answering in its place (502/503/504, 540 the function would not start,
// 546 a resource / time limit): its error page is no use to anyone. Every answer of the app itself carries
// x-fs-app: 1 (src/app.js), so a 5xx without it is Supabase's, and becomes a plain message the screens can show.
export const ASLEEP = 'The database is asleep or unreachable — try again in a minute';
export const TOO_LONG = 'That took too long — try again';
export const fromApp = res => res.headers.get('x-fs-app') === '1';
// null when the answer is the app's own (or not an error); otherwise the message to give instead.
export function outsideError(res) {
  if (res.status < 500 || fromApp(res)) return null;
  return res.status === 546 ? TOO_LONG : ASLEEP;
}
export const plainError = msg => new Response(JSON.stringify({ error: msg }), {
  status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export const notConfigured = env => !env.API_ORIGIN || !env.PASS_SECRET;
export const NOT_CONFIGURED = 'The online server address is not set up (API_ORIGIN / PASS_SECRET)';

// A copy of the response whose headers keep EVERY Set-Cookie (a plain copy can fold them into one).
export function sameResponse(upstream) {
  const out = new Headers();
  for (const [k, v] of upstream.headers) if (k.toLowerCase() !== 'set-cookie') out.append(k, v);
  for (const c of upstream.headers.getSetCookie?.() ?? []) out.append('set-cookie', c);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export async function forward(request, env) {
  if (notConfigured(env)) return new Response(NOT_CONFIGURED, { status: 500 });
  const incoming = new URL(request.url);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && !!request.body;
  let upstream;
  try {
    upstream = await fetch(apiUrl(env, incoming.pathname, incoming.search), {
      method: request.method,
      headers: upstreamHeaders(request, env),
      body: hasBody ? request.body : undefined, // streamed, never buffered here
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',                        // a redirect is the browser's to follow
    });
  } catch {
    return plainError(ASLEEP);
  }
  const outside = outsideError(upstream);
  if (outside) {
    try { await upstream.body?.cancel(); } catch { /* nothing to read */ }
    return plainError(outside);
  }
  return sameResponse(upstream);
}
