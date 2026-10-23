// Cloud spike: does the heavy work fit in a Supabase Edge Function (free plan: 2 s CPU per request)?
// Routes (all return JSON { ms, cpuHint, ... }):
//   GET  /scrypt            verify a hash made by src/auth.js with node:crypto scrypt  (?lib=noble for @noble/hashes,
//                           ?wrong=1 checks that a wrong password is rejected)
//   POST /pdf               body = the PDF; runs the src/parseOrder.js logic (pdfjs-dist)
//   GET  /xlsx              builds a 70 x 120 exceljs workbook into a buffer
//   GET  /loop              one transaction, 300 sequential SELECT/UPDATE pairs against scratch table spike_loop
//   GET  /cleanup           drops the scratch table
//   POST /echo              returns { sha256, cookie } of the request body and sets two cookies (pass-through test)
//
// ms       = wall-clock of the work section (excludes the first-use import of the library).
// cpuHint  = for pure-compute routes (scrypt, pdf, xlsx) the same as ms, because the work is synchronous CPU or
//            close to it. For /loop it is 0 by design: the time is spent waiting on the database, not on CPU.
// importMs = time to load the library the first time this isolate runs the route (counts toward CPU too).
// The authoritative CPU figure is in the Supabase dashboard (Edge Functions > spike > Invocations / Logs).
//
// Libraries are imported lazily inside each route so one broken library can't take the others down.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

// Hash made locally by the CURRENT src/auth.js format for the throwaway password 'spike-pass-1'
// (scrypt$N$r$p$saltB64$hashB64, N=16384 r=8 p=1, 64-byte key). Not a real password.
const SPIKE_HASH =
  'scrypt$16384$8$1$TiWH4ghUv1RniPpp8oY/BA==$zAUF0dPSCSYyZdiLo6nAdlqOg/sHyi+rB6OLnYhnY3dUMJRc6pZmJ+VrN4WNK4PfcyfLawLgZ4UBKPHumSQcWA==';
const SPIKE_PASSWORD = 'spike-pass-1';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const round = (n: number) => Math.round(n * 100) / 100;

function parseStored(stored: string) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) throw new Error('bad hash format');
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), salt: Buffer.from(m[4], 'base64'), want: Buffer.from(m[5], 'base64') };
}

async function routeScrypt(url: URL) {
  const { N, r, p, salt, want } = parseStored(SPIKE_HASH);
  const lib = url.searchParams.get('lib') === 'noble' ? 'noble' : 'node';
  const wrong = url.searchParams.get('wrong') === '1';
  const password = (wrong ? 'not-the-password' : SPIKE_PASSWORD).normalize('NFC');
  let ok = false, importMs = 0, ms = 0;
  if (lib === 'node') {
    const t0 = performance.now();
    // scryptSync on purpose: the whole cost is CPU on this thread, so wall-clock == CPU and is easy to read.
    // (src/auth.js uses the async version; the work is the same.)
    const got = crypto.scryptSync(password, salt, want.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
    ok = got.length === want.length && crypto.timingSafeEqual(got, want);
    ms = performance.now() - t0;
  } else {
    const i0 = performance.now();
    // @ts-ignore npm: specifier (Deno)
    const { scrypt } = await import('npm:@noble/hashes@1.8.0/scrypt');
    importMs = performance.now() - i0;
    const t0 = performance.now();
    const got = scrypt(new TextEncoder().encode(password), salt, { N, r, p, dkLen: want.length, maxmem: 256 * 1024 * 1024 });
    ok = got.length === want.length && Buffer.from(got).equals(want);
    ms = performance.now() - t0;
  }
  return json({ route: 'scrypt', lib, wrongPasswordTried: wrong, ok, N, r, p, ms: round(ms), cpuHint: round(ms), importMs: round(importMs) });
}

async function routePdf(req: Request) {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) return json({ error: 'POST the PDF as the request body (--data-binary @spike/sample-order.pdf)' }, 400);
  const i0 = performance.now();
  // parseOrder.js is the app's own file, copied next to this one by spike/stage-edge.sh (with its bare
  // 'pdfjs-dist/...' import rewritten to an npm: specifier, which is the only change).
  // @ts-ignore plain JS module
  const { parseOrderPdf } = await import('./parseOrder.js');
  const importMs = performance.now() - i0;
  const t0 = performance.now();
  const parsed = await parseOrderPdf(buf);
  const ms = performance.now() - t0;
  return json({
    route: 'pdf', bytes: buf.length, fields: parsed.fields.length, chassis: parsed.header.chassis,
    ms: round(ms), cpuHint: round(ms), importMs: round(importMs),
  });
}

async function routeXlsx() {
  const i0 = performance.now();
  // @ts-ignore npm: specifier (Deno)
  const ExcelJS = (await import('npm:exceljs@4.4.0')).default;
  const importMs = performance.now() - i0;
  const t0 = performance.now();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan');
  const ROWS = 70, COLS = 120;
  for (let r = 1; r <= ROWS; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= COLS; c++) {
      const cell = row.getCell(c);
      cell.value = `R${r}C${c}`;
      if (r === 1) cell.font = { bold: true };
      if (r === 1 || (r + c) % 17 === 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: r === 1 ? 'FFD9D9D9' : 'FFFFF2CC' } };
      }
    }
  }
  const buildMs = performance.now() - t0;
  const out = await wb.xlsx.writeBuffer();
  const ms = performance.now() - t0;
  return json({
    route: 'xlsx', rows: ROWS, cols: COLS, bytes: (out as ArrayBuffer).byteLength,
    buildMs: round(buildMs), ms: round(ms), cpuHint: round(ms), importMs: round(importMs),
  });
}

async function getSql() {
  // @ts-ignore npm: specifier (Deno)
  const postgres = (await import('npm:postgres@3.4.5')).default;
  // DATABASE_URL if you set it; otherwise the connection string Supabase gives every Edge Function.
  const dsn = Deno.env.get('DATABASE_URL') || Deno.env.get('SUPABASE_DB_URL');
  if (!dsn) throw new Error('No DATABASE_URL / SUPABASE_DB_URL in the environment');
  return postgres(dsn, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 15 });
}

async function routeLoop() {
  const i0 = performance.now();
  const sql = await getSql();
  const importMs = performance.now() - i0;
  try {
    const s0 = performance.now();
    await sql`create table if not exists spike_loop (id int primary key, n int)`;
    await sql`insert into spike_loop (id, n) select g, 0 from generate_series(1, 300) g on conflict (id) do nothing`;
    const setupMs = performance.now() - s0;

    const t0 = performance.now();
    await sql.begin(async (tx: any) => {
      for (let i = 1; i <= 300; i++) {
        const [row] = await tx`select n from spike_loop where id = ${i}`;
        await tx`update spike_loop set n = ${row.n + 1} where id = ${i}`;
      }
    });
    const ms = performance.now() - t0;
    return json({
      route: 'loop', pairs: 300, setupMs: round(setupMs), ms: round(ms), cpuHint: 0, importMs: round(importMs),
      note: 'cpuHint is 0 by design: the time is spent waiting on the database',
    });
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function routeCleanup() {
  const sql = await getSql();
  try {
    await sql`drop table if exists spike_loop`;
    return json({ route: 'cleanup', dropped: 'spike_loop', ms: 0, cpuHint: 0 });
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function routeEcho(req: Request) {
  const t0 = performance.now();
  const body = new Uint8Array(await req.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const sha256 = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('Set-Cookie', 'a=1; Path=/; HttpOnly; Secure; SameSite=Lax');
  headers.append('Set-Cookie', 'b=2; Path=/; HttpOnly; Secure; SameSite=Lax');
  const ms = performance.now() - t0;
  return new Response(
    JSON.stringify({
      route: 'echo', bytes: body.length, sha256, cookie: req.headers.get('cookie') ?? '',
      xRegion: req.headers.get('x-region') ?? '', ms: round(ms), cpuHint: round(ms),
    }),
    { status: 200, headers },
  );
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // On Supabase the path arrives as /spike/<route> (function name first); locally it may be just /<route>.
  const route = url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/spike(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  try {
    switch (route) {
      case '/': return json({ ok: true, routes: ['/scrypt', '/pdf', '/xlsx', '/loop', '/cleanup', '/echo'] });
      case '/scrypt': return await routeScrypt(url);
      case '/pdf': return await routePdf(req);
      case '/xlsx': return await routeXlsx();
      case '/loop': return await routeLoop();
      case '/cleanup': return await routeCleanup();
      case '/echo': return await routeEcho(req);
      default: return json({ error: 'unknown route', route }, 404);
    }
  } catch (e) {
    const err = e as Error;
    return json({ error: String(err?.message ?? e), stack: String(err?.stack ?? '').split('\n').slice(0, 6) }, 500);
  }
});
