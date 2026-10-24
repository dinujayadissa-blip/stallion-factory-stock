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
// must not choose itself, plus ours.
export function upstreamHeaders(request, env) {
  const headers = new Headers(request.headers);
  for (const h of ['host', 'x-pass-secret', 'x-region', 'x-forwarded-host', 'x-forwarded-for']) headers.delete(h);
  headers.set('x-pass-secret', env.PASS_SECRET);
  headers.set('x-region', REGION);
  headers.set('x-forwarded-host', new URL(request.url).host);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  return headers;
}

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
  const upstream = await fetch(apiUrl(env, incoming.pathname, incoming.search), {
    method: request.method,
    headers: upstreamHeaders(request, env),
    body: hasBody ? request.body : undefined, // streamed, never buffered here
    ...(hasBody ? { duplex: 'half' } : {}),
    redirect: 'manual',                        // a redirect is the browser's to follow
  });
  return sameResponse(upstream);
}
