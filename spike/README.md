# Cloud spike: Edge CPU limits and the Pages pass-through

Throwaway. Proves the heavy jobs fit in a Supabase Edge Function (free plan: 2 s CPU per request) and that a
Cloudflare Pages Function can pass requests through (free plan: 10 ms CPU) without breaking cookies or binary
bodies. Nothing here is part of the app. Results go in `docs/superpowers/spikes/2026-10-edge-spike.md`.

Run everything from the repo root (the folder containing `server.js`). `<ref>` is the Supabase Project Reference
id; `$SITE` is the Pages URL printed by the deploy (e.g. `https://stallion-stock.pages.dev`).

## Files

| File | What it is |
| --- | --- |
| `edge/index.ts` | the Edge Function (Deno): `/scrypt`, `/pdf`, `/xlsx`, `/loop`, `/cleanup`, `/echo` |
| `stage-edge.sh` | copies `edge/index.ts` and `src/parseOrder.js` into `supabase/functions/spike/` (git-ignored) |
| `pages/functions/[[path]].js` | Pages Function: forwards everything to the Edge Function |
| `pages/index.html`, `pages/_routes.json` | placeholder page; `_routes.json` keeps `/` static |
| `make-test-pdf.mjs`, `sample-order.pdf` | synthetic 3-page dealer order (made-up names, no real data) |
| `mkhash.mjs` | how the embedded `spike-pass-1` hash was made (same format as `src/auth.js`) |
| `check-local.mjs` | Node checks of the scrypt, exceljs and parseOrder code before deploying |

`/pdf` runs `src/parseOrder.js` itself, not a rewrite: `stage-edge.sh` copies it, changing only the
`pdfjs-dist` import to `npm:pdfjs-dist@4.10.38/...` (Deno has no `node_modules`).

## Before deploying: local check (no cloud needed)

```bash
npm install --prefix spike          # pdf-lib and @noble/hashes, only under spike/
node spike/check-local.mjs          # expect: right=true, wrong=false for both scrypt libraries, 54 fields
node spike/make-test-pdf.mjs        # only if you want to regenerate sample-order.pdf
```

## Part A: the Edge Function

```bash
bash spike/stage-edge.sh
# First time only, if there is no supabase/ folder yet:
npx supabase init
npx supabase functions deploy spike --project-ref <ref> --no-verify-jwt
```

- The CLI wants the function at `supabase/functions/<name>/index.ts`, which is what `stage-edge.sh` makes.
- If the deploy complains that Docker is not running, add `--use-api` (bundles on Supabase's side, no Docker).
- `--no-verify-jwt` is only for the spike, so curl needs no key. The function is deleted at the end (Task 0 step 6).
- `/loop` reads the database address from `DATABASE_URL`, or, if that is not set, from `SUPABASE_DB_URL`, which
  Supabase gives every Edge Function automatically. So normally no secret is needed. If `/loop` cannot connect,
  set one yourself (copy the pooler connection string from Dashboard > Connect; the owner pastes it in their own
  terminal, never in chat):

  ```bash
  npx supabase secrets set DATABASE_URL="postgresql://postgres.<ref>:<db-password>@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres" --project-ref <ref>
  ```

Run each route 5 times:

```bash
EDGE=https://<ref>.supabase.co/functions/v1/spike
for i in 1 2 3 4 5; do curl -s -w '  [%{http_code} %{time_total}s]\n' "$EDGE/scrypt"; done
for i in 1 2 3 4 5; do curl -s -w '  [%{http_code} %{time_total}s]\n' "$EDGE/scrypt?lib=noble"; done
curl -s "$EDGE/scrypt?wrong=1"                      # must say ok:false
for i in 1 2 3 4 5; do curl -s -w '  [%{http_code} %{time_total}s]\n' -X POST --data-binary @spike/sample-order.pdf -H 'content-type: application/pdf' "$EDGE/pdf"; done
for i in 1 2 3 4 5; do curl -s -w '  [%{http_code} %{time_total}s]\n' "$EDGE/xlsx"; done
for i in 1 2 3 4 5; do curl -s -w '  [%{http_code} %{time_total}s]\n' "$EDGE/loop"; done
```

Notes for reading the results:

- Run 1 of each route is a cold start (includes `importMs`); report the median of all 5 and also note the cold one.
- `ms` and `cpuHint` are in the JSON. The real CPU time is in the Supabase dashboard: Edge Functions > spike >
  Invocations / Logs. The limit is 2 s CPU. A route over 1500 ms moves to the browser (Task 0 step 5).
- A 546 or "CPU time limit" error counts as a fail for that route.
- `/loop` over 3 s total means "re-prioritise for a Postgres function in Task 4".
- Local Node timings for comparison (this PC): scrypt about 70 ms, noble about 150 ms, xlsx about 240 ms, pdf about 180 ms.

## Part B: the Pages pass-through

The Pages Function looks for a `functions/` folder in the folder you deploy from, so run the deploy from
`spike/pages`, not from the repo root (not verified until the first deploy; if the function is missing, try
`npx wrangler pages deploy spike/pages --cwd spike/pages --project-name stallion-stock`).

```bash
cd spike/pages
npx wrangler pages project create stallion-stock --production-branch main     # first time only
npx wrangler pages secret put API_ORIGIN --project-name stallion-stock         # when asked, type: https://<ref>.supabase.co
npx wrangler pages deploy . --project-name stallion-stock                      # secrets apply to new deployments, so deploy after setting it
cd ../..
```

If `secret put` is awkward, set `API_ORIGIN` in the Cloudflare dashboard instead (Workers & Pages >
stallion-stock > Settings > Variables and Secrets), then redeploy. It is just the Supabase address, not a secret.

Check the pass-through (2 MB random binary body, cookies):

```bash
SITE=https://stallion-stock.pages.dev      # use the URL the deploy printed
head -c 2097152 /dev/urandom > /tmp/two-mb.bin
sha256sum /tmp/two-mb.bin                                                   # note this value
curl -s -D /tmp/h.txt -c /tmp/jar.txt -X POST --data-binary @/tmp/two-mb.bin -H 'content-type: application/octet-stream' "$SITE/echo"
# expect: "sha256" identical to the value above, "bytes":2097152, "xRegion":"ap-southeast-2"
grep -i '^set-cookie' /tmp/h.txt                                            # expect TWO lines: a=1 and b=2
curl -s -b /tmp/jar.txt --data-binary 'x' "$SITE/echo"                      # expect "cookie":"a=1; b=2"
curl -s "$SITE/scrypt"                                                      # a normal route also works through the pass-through
```

Also look at the Pages Function's own CPU time in the Cloudflare dashboard (Workers & Pages > stallion-stock >
Functions > Metrics) to confirm it stays well under 10 ms.

## Cleaning up (Task 0 step 6)

```bash
curl -s "$EDGE/cleanup"                                      # drops the scratch table spike_loop
npx supabase functions delete spike --project-ref <ref>
npx wrangler pages project delete stallion-stock             # optional; the real site reuses the name later, so you may keep it
```
