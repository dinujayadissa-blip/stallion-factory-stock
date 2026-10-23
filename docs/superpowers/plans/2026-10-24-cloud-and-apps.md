# Factory Stock in the cloud — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Factory Stock runs in the cloud, free with no card, at one https address. It is used from
Windows as an installed web app, from iPhones as a home-screen app, and from the owner's Android phone
as an Expo app, with all existing data and logins moved across intact.

**Architecture:**

- **Screens** are static files on Cloudflare Pages.
- **A Pages Function** forwards `/api/*` and `/photos/*` to a single Supabase Edge Function. That
  function runs the existing Express app, converted from synchronous `node:sqlite` to async Postgres.
- **Data** lives in Supabase Postgres in Sydney. **Photos** live in a private Supabase Storage bucket.
- **Writes** are serialised by a Postgres advisory lock, so the code keeps the "one writer at a time"
  behaviour it had under SQLite.

**Tech Stack:**

- Node 24 locally, Deno on Supabase Edge
- Express 4
- `postgres` (porsager) client in the cloud, `@electric-sql/pglite` for tests and local development
- Supabase CLI, Cloudflare `wrangler`
- Expo SDK 57 + `react-native-webview` + EAS
- GitHub Actions for backups

**Spec:** `docs/superpowers/specs/2026-10-24-cloud-and-apps-design.md`. Read it first; this plan argues
from it.

## Global Constraints

- **Hosting:** free, no card on file anywhere. Supabase free plan plus Cloudflare free plan only.
  Vercel, Render, Cloud Run, Fly and Oracle are not allowed. Any paid step needs the owner's yes first.
- **Regions:**
  - Supabase region `ap-southeast-2` (Sydney).
  - The Edge Function is invoked pinned to that region (`x-region: ap-southeast-2` header from the
    pass-through).
- **Web address:** `https://stallion-stock.pages.dev`, or the closest free name. It is fixed once
  chosen and baked into the manifests and the Android app.
- **The public repo** (`dinujayadissa-blip/stallion-factory-stock`) never gets:
  - secrets or keys
  - `data/`, backups, `_extracted/`, `_testdata/`
  - customer names, real staff names, or the LAN IP

  Secrets go in Supabase secrets, Cloudflare env vars, and the private backup repo's Actions secrets.
- **Behaviour stays the same.** All 52 existing tests must keep passing, converted to async, against
  PGlite. Screens, wording, roles and rules don't change, except where the spec says so:
  - "start again from spreadsheet", plan import and first-time setup are off in the cloud
  - the cookie is named `fs_session` and is `Secure`
- **Never touch the live data files.** Every run uses a copy, made with
  `node "%TEMP%\fs-tools\copydb.cjs" <db> <dir>`, or a temp folder.
- **Times:** stored local times stay `YYYY-MM-DD HH:MM:SS` text in **Australia/Melbourne** time, and
  "today" means today in Melbourne, even though the cloud runs on UTC.
- **Passwords:** existing scrypt hashes (`scrypt$N$r$p$salt$hash`, N=16384 r=8 p=1) must verify
  unchanged.
- **Owner-only steps:** these are done only by the owner, from click-by-click notes in
  `HANDOVER-CLOUD.md`:
  - creating accounts and projects
  - `supabase login`
  - `wrangler login`
  - pasting secrets into dashboards
- **The sqlite version stays runnable.** Before Task 1, tag the current commit `sqlite-final`. The
  home-PC plan import on cut-over day uses a checkout of that tag.

## Review Focus

These are the failure modes most likely to reach a person. Each is pinned by a test in the task named.

1. **Two phones save at once.** The same part is taken or delivered for the same item at the same
   moment. Today SQLite runs one request at a time; async Postgres interleaves them. Expected: no part
   is set aside twice and the on-hand is right. **Task 5**:
   `two simultaneous takes of the last unit: one succeeds, one is refused`.
2. **Cloud clock is UTC.** At 9:30am Melbourne time, "today", overdue ETAs, default timestamps and the
   export file name must all still be Melbourne's date, including across the daylight-saving change.
   **Task 1**: `melbourne time defaults with TZ=UTC`. **Task 5**: `export filename uses Melbourne date`.
3. **Counts arrive as text.** Postgres `COUNT`/`SUM` come back as strings (`"3"`), which turns `+`
   into joining text ("3" + "1" = "31") on screens. Expected: numbers everywhere. **Task 1**:
   `bigint and numeric results are JS numbers`.
4. **Logging in on iPhone through the pass-through.** The cookie must survive the pass-through:
   - `Set-Cookie` passes through, including more than one
   - `Secure` is set
   - the next request sends the cookie back
   - PDF and photo uploads arrive byte-for-byte

   **Task 8**: `pass-through keeps cookies and body bytes`.
5. **Supabase paused or unreachable.** A paused project or a dropped connection must give a clear
   message on screen, not a blank page or a hang. Expected: `/api/*` answers
   `503 {"error":"The database is asleep or unreachable — try again in a minute"}`, and the pages still
   load. **Task 7**: `database down gives a 503 with a plain message`.

---

## Phase 0 — Prove it (gate: stop and report to the owner if this fails)

### Task 0: Accounts and the Edge spike

**Files:**
- Create: `HANDOVER-CLOUD.md` (section "1. One-time sign-ins": click-by-click for the owner)
- Create: `spike/edge/index.ts`
- Create: `spike/pages/functions/[[path]].js`
- Create: `docs/superpowers/spikes/2026-10-edge-spike.md` (the results)

**Interfaces:**
- Produces: a decision for each of `pdf`, `excel`: either `edge` or `browser`. Later tasks read the
  spike report.

- [ ] **Step 1: Write the owner's sign-in notes** in `HANDOVER-CLOUD.md`, then wait for the owner to
  do them:
  1. In supabase.com, using the same account as Ausventure, create a new project named
     `stallion-factory-stock`. Choose region Sydney and a strong database password, and keep that
     password in the owner's password manager.
  2. Run `npx supabase login` on the home PC.
  3. In cloudflare.com, create a free account (no card) and run `npx wrangler login`.

  Nothing is pasted into chat.
- [ ] **Step 2: Build the spike Edge Function** `spike/edge/index.ts` with these routes:
  - **`/scrypt`:** verifies a hash made locally with `auth.hashPassword('spike-pass-1')`, using
    `node:crypto` scrypt. If that's over 500 ms, retry with `@noble/hashes/scrypt`.
  - **`/pdf`:** runs the `src/parseOrder.js` logic on a dealer-order PDF taken from `_testdata/`.
    Upload it in the request body; never commit it.
  - **`/xlsx`:** builds an exceljs workbook of 70 vans × 120 columns.
  - **`/loop`:** opens one transaction and runs 300 sequential `SELECT`/`UPDATE` pairs against a
    scratch table.

  Each route returns `{ ms, cpuHint }`.
- [ ] **Step 3: Deploy and run each route 5 times.**
  Run: `npx supabase functions deploy spike --project-ref <ref>`, then curl each route.
  Expected: every route returns 200. Record the median times in the spike report.
- [ ] **Step 4: Build the Pages pass-through.** `spike/pages/functions/[[path]].js` forwards to the
  spike function. Deploy it with `npx wrangler pages deploy spike/pages --project-name stallion-stock`.
  Check that `Set-Cookie` and a 2 MB binary POST round-trip unchanged. Expected: identical sha256 of
  the body, and the cookie is echoed back on the next request.
- [ ] **Step 5: Write the decision in the spike report.**
  - Any route that failed with a CPU-limit error, or took more than 1500 ms, moves to the browser
    (pdf or excel). For scrypt, switch library.
  - If `/loop` is over 3 s, mark re-prioritise for a Postgres function in Task 4.
  - If scrypt can't verify under the limit with either library, **stop and tell the owner.**
- [ ] **Step 6: Delete the spike function and the scratch table, then commit the report.**
  Run: `npx supabase functions delete spike`.
  ```bash
  git add HANDOVER-CLOUD.md docs/superpowers/spikes/ spike/
  git commit -m "Cloud spike: Edge CPU, pass-through, results"
  ```

---

## Phase 1 — Postgres underneath (local, no cloud needed)

### Task 1: Async database layer, schema and test harness

**Files:**
- Create: `supabase/migrations/0001_schema.sql`
- Rewrite: `src/db.js` (keep its exports' names; all become async)
- Create: `src/pg.js` (the driver adapter)
- Create: `test/helpers.js`
- Create: `test/db.test.js`
- Modify: `package.json`
  - add `postgres@3.4.x`, `@electric-sql/pglite@0.3.x`
  - add the script `"test": "node --test \"test/*.test.js\""`, which stays as it is

**Interfaces:**
- Produces, from `src/db.js`:
  - `all(sql, ...p): Promise<object[]>`
  - `get(sql, ...p): Promise<object|undefined>`
  - `run(sql, ...p): Promise<{ changes: number }>`
  - `insert(sql, ...p): Promise<number>`: appends ` RETURNING id` and returns the new id. This
    replaces every `run(...).lastInsertRowid`.
  - `tx(fn: () => Promise<T>): Promise<T>`: re-entrant, using `AsyncLocalStorage` that holds the
    transaction's connection. Every `all/get/run/insert` inside `fn` uses that connection.
  - `writeTx(fn)`: `tx` plus `SELECT pg_advisory_xact_lock(42)` first and
    `UPDATE settings SET value = (value::int + 1)::text WHERE key = 'data_version'` last.
  - `getSetting(key, fallback): Promise<string>`, `setSetting(key, value): Promise<void>`
  - `logAlloc(reason, {...}): Promise<void>`, with the same fields as today
  - `syncSuppliers(): Promise<void>`
  - `dataVersion(): Promise<string>`
  - `openDb({ url?: string, pgliteDir?: string }): Promise<void>`
  - `closeDb(): Promise<void>`
- Produces, from `src/pg.js`: `makeDriver({ url } | { pgliteDir })` returns
  `{ query(sql, params): Promise<{ rows, count }>, begin(fn), close() }`.
- Produces, from `test/helpers.js`: `freshDb(): Promise<void>`. It opens an in-memory PGlite, applies
  every `supabase/migrations/*.sql` in order, and is used by every test file.

**Rules `src/db.js` applies to every query:**
- `?` placeholders become `$1..$n`. Skip any `?` inside single-quoted literals.
- Results of type int8 (OID 20) and numeric (OID 1700) are parsed to JS `Number`.
- A connection error, or a "project paused" error, is rethrown as
  `httpError(503, 'The database is asleep or unreachable — try again in a minute')`.

**Schema rules for `0001_schema.sql`:**
- It must equal the **final** SQLite schema: every `addColumn` in today's `src/db.js` folded in, plus
  the tables from `src/tidy.js`, `src/auth.js` and `src/layout.js` that exist in a migrated real
  database. Read the schema from a copy of the real db
  (`SELECT sql FROM sqlite_master`), not from reading the code.
- `INTEGER PRIMARY KEY` becomes `integer generated by default as identity`. Use `integer`, not
  `bigint`, so ids are JS numbers.
- 0/1 flags stay `integer`, which avoids changing code that compares to 1. `REAL` becomes
  `double precision`.
- `DEFAULT (datetime('now','localtime'))` becomes
  `DEFAULT to_char(now() AT TIME ZONE 'Australia/Melbourne','YYYY-MM-DD HH24:MI:SS')`.
- `users.username`: a unique index on `lower(username)`, and lookups use `lower(username) = lower(?)`.
- Trigger `trg_firm_cap` becomes a plpgsql `BEFORE UPDATE` trigger that clamps
  `reserved_firm` to `[0, reserved]`.
- Function `first_number(text) RETURNS integer` returns the first run of digits, or 9999.
- Seed `settings('data_version','0')`.
- **New tables:**
  - `login_throttle(key text primary key, fails integer, first_at bigint, locked_until bigint)`
  - `request_receipts(rid text primary key, out jsonb, at bigint)`

- [ ] **Step 1: Tag the sqlite version.** Run: `git tag sqlite-final && git push origin sqlite-final`.
- [ ] **Step 2: Write `test/db.test.js`** with these tests:
  - `insert returns the new id`
  - `tx rolls back everything when fn throws`: insert, throw, then `get` count equals 0
  - `tx is re-entrant`: a nested `tx` inside `tx` joins it, and one rollback undoes both
  - `bigint and numeric results are JS numbers`:
    `typeof (await get('SELECT COUNT(*) AS n FROM items')).n === 'number'`
  - `melbourne time defaults with TZ=UTC`: with `process.env.TZ='UTC'`, insert a `users` row; its
    `created_at` matches the Melbourne wall-clock from `Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne'})`
    to the minute
  - `first_number`: `'Bay 6'` gives 6 and `'Yard'` gives 9999
  - `firm cap trigger clamps`: set `reserved_firm` to 5 with `reserved` 2, and it becomes 2
  - `username unique whatever its capitals`: inserting `Alex` then `alex` throws
  - `writeTx bumps data_version`
- [ ] **Step 3: Run them and check they fail.** Run: `node --test test/db.test.js`.
  Expected: FAIL (`openDb` is not exported).
- [ ] **Step 4: Implement `src/pg.js`, the new `src/db.js` and `0001_schema.sql`** to the rules above.
  `DATA_DIR` keeps meaning the folder for local data. With no `DATABASE_URL`, local runs use PGlite at
  `DATA_DIR/pg`.
- [ ] **Step 5: Run them and check they pass.** Run: `node --test test/db.test.js`. Expected: 9 pass.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/db.js src/pg.js supabase/ test/db.test.js test/helpers.js package.json package-lock.json
  git commit -m "Async Postgres database layer (PGlite for tests), schema migration"
  ```

### Task 2: Logins on Postgres

**Files:**
- Modify: `src/auth.js`
- Modify: `test/auth.test.js`, `test/auth-http.test.js` (switch to `freshDb()` and `await`)
- Modify: `scripts/users.js` (async; uses `DATABASE_URL` if set)

**Interfaces:**
- Consumes: Task 1's `db.js`.
- Produces: the same exported names as today, now async wherever they touch the database:
  - `listUsers`, `getUser`, `findUser`, `userCount`
  - `createUser`, `updateUser`, `setActive`, `resetPassword`, `changeOwnPassword`
  - `createSession`, `sessionFromToken`, `endSession`, `endUserSessions`, `pruneSessions`
  - `login`
- Produces: `createThrottle()`, now backed by `login_throttle`. It keeps the same limits (5 per
  username+IP, 30 per IP, 15-minute lock) and the same `{ left, until }` errors.
- Produces: `COOKIE` is `'fs_session'` when `process.env.CLOUD === '1'`. `sessionCookie(token, { secure: true })`
  is used in the cloud.

- [ ] **Step 1: Convert the two auth test files** to `await` and `freshDb()`, and add these tests:
  - `throttle survives a new throttle object`: 5 wrong tries, a new `createThrottle()`, then the 6th
    try is still locked
  - `login is case-insensitive on username`
  - `existing scrypt hash verifies`: use a fixed hash string made by today's code for `'Test-pass-123'`
- [ ] **Step 2: Run them and check they fail.** Run: `node --test test/auth.test.js test/auth-http.test.js`.
  Expected: FAIL.
- [ ] **Step 3: Convert `src/auth.js` and `scripts/users.js`.** Move the throttle state into
  `login_throttle`, inside `writeTx`. If `process.env.CLOUD === '1'`, `fromThisPc()` returns `false`,
  which turns off first-time setup.
- [ ] **Step 4: Run them and check they pass.** Run: the same command. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -am "Logins on Postgres: async, lock-outs stored in the database"`

### Task 3: Stock logic on Postgres (`src/inventory.js`)

**Files:**
- Modify: `src/inventory.js`
- Modify: `test/merge-and-shortages.test.js`, `test/owner-r3.test.js`, `test/planner-r3.test.js`,
  `test/worker-r3.test.js` (switch to `freshDb()` and `await`; test helpers use `insert`)

**Interfaces:**
- Consumes: Task 1.
- Produces: every exported function keeps its name and arguments and returns a Promise.
- Produces: `shortagesCached()` keys its memo on `await dataVersion()` plus the Melbourne `today()`,
  instead of `total_changes()`.
- Produces: `today()` returns the Melbourne date `YYYY-MM-DD` whatever `TZ` is.

**SQL rewrites:**

| SQLite | Postgres |
|---|---|
| scalar `MAX(a,b)` / `MIN(a,b)` | `GREATEST` / `LEAST` |
| `group_concat(x, s)` | `string_agg(x::text, s)` |
| `instr(a, b)` | `strpos(a, b)` |
| case-insensitive `LIKE` | `ILIKE` |
| `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` |
| double-quoted string literals | single quotes |

Also fix any `GROUP BY` that selects ungrouped columns.

- [ ] **Step 1: Convert the four test files** to async (mechanical). Add
  `today() is Melbourne's date when TZ=UTC`: fake the clock with `t.mock.timers` at
  `2026-10-24T14:30:00Z`; the expected result is `'2026-10-25'`.
- [ ] **Step 2: Run them and check they fail.** Run: `npm test`. Expected: FAIL in the converted files.
- [ ] **Step 3: Convert `src/inventory.js`** to the rules above. If the spike marked `/loop` as slow,
  move `reprioritise`'s inner loop into a plpgsql function `reprioritise_all()` in
  `supabase/migrations/0002_reprioritise.sql`, with the same results as the JS version.
- [ ] **Step 4: Run them and check they pass.** Run: `npm test`. Expected: every test in these four
  files passes.
- [ ] **Step 5: Commit.** `git commit -am "Stock logic on Postgres (async), Melbourne 'today'"`

### Task 4: The other modules on Postgres

**Files:**
- Modify: `src/relink.js`, `src/planMap.js`, `src/layout.js`, `src/lineState.js`, `src/rules.js`,
  `src/trades.js`, `src/webImage.js`, `src/golive.js`, `src/exportXlsx.js`
- Unchanged: `src/parseOrder.js`, unless the spike moved PDF reading to the browser (see Task 8)
- Not converted (sqlite-only, used from the `sqlite-final` tag): `src/importPlan.js`, `src/tidy.js`,
  `src/seed.js`. Their imports are removed from the cloud code path.
- Test: `test/modules.test.js`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces: the same exports, async.
- Produces: `golive.js` drops the steps that read `tidyStatus()` / `planConflicts()` when
  `CLOUD=1`, and marks them done.
- Produces: the relink caches (`reCache`, `supCache`, `supWordCache`) key on `dataVersion()`.

- [ ] **Step 1: Write `test/modules.test.js`** with these tests:
  - `layout save and load round-trip`
  - `relink suggestions refresh after a supplier change`: change a supplier, and the next call sees it
  - `excel export has one row per van`
- [ ] **Step 2: Run it and check it fails.** Run: `node --test test/modules.test.js`. Expected: FAIL.
- [ ] **Step 3: Convert the modules** using the SQL rewrites from Task 3.
- [ ] **Step 4: Run all tests.** Run: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -am "Remaining modules on Postgres"`

### Task 5: Server on Postgres, one writer at a time

**Files:**
- Modify: `server.js`. Split it into `src/app.js` (builds and exports the Express app) and `server.js`
  (local runner: `openDb` + `listen`).
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `createApp({ cloud: boolean }): express.Application` from `src/app.js`.
- Produces, in the `h()` wrapper: every `POST/PUT/PATCH/DELETE` handler runs inside `writeTx`.
  `stampMovements` runs inside that same transaction.
- Produces: `floorReceipts` becomes the `request_receipts` table. Keep entries for 24 h; the nightly
  prune deletes older rows.
- Produces: when `cloud` is true:
  - every `POST /api/import/plan/*` route (preview, update and apply, which is "start again") and the
    `/api/setup` POST return `410 {"error":"Not available in the online version"}`. The office app
    hides those buttons when `GET /api/me` says `cloud: true`.
  - the backup-before-start-again code is unreachable
  - `setInterval(pruneSessions)` is removed, because the nightly job does it
  - the page routes `/`, `/floor` and `/login` are not served, because Pages serves them
  - `/photos/*` streams from Storage (see Task 6)
- Produces: the Excel export file name uses the Melbourne date.

- [ ] **Step 1: Write `test/server.test.js`** using supertest-style `fetch` against
  `createApp({ cloud: false }).listen(0)`:
  - `two simultaneous takes of the last unit: one succeeds, one is refused`: one item, on-hand 1,
    two vans each with a line. Fire `Promise.all` of two `/api/floor/take` calls. Expect exactly one
    200, on-hand 0, and that unit set aside or taken exactly once.
  - `a repeated floor delivery id books once`: post `/api/floor/receive` twice with the same `rid`,
    and there is one movement.
  - `export filename uses Melbourne date`: with `TZ=UTC` and the clock at `2026-10-24T14:30:00Z`, the
    `Content-Disposition` contains `2026-10-25`.
  - `cloud mode refuses plan import`: with `createApp({ cloud: true })`, `POST /api/import/plan/apply`
    returns 410.
- [ ] **Step 2: Run it and check it fails.** Run: `node --test test/server.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the split, `writeTx` in `h()`, the receipts table and the cloud switches.
- [ ] **Step 4: Run all tests.** Run: `npm test`. Expected: all pass.
- [ ] **Step 5: Run the app locally on a copy of the real data.**
  1. Make a copy with the copy script from Task 9, step 3, pointed at a PGlite folder in `%TEMP%`.
  2. Run `DATA_DIR=<that folder> PORT=3300 node server.js`.
  3. Click through as owner and as worker.

  Expected: the same vans, stock and shortages as the sqlite version shows on the same data.
- [ ] **Step 6: Commit.** `git commit -am "Server on Postgres: one writer at a time, cloud switches"`

### Task 6: Photos in Storage

**Files:**
- Modify: `src/photos.js`
- Test: `test/photos.test.js`

**Interfaces:**
- Produces: `savePhoto(itemId, fullDataUrl, thumbDataUrl): Promise<string>` returns the file name, as
  today.
- Produces: `deletePhoto(name): Promise<void>`.
- Produces: `readPhoto(name): Promise<{ body: Uint8Array, type: 'image/jpeg' } | null>`.
- Backend: local disk under `DATA_DIR/photos` when `SUPABASE_URL` is unset. Otherwise the private
  bucket `item-photos`, through the Storage REST API with `SUPABASE_SERVICE_ROLE_KEY`.
- The JPEG checks stay as they are.

- [ ] **Step 1: Write the tests** with the disk backend:
  - `save, read and delete a photo`
  - `non-JPEG refused`
  - `name with ../ refused`
- [ ] **Step 2: Run them and check they fail.** Run: `node --test test/photos.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement both backends.** In `src/app.js`, `/photos/:name` calls `readPhoto` after
  the login check.
- [ ] **Step 4: Run all tests.** Run: `npm test`. Expected: pass.
- [ ] **Step 5: Commit.** `git commit -am "Photos: disk locally, private Supabase Storage in the cloud"`

---

## Phase 2 — Cloud

### Task 7: The Edge Function

**Files:**
- Create: `supabase/functions/api/index.ts`, which imports `createApp` from `../../../src/app.js` with
  `{ cloud: true }`, calls `openDb({ url: Deno.env.get('DATABASE_URL') })` once per isolate, and runs
  `app.listen(8000)`
- Create: `supabase/functions/api/deno.json` (npm import map for express, postgres, exceljs, pdfjs-dist)
- Create: `supabase/config.toml` (`verify_jwt = false` for `api`, because the app does its own logins)
- Create: `scripts/deploy-api.ps1`, which runs `npx supabase db push` and
  `npx supabase functions deploy api --no-verify-jwt`
- Test: `test/cloud-api.test.js`

**Interfaces:**
- Consumes: Task 5's `createApp`.
- **Secrets**, set by the owner from notes in `HANDOVER-CLOUD.md`:
  - `DATABASE_URL` (Supabase pooler, transaction mode, port 6543)
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `PASS_SECRET` (random, 32 bytes)
  - `CLOUD=1`
- **Trust rule:** requests are trusted for `x-forwarded-host` and `x-forwarded-for` only if
  `x-pass-secret === PASS_SECRET`. Otherwise the function answers 403. The function is reachable only
  through Pages.

- [ ] **Step 1: Write `test/cloud-api.test.js`** against `createApp({ cloud: true })`:
  - `request without the pass secret is refused (403)`
  - `database down gives a 503 with a plain message`: point `openDb` at an unused port, and `/api/me`
    returns 503 with the exact message from Review Focus 5
- [ ] **Step 2: Run it and check it fails.** Run: `node --test test/cloud-api.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the pass-secret middleware in `src/app.js` (cloud only) and the function
  entry.
- [ ] **Step 4: Run all tests.** Run: `npm test`. Expected: pass.
- [ ] **Step 5: Deploy to the empty live project.** Run: `scripts/deploy-api.ps1`, then call
  `curl -H "x-pass-secret: <secret>" https://<ref>.supabase.co/functions/v1/api/api/me`.
  Expected: `401` JSON (not logged in), which proves the function and the database are up.
- [ ] **Step 6: Commit.** `git commit -am "Supabase Edge Function running the app"`

### Task 8: Cloudflare Pages: screens, pass-through, installable apps

**Files:**
- Create: `scripts/build-pages.js`. It assembles `dist-pages/` from:
  - `public/*`
  - `views/index.html` → `dist-pages/index.html`
  - `views/floor.html` → `dist-pages/floor.html`
  - `public/login.html` → `dist-pages/login.html`
  - `functions/`
- Create: `functions/api/[[path]].js` and `functions/photos/[[path]].js`, both calling
  `forward(request, env)` from `functions/_forward.js`.
- Create: `functions/_middleware.js`, the page gate for `/`, `/index.html`, `/floor` and `/floor.html`.
  It calls the API's `/api/me` with the request's cookie and redirects exactly as `server.js` does
  today:
  - not logged in, or must change password: `/login?next=…`
  - a worker opening `/`: `/floor`
  - anything else: serve the asset with `Cache-Control: no-store`
- Create: `public/office.webmanifest` ("Stallion Stock", start `/`, `display: standalone`, Stallion
  icons). Link it from `views/index.html`. Add `apple-mobile-web-app-capable` metas to both views.
- Modify: `public/floor-sw.js` only if the spike found the service worker breaks over https. Otherwise
  leave it alone.
- If the spike chose `browser` for pdf: modify `public/app.js` to read the PDF with pdf.js from
  `/vendor/pdfjs/` and post the text. The server's PDF route accepts the text form.
- If the spike chose `browser` for excel: the same pattern, with exceljs, for the export.
- Create: `scripts/deploy-pages.ps1`, which runs `node scripts/build-pages.js` and
  `npx wrangler pages deploy dist-pages --project-name stallion-stock`.
- Test: `test/pages.test.js` (imports `_forward.js` and `_middleware.js` with a fake `env` and a fake
  `fetch`)

**Interfaces:**
- `forward(request, env)` sends to `${env.API_ORIGIN}/functions/v1/api${path}${search}`.
  - It adds the headers `x-pass-secret: env.PASS_SECRET`, `x-region: ap-southeast-2`,
    `x-forwarded-host`, and `x-forwarded-for` (from `CF-Connecting-IP`).
  - It streams the body.
  - It returns the response with every `Set-Cookie` kept.
- Pages env vars, set by the owner from notes: `API_ORIGIN`, `PASS_SECRET`.

- [ ] **Step 1: Write `test/pages.test.js`** with these tests:
  - `pass-through keeps cookies and body bytes`: two `Set-Cookie` headers survive, and the sha256 of
    a 2 MB body is unchanged
  - `worker opening / is sent to /floor`
  - `not logged in opening /floor goes to /login?next=%2Ffloor`
  - `office manifest is valid JSON with a 512 icon`
- [ ] **Step 2: Run it and check it fails.** Run: `node --test test/pages.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions, build script and manifest.
- [ ] **Step 4: Run all tests.** Run: `npm test`. Expected: pass.
- [ ] **Step 5: Deploy, then check from a phone-sized browser:**
  - log in
  - add a photo
  - import a test dealer PDF from `_testdata/`
  - download the Excel export
  - log out

  Expected: all work at `https://stallion-stock.pages.dev`. Edge offers "Install app".
- [ ] **Step 6: Commit.** `git commit -am "Cloudflare Pages: screens, pass-through, installable office app"`

### Task 9: Copy the real data up

**Files:**
- Create: `scripts/copy-to-cloud.js`
  - **Inputs:** `--from <path to factory.db>` and `--to <DATABASE_URL | pglite dir>`, with
    `--photos <dir>` optional.
  - It refuses to run unless the target's `vans` table is empty, or `--wipe` is given.
- Test: `test/copy.test.js`

**Interfaces:**
- Consumes: Task 1's schema, and node:sqlite for reading.
- Produces: `copyAll({ from, to, photosDir, wipe }): Promise<Report>`, where
  `Report = { tables: {name, from, to}[], checks: {name, from, to, ok}[], ok: boolean }`.
- **Rules:**
  - Copy every table, keeping ids.
  - Then reset each identity sequence to `max(id)+1`. `movements` restarts above
    `max(max(movements.id), max(count_sessions.last_move_id))`.
  - Skip `sqlite_sequence`.
  - Upload photos to Storage under the same names.
- **Checks:**
  - the row count of every table
  - `SUM(on_hand)` per item
  - `SUM(reserved)` and `SUM(reserved_firm)` per van
  - the open PO quantity per PO line (`qty - received - closed`)
  - the count and `pass_hash` equality of `users`

- [ ] **Step 1: Write `test/copy.test.js`.** Build a small sqlite db with the `sqlite-final` schema,
  using node:sqlite and the `sqlite-final` `db.js` from `git show sqlite-final:src/db.js` saved to a
  temp file. Then:
  - `copy matches every check`
  - `refuses a non-empty target without --wipe`
  - `next movement id is above every copied one`
- [ ] **Step 2: Run it and check it fails.** Run: `node --test test/copy.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `copyAll`** and the CLI that prints the report as a table with a final
  `ALL CHECKS PASSED` or `CHECKS FAILED — nothing to switch to`.
- [ ] **Step 4: Run all tests.** Run: `npm test`. Expected: pass.
- [ ] **Step 5: Trial load.**
  1. Copy the real db with `copydb.cjs`.
  2. Run `node scripts/copy-to-cloud.js --from <copy> --to $env:DATABASE_URL --photos <copy>\photos`.

  Expected: `ALL CHECKS PASSED`.
- [ ] **Step 6: Commit.** `git commit -am "Copy-to-cloud script with before/after checks"`

### Task 10: Nightly backups

**Files:**
- Create a new **private** repo, `dinujayadissa-blip/stallion-factory-backups`:
  `gh repo create dinujayadissa-blip/stallion-factory-backups --private`.
- Create, in that repo: `.github/workflows/nightly.yml`
  - cron `0 15 * * *` UTC, which is 2am in Melbourne during summer time (1am in winter, which is fine)
  - `workflow_dispatch`
  - `postgresql-client-17`, then `pg_dump --format=custom "$DATABASE_URL" > db/factory-$(date +%F).dump`
  - downloads every object in `item-photos` to `photos/` with a small Node script, `scripts/photos.mjs`
  - deletes dumps older than 30 days
  - runs `DELETE FROM sessions WHERE expires_at <= …`, `DELETE FROM request_receipts WHERE at < …`
    and the `login_throttle` prune
  - commits to the private repo
- Create, in the public repo: `docs/RESTORE.md` (step by step: `pg_restore` into a scratch project,
  then switch secrets)
- Secrets in the private repo: `DATABASE_URL` (session mode, port 5432), `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`. Set them with `gh secret set` from values the owner pastes in their own
  terminal, never in chat.

- [ ] **Step 1: Create the repo and the workflow, then push.**
- [ ] **Step 2: Run it once.** Run: `gh workflow run nightly.yml -R dinujayadissa-blip/stallion-factory-backups`,
  then `gh run watch`. Expected: success, with one `.dump` and the photos committed.
- [ ] **Step 3: Rehearse a restore** into a local PGlite or a local Postgres following `docs/RESTORE.md`,
  then run Task 9's checks against it. Expected: all checks equal.
- [ ] **Step 4: Commit `docs/RESTORE.md`** to the public repo. `git commit -am "Backups: nightly to private repo, restore steps"`

---

## Phase 3 — Android app

### Task 11: Expo WebView app

**Files:**
- Create `mobile/`:
  - `package.json` (expo ~57, react-native-webview, expo-splash-screen, expo-status-bar)
  - `app.json` (name "Stallion", slug `stallion-stock`, Android package `au.com.stallioncaravans.stock`,
    icon and splash from `public/assets/app/`, permissions CAMERA and READ_MEDIA_IMAGES)
  - `eas.json` (a `preview` profile that builds an APK)
  - `.npmrc` (`legacy-peer-deps=true`)
  - `App.js`

**Interfaces:**
- Consumes: the fixed address from Task 8, as constant `APP_URL` in `App.js`.
- **Behaviour of `App.js`:**
  - a full-screen `WebView` of `APP_URL` with `sharedCookiesEnabled`, `domStorageEnabled`,
    `allowFileAccess`, and `mediaPlaybackRequiresUserAction={false}`
  - the Android back button calls `goBack()` while `canGoBack`, and otherwise exits
  - `onError` and an offline check show a Stallion-coloured screen: "Waiting for signal…" with a
    Retry button
  - links that leave `APP_URL`'s host open in the phone's browser

- [ ] **Step 1: Create the project and run it in Expo Go** on the owner's phone with
  `npx expo start --tunnel` (this is how Ausventure ran). Expected:
  - the login page shows
  - logging in works, and the cookie survives closing and reopening the app
  - the photo picker opens the camera
- [ ] **Step 2: Build the APK.** Run: `npx eas-cli build --profile preview --platform android`
  (owner's Expo account `uvindu13`). Expected: a build link. The owner installs it from the link.
- [ ] **Step 3: Commit.** `git add mobile && git commit -m "Android app (Expo WebView shell)"`

---

## Phase 4 — Hand-over, trial and cut-over

### Task 12: Owner notes, trial, cut-over

**Files:**
- Complete: `HANDOVER-CLOUD.md`, with these sections:
  1. One-time sign-ins (from Task 0)
  2. Secrets: where each one is pasted, with screenshots described in words
  3. Install on Windows (Edge → ⋯ → Apps → Install), on iPhone (Safari → Share → Add to Home Screen)
     and on Android (APK link)
  4. Second owner login: make it now and keep it somewhere safe
  5. If the app says "asleep": Supabase → project → Restore
  6. Cut-over day checklist (below)
  7. Where the backups are, and `docs/RESTORE.md`
- Modify: `README.md` (how to run locally with PGlite, deploy commands), `CHANGES.md` (an "Online
  version" section)
- GitHub board:
  - close #5 (office PC move) as replaced
  - comment on #6 (remote access), which this provides, and close it
  - #7 (real phone test) is done by the trial

**Cut-over checklist** (run by Claude with the owner, on the owner's chosen day):
1. Optional: re-import the latest production plan on the home PC from a `sqlite-final` checkout, on
   a copy, exactly as before.
2. `node scripts/copy-to-cloud.js --from <latest db copy> --to <DATABASE_URL> --photos <photos> --wipe`.
   Expected: `ALL CHECKS PASSED`.
3. Run the backup workflow once by hand. Expected: green.
4. The owner logs in on Android, one iPhone and one Windows PC, and checks three vans and three items
   against the old copy.
5. Send everyone the address and the install notes. Leave the home-PC copy untouched for at least a
   month.

- [ ] **Step 1: Write the notes, update README/CHANGES and update the board.**
- [ ] **Step 2: Trial.** The owner tries every role on the trial data. Fix anything found, with a test
  for each fix.
- [ ] **Step 3: Commit and push.** `git commit -am "Online version: hand-over notes" && git push`
- [ ] **Step 4: Cut-over day:** run the checklist with the owner.
