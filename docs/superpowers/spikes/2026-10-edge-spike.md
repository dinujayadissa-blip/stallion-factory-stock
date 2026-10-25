# Edge spike results (2026-10-25)

Supabase project in Sydney (ap-southeast-2), Postgres 17, free plan. Function `spike` deployed with
`supabase functions deploy spike --use-api --no-verify-jwt` (the first deploy attempt returned a Supabase
"internal error" 500; the retry worked). Each route was called 5 times from the home PC in Victoria.

| Route | Work time (median of 5) | Cold first call | Limit | Decision |
|---|---|---|---|---|
| `/scrypt` (node:crypto, N=16384 r=8 p=1) | 26 ms, verifies the old-format hash; wrong password rejected | 6.7 s total (function's first-ever boot) | 2 s CPU | **edge**, keep node:crypto |
| `/scrypt?lib=noble` | 49 ms | — | — | not needed |
| `/pdf` (src/parseOrder.js on a synthetic 3-page order, 54 fields) | 13 ms (+50 ms first import) | 0.26 s | 2 s CPU | **edge** (no browser fallback) |
| `/xlsx` (exceljs 70 x 120) | 145–230 ms (+310 ms first import) | 0.65 s | 2 s CPU | **edge** (no browser fallback) |
| `/loop` (one transaction, 300 SELECT/UPDATE pairs) | 1.91 s (≈3.2 ms per query round trip) | 2.2 s | plan rule: > 3 s → Postgres function | **keep JS** — under 3 s |

Notes
- Round trips from the Edge Function to Postgres cost about 3 ms each. The real "re-prioritise" loops over every
  stock item with several queries each, so on real data (263 items) it may take several seconds. It is wall-clock
  (waiting on the database), not CPU, so it fits the limits, but measure it on the trial and move it to a Postgres
  function if it feels slow.
- The 6.7 s first call was the function's first boot after deploy; later calls answered in about 0.1 s. Watch cold
  starts on the trial (Review Focus: "workers wait no more than a few seconds").
- Part B (Cloudflare Pages pass-through: cookies + 2 MB body) waits for the owner's Cloudflare sign-in.
