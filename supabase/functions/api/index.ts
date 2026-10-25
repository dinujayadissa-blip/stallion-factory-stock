// Supabase Edge Function "api": the whole Factory Stock server online — src/app.js, the same Express app the
// office PC runs, with cloud: true (see src/edge.js, which does the work and is tested in Node).
//
// Only the Cloudflare Pages pass-through calls it; anything without its x-pass-secret is refused (403).
// It runs on Deno with Node compatibility: the bare names in src/ (express, postgres, exceljs, pdfjs-dist)
// come from ./deno.json. Deploy with scripts/deploy-api.ps1, which puts a copy of src/ next to this file
// (Supabase only bundles what is inside the function's folder) and points the import below at it.
//
// Secrets (npx supabase secrets set …): PASS_SECRET, ALLOWED_HOSTS, CLOUD=1 (PUBLIC_URL optional).
// SUPABASE_DB_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself.
import process from 'node:process';
import { Buffer } from 'node:buffer';

// The app is Node code that uses `process` and `Buffer` as globals: make sure they exist before it loads
// (hence the dynamic import below, which runs after this).
const g = globalThis as Record<string, unknown>;
g.process ??= process;
g.Buffer ??= Buffer;
// This is the online version, whatever the secrets say (auth.js reads it: cookie name, no "this PC").
try { process.env.CLOUD = '1'; } catch { /* env not writable: the CLOUD=1 secret covers it */ }

const { startEdge } = await import('../../../src/edge.js');
// Opens the database once for this isolate, before the first request, and listens on 8000.
// SUPABASE_DB_URL is the address Supabase gives every function itself (kept right when the database password
// is reset), so nobody has to type one; DATABASE_URL is only a fallback for running this somewhere else.
startEdge({ databaseUrl: Deno.env.get('SUPABASE_DB_URL') || Deno.env.get('DATABASE_URL') });
