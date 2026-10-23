// Cloudflare Pages Function: forwards EVERY request that is not a static file to the Supabase Edge Function.
//   browser -> https://<pages-site>/anything?x=1  ->  ${API_ORIGIN}/functions/v1/spike/anything?x=1
// API_ORIGIN is a Pages variable, e.g. https://<project-ref>.supabase.co  (not a secret).
// It keeps CPU use tiny (Pages Functions on the free plan get 10 ms): no parsing, the body is streamed
// straight through, and every Set-Cookie header from the upstream comes back separately.
export async function onRequest({ request, env }) {
  if (!env.API_ORIGIN) return new Response('API_ORIGIN is not set', { status: 500 });
  const incoming = new URL(request.url);
  const target = `${env.API_ORIGIN.replace(/\/+$/, '')}/functions/v1/spike${incoming.pathname}${incoming.search}`;

  const headers = new Headers(request.headers);   // includes cookie, content-type, content-length
  headers.delete('host');
  headers.set('x-region', 'ap-southeast-2');       // Supabase runs the function in Sydney

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,      // streamed, never buffered here
    redirect: 'manual',
  });

  // Rebuild the response headers so that EVERY Set-Cookie survives (a plain copy can fold them into one).
  const out = new Headers();
  for (const [k, v] of upstream.headers) if (k.toLowerCase() !== 'set-cookie') out.append(k, v);
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  for (const c of cookies) out.append('set-cookie', c);

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
