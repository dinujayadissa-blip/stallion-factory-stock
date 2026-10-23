# Factory Stock in the cloud, with a Windows app and phone apps — design

Date: 2026-10-24 · Status: for the owner's approval

## Why

Today Factory Stock (this repo) runs on one PC: an Express server with the data in a SQLite file
(`data/factory.db`) and item photos in `data/photos`. Only devices on that PC's Wi‑Fi can reach it, and
it stops when the PC stops. It has not been moved to the office PC yet, and nobody has used it since
2026-10-13. The newest real data is on the owner's home PC.

The owner wants:

- **Use from anywhere:** the factory floor, home, and out on the road (dealers, suppliers).
- **No PC kept switched on.** The office-PC move (board item #5) is dropped.
- **The same live data on every device:** Windows PCs and laptops for the office, and smartphones for
  the owner, leading hands and workers.
- **An installed phone app like the owner's other project, Ausventure:** an Expo app on Android, with
  its data in Supabase.
- **Free to run, with no credit card on file anywhere.** The owner chose this over a faster
  card-on-file option.

Phones: the owner uses **Android**. Everyone else (office, leading hands, workers) uses **iPhone**.
The owner chose the **free route for iPhone**, a home-screen web app rather than a paid Apple developer
account. Moving to a proper iPhone app later must not mean rebuilding the screens.

## Goals

1. **All data lives in a free Supabase project** (Postgres plus Storage) in the **Sydney region**
   (`ap-southeast-2`). That covers vans, stock, allocations, purchase orders, rules, layout, logins,
   sessions, logs and photos.
2. **Always reachable over https, with nothing on the factory's premises and no card on file.** It
   must not fall asleep and take a minute to wake.
3. **One set of screens on every device:**
   - **Windows:** the office app, installed from Edge or Chrome as an app. It gets a Start-menu icon,
     its own window, and updates itself.
   - **iPhone:** the worker and office screens added to the home screen from Safari. They get the
     Stallion icon, run full screen, and show no browser bars.
   - **Android (owner):** an installed Stallion app built with Expo and EAS on the owner's existing
     Expo account, the same way as Ausventure.
4. **Behaviour doesn't change.** Everything below stays as it is, except where this document says
   otherwise:
   - screens, wording, and the Stallion look
   - roles (owner, office, stores, leadhand, worker with trade) and what each can see and do
   - build-order allocation, locked parts, purchasing, rack counts, reminders, and the floor map
   - dealer order PDF reading and the Excel export
5. **All current data comes across intact**, including the existing logins and their passwords. The
   scrypt hashes copy across as they are.
6. **A nightly backup** of the database and photos goes to a **second, private place**, because
   Supabase's free plan has no automatic backups.

## Non-goals

- No paid iPhone app, TestFlight, or App Store for now.
- No new features. Van cost tracking (#10) and yard positions (#9) stay parked. The role questions in
  #4 are not changed.
- No redesign of the screens.
- No offline editing. If signal drops, the app says it's waiting, as it does today.

## Anti-goals (it fails even if it "works" if…)

- **Data is lost or changed in the move.** Any stock count, allocation, or PO line that differs before
  and after counts as a failure.
- **Data becomes reachable without a login.** That covers customer names, stock and photos: no public
  Storage buckets, no keys in the public GitHub repo, and no backups in the public repo.
- **Workers wait** more than a few seconds for the app to respond during working hours.
- **It quietly starts costing money,** or needs a card. Any paid step needs the owner's yes first.
- **The owner has to babysit it,** such as restarting servers or renewing things every few weeks.

## Constraints

- **The GitHub repo is public** (dinujayadissa-blip/stallion-factory-stock). No secrets, data, customer
  names, real staff names, or backups go in it. Keys live in the Supabase and Cloudflare dashboards and
  in GitHub Actions secrets of the private backup repo.
- **Supabase free plan limits:**
  - 500 MB database and 1 GB storage. Today's data is about 2 MB of database plus 5 MB of photos.
  - 5 GB a month of data out.
  - 500,000 Edge Function calls a month.
  - Each Edge Function call may use **2 seconds of CPU**. Waiting on the database doesn't count toward
    that.
  - The project pauses after 7 days with no activity.
  - Two free projects per account. Ausventure uses one.
- **Cloudflare free plan limits:**
  - Static pages are unlimited.
  - Pages Functions share the Workers free quota: 100,000 calls a day and **10 ms of CPU each**. That
    is fine for passing requests through, but not for real work.
- **Ruled out:**
  - **Vercel Hobby:** non-commercial use only.
  - **Render free:** its docs say not to use it for production, and it sleeps for about a minute.
  - **Google Cloud Run, Fly.io and Oracle:** they need a card.
- **The current app keeps working until cut-over.** The move is tested on a copy of the real data
  first, and the owner picks the switch-over day.
- **The owner is not a programmer.** Any step they must do by hand needs click-by-click instructions.

## How it's built (decided)

### Where things run

```
Phone / PC browser ──https──▶ Cloudflare Pages (stallion-stock.pages.dev)
                                ├─ screens: HTML / CSS / JS / icons (static, unlimited)
                                └─ /api/* and /photos/* ──pass-through──▶ Supabase Edge Function "api"
                                                                           (Deno, Sydney)
                                                                              ├─ Postgres (Sydney)
                                                                              └─ Storage, private bucket
```

- **Screens are served by Cloudflare Pages**, free with no card. Supabase can't serve HTML on its free
  plan, because it turns HTML into plain text.
- **A tiny Pages Function forwards `/api/*` and `/photos/*` to the Supabase Edge Function.** It keeps
  everything on one web address, so the login cookie stays first-party. That matters because iPhone
  Safari blocks cross-site cookies. The function does no other work, so it stays well inside the 10 ms
  CPU limit.
- **The app's "brains" become one Supabase Edge Function** that runs the existing Express routes
  (Express runs on Supabase's Deno runtime). Server code moves from Node to Deno, keeping Express and
  the existing modules wherever the runtime allows. It talks to Postgres in the same region, so the
  many small queries per request stay fast.
- **The web address is `https://stallion-stock.pages.dev`**, or the closest free name available. It
  stays the same even if the "brains" move to another host later, so installed apps never need
  reinstalling.

### Step 0: prove it before converting anything (about a day)

A throwaway test on a scratch Supabase project, or the live project while it's still empty, checks
these things inside a real Edge Function:

1. **Existing scrypt password hashes verify** (N=16384, r=8, p=1) well under the 2 s CPU limit. If
   Deno's built-in scrypt is too slow, use a pure-JS scrypt such as `@noble/hashes`.
2. **A real dealer order PDF is read** by the `src/parseOrder.js` logic under the CPU limit.
3. **The Excel export** of the full plan finishes under the limit.
4. **The heaviest allocation call** works over Postgres: re-prioritise, which loops `allocateItem` over
   every item. It runs as one transaction, and the time it takes is measured.
5. **The Pages pass-through** forwards cookies, JSON, file uploads (PDF, photos) and photo downloads
   correctly.

If item 2 or 3 is over the limit, that job moves **into the browser**:

- PDF reading uses pdf.js in the page and sends the extracted text and fields to the server.
- The Excel export is built with exceljs in the page from JSON the server sends.

If item 4 is too slow even in one transaction, it becomes a Postgres function. If the whole approach
fails, stop and report to the owner before converting anything.

### Data: SQLite → Supabase Postgres

**Schema.** The schema in `src/db.js` becomes Postgres migrations, kept in the repo under
`supabase/migrations/`.

**Database helpers.** `src/db.js` stays the one place that talks to the database, but its helpers
(`all`, `get`, `run`, `tx`) become async over a Postgres connection. Every caller is converted to
`await`; there are about 960 call sites in `server.js` and `src/`. `tx()` keeps its meaning: all or
nothing, re-entrant, holding one connection for the whole transaction.

**SQLite-only SQL to rewrite** (about 50 spots):

| SQLite | Postgres replacement |
|---|---|
| custom `first_number()` | a Postgres function |
| `datetime()` / `strftime()` | Postgres date functions |
| `INSERT OR …` | Postgres equivalent (for example `ON CONFLICT`) |
| `lastInsertRowid` | `RETURNING id` |
| integer booleans | Postgres booleans |
| case-insensitive `LIKE` | `ILIKE` |

**One-off copy script.** It reads the real `factory.db` on the owner's home PC and writes every table
into Supabase, keeping the ids. It then checks that these match:

- row counts per table
- on-hand per item
- firm and soft reservations
- open PO quantities
- users

It prints a pass/fail report.

**Start-up work moves out of the request path.** Today the server runs seed, catalogue sync and tidy
when it boots. The cloud version does any needed one-time work in the migrations or the copy script,
and never on the first request.

### "Start again from the spreadsheet" and the tidy steps

- **The "start again" button is turned off in the cloud version.** It's a pre-go-live tool, and it
  would need a full backup plus all 756 lines of `src/tidy.js` ported to Postgres.
- **If the owner wants the latest 2026 Production Plan loaded on cut-over day,** it's imported the way
  it is today, on the home PC copy with SQLite and tidy. That result is then what the copy script
  sends up.
- **`src/tidy.js` is not ported.** Its effects come across in the data.

### Photos → Supabase Storage

Photos go in a **private** bucket. The Edge Function checks the login and streams the photo, so the
app's `/photos/...` links keep working. The browser keeps shrinking pictures before upload, as it does
today.

### Logins

**Keep the app's own login system** (`src/auth.js`: usernames, roles, scrypt, sessions, lock-outs).
Don't switch to Supabase Auth: staff have usernames, not emails, and the role rules are already built
and tested. The browser never talks to Supabase directly. Only the Edge Function holds the database
connection and the Storage key.

Cloud adjustments:

- **Cookie:** set Secure and SameSite=Lax. Name it `fs_session`; the per-port suffix is no longer
  needed.
- **Host check:** the allowed host is the pages.dev address. The pass-through sends the original host
  and client IP in headers that the Edge Function trusts only when they come with a shared secret
  header.
- **Login lock-outs** move from memory into a Postgres table, because Edge Function instances come and
  go.
- **Session pruning** moves from a `setInterval` to a step the nightly backup job runs.
- **First-time owner setup** isn't needed: the owner's existing login is copied across. The "setup
  from this PC only" path is turned off in the cloud.
- **Forgotten passwords:**
  - The owner resets anyone's password from the Logins page, as today.
  - For the owner's own password, the hand-over recommends a **second owner login** kept somewhere
    safe.
  - As a last resort, `scripts/users.js` is pointed at the cloud database. It needs the database
    password and is run from a PC by whoever helps the owner.

### Windows

- The office app gets its own web-app manifest and icons, as the floor app has, so Edge and Chrome
  offer "Install app".
- Install steps go in the hand-over notes.

### iPhone

- The floor app already has a manifest, `floor-sw.js` and Stallion icons, so it can be added to the
  home screen. Over https the service worker now works properly.
- The office app gets the same treatment, so the owner and office can add it on iPhone too.

### Android (owner)

A small **Expo app** in `mobile/` on the owner's Expo account. It is built with EAS as an Android APK,
the same way as Ausventure's dev build. It shows `https://stallion-stock.pages.dev` full screen in a
WebView, with:

- the Stallion icon and splash screen
- the login cookie kept between launches
- camera and file access for item photos and PDFs
- the back button working
- a "waiting for signal" screen when offline

Screens update without reinstalling. The same Expo app can be built for iPhone later if the owner pays
Apple.

### Backups

- **When and what:** nightly at 2am Melbourne time, a full database dump plus a copy of the Storage
  photos, keeping 30 days.
- **Where:** a **new private GitHub repository** (for example `stallion-factory-backups`), run by a
  scheduled GitHub Action. The connection details are kept as Actions secrets.
- **Same run:** the job prunes old sessions. Its database activity also stops Supabase from pausing the
  project over quiet weeks. If the factory shuts for longer, for example over Christmas, the
  hand-over says how to click "Restore" in Supabase.
- **Restore:** written down step by step and tested once on a scratch database.

### Accounts, and who does what

- **The owner signs in once on the home PC.** They create the Supabase project on their existing
  account, using the last free slot (the builder's call), and sign in to the Supabase CLI and to
  Cloudflare (`wrangler login`). GitHub (`gh`) and Expo (`eas`) are already signed in from earlier
  work.
- **The builder does everything else by command line**, except steps that need a dashboard click,
  which get click-by-click notes.
- **The copy script runs on the owner's home PC,** where the newest data is.

### Trial and cut-over

1. **Build on the live Supabase project while it's still empty,** then load a copy of the real data
   for the trial. Everyone is told that anything they enter during the trial is thrown away.
2. **The owner tries it** on their Android phone, one iPhone and one Windows PC, logging in as
   different roles.
3. **On the owner's chosen day:**
   - optionally re-import the latest production plan on the home PC
   - wipe the trial data and run the copy script
   - check the pass/fail report
   - send everyone the address
4. **Keep the home-PC copy and its data untouched** for at least a month as a fallback.

### Tests

- **Postgres:** the existing 52 tests must pass against Postgres, run on a throwaway local Postgres
  (for example PGlite), never against the live project.
- **Pass-through and cloud login:** these get their own tests.
- **Check before trial:** a full click-through as each role on the trial site.

## Left to the builder

- **Postgres client and pooling:** which client to use for Deno, and connection pooling through
  Supabase's pooler in transaction or session mode.
- **Converting the ~960 call sites:** how to do it mechanically and safely, with tests after each
  module.
- **Code layout:** how to keep the code runnable locally for development.
- **Expo WebView details.**
- **Naming:** names of buckets, settings, functions and repos.

## Calls made by Claude (not decided by the owner)

- Supabase goes on the owner's **existing** account (last free slot). The other option is a new free
  account.
- The "start again from spreadsheet" button is turned **off** in the cloud version.
- The trial runs on the live project and is wiped at cut-over.
- Backups go to a new **private** GitHub repo.
- The Android app is a WebView shell, not native screens, so all three platforms share one set of
  screens.
- The owner keeps a second owner login as a spare key.
