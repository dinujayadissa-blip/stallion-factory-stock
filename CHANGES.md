# Changes in factory-stock-v2 (to carry over to the office PC)

Each entry: what, why, files, and any data migration. The migrations run by themselves the first
time the new version starts; they are safe on the real database and safe to run twice.

---

## Online version (newest: Factory Stock moves to the internet)

This entry is first because it is the newest. Everything below it is the history of the home-PC version, which the
online version carries over.

### What changes for staff (plain words)

- **One address for everyone: https://stallion-stock.pages.dev.** It works from the factory, from home or on the road.
  No more `http://192.168...` addresses, and the office PC no longer has to stay switched on for the phones to work.
- **Install it like an app.** Android: the Stallion app (installed from a file). iPhone: Safari, Share, *Add to Home Screen*.
  Windows: Edge, the three dots, Apps, *Install this site as an app*. Steps are in `HANDOVER-CLOUD.md`.
- **You log in as before.** The same job roles and screens. Logins are not copied across (the old data had
  none): the owner makes the first owner login, then a spare owner login, then the staff logins on **Logins**.
  Staff stay logged in for 30 days on a phone.
- **Photos** are kept online in a private store. Taking a photo with the phone camera works as before.
- **Updates from the production plan spreadsheet are not in the online version.** The two panels in Settings
  (*Update from the production plan spreadsheet* and *Start again from the spreadsheet*) are hidden. Any plan update is
  done on the original version at the home PC.
- **A save that fails saves nothing.** If a sheet or form fails part-way (for example a stocktake sheet with one bad row),
  none of it is saved. The message says what is wrong; fix the row and send the sheet again. Before, the good rows were
  saved and only the bad row was skipped.
- **"The database is asleep or unreachable — try again in a minute"** can appear if the free database has gone to sleep or the
  internet is down. The owner can wake it from the Supabase website (`HANDOVER-CLOUD.md` step 5).
- **Stock figures were tidied once at the move.** The one-off stock clean-up (the same one as in the earlier entries
  below) was run on a copy of the real data before it went online. On the trial copy it locked 673 lines of received stock
  to their vans, among other changes. The office should glance over **Stock checks**, the **Clean-up report** and the
  **Dashboard** shortages after cut-over.
- **Backups are automatic.** Every night a copy of the database and photos goes to a private GitHub repository (30 nights
  kept). `docs/RESTORE.md` says how to get one back.

### What changed underneath

- The database is Postgres: on the PC (PGlite, in `data/pg`) when running locally, and at Supabase (Sydney) online. All the
  stock, purchasing, factory-floor, Excel and login code was converted to it, and one request is saved at a time (so two
  people can't clash).
- Online, the screens are on Cloudflare Pages and one Supabase Edge Function runs the app (`src/edge.js`,
  `supabase/functions/api`). A shared secret stops anything else calling the Edge Function directly. The Edge Function reads
  the visitor's address and the public host from the pass-through, so the log in lock-out and the change checks still
  work per person.
- Item photos are in a private Supabase Storage bucket (`item-photos`) online, in `data/photos` locally.
- `scripts/copy-to-cloud.js` moves a SQLite database and its photos up, running the old start-up clean-up on a temporary copy
  first, and checks every table and total before and after; it leaves the database unchanged if any check fails.
- `package.json`: `npm run seed`, `reset` and `demo` were removed (they only worked on the SQLite version). `npm run backup`
  still works on an old SQLite folder only.
- Not in the online version: the plan import (`src/importPlan.js`), the one-off clean-up code (`src/tidy.js`) and the starter
  catalogue (`src/seed.js`) are kept for the original version only.
- New files: `HANDOVER-CLOUD.md` (owner's guide), `docs/RESTORE.md`, `supabase/`, `functions/`, `mobile/`,
  `scripts/deploy-api.ps1`, `scripts/deploy-pages.ps1`, `scripts/build-pages.js`, `scripts/copy-to-cloud.js`,
  `scripts/restore-photos.mjs`. The nightly backup lives in its own private repository.

---

## Round 1, batch 1 — stock clean-up foundation (C1–C4)

### How the one-off clean-up works (src/tidy.js — new)

- `server.js` calls `runTidy()` once at start-up (after seed / catalogue sync / trades / layout).
- **Backup first:** if any clean-up step hasn't run yet, a full copy of `factory.db` is made in
  `data/backups/before-tidy-<yyyy-mm-dd_hhmmss>/factory.db` (same method as `scripts/backup.js`:
  `VACUUM INTO`, integrity check, row counts compared, then rename). If the backup fails, **no step
  runs** and the start-up log says why. Photos are not copied (the clean-up never touches them).
- Each step runs once (settings flag `tidy_<step>_v1`), inside one transaction, and only touches rows
  that still need it. Every change is written to the new `allocation_log` table with reason
  `tidy:<step>` and before → after.
- Step order (locks first, so later steps respect them):
  1. `tidy_lock_v1` 2. `tidy_plan_qty_v1` 3. `tidy_merge_dupes_v1` 4. `tidy_placeholder_v1` 5. `tidy_relink_v1`.
  Later batches add: line states (C5), kinds & suppliers (C9), PO spec / PO tidy (C7, C8) to `STEPS`
  in that order.
- New page **Clean-up report** (office menu, `#/cleanup`): per step the number of changes, every
  changed van / part / line with before → after, anything flagged "please check", the backup folder,
  and a **Checked** button (stores who/when in setting `tidy_report_checked`). The go-live checklist
  (C10, later batch) should link to it as step (a).
- Tested on a copy of the live data: second run with the flags cleared changes nothing (same totals,
  same movement count). Every item's shelf figure still equals the sum of its movements.

### New columns / tables (src/db.js, `addColumn` style)

| Where | Column | Why |
|---|---|---|
| `van_lines` | `reserved_firm REAL DEFAULT 0` | part of "set aside" that was received for this van (locked) |
| `van_lines` | `urgent INTEGER DEFAULT 0` | its part was borrowed by another van on the floor → "Order now" |
| `vans` | `build_order INTEGER` (nullable) | office build sequence |
| `items` | `last_counted TEXT DEFAULT ''` | set only by a real count (type `count`); not back-filled |
| `items` | `placeholder INTEGER DEFAULT 0` | "(as per plan)" catch-all item |
| new table | `allocation_log` | every set-aside change + every clean-up change (before → after, who, why) |
| new table | `count_sessions` | blind rack counts: expected figures recorded when the count is opened |
| new trigger | `trg_firm_cap` | `reserved_firm` can never exceed `reserved` or go below 0, whatever code changes it |

### C1 — Locked stock, build order, two-step re-prioritise, floor borrow

- **Migration `tidy_lock_v1`:** per van + item, received for the van = all `receive` movements booked
  for that van (plan-import grey cells, PO deliveries for the van, deliveries booked for it).
  Locked = min(set aside, received − fitted), spread over the van's lines in line order; only lines
  with `reserved_firm = 0`. Anything above the received amount stays flexible.
  On the test copy: 673 lines locked; all 1,057.5 set aside was received for its van.
- **Build order** (`PRIORITY` in src/inventory.js, also `vanRanks()`): 1) in production in a bay, by
  bay order; 2) other vans in production; 3) vans with a build order number; 4) planned vans by due
  date — a planned van whose date has passed counts as "no date"; 5) no date, oldest first.
  Used by allocation, shortages, van lists, floor lists, the floor "delivery went to" list, trimming
  and borrowing. ST0388 (planned, Feb 2026) now sorts after every dated van.
- **Firm stock:** receiving for a van (PO line for the van, item/floor delivery for a van, plan cell
  "Mark received") adds to `reserved_firm`. Re-prioritise and trimming after a count only move the
  flexible part (`reserved − reserved_firm`); per-van items are never moved to another van.
- **Re-prioritise is two steps:** `GET /api/allocate/reprioritise/preview` (runs it in a transaction
  and rolls back) shows per van what it gains / loses; the Vans page button opens that list with
  "Only free shelf stock moves"; `POST /api/allocate/reprioritise` runs only after Confirm and logs
  every line change (reason `reprioritise`). On the test copy the preview is empty: ST0393 and
  ST0377 keep everything received for them.
- **Floor borrow** (`takeForVan`): free stock first, then flexible set-aside of vans built later,
  then — only after the worker accepts "This is ST0390's – it will be re-ordered for them" — locked
  or bought-for-van stock of another van. Never refused because a part is locked. The donor line
  loses reserved/reserved_firm, gets `urgent = 1`, the issue movement note says
  "borrowed from ST0390 by <worker>", allocation_log reason `borrow`. The worker can also answer
  "No — it's a new delivery for this van" (old count-correction path). Undo puts back the donor's
  set-aside, lock and urgent flag. The floor shows "Taken from ST0390's set-aside".
  API: `/api/floor/take` and `/api/floor/extra` accept `accept_borrow`; without it they answer 409
  with `confirm: {borrow, from, qty, message}`.
- **Screens:** Vans, Dashboard, Production plan (and Van details) show **Due date missing** (blank
  date) and **Date passed – check** (planned van, date before today). Vans page has a **Build order**
  number box per van (saved on change) and lists vans in build order. Van page shows
  "N kept for this van" (locked) and **Order now** on borrowed lines; Purchasing shows "Order now".
- Files: src/db.js, src/inventory.js, src/tidy.js, server.js, public/app.js, public/stockcheck.js (new),
  public/floor.js, public/floor.css, public/styles.css, public/index.html.

### C2 — Plan quantities, duplicate merge

- **Parser (src/planMap.js):** new `leadInfo()` (and `lead()` uses it): a leading count is taken from
  `N x`, `Nx`, `N /` + description, or a small bare count followed by a word ("1 Coast Order 146");
  `N / SUPPLIER` and `N / SUPPLIER / NNN` (e.g. "25 / NCE / 111") are order numbers, not counts;
  trailing numbers are never taken. Text with "need to order N" and no count in front uses N and is
  flagged. Metre items (vinyl): `metresInfo()` takes a number followed by m / mtr then a space or the
  end ("7.6m"); anything over 15 m ("634M", "990m") is skipped and flagged. `capFor()`: vinyl 15 m,
  roof baw 4, any `ea` item 10 unless the item normally uses more.
- **Import (src/importPlan.js):** each part carries a `check` reason; the import preview (Settings →
  Check file) lists "N quantities to check"; imported lines get the note "Please check quantity: …".
  Grey (received) cells now also set `reserved_firm`.
- **Migration `tidy_plan_qty_v1`:** for `source='plan'` lines with nothing fitted, the plan text is
  re-parsed; a line changes only when the new qty differs AND the stored qty breaks the cap or is more
  than 3× the item's usual (median) qty. Set aside / locked are cut to the new qty; the shelf figure
  is lowered by the freed amount, capped at what the import booked for that line and at the current
  shelf figure (never below 0), with an `adjust` movement "Plan quantity corrected (was 634)". If the
  item was counted or corrected after the import, the shelf figure is **not** changed and the report
  says "quantity fixed, shelf figure not changed – please check". Line note "Plan quantity corrected
  (was N)". Test copy result: ST0367 vinyl 634 → 7.6 (floor vinyl on hand 707.9 → 81.5 m: equals
  what is set aside for the 11 vans that have it; the "about 74" estimate didn't keep ST0367's own
  7.6 m), Roof Baw 25 → 1 on ST0389, ST0394 and LG024 (LG024's 24 extra came off the shelf: 29 → 5).
- **ST0367 grab handles:** "5 / Black / Nikpol 09 - Ordered 2 and need to order 2" keeps 5 (the
  leading count; every van uses 5) and shows **Please check quantity** instead of silently dropping
  to 2 — dropping it could under-order. One click on "Quantity is right" clears it.
- **Migration `tidy_merge_dupes_v1`:** lines with the same van, item, plan column and text merge into
  the lowest id (qty, set aside, locked, fitted added; notes and PO refs joined; allocation_log
  re-pointed; note "merged from line N"). None on the test copy.
- **Screens:** Van page shows a yellow **Please check quantity** tag (above 3× usual, above the cap,
  or unclear plan text) with **Quantity is right** (adds `qty-ok` to the note,
  `POST /api/van-lines/:id/qty-ok`). Van page and floor screen show **for: <plan column>** under the
  part name (ST0367's two service doors: "for: Service Door for entertainment box / Toilet" and
  "for: SERVISE DOORS TUNNEL BOOT").

### C3 — Already fitted, counts, bought-for-van check

- **Already fitted** (`inventory.markFitted`, `POST /api/vans/:id/fitted`): dialog on the Van page and
  the factory-floor van panel, parts grouped by trade with "Tick all fitted". Each ticked line is
  closed (issued = qty). Only what was set aside comes off the shelf figure (one `issue` movement per
  item, "Already fitted (set up before go-live)", with the person's name); lines never set aside close
  with no movement and a log entry "fitted before go-live, not from stock".
- **Count movement type:** counts are now type `count` (corrections stay `adjust`). Count / adjust →
  "Set on-hand to counted quantity" and the bulk stocktake write `count` and set `last_counted`.
  "Set shelf stock to zero" stays an `adjust`. `last_counted` is not back-filled.
- **Count a rack** (Stock page): pick a rack/area, "No rack yet" or a trade (each item has one place;
  per-van and "as per plan" items are not in rack counts). Blind: the expected figure is stored when the
  count is opened and not shown. "Check counts" shows system / counted / difference; differences over
  10% or 5 need a recount or a reason; stock that moved since the count opened is listed and must be
  acknowledged. Adjustment = count − figure when opened. Counted below what is locked for vans → "Are
  ST0389's 3 kept somewhere else?": **Yes, elsewhere** (books = shelf count + kept elsewhere, locks
  kept) or **No, they are missing** (set-aside cut from the vans built last, lines go back to short,
  logged). APIs: `/api/counts/choices`, `POST /api/counts`, `/api/counts/:id/check`, `/api/counts/:id/save`.
  Note: no items have a rack set yet in the current data, so today counts are by trade or "No rack yet".
  No unit-cost column exists, so the "any difference on costed items" rule is not used.
- **Check bought-for-van parts** (Stock page): per van, "Is ST0389's fridge here?" Yes / No / Already
  fitted. No = off the shelf figure (`count` movement) and back to short; Already fitted = markFitted.
  APIs: `GET /api/bought-for-van`, `POST /api/van-lines/:id/check`.
- Stock page shows **Not counted yet**; Dashboard and Purchasing show "not counted – check shelf first"
  next to the suggested quantity of shelf items never counted; item window shows "Last counted".

### C4 — "(as per plan)" catch-alls

- **Migration `tidy_placeholder_v1`:** `placeholder = 1` for `PLAN-%` / category "As per plan"
  (56 items) and display-name spelling fixes (Servise → Service, Seperating Bunk Aeria → Separating
  bunk area, Barthroom → Bathroom, tpilet → toilet). `plan_column` keeps the original header, so the
  Excel export is unchanged.
- **Migration `tidy_relink_v1`** (reviewed table in src/relink.js — new): first creates missing items
  OVEN-SWIFT-FULL, GRILL-SWIFT-MINI, ANT-VINGUARD, ANT-MILENCO, TOILET-LOOSEAL, TOILET-OGO,
  AC-BELAIR-3400, SINK-RAZOR-BLK-DRAIN, LIGHT-DOWN-BLK, LIGHT-DOWN-WHT (trade from the same plan
  column). Then, for lines on vans still to build, `linkLine()`: if the van already has a line for the
  real part, merge only when clearly the same need (its qty ≥ plan qty and text blank / same), else
  leave it "to confirm" marked "possible duplicate of line N"; otherwise the line moves to the real
  part (note "was PLAN-X"). Only the stock set aside on the line moves (two `adjust` movements
  "Re-linked from PLAN-X"); fitted (issued) amounts are not moved. Open PO lines for that van move too.
  Table entries beyond the brief: Looseal / OGO toilets, Belair 3400, Vinguard / Milenco antennas,
  Swift full oven, mini grill, black Razor sink, white / black down lights (the new items' matches).
  "Hawk full oven" is **not** mapped to the Swift oven (different brand — left to confirm).
  Test copy: 55 lines re-linked (14 of them carried set-aside stock across), no second battery /
  jack line created.
- **Future imports** use the same table and duplicate check (src/importPlan.js); new catch-all items
  are created with `placeholder = 1` and fixed names.
- **Screens:** catch-alls are left out of the Stock list (filter "As per plan catch-alls" shows them),
  out of Dashboard counts and the main to-order list. **Special parts to confirm** — Stock tab (grouped
  by van, build order) and a section at the top of each Van page — with **Link to a real part**
  (search, or "create new part from this text"; `POST /api/van-lines/:id/link`). Purchasing has
  "Special parts still to order — by van". Stock tab **Many different specs**: items with 5+
  different descriptions on vans still to build (order numbers ignored). Search covers name, SKU,
  plan column, supplier, category, location and synonyms (aircon / air conditioner, oven / cooker /
  grill, toilet / loo, sink / basin, antenna / aerial): "aircon" finds the Dometic and Belair units.

### Other API / behaviour notes

- Error replies may now include `confirm` (needs a yes first) and `problems` (all reasons a save was refused).
- `GET /api/placeholders?van=&short=1`, `GET /api/items/many-specs`, `GET /api/tidy/report`, `POST /api/tidy/checked`.
- Office actions that are logged (fitted, counts, bought-for-van checks) ask for "Your name" once; it is
  remembered on that PC (browser storage).

---

## Round 1, batch 2 — purchasing clean-up (C5–C8)

New clean-up steps (same rules as batch 1: backup first, each once, one transaction each, every change in
`allocation_log`, shown on the Clean-up report). Order in `STEPS` (src/tidy.js): … relink → **state** →
(C9 kinds & suppliers goes here, batch 3) → **po_spec** → **po**. Flags: `tidy_state_v1`, `tidy_po_spec_v1`,
`tidy_po_v1`. Tested on a fresh copy of the v2 data: 8 / 161 / 26 changes; run a second time (flags cleared)
they change nothing the office has answered (one harmless fill of a blank "ordered" date on POs made
since). Every item's shelf figure still equals the sum of its movements; nothing set aside was lost.

### New columns / tables (src/db.js, `addColumn` style)

| Where | Column | Why |
|---|---|---|
| `van_lines` | `state TEXT DEFAULT ''` | '' / `customer` / `tbd` / `not_ordered` (C5) |
| `po_lines` | `spec TEXT DEFAULT ''` | colour / size / model ordered (C7) |
| `po_lines` | `expected TEXT DEFAULT ''` | backorder date for what is still to come (C8) |
| `po_lines` | `closed REAL DEFAULT 0` | balance the supplier cancelled (C8). Open qty = qty − received − closed |
| `purchase_orders` | `ordered_at`, `expected` TEXT, `needs_check` INTEGER | PO dates, "POs to check" (C8) |
| new table | `suppliers(name PK, lead_days 14, lead_confirmed 0)` | lead time per supplier; filled at start-up from items + POs (`INSERT OR IGNORE`, `syncSuppliers()` in db.js) |
| indexes | `po_lines(van_id,item_id)`, `van_lines(van_id,item_id)`, `movements(item_id,at)` (`movements(van_id)` already there) | faster purchasing queries |
| settings | `build_weeks` (default 3), `short_weeks` (default 4) | read with defaults, nothing written until changed |

New file **src/lineState.js**: the state words, detection (`detectState`), the shared SQL for "open PO
quantity", "unanswered check" and "counts as short", local dates, and `specForPo()` (plan text without its
order number, e.g. "Double Order 108 Ranger" → "Double Ranger"; a bare "Yes" is dropped).

### C5 — one status per line: check order number / customer supplies / to be decided

- **Migration `tidy_state_v1`:** lines with state '' and nothing fitted (and nobody has set/cleared a state
  on them before): `customer` when the text matches `customer s(u|y)p+ly | supplied by customer | cust supply`,
  `tbd` when it matches `TBA | ?? | .... | do we supply`. Only the flexible part (reserved − reserved_firm)
  is released to free stock (logged, then handed to the next van waiting); locked stock stays and the line is
  listed under "Please check" as "Stock received but marked customer supplies / to be decided – check".
  Test copy: 3 customer + 5 to be decided; 1 (ST0367's basin, 1 locked) on the check list; nothing released.
- Same detection in the plan import (`importPlan.js`, not on fitted cells) and the dealer-order rules
  (`applyRules`; never overrides a status someone set).
- **Allocation never sets stock aside for customer / to-be-decided lines** (`allocateItem`, also re-prioritise).
- **"Check: already ordered?"** is display only: a line is unanswered when `po_ref` is not blank, state '',
  it is short and there is no open PO line for that van + part. **Counting rule:** only unanswered,
  `customer` and `tbd` lines are left out of short / to-order / "waiting on parts" (`ITEM_STOCK_SQL`,
  `listVans.waiting_count`, `shortages()`); `not_ordered` lines are normal shortages.
  Test copy: 387 lines / 106 order numbers waiting for an answer.
- **Purchasing → "Check: already ordered?"** (above the to-order list), one row per order number:
  **Yes, on order** (`POST /api/check-ordered {po_ref, answer:'yes', line_ids, supplier, by}`) joins or
  creates the open PO with that number for each part's supplier (asks for a supplier if a part has none)
  and adds PO lines with van, spec and the short qty; **No, still to order** sets `not_ordered` and the lines
  appear in the order list straight away. Untick lines that differ. Logged (`check ordered`).
- **Van page:** one plain status per line instead of the order-number badge: Not ordered / Check: plan says
  'Order 262' / Ordered – PO 128, supplier, "Arrives 3/11" or red "Late for due date" / In stock for this
  van / Fitted / Customer supplies / To be decided. A drop-down per line sets / clears Customer supplies /
  To be decided (`POST /api/van-lines/:id/state {state, stock, by}`); if stock was received for the van it
  asks "Keep for the van / Put on the shelf". Tiles for "Check: already ordered?" and "Waiting on a decision";
  a "Waiting on a decision" panel by trade. Dashboard has the same panel (`GET /api/decisions?van=`).
- Floor screen: those lines show "Customer supplies" / "To be decided – ask the office", never "On shelf"
  unless something is kept for the van; factory-floor van panel no longer lists them as missing.

### C6 — Order now / Coming up / Later, netted against what's coming

- `shortages()` (src/inventory.js) now returns `{today, settings, rows, counts, noSupplier, suppliers}`:
  one row per short van line (or a shelf top-up row), with `needed_by` (today for vans in production and
  borrowed/urgent lines, else due date − build weeks; planned van with a passed date = no date),
  `order_by` = needed_by − supplier lead days, `group` now / soon / later / nodate.
- **Netting per item in build order:** own set-aside → open PO qty for that van → free shelf stock (shelf
  items only; spare per-van parts are never handed on) → open shelf PO qty. Top-up to `order_up_to` (if
  that column exists — batch 3) or the reorder level from what is still free + coming. One aggregated
  query for open PO quantities replaces the correlated sub-queries (`ITEM_STOCK_SQL` too).
- **Purchasing page** (new public/purchasing.js, loaded from index.html; the old purchasing code left
  app.js): Order now (ticked) / Coming up / Later (closed, unticked) / No date – check, each by supplier,
  rows by order-by date with spec, van, needed by, "already on order: N". Filters: supplier, trade, van,
  window 2/4/8 weeks; "Build takes N weeks" box. Supplier headers: lead days edit box
  (`PUT /api/suppliers`), "lead time not set (14 days assumed)" until set. Parts with no supplier are one
  link "X parts have no supplier – fix" (opens Stock with the new "No supplier set" filter; batch 3's Fix
  the catalogue page can take this over). "free 0 · reorder at 0" only shows when a reorder level is set.
- Dashboard: "Parts to order now" tile (= nav badge), "Check: already ordered?" tile, "Order now" list,
  "Overdue deliveries", "Waiting on a decision". "Vans waiting on parts" ignores lines waiting on an answer.
- Test copy: Order now 403 lines (8 vans in production + 4 planned vans due within a few weeks),
  Coming up 266, Later 64, No date 137 (LG024, ST0388). Feb 2027 vans are Later, not ticked.

### C7 — spec on purchase orders

- **Migration `tidy_po_spec_v1`:** PO lines for a van with a blank spec get that van's line spec for the
  same part (first one), without the order number. Only blanks are filled. Test copy: 161.
- Spec copied from the to-order list, from "Yes, on order", from the plan import and from the plan grid's
  "ordered". New POs combine lines only when part, van and spec all match (shelf stock: part + spec).
- Shown on to-order rows ("Kitchen sink white, no drainer – White No drainer / Razor"), the PO page, the
  PO print, and the Excel export (To Order sheet rebuilt with When / Order by / Description / Needed by /
  Lead days; new **Open POs** sheet with a Description column).

### C8 — tidy imported POs, dates, part / short / over deliveries

- **Migration `tidy_po_v1`:** `ordered_at` = created date where blank; "From plan" →
  "Plan – <supplier or no supplier> (no number)" (old name kept in notes); `needs_check = 1` for no real
  number, no supplier, or the same number twice **for the same supplier or where one has no supplier**
  (the plan's order numbers run per supplier — "White Vision 11", "Onex 08" — so 11 for two suppliers is
  normal). Test copy: 16 POs to check (9 "Plan – …", 7 with no supplier incl. the "156" pair).
  Future plan imports name / flag their POs the same way.
- **Purchasing → "POs to check"** (folded, opens on click): set PO number, supplier, ordered and expected
  dates inline (Save — old number/supplier kept in notes), **Looks right**, **Merge into PO…**
  (`POST /api/pos/:id/merge {into}` moves lines, closes the empty one, notes on both), **Close**.
- **Closing a PO** writes the not-delivered balance into `po_lines.closed` (logged); Re-open clears it.
- New POs (`createPO`) ask first (409 `confirm.warnings`) when the number is already used for that supplier
  / a PO with no supplier, or the supplier is blank. PO list and PO page show the vans it is for, ordered
  and expected dates; "to check" chip.
- Van lines on order show "Arrives d/m" or red "Late for due date" (expected after needed-by).
  **Overdue deliveries** (open lines with an expected date before today) on Dashboard and Purchasing
  (`GET /api/pos/overdue`).
- **Receive dialog** (`POST /api/pos/:id/receive {lines:[{id,qty}], backorder:{lineId:date}, close_balance:[lineId], by}`):
  "Received by" name (→ `movements.worker`); a **Total arrived** box per part fills its van rows in build
  order. Received for a van = locked (as before). Short: the rest stays on order with its own date, or tick
  "supplier cancelled" → `closed` = balance, logged, and the van line goes back on the to-order list (a line
  with a plan order number becomes `not_ordered` so it doesn't drop into "check"). Over delivery: the extra
  is a separate receive with no van ("X more than ordered – put on the shelf"), free stock. Van line now
  customer / to be decided / fitted: that part goes on the shelf with a warning instead of being locked.
  Warnings are shown after saving.
- Everywhere an "open" PO line is tested now uses qty − received − closed (floor delivery booking, floor
  take, plan grid, plan "ordered/received", factory-floor van panel, Excel).

### Files

src/db.js, src/lineState.js (new), src/inventory.js, src/tidy.js, src/importPlan.js, src/exportXlsx.js,
src/layout.js, server.js, public/purchasing.js (new), public/app.js, public/stockcheck.js, public/floor.js,
public/styles.css, public/index.html.

New / changed API: `GET /api/shortages` (new shape), `GET/PUT /api/suppliers`, `PUT /api/purchasing/settings`,
`GET/POST /api/check-ordered`, `POST /api/van-lines/:id/state`, `GET /api/decisions`, `GET /api/pos/to-check`,
`GET /api/pos/overdue`, `POST /api/pos/:id/merge`, `PUT /api/pos/:id` (po_no, supplier, ordered_at, expected,
notes, checked, status), `POST /api/pos` (spec per line, ordered_at, expected, confirm),
`POST /api/pos/:id/receive` (backorder, close_balance, by). `/api/summary` adds counts.toCheck,
comingUp, posToCheck, decisions, overdue; `toOrder` is now Order-now rows.

### Note for whoever carries this over

While testing, a one-line check of a module (`node -e "import('./src/inventory.js')"`) was run without
`DATA_DIR`, so it opened `factory-stock-v2\data\factory.db` and ran the **schema** part of `src/db.js` on it:
the batch 1 + batch 2 columns/tables/indexes/trigger were added and the new `suppliers` table got its 48
rows. No existing data was changed (all vans, lines, POs, items, movements, settings compared equal with a
copy taken before) and none of the clean-up steps ran. The same additions happen anyway the first time
the new version starts on that data. Always set `DATA_DIR` before running anything that imports `src/`.

---

## Round 1, batch 3 — catalogue, honest numbers, history, safe re-import (C9–C12)

Two new clean-up steps (same rules as before: backup first, each once, one transaction each, every change in
`allocation_log`, shown on the Clean-up report). Order in `STEPS` (src/tidy.js): … state → **kind** → **supplier** →
po_spec → po. Flags: `tidy_kind_v1`, `tidy_supplier_v1`. Tested on a fresh copy of the v2 data: 25 / 0 changes.
Run a second time with **every** flag cleared: 0 changes in all ten steps. After every test (migrations, plan
update, start again, counts, floor borrow, assign / spare) every item's shelf figure still equals the sum of its
movements, and no line has more set aside than it needs or more locked than set aside.

### New columns / tables (src/db.js, `addColumn` style)

| Where | Column | Why |
|---|---|---|
| `items` | `unit_size TEXT DEFAULT ''` | what one unit is ("1 length = 6.5 m", "set = 1 van"), shown next to every quantity on the floor |
| `items` | `order_up_to REAL DEFAULT 0` | shelf top-up target (0 = the reorder level) — already read by `shortages()` since batch 2 |
| `allocation_log` | `change REAL`, `firm_change REAL` | exact change of set aside / kept-for-van on that line (NULL on rows written before this version) |
| `allocation_log` | `ack INTEGER DEFAULT 0` | ticked on the weekly Stock checks page |
| `movements` | `ack INTEGER DEFAULT 0` | same, for corrections / count differences / over deliveries |
| indexes | `allocation_log(item_id)`, `allocation_log(at)`, `movements(type, at)` | history and Stock checks |
| settings | `plan_conflicts`, `plan_conflicts_kept`, `last_plan_import`, `plan_import_history` | plan update (C12) |

Note: the brief's `allocation_log(id, at, item_id, van_id, line_id, change, firm_change, reason, worker, ack)` already
existed from batch 1 with `field / before / after / note`; the three missing columns were added to it rather than
making a second table. `logAlloc()` (src/db.js) fills `change` / `firm_change` itself for set-aside fields, or takes them.

### C9 — shelf vs bought-for-van, suppliers, racks, unit sizes

- **Migration `tidy_kind_v1`** (reviewed list in src/tidy.js `KIND_TO_PER_VAN` / `KIND_TO_SHELF`): to *bought for one
  van*: FRIDGE-BUSH-225, FRIDGE-DOM-190, FRIDGE-DOM-220, AC-FRESHJET, AC-FRESHJET-PRO, AC-BELAIR-3400, HEATER-DIESEL,
  WM-AT-3KG, WM-AT-TOP, WM-NCE-COMBO, MW-CAMEC-28, MW-NCE-23, HAWK-COMBI, TOILET-C263, TOILET-PLASTIC, TOILET-LOOSEAL,
  TOILET-OGO, HWS-REFLEX, HWS-SWIFT, AWNING-AT, DOOR-TRILOCK, WINDOW-SET, TV-24, TV-32, SHOWER-CS11R, SHOWER-CS13F
  (+ any later FRIDGE- / AC- / HEATER- / WM- / MW- / TOILET- / HWS- code). To *shelf*: LIGHT-DOWN-BLK/WHT, SWITCH-BLACK/
  WHITE/SPHERE, JACK-KO, JACK-BLACKJACK, TABLE-LEG, TOOLBOX-GOLD, TOOLBOX-PROLINE.
  **Deliberately not changed:** `AC-CHG-120` / `AC-CHG-30` are Victron AC *chargers*, not aircons; the concertina
  door (sizes vary but it is a stock item) and TV bracket stay shelf stock. Only items whose kind is still the old value
  change; the item's notes get "kind was stock (changed 2026-10-13)". Set-aside stock stays with its van (per-van parts
  are never moved by re-prioritise / borrowing step 1).
  Test copy: 25 changed (24 to per-van, TOOLBOX-PROLINE to shelf); every fridge / aircon on the shelf was already set
  aside for a van, so no orphans on this data.
- **Orphans:** stock of a per-van part not set aside for any van (on hand − set aside) is flagged in the Clean-up report
  (and open *shelf* POs for it), and listed under **Stock → Bought for vans → "Bought-for-van stock with no van – assign to
  a van"** and in go-live step (c). Each row: **Assign to van** (vans with an open line for it, build order; sets aside
  *and locks* the qty, logged `assign to van`; `POST /api/items/:id/assign {van_id, qty}`) or **Keep on shelf as spare**
  (logged `spare` with the qty seen; more arriving with no van brings it back; `POST /api/items/:id/spare`). They stay on
  the Bought-for-vans list with an **Unassigned** tag either way. `GET /api/items/unassigned[?all=1]`.
- **Migration `tidy_supplier_v1`:** blank supplier ← most common supplier on that item's PO lines (notes say so). On this
  data 0 (the imported POs got their supplier from the item, so blank items had blank POs); it matters for the real data
  if POs were typed with suppliers later. **Suggestions only** (nothing saved without a click): the reviewed words
  E time / Battery Stop / Capral / Nikpol / Urban Republic, any existing supplier name (4+ letters, not a colour word like
  "Gold") found in the part's name or plan text, and for shelf parts only "same supplier as" sister parts (same code
  start + category, all agreeing). Brand parts don't get sister suggestions (an OGO toilet isn't from Thetford).
- **Stock page:** tabs **Shelf stock** / **Bought for vans** / **Fix the catalogue** / Special parts / Many specs;
  new **Location** (rack · shelf/bin, "no rack yet") and **Last counted** columns; filter "No rack yet"; "Below reorder
  level" only lists parts with a level. Banner when bought-for-van stock has no van.
- **Fix the catalogue:** tiles (no supplier 58, no rack 159, no unit size 45, no reorder level 159 on the test copy) that
  filter; each line editable in place (supplier with a list, rack + shelf/bin, unit + "what one unit is", reorder level +
  order up to) with "Use 'Swift'?" / "Apply 2" suggestions and Save per line (missing chips update without redrawing);
  bulk **Put on rack** (filter by trade / category, tick, pick a rack; `POST /api/items/rack`). `GET /api/catalogue`.
  Item edits of kind / supplier / rack / reorder level / order up to / unit / unit size are logged (`catalogue`).
- **Floor screen:** every quantity shows the unit and unit size ("Need 2 length (1 length = 6.5 m)"), "On shelf ·
  Rack B · Shelf 3", the take sheet shows "📍 Rack B", receive / extra sheets show the unit.

### C10 — honest numbers, reorder suggestions, go-live checklist

- **Short / waiting on parts** count only vans in production or due within `short_weeks` (planned vans whose date passed
  are on "dates to check"), and never "as per plan" lines, customer / to-be-decided or unanswered "check: already
  ordered?" lines (`nearVanSql()`, item `short`, `listVans.waiting_count` + `near`).
- **Low** (`withAvailable`): shelf part, reorder level > 0, free + open *shelf* PO qty < level. No van shortfall mixed in.
  Hidden for parts nobody has counted while the first full count isn't done.
- **Reorder suggestion** (`reorderSuggestions()`, never applied by itself): part on van lines → about one van's use
  (median qty per van, rounded up for whole units); floor consumable not on van lines → average use per week from
  `issue` movements (needs 4 weeks of history, up to 12 weeks looked at) × (supplier lead days / 7 + 1 week).
  Shown with **Apply** in the Item window and Fix the catalogue.
- **Dashboard:** the old tiles are replaced by one **Needs action this month** number with links: Order now, Check
  already ordered (order numbers on vans due soon, all in brackets), POs to check, overdue deliveries, dates to check,
  decisions waiting, quantities to check (opens a list), received-but-customer/tbd, plan changes to check. "Waiting on
  parts" lists each van due soon with the names of the missing parts. Test copy: 174 = 103 + 46 + 16 + 0 + 3 + 4 + 1 + 1.
- **Go-live checklist** (Dashboard, `src/golive.js`, read-only): (a) clean-up steps done + report checked; (b) dates to
  check; (c) "Already fitted" checked for each van in a bay (buttons per van; the dialog has a new **Nothing (else) is
  fitted — done** button; both buttons log `fitted: checked`) + bought-for-van stock with no van; (d) check already
  ordered answered; (e) first full count — every rack plus "No rack yet" (chips per place, Count a rack…); (f) reorder
  levels for every shelf part that has a suggestion (greyed until (e) is done).
  Until (e) is done "Free" is grey with "not counted yet" on the Stock page and in the Item window.

### C11 — set-aside history and weekly Stock checks

- Now logged (allocation_log): `allocateItem` (with exact change / locked change), `trimReservations`, re-prioritise,
  floor takes (`floor take`: "taken on floor by Sam: 1 (borrowed from ST0383)", with the line's set-aside change) and
  undo (`floor take undone`), borrows (donor line, as before), `van finished` (useUpVan and cancel / releaseVan),
  `fitted`, receipts (`receive`, `receive: over`, `receive: short`, `po: balance closed`), counts (`count`), catalogue
  edits, assign / spare, plan update / import, and every clean-up step.
- **Why?** link on every Van-page line (`GET /api/van-lines/:id/log`): needed / set aside / kept / fitted now, then every
  log entry, borrows *for* this line from other vans, and the shelf movements of that part for that van, oldest first.
- **Item window → Set-aside history** (last 200 entries for the part).
- **Stock checks** page (menu, badge = rows not ticked): Borrowed between vans (from, to, who, and "re-ordered (N on
  order)" / "covered again" / red "Not re-ordered yet – Order now"), floor and office corrections (`adjust` movements,
  not the clean-up's), count differences (`count` movements ≠ 0), over deliveries, bought-for-van answers; each with a
  Seen tick (`POST /api/stock-checks/ack {kind:'m'|'a', id, ack}`); shows everything not ticked plus what was ticked in the
  last 7 days; **Count these next** (racks never counted first, then oldest count) with Count… buttons.
  Note: on the real data, older office corrections (e.g. "Stocktake" −2 on the white sink) show once until ticked.

### C12 — safe production plan re-import

- **Settings → Update from the production plan spreadsheet** (the default): "Check what will change" →
  `POST /api/import/plan/update/preview` (read-only) shows counts and lists — new vans, new lines, date / status
  changes, lines with new text (nothing set aside), deliveries to book (grey), parts to close as fitted (blue),
  "Plan changed after parts were set aside" conflicts, "Not in latest plan" vans / lines. **Confirm** →
  `POST /api/import/plan/update?by=` (one transaction).
  - New vans and lines use the same parser (C2), re-link table and duplicate check (C4) and state detection (C5) as the
    import (shared code: `vanEntries`, `insertLine`, `insertPlanVan` in src/importPlan.js).
  - Lines are matched per van and plan column (same part first, incl. "was PLAN-…" re-linked lines). A cell whose text
    is the same as last time never re-adds a line that was merged / removed on purpose. Vans that came from a dealer
    order (no plan lines) only get their date / status updated.
  - Text / qty / part change only on lines with nothing set aside or fitted; otherwise a conflict ("was Black, now White
    – check") kept in setting `plan_conflicts`, answered on Settings (and linked from the Dashboard) with **Use new** /
    **Keep current** (`GET /api/plan-conflicts`, `POST /api/plan-conflicts/:lineId {use}`). Use new with a different
    part releases the old part's set-aside to the shelf (a per-van part then shows as unassigned); refused if part of
    the line is already fitted. Keep current is remembered for that exact new text.
  - **Receipts:** grey cell → only up to min(line qty, cell qty) − (set aside + fitted) − what was already received for
    that van and part but has since gone (borrowed away, found missing at a count). So the same delivery is never booked
    twice — the untouched real plan against the test copy gives 0 receipts. Open PO lines for the van are ticked off
    first (`receiveForLine()` in src/inventory.js). Blue cell → closed like Already fitted (`markFitted`).
  - Dates follow the sheet when it has one; statuses only move forward (or to cancelled), never back.
  - Missing vans / lines: note "Not in latest plan – check", never deleted. Movements and POs are never deleted.
  - The app's own Excel export re-imports as "nothing to update".
- **Start again from the spreadsheet** (red panel): shows what will be lost, needs RESET typed (`?confirm=RESET`),
  runs `scripts/backup.js` first (to `BACKUP_DIR`, else `<parent of data folder>\Factory Stock backups (before start
  again)`; if the backup fails nothing happens), then the old full replace (`applyPlan`, now also clearing
  `last_counted` because the stock figures restart), then **all clean-up steps run again** (`rerunTidy()`; on the test
  copy they changed nothing because the import already does their work).
- Every import is recorded: settings `last_plan_import` {at, file, mode, by, counts}, `plan_import_history` (last 30,
  shown under "Last imports"), and an allocation_log row `plan import`.
- Test (copy of the real plan with ST0390's date changed, table-leg text changed, stereo text changed (set aside),
  fans cell grey, aircon cell blue, decals cell cleared, a new van ST0999, ST0394 removed): exactly 1 date, 1 text
  update, 1 conflict, 1 receipt (5 fans), 1 fitted, 1 removed line, 1 removed van, 1 new van (132 cells); applying it
  again: nothing (only the open conflict); after "Use new": nothing.

### Files

src/db.js, src/inventory.js, src/tidy.js, src/importPlan.js (restructured), src/golive.js (new), server.js,
public/app.js, public/stockcheck.js, public/purchasing.js, public/floor.js, public/index.html (Stock checks menu),
public/styles.css, public/floor.css, README.md.

New / changed API: `GET /api/summary` (adds `action`, `waiting`, `qtyChecks`, `golive`, `settings`, `counts.vansNear`,
`counts.stockChecks`), `POST /api/vans/:id/fitted {done}`, `GET /api/van-lines/:id/log`, `GET /api/items/unassigned`,
`POST /api/items/:id/assign`, `POST /api/items/:id/spare`, `GET /api/catalogue`, `POST /api/items/rack`,
`GET /api/stock-checks`, `POST /api/stock-checks/ack`, `POST /api/import/plan/update/preview`, `POST /api/import/plan/update`,
`POST /api/import/plan/apply?confirm=RESET` (now backs up and re-runs the clean-up), `GET /api/import/history`,
`GET/POST /api/plan-conflicts[/:id]`; `PUT /api/items/:id` takes `unit_size`, `order_up_to` and logs catalogue changes;
`GET /api/items/:id` adds `history`, `reorder`, `unassigned`, `spare`; `GET /api/settings` adds `importHistory`.

---

## Round 2, batch 1 — build order, borrowed parts on "Order now", honest counts (check-r1-1 … check-r1-4)

No new columns or tables, and no data migration: every change is in the code and works on the real
database as it is. Nothing to run by hand on the office PC.

### check-r1-1 — Build order: furthest along first (the van about to leave no longer waits for Bay 1)

- **What:** the one build order (`PRIORITY` / `vanRanks()` in `src/inventory.js`) is now:
  1. vans in production **not in a bay** (yard / finishing / not on the map), by due date (no date last);
  2. vans in production **in a bay, highest bay first** (Bay 6, Bay 5 … Bay 1);
  3. build order number; 4. planned vans by due date; 5. no date — unchanged.
  Before, Bay 1 (the newest chassis) came first and Bay 6 (about to leave) last.
- Because everything uses this one order, it applies everywhere: allocation, Order now / shortages, which van
  gets borrowed from on the floor (from the end of the order), trimming after a count, cutting missing parts,
  the unassigned list, Re-prioritise, the Vans list, the floor screen van list.
- Bay number is read from the bay name the same way "Move the line along" reads it (first number in the name;
  new SQL function `first_number()` registered in `src/db.js`), with the area id as a tie-break.
- Wording updated: Vans page note, Re-prioritise dialog (`public/app.js`, `public/stockcheck.js`), README "How it works".
- Checked on the copy: ST0380, ST0382 (in production, off the map) → Bay 6 ST0375 → Bay 5 LG027 → Bay 4 ST0386 →
  Bay 3 ST0367 → Bay 2 ST0393 → Bay 1 ST0377 → planned by date.
- After carrying over: allocation already made stays as it is; press **Vans → Re-prioritise stock…** once to
  hand free shelf stock out in the new order (preview first; only free shelf stock moves).

### check-r1-2 — A van whose part was borrowed (or found missing) shows under "Order now"

- **Why:** a donor line with a plan order number (`po_ref`) and no answer was treated as "Check: already ordered?"
  and left out of the order list, although its order number had already been used up when the part arrived.
- **What:**
  - `src/lineState.js`: `UNANSWERED` / `UNANSWERED_CORR` now skip `urgent = 1` lines — a borrowed-from line is always a
    real shortage, whatever its `po_ref`. This also covers lines borrowed before this version (no migration needed).
    `lineStatus()` (van page) and the "special parts" panel do the same.
  - `takeForVan` (floor borrow, "Yes, take it"): the donor line with a plan order number and no status is set to
    `state = 'not_ordered'` ("still to order"), logged in the allocation log (reason `borrow`, field `state`).
    **Undo** puts the status back (logged as `borrow undone`), only if nobody changed it since. The undo record keeps
    the old status as a 5th element of each `borrowed` entry (older undo records without it still work).
  - Parts received for a van and then **found missing** — count answer "No, they are missing" (`cutLocked`) and
    "Check parts bought for a van" → No (`checkBoughtLine`) — set the same "still to order" status (logged,
    reasons `count: missing` / `check: missing`) when the line has a plan order number and no status.
  - History ("Why?") shows status changes in plain words ("status: normal → still to order").
- Tested: borrowing INV-3000 from 4 vans put all 4 under Order now (group `now`, urgent), none under
  "Check: already ordered?"; Undo restored reserved, locked and status on all 4.

### check-r1-3 — Stock that moved while counting is never counted twice

- **Why:** the count change was always worked out against the figure when the count started, so a take made after
  the shelf was counted was booked twice; and the check for "less than kept for vans" used the shelf count only.
- **What (`checkCount` / `saveCount`):**
  - For every part that moved while counting, the office answers **Before** or **After** (per part):
    *After* (the safe default for older screens sending `ack_moves`): books = counted, change = counted − on hand now.
    *Before*: books = counted + what moved since, change = counted − figure when the count started.
  - The "kept for vans" check, the big-difference check and the movement are all worked out from that resulting
    book figure. The count movement is always `new books − on hand now`, so on hand = sum of movements still holds.
  - Refused (nothing saved): moved-while-counting with no answer; a count below 0; "before" giving books below 0;
    and — final safety net — any save that would leave more set aside for vans than the books hold.
  - Count screen (`public/stockcheck.js`): shows "System" and "now", the movements, and the Before / After question;
    the Change column, recount box and "kept elsewhere" question update live as answers / recounts are typed
    (same maths as the server). The old "I've seen the stock that moved" tick box is replaced by the per-part question.
- API: `POST /api/counts/:id/check` takes `timing`; `POST /api/counts/:id/save` takes `timing` and `elsewhere_qty`
  (`ack_moves` still accepted = "after"). Check rows add `now`, `moved`, `changed`, `timing`, `book`, `diff_before`,
  `diff_after`, `big_before`, `big_after`, `shortfall`, `shortfall_before`, `shortfall_after`.

### check-r1-4 — "Yes, kept elsewhere" adds only the shortfall

- **Why:** "Yes, elsewhere" added *all* locked stock on top of the shelf count (counted 2, 5 kept for vans → books 7).
- **What:** kept elsewhere = the shortfall only (`locked − books`), or the number the office types in the new
  "How many elsewhere?" box (default the shortfall, at most the shortfall). Any not kept elsewhere are missing:
  taken back from the vans built last ("back to short", logged) and set to "still to order" if they had a plan order
  number. Stock added by a "kept elsewhere" answer is never handed out to other vans (no allocation runs for it).
  The movement note says it all, e.g. "Counted 5 ea (after the stock that moved while counting) + 2 kept elsewhere
  for … · 1 kept for … missing — back to short".
- Tested: INV-3000 (5 on hand, 5 locked) counted 2 → "yes" gives 5 (not 7); "yes, 1" gives 3 with 2 back to short and
  both lines under Order now; "yes, 4" refused (at most 3); no answer refused. On hand change = sum of the new
  movements for every item tested; set aside never above on hand after a save.

### Files

src/db.js (`first_number` SQL function), src/inventory.js (PRIORITY, lineStatus, placeholderLines, takeForVan,
undoTake, cutLocked, new `stillToOrder`, checkBoughtLine, checkCount, saveCount), src/lineState.js (UNANSWERED*),
server.js (count check / save parameters), public/stockcheck.js (count screen, history wording, re-prioritise text,
special parts status), public/app.js (Vans page note), public/styles.css (`#cnt-check [hidden]`), README.md.

---

## Round 2, batch 2 — "....", already-ordered groups, special parts, one "order now" number (check-r1-5, user-r1-1 … user-r1-3)

No new columns or tables. Three new clean-up steps (same rules as before: backup first, each once, one transaction
each, every change in `allocation_log`, shown on the Clean-up report). Order in `STEPS` (src/tidy.js):
… relink → **autolink** → state → **state_dots** → **po_ref** → kind → supplier → po_spec → po.
Flags: `tidy_autolink_v1`, `tidy_state_dots_v1`, `tidy_po_ref_v1`. They run by themselves at the first start.

Tested on a fresh copy of the v2 data (`%TEMP%\fs-tools\v2\build-r2-b2\run`): autolink 0 (the reviewed list in the
relink step already took the sure ones: relink now 69), state_dots 0, po_ref 28. All 13 steps run a second time
(every flag cleared): 0 changes in each. After every test: on hand = sum of movements for every item, no line with
more set aside than it needs or more locked than set aside, nothing set aside above on hand.

### check-r1-5 — "...." only means "to be decided" when the cell has nothing else in it

- **Why:** any "...." marked a line "to be decided" — e.g. ST0377 (in production) fans "2 ......." dropped out of
  short / to-order, and "Straight / Driver side / ....../1380.5" too.
- **What (src/lineState.js):** `detectState()` treats dots as "to be decided" only when the text is nothing but dots
  (and separators). With a count or description the line stays normal, and the Van page shows the yellow
  **Please check** tag "the plan text has "...." in it – check what is needed" (`dotsCheck()`, used by `qtyCheckFor`,
  also on the Dashboard "Quantities to check"). Same rule in the plan import, plan update and dealer-order rules.
  `detectStateV1()` keeps the old rule, used only by the migration.
- **Migration `tidy_state_dots_v1` (`stepStateDots`):** lines on active vans still marked `tbd`, not fully fitted,
  where the OLD rule says tbd and the NEW rule doesn't (i.e. marked on the dots rule alone), and nobody set the status
  by hand (no `allocation_log` row with reason `state` for the line): status back to normal, free stock handed out in
  build order (`allocateItem`), two log rows (`state` change + a "please check" flag naming the van and text).
  Fresh v2 data: 0 (the new state step never marks them). Tested by simulating the old rule on ST0377's fans: 1 change,
  logged; with a hand-set status on the line: 0 changes.

### user-r1-1 — "Check: already ordered?" grouped by supplier AND number, never dates / sizes / quantities

- **Order number reader (`poRef()` in src/planMap.js; `poRefV1()` keeps the old one for the migration):**
  dates are removed first ("Urban republic Order 29/06/2026" → none; "Order 34 16/04/2026" → 34); "need to order 2",
  "Ordered 2 and need…", "8 x 225 or 9", "2 + Small 1", "Double/Dual Axel 2", product codes glued to letters
  ("ATS4", "DO35", "MSRA60", "SLMKIT04") and a bare single digit at the end ("Shiran 2") are not order numbers.
  A supplier word with a 0-led number anywhere is ("5 / Black / Nikpol 09 - Ordered 2 and need to order 2" → 09), and so
  is "NN / SUPPLIER" ("121 / NCE" → 121, the user's Roof Baw example; leadInfo already treated these as not-a-quantity).
- **Migration `tidy_po_ref_v1` (`stepPoRef`):** plan lines on active vans, not fully fitted: the text is read again;
  a line changes only when its stored number is exactly what the OLD reader made of the text (so a number a person
  typed, or two joined by a merge, is never touched). The plan text is kept; before → after is logged.
  Fresh v2 data: 28 (18 wrong numbers removed — dates, axles, "Shiran 2", ATS4, DO35, "or 9"…; 1 corrected 2 → 09; 9
  roof baw lines "121 / NCE", "114 / NCE", "25 / NCE" gained their number). Lines that lose a wrong number become normal shortages (on the order
  list); lines that gain one go to "Check: already ordered?".
- **Groups (`orderGroupOf()` + `checkOrdered()` in src/inventory.js):** one group per supplier + number. The supplier
  is the part's own, unless the plan text puts another supplier's name right before the number ("KO Jack E time 29"
  → E time; "Dometic Freshjet Pro Order 17" stays with the part's supplier — Dometic is only the brand). A part with no
  supplier takes the one named anywhere in its text ("Vinguard Antenna / Butterfly /coast to Coast 141" → Coast to
  Coast 141). With neither, the number is grouped per kind of part: "Order 141 – TABLE LEG (no supplier)" and
  "Order 141 – Wheel Box (no supplier)" are separate (before, wheel boxes, table legs, antennas and toolboxes were
  all one "141"). New helper `supplierMatcher()` (reads the supplier list once; `supplierFromText()` uses it).
- **Purchasing → Check: already ordered?** vans in production / due within the "coming up" weeks first, earliest
  "needed by" on each group ("needed by now" in red for vans in production), the rest folded under **Later vans**.
  Each group says plainly what "Yes" does: "“Yes” adds them to PO 11 – White Vision (already in the system)" /
  "“Yes” makes a new PO 137 for Coast to Coast", notes another supplier's PO with the same number, and
  "(supplier from the plan text)" when that applies. No-supplier groups ask for the supplier first.
- **Answer (`answerOrdered`, `POST /api/check-ordered`)** takes the group `key` (the screen sends it): only that
  group's lines are answered, each going on the PO of its group supplier. Older `group` (supplier) still accepted.
- **Nothing urgent hidden:** unanswered lines are also in the to-order list (`shortages()` rows with `check = 1`,
  `check_label` e.g. "Coast to Coast 141"), marked **Plan says ordered (Coast to Coast 141) – check**, not ticked,
  netted after the real shortages, and not in the "order now" count (section header says "+ N plan says ordered –
  check (not counted)").
- Test (API and screen): "Yes" on E time 29 → new PO 29 for E time with the 4 KO jack lines; "No" on "Order 141 –
  TABLE LEG" → 6 lines to the order list, the wheel box 141 group untouched; "Yes" on a no-supplier group without a
  supplier → asks "Which supplier is order 141 with?".

### user-r1-2 — Special parts to confirm: suggestions, link all with the same text, one-off parts

- **Reviewed list (src/relink.js `RELINKS`)** gained texts that plainly name one part: "White / Rectangle [/ Razor] [NN]"
  basin → BASIN-RECT, "PR8235" → BASIN-ROUND, "Induction cooker" → COOKER-INDUCTION,
  Hawk microwave/combi → HAWK-COMBI, "Camec microwave 28" → MW-CAMEC-28, "Proline premium" toolbox → TOOLBOX-PROLINE.
  They are linked by the existing relink step (same safe `linkLine`: only stock set aside on the line moves, two
  adjust movements; a van that already has a different line for that part is left "to confirm", marked "possible
  duplicate"). Fresh v2 data: relink 69 (was 55).
- **Migration `tidy_autolink_v1` (`stepAutoLink`):** links lines whose suggestion is *sure* (`suggestLink()`:
  on the reviewed list, the same catch-all + text linked the same way by a person before, or a model number found in
  exactly one part's name/SKU in a text that names one thing). Same `linkLine`. 0 on this data (relink took them);
  it matters on the real data after people have linked lines.
- **Suggestions (`suggestLink()`)** for every special part line: words of the text found in the part (colours /
  sizes count half; a different brand, colour or round/rectangle rules a part out; ties give no suggestion), never
  the part the same plan cell already became on that van ("Roller Rocker + DO35" is not the DO35 hitch). Shown as
  "Suggested: …" in the lists; the **Link** box opens with it at the top and in the search box ("Suggested – check it
  is right" + **Link to this**).
- **Link all N lines with this same text** (ticked by default when there are others): same catch-all, same words
  (case/punctuation ignored, numbers kept — "121 / NCE" ≠ "114 / NCE"), any van. `POST /api/van-lines/link-many
  {line_ids, item_id | new_item, by}`: each line through `linkLine` (reason `link many`); a new part made from the
  text is made once. Test: 8 × "121 / NCE" → one new part "Roof Baw" (NCE), 8 linked.
- **Keep as a one-off special part for this van** (button in the Link box and a **One-off** button on each row;
  `POST /api/van-lines/:id/one-off {supplier, name, by}`, `makeOneOff()` in src/relink.js): makes a part
  `ONEOFF-<chassis>-<column>` (kind bought-for-one-van, category "Special (one-off)", supplier pre-filled from the
  text when it names one, e.g. "L & S"), moves the line onto it with `linkLine` (logged `one-off`). It stops counting
  as "to confirm" but is ordered, received and found on the floor like any other part. One-off parts are never
  offered as link targets. Test: ST0380 L&S doors → ONEOFF-ST0380-L-S-DOORS (its 1 set aside moved with it); asking
  again → "This line is already a real part".
- Fresh v2 data: 162 lines to confirm (103 short) after the clean-up, 16 with a suggestion; 72 share their text with
  another line.

### user-r1-3 — One "order now" number

- `shortages()` returns `orderNow = {parts, lines, topups, check, text}` (`orderNowCount` / `orderNowText`):
  rows in the Order now group with something to order, not counting "plan says ordered – check" rows.
  Text: "107 parts (413 van lines)" (+ "N shelf top-ups" when there are any).
- The same object feeds the menu badge (number = parts, tooltip = the text), the Dashboard "Needs action" row
  ("107 Order now parts (413 van lines) — same as Purchasing → Order now"), the Dashboard Order now panel footer and
  the Purchasing **Order now** header. `summary().action.orderNow` / `counts.itemsToOrder` = `orderNow.parts`.

### Files

src/lineState.js, src/planMap.js (`poRef`, `poRefV1`), src/tidy.js (stepAutoLink, stepStateDots, stepPoRef),
src/relink.js (RELINKS, suggestLink, sameTextKey, cellSiblings, learnedLinks, linkableItems, makeOneOff),
src/inventory.js (shortages, orderNowCount/Text, orderGroupOf, checkOrdered, answerOrdered, placeholderLines,
supplierMatcher, qtyCheckFor), src/importPlan.js (new readers), server.js (`/api/van-lines/link-many`,
`/api/van-lines/:id/one-off`, `/api/check-ordered` takes `key`), public/purchasing.js, public/stockcheck.js,
public/app.js, public/styles.css, README.md.

### Carrying over to the office PC

Copy the changed files; the three steps run once at the first start (backup first). Afterwards look at the Clean-up
report: "Order numbers read wrongly" lists every number changed (before → after) and "...." lists any line put back
to normal. Nothing else to run by hand.

---

## Round 2, batch 3 — build order by due date, "Gave to Alex", Already-fitted quick start (user-r1-4, user-r1-5)

No new columns or tables. One new clean-up step (same rules as before: backup first, runs once, one transaction,
every change in `allocation_log`, shown on the Clean-up report). Order in `STEPS` (src/tidy.js):
… state → state_dots → po_ref → **given** → kind → supplier → po_spec → po. Flag: `tidy_given_v1`. It runs by itself
at the first start.

Tested on a fresh copy of the v2 data (`%TEMP%\fs-tools\v2\build-r2-b3\run`): given = 3 changes + 1 "please check".
All 14 steps run a second time (every flag cleared): 0 changes in each, 0 movements added. After every test (clean-up,
quick-start Save of 84 lines on ST0375, plan update with a "Gave to Sam" cell, full re-import on a separate copy):
on hand = sum of movements for every item, no line with more set aside than it needs, more locked than set aside or
more issued than needed, nothing set aside above on hand.

### user-r1-4 — Late vans get first claim on deliveries and stock

- **What:** the one build order (`PRIORITY` / `vanRanks()` in `src/inventory.js`) is now:
  1. vans **in production**: a **Build order** number the office gives (1 = first; works for vans in the bays too),
     then the **earliest due date** (the most overdue van first; no due date after the dated ones), and only as a
     tie-break the bay: yard / not on the map first, then the highest bay (Bay 6 … Bay 1);
  2. planned vans with a build order number; 3. planned vans by due date (a passed date = "no date");
  4. no date — unchanged.
  This replaces round 2 batch 1's "bay first" rule (check-r1-1): the bay is now only the tie-break, as the user asked.
  Because everything uses this one order, it applies to allocation, Order now, floor borrowing (from the end of the
  order), trimming after a count, the receive dialog, Re-prioritise and every van list.
- **New `buildOrderInfo()`**: every active van's place (#1, #2…) and why in plain words, e.g.
  "In production · due 18/9 – 26 days late · Bay 3", "In production · build order 1 · due 19/11 · Bay 1",
  "Planned · date passed (8/2) – check". Added to `GET /api/vans` (`build_pos`, `build_why`), `GET /api/vans/:id`
  (`van.build_pos`, `van.build_why`) and `GET /api/pos/:id` lines (`build_pos`, `build_why`).
- **Screens:** Vans page has a **#** column and the reason under each chassis, and new wording explaining the order;
  saving a build order number reminds to press *Re-prioritise stock…*. Van page header shows "#3 in build order"
  (hover = why). **PO → Receive delivery**: every van row shows its **#** and the reason, the hint says the total is
  shared out "in build order, top row first" — the rows were already in that order, now it is visible.
  Re-prioritise dialog and README wording updated.
- Test copy order now: #1 ST0367 (due 18/9, 26 days late, Bay 3), #2 ST0380 (30/9), #3 ST0375 (10/10, Bay 6),
  #4 ST0382, #5 LG027, #6 ST0386, #7 ST0377 (19/11, Bay 1), #8 ST0393 (in production, no due date — give it a date or
  a number), then planned vans by date. Giving ST0377 build order 1 put it at #1; clearing it put it back.
  Receive dialog on PO 100 (Swift rangehood, 10 vans): rows #1 ST0367, #5 LG027, #6 ST0386…; "Total arrived 2" filled
  #1 and #5.
- Re-prioritise preview on the test copy: nothing would move (free shelf stock already matches).
- **After carrying over:** existing allocation stays as it is; press **Vans → Re-prioritise stock…** once (preview
  first; only free shelf stock moves). If a planned van was given a build order number, it keeps it when it goes into
  production and is then ahead of the dated production vans — clear the number if that is not wanted (the "#" reason
  shows "build order N" so it is never a mystery).

### user-r1-5 — "Gave to Alex" lines no longer count as on the shelf; Already-fitted quick start

**"Given to a worker" plan notes**
- `givenTo(text)` in `src/lineState.js`: "Gave to Alex", "given to Sam on 3/4", "handed (over) to Jordan" → the person
  (and date). Not: "to be given to…", "will give…", "need to give…", "not given…", "given to customer / dealer /
  supplier". "Picked up" ("Jordan picked up", "picked up from Aussie traveller") means collected from the supplier —
  `pickedUp()` only flags it.
- `closeAsGiven(lineId, {reason, by, text})` in `src/inventory.js` (same stock rule as Already fitted): the line is
  closed (issued = qty); what was set aside for it comes off the shelf figure with one `issue` movement, worker = the
  person named, note `Given to Alex for ST0375 (plan says 15/07/2026) – plan note "…"`, ref = chassis; logged with the
  exact set-aside / kept change. A part never set aside closes with no movement and the log says so.
- **Migration `tidy_given_v1` (`stepGiven`):** open lines on vans still to build whose plan text says given to someone
  → `closeAsGiven` (reason `tidy:given`). Customer-supplies / to-be-decided lines are only flagged. "Picked up" lines
  are flagged "collected from the supplier; check it is in the factory (or already in the van)". Flags are written
  once per line (second run adds nothing). Test copy: ST0375, ST0386, ST0377 Black Jack (each 1 set aside and kept
  for the van) booked out — JACK-BLACKJACK shelf figure 3 → 0, three issue movements naming Alex; ST0382 tool box
  "Double Slide Jordan Picked up" flagged. Completed vans were already closed.
- **Plan import / update:** a new line whose cell says given (full import or new line in an update) is closed the
  same way (a grey cell is booked in and straight out again, so the shelf figure is unchanged and both movements
  explain it). In **Update from spreadsheet**, an open line whose cell now says "… Gave to Sam" is closed as given
  out (the text is updated, logged) instead of becoming a "plan changed after parts were set aside" conflict; the
  preview shows a "Given to a worker" tile and list. Test: ST0380 wheel box "Double Axel 141" → "… Gave to Sam
  10/10/2026": 1 given, 1 issue movement (Sam), no conflict; the same file again → nothing to update. The unchanged
  plan still gives "nothing to update".
- "Why?" history shows "Clean-up: plan says it was given to a worker".

**Already fitted… quick start** (Van page and factory-floor van panel — same dialog)
- New `GET /api/vans/:id/fitted-quick` (`fittedQuickStart()`): per open line — received for this van and kept for it
  in full (`covered`), last delivery date for this van and part, and `before_start` = it came in with the production
  plan import. Lines moved off a catch-all ("Re-linked from PLAN-X") take the catch-all's delivery date. Read-only.
- The dialog shows a **Quick start** box: "ST0375 is in production (Bay 6)… Tick everything received for this van
  more than [2] weeks ago (or before the system started) — **Tick these (84)**", then "untick anything that isn't in
  the van yet, and press Save". Partly received parts are never ticked by it. Each line shows "received for this van
  before the system started" / "received for this van 3/11" / "partly received (2 of 5)". Nothing is saved until Save
  (same `POST /api/vans/:id/fitted`, same stock rule, logged as before, counts for go-live step c).
- Test copy: ST0375 — 125 open lines, 84 offered (all received with the plan import); Save closed 84 lines;
  invariants hold.

### Files

src/inventory.js (PRIORITY, buildOrderInfo, listVans, getVan, getPO, fittedQuickStart, closeAsGiven),
src/lineState.js (givenTo, pickedUp), src/tidy.js (stepGiven, STEPS), src/importPlan.js (insertLine, updateDiff,
diffSummary, planUpdate: given lines), server.js (`GET /api/vans/:id/fitted-quick`), public/app.js (Vans page #,
van header, plan-update preview), public/purchasing.js (receive dialog #/reason), public/stockcheck.js (Already
fitted quick start, Re-prioritise wording, history wording), README.md.

### Carrying over to the office PC

Copy the changed files; the `given` step runs once at the first start (backup first). Then: look at the Clean-up
report ("Parts the plan says were given to someone"), press **Vans → Re-prioritise stock…** once, and use the
Already-fitted quick start van by van for the go-live walk-through.

---

## Round 3, batch 1 — Purchasing tabs, Order now in build order, safer special-part links, van page keeps its place (user-r2-1 … user-r2-4)

No new columns or tables. Two new clean-up steps (same rules as before: backup first, each runs once, one
transaction each, every change in `allocation_log`, shown on the Clean-up report). Order in `STEPS` (src/tidy.js):
… relink → autolink → **parts_r3** → **notes_r3** → state → … Flags: `tidy_parts_r3_v1`, `tidy_notes_r3_v1`.
They run by themselves at the first start.

Tested on `%TEMP%\fs-tools\v2\build-r3-b1`:
- a copy already cleaned up by the round-2 code (as the office PC will be): parts_r3 = 4 (2 new parts, LG027's
  "Thedford 175 L Compressor Order 78" and "white instead of black Round / Razor /44" linked, their 1 set aside each
  moved with two adjust movements), notes_r3 = 0 (no old notes in this data);
- the same copy with three old-style notes written in (relink merge, exact-duplicate merge, possible duplicate):
  notes_r3 = 3, all reworded, old text kept in the log;
- a fresh copy of the v2 data: all 16 steps (relink now 71 — the two new reviewed texts — parts_r3 0, notes_r3 0);
- every step run a second time (all flags cleared) on both: 0 changes, 0 movements added.
After every test: on hand = sum of movements for every item, no line with more set aside than it needs / more locked
than set aside / more fitted than needed, nothing set aside above on hand.

### user-r2-1 — Purchasing is no longer one 80,000px page

- **Tabs** (`public/purchasing.js`): **To order** · **Check: already ordered?** · **Special parts** · **Purchase orders**,
  each with its count in the tab (Order now parts; already-ordered numbers for vans due soon; special parts; open
  POs + "N late"). The tab is remembered; Dashboard links ("Order now", "Check: already ordered?", "POs to check",
  "Overdue deliveries") and the van page's "Check: already ordered?" tile open the right tab.
- **To order:** each supplier is ONE closed line in Order now / Coming up / Later / No date:
  "Arizon · 8 lines · earliest order-by 30/09 · first van #7 ST0377 · 8 ticked · lead time [14] days ·
  Create PO for ticked". Click it to open (remembered while the page is redrawn); **Open all / Close all** per
  section. Lines are only drawn when a supplier is opened (the page went from ~80,000px to ~6,000px with Order now
  and Coming up open). Ticks and typed quantities are kept per line in memory, so **Create PO for ticked** works
  from a closed supplier too and survives a redraw (filter change, lead time…); untouched lines follow the latest
  suggestion. Lead time box is still in the supplier line.
- **"Plan says ordered – check" rows are folded:** one row per supplier block — "6 to check — the plan says these were
  already ordered (Aussie Traveller 275, … + 1 more), not counted here. See Check: already ordered? →". The link opens
  the Check tab showing only that block's order numbers ("Showing the order number(s) for Aussie Traveller … Show all").
  They were never ticked before either; now they are answered there ("No, still to order" puts them on the list).
- **Purchase orders tab:** search box (PO number, supplier, van, notes — all words must match), Open / All / Closed,
  a **Receive…** button on every open PO with something still to come (same receive dialog as on the PO page),
  then folded **Overdue deliveries** and **POs to check** (open state remembered).
- Special parts still to order are on their own tab (same panel as before).

### user-r2-2 — Order now in build order

- `shortages()` (src/inventory.js): every row has `build_pos` (#1 = first call on stock, the same numbers as the Vans
  page and the receive dialog). **Order now** rows are sorted by build order first (vans in production first, then
  planned vans), then order-by date; shelf top-ups after the vans. Coming up / Later / No date: order-by date, then
  build order (as before). Before, a planned van (ST0383) came first because its supplier's longer lead time gave an
  earlier order-by date than the overdue vans in production.
- Screen: each line shows "#3 ST0375"; vans in production say **needed now** (red) instead of a date; the supplier
  line says "first van #1 ST0367". Dashboard Order now panel: #, and "now" for vans in production.
- The Order now number is unchanged ("107 parts (413 van lines)" on the test copy) — only the order changed.

### user-r2-3 — Suggested links that can't double-order a part

`src/relink.js`:
- **No suggestion on a supplier name alone:** a word match needs at least one matching word that is in the part's own
  name / code and is not a supplier name (`supplierWords()`). "Nikpol 13" no longer suggests the Nikpol sliding
  door kit.
- **A size in both that differs rules a part out** (`sizes()`): "Thedford 220 ltr Compressor" is not the Thetford 175L.
- **Never a part the van already has** (`vanParts()`, `suggestFor()`): if the best match is already on the van (or,
  failing a normal match, one of the van's own parts is the same kind of thing — brand + plan column is enough here),
  the line says **"This van already has Sliding door rail + pelmet – same thing?"** instead of a suggestion. The Link
  box shows it with **Yes, same thing – merge…**; the list button reads **Same thing?…**.
- **Never one part for two lines of one van** (`suggestionsFor()`): both lose the suggestion and say "Could be AU Focus
  diesel heater, but that also fits the "HWS" line on this van — pick by hand" (ST0377 Extra Heating / HWS).
  `placeholderLines()` works this out over all of a van's special-part lines, short or not. The sure-link clean-up
  step (`stepAutoLink`) uses the same rules.
- **Warn before merging:** new `POST /api/van-lines/link-preview {line_ids, item_id}` (`linkPreview()`, changes
  nothing) says per line link / merge / duplicate, the van's existing line, what moves and what would become free
  shelf stock. The Link box always asks first when a van already has the part ("This van already has this part. The
  plan line will be merged into the van's own line — one part to order, not two: ST0367: the plan line Sliding Door
  Pelmet … need 1 → this van's Sliding door rail + pelmet line … need 1 · 1 set aside on the plan line will be free
  shelf stock of Sliding door rail + pelmet"). Different amount/text: **Merge all** / **Merge only the same ones** /
  Cancel. `POST /api/van-lines/link-many` takes `force` for "Merge all".
- **Words, not line numbers:** a merge writes "merged from the plan line Sliding Door Pelmet 1 Can use for 4 sliding
  doors ("Nikpol 13")" on the van's line; a possible duplicate says "possible duplicate of this van's "Sliding door
  rail + pelmet" line (for: Sliding Door Railing)"; the history ("Why?") says "plan line … → this van's … line". The
  exact-duplicate clean-up step writes "merged from the plan line X (it was listed N times)".
- **Migration `tidy_notes_r3_v1` (`stepNotesR3`):** rewrites old notes "merged from line N (PLAN-…: text)", "merged
  from line N" and "possible duplicate of line N" into those words (the plan column comes from the catch-all or the
  line itself; the existing line's part for duplicates). Only those words change; before → after logged.
- **New parts** (`NEW_ITEMS`, created only if the SKU doesn't exist): **FRIDGE-THET-175** "Thetford 175L compressor
  fridge" (bought for one van, supplier Thetford, category Appliances) and **BASIN-ROUND-RAZOR** "Vanity basin white
  round (Razor)" (shelf stock, supplier Razor). Trade comes from the plan column (builder / plumber). Reviewed texts
  (`RELINKS`, marked `r3`): any spelling of Thetford + 175 on the FRIDGE column; white + round + Razor on the ensuite
  basin column, but not fluted / ribbed / cup cake / PR82xx basins (other models). `ensureNewItems()` now takes a
  kind and supplier per new part.
- **Migration `tidy_parts_r3_v1` (`stepPartsR3`):** creates the two parts if missing and moves the catch-all lines
  on vans still to build whose text matches the round-3 reviewed entries onto them, with the same `linkLine` (only
  what is set aside on the line moves, two adjust movements, logged). The office should check the two suppliers.
- Tested (screen): ST0367 pelmet "Nikpol 13" → Same thing? → warning → Yes → merged into the van's kit line; note and
  history in words; on hand still = movements.

### user-r2-4 — Van page (and every page) keeps its place after a change

- `public/app.js` `route({ keep })` / `reload()`: a redraw after a change keeps the old page on screen until the new
  one is drawn (no "Loading…" flash), then puts the line you were looking at back at the same height on the screen
  (anchors on `data-line`, `data-ph`, supplier blocks, PO rows…; falls back to the old scroll position) and restores
  filter boxes marked `data-keep` (van page "Filter parts…" and status). Opening a page from a link still starts at
  the top. Tested: line 70 of 116 on ST0367, Edit → Save: the line stayed at the same height on screen although the
  page above it changed.
- The van line just changed (Edit, Quantity is right, Customer supplies / To be decided) lights up for a moment.
- The Stock page's part dialog refresh uses the same keep-your-place redraw.

### Files

src/inventory.js (shortages sort + build_pos, placeholderLines → suggestionsFor), src/relink.js (RELINKS r3 entries,
NEW_ITEMS kind/supplier, planLineName, sameNeed, dupFlag, linkLine wording, linkPreview, suggestFor, scoreWords,
vanParts, suggestionsFor, sizes, supplierWords), src/tidy.js (stepMergeDupes wording, stepAutoLink, stepPartsR3,
stepNotesR3, STEPS), server.js (`POST /api/van-lines/link-preview`, `force` on link-many), public/purchasing.js
(tabs, To order / Check / Purchase orders tabs), public/stockcheck.js (Link box: already / clash / ask before
merging), public/app.js (keep-your-place redraw, flash, van page suggestions, Dashboard Order now #, tab links),
public/styles.css, README.md.

### Carrying over to the office PC

Copy the changed files; the two steps run once at the first start (backup first). Then look at the Clean-up report
("Thetford 175L fridge and white round Razor basin added…" and "Notes name the plan line…"), and check the suppliers
on the two new parts (Stock page). Nothing else to run by hand.

---

## Round 4, batch 1 — safe merges of special parts, merged plan cells keep their colour, van POs nobody needs (check-r3-1 … check-r3-4)

### New column (src/db.js, `addColumn` style)

| table | column | why |
|---|---|---|
| `van_lines` | `merged_cols TEXT DEFAULT ''` | production-plan columns whose plan line was merged into this line (JSON list, e.g. `["Sliding Door Pelmet 1 Can use for 4 sliding doors"]`). The plan grid and the Excel export colour those cells from this line. |

### check-r3-1 — "Same thing?" is no longer offered on a supplier name alone, nor for two received lines; a forced merge never turns received stock into free shelf stock

`src/relink.js`:
- `scoreWords` loose mode (only used for "This van already has … – same thing?") now also needs at least one word
  that is in the part's own name / code and is not a supplier name (`realHit`), like the normal rule. "Nikpol 13"
  in the pelmet column no longer says "This van already has Sliding door rail + pelmet – same thing?".
- New `bothReceived(a, b)`: each line has stock received for the van (`reserved_firm > 0`) or its plan cell is grey /
  blue (set aside + fitted cover the need). When the plan line and the van's line both have it:
  - `suggestFor` gives no "same thing?" but `different` → the screens say **"Two deliveries were received for this
    van – probably different parts"** (Special parts list, van page, Link box);
  - `linkPreview` gives `result: 'duplicate'` with `different: 1` (not 'merge');
  - `linkLine` without `force` leaves the line "to confirm" with the note "two deliveries were received for this van –
    probably not the same part as this van's "…" line".
- **If the office still merges ("Merge all")**: only what the van's line has room for moves across (two adjust
  movements as before). Anything more that was set aside on the plan line is **no longer handed to the part as free
  shelf stock**: the plan line is kept (not deleted), its need = what it still holds, locked part stays locked, note
  "to check: 1 received for this van stays on this line – merged with this van's "…" line, but probably a different
  part". It is not free, not given to another van by allocation / re-prioritise, and stays on the Special parts list
  (chip shown) until someone links it, marks it fitted, or answers it. The merge log row says what stayed; when the
  plan line is kept its history stays with it and both lines' set-aside changes are logged with `change` /
  `firm_change`.
- `vanParts` returns reserved / reserved_firm / issued; `placeholderLines` returns `reserved_firm` and `different`.
- Test `test/merge-and-shortages.test.js` (new, `npm test`, built-in `node:test`, runs on a fresh database in a temp
  folder): two received lines → no "same thing?", preview says different, no merge without force; after a forced
  merge on-hand (both items), free (both items) and the to-order rows are unchanged, the received part is still on
  the plan line, on hand = sum of movements, plan colours unchanged, re-allocating doesn't hand it out. Plus a test
  that a supplier name alone gives no "same thing?".

### check-r3-2 — "Merge all" keeps the larger need

- `linkLine` merge and `linkPreview` share one sum (`mergeSums`): need = `Math.max(existing.qty, plan line qty,
  fitted + already set aside on the van's line)` (the last term only matters if the plan line's part was fitted while
  the van's line also holds stock — then nothing it holds is dropped). Before, the plan line's larger need was lost.
- The preview returns `qty_after`; the warning shows "need 1 **→ need 3**". The 'merged' history row keeps the plan
  line's need in `before` and says "need 1 → 3" in `after`.
- Tested on the data copy: ST0394's pelmet plan line set to need 3, Merge all → the van's kit line needs 3 and ST0394
  is short 3 on the order list (was 1).

### check-r3-3 — A merged plan line keeps its colour in the Production plan and the Excel export

- A merge records the plan line's column on the van's line (`merged_cols`); `planGrid` colours every listed column
  from that line too (least advanced wins, as for any cell with several lines), and clicking that cell opens the
  van's line. The Excel export uses `planGrid`, so it follows.
- **Migration `tidy_merged_cols_v1` (`stepMergedCols`, src/tidy.js, after notes_r3):** for merges made before this
  version, reads the 'merged' rows of the allocation log ("plan line <column> (…) on PLAN-…", or the older "line N
  (PLAN-…: …)"), and adds the column to the surviving line when it is a real plan column. Only adds, logged before →
  after, a column already listed is skipped. The exact-duplicate merge step now also carries `merged_cols` over.
- Tested: export before and after a merge (ST0367 forced merge of two received lines, and ST0394 Merge all with need 3)
  compared cell by cell — 0 differences in text or colour.

### check-r3-4 — Spare stock on a van that still has its own part on order no longer makes the list one too many

- `shortages()` (src/inventory.js): for shelf items, open van-PO quantity that its van no longer needs (open van PO
  minus that van's still-short lines for the part — e.g. spare shelf stock was set aside for the van meanwhile) is
  counted with the shelf POs for the other vans. When that PO arrives, receiving locks the van's set-aside stock and
  hands the new part to the next van short in build order, so this is where it really goes. Per-van parts are not
  pooled (they are never handed on). Allocation itself is unchanged, so a van in production keeps first call on the
  shelf (build order).
- Re-tested with the PO 14 scenario (receive 1 for ST0367, 3 for LG027, close ST0386's balance, back-order ST0393):
  rangehood rows to order after = 4 (ST0394, ST0381, ST0388, LG024), not 5 — ST0391 is covered by ST0393's
  back-ordered PO. Also a unit test.

### Tested

- `node --check` on every changed JS file; `npm test` (4 tests) passes.
- Fresh copy of the v2 data (`%TEMP%\fs-tools\v2\build-r4-b1`): server starts, all clean-up steps run (same counts as
  round 3, merged_cols 0), second start runs nothing. `merged_cols` step with its flag cleared and the column wiped on
  2 lines: run 1 → 2 changes, run 2 → 0.
- After the merges and the PO 14 receive: on hand = sum of movements for every item, no line over-reserved, no locked
  more than set aside, nothing set aside above on hand.
- Screen (own browser tab, port 3310): van page, Special parts list (the "to check" chip), Link box warning ("Two
  deliveries were received…", "stays on it, marked to check"), Production plan, Purchasing, Stock, Dashboard,
  Clean-up report, /floor — no console errors.

### Files

src/db.js (`merged_cols`), src/relink.js (`bothReceived`, `DIFFERENT_TEXT`, `diffFlag`, `mergedCols`,
`withMergedCols`, `mergeSums`, linkLine merge, linkPreview, suggestFor, scoreWords, vanParts), src/inventory.js
(placeholderLines `different` / `reserved_firm` / `LINK_FLAG_RE`, planGrid merged columns, shortages van-PO spare),
src/tidy.js (`stepMergedCols`, STEPS, stepMergeDupes carries `merged_cols`), public/stockcheck.js (different text, merge
warning: need after, kept, both received; chip text), public/app.js (chip test), test/merge-and-shortages.test.js (new),
package.json (`npm test` script, no new dependency), README.md.

### Carrying over to the office PC

Copy the changed files (and the new `test` folder if wanted). The new column is added and the `merged_cols` step runs
once at the first start (backup first, as for every clean-up step). Nothing to run by hand.

---

## Round 4, batch 2 — "Check: already ordered?" by first van + "Yes, all on order"; Order now sorted by urgency (user-r3-1, user-r3-2)

No new columns, tables or clean-up steps, and no data migration: all changes are in the code and work on the real database
as it is. Nothing to run by hand on the office PC.

### user-r3-1 — "Check: already ordered?" shows the first van and how late it is; "Yes, all on order" per supplier

- **Why:** every group said "needed by now", so nobody could tell which order number mattered most; and a supplier with
  ten order numbers needed ten separate "Yes" clicks after one phone call.
- **What (`checkOrdered()` in src/inventory.js):** each line now has `build_pos` (#1 = first call on stock, the same
  numbers as the Vans page) and `late_days` / `needed_now` / `when` from the new `vanTiming()`:
  "26 days late" (in production, past its due date), "in production, due 19/11", "in production, no due date",
  "due 4/11 – parts needed now" (planned, due within the build weeks), "due 20/11", "date passed (8/2) – check",
  "no due date". Each group has `first` = its first van in the build order with a label such as
  **"#1 ST0367 – 26 days late"**. Groups are sorted: vans due soon first (as before), then **by that first van's #**,
  then needed-by date, then most parts.
- **Screen (public/purchasing.js, Check tab):** each order number shows "#1 ST0367 – 26 days late" (red when late, amber
  when parts are needed now but the van isn't late) instead of "needed by now"; the part list shows "#3 ST0375 (26 days
  late)" per van.
- **Supplier filter** on the Check tab ("All suppliers (144 order numbers)", each supplier with its count, "No supplier");
  remembered while the page is open. When one supplier is shown (picked here, or sent from the To order tab's
  "See Check: already ordered? →") and it has more than one order number, a green box offers
  **Yes, all on order**. It first lists exactly what will happen ("add to PO 11 (already in the system): 3 part(s) for
  ST0367, ST0380" / "new PO 13: …"), then answers every order number shown in **one transaction** — all or nothing.
  Parts unticked in a group are left out (the same as the single "Yes"). Each part goes on that supplier's PO with its
  own number and its van, logged `check ordered` per line exactly as before.
- **API:** `POST /api/check-ordered/all {supplier, groups: [{key, po_ref, line_ids}], by}` (`answerOrderedMany()`):
  refuses a blank supplier, an empty list, or any group that isn't that supplier's (no-supplier groups must be answered
  one by one, with their supplier typed). `GET /api/check-ordered` adds `first` per group and `build_pos`, `late_days`,
  `needed_now`, `when` per line.
- Test copy: 144 groups; first groups "Battery Stop 200 / Onex 08 / Purple Line 01 … #1 ST0367 – 26 days late", then
  "#2 ST0380 – 14 days late"…; later vans "#11 ST0390 – due 16/11". Ranger filter → 10 order numbers, one part unticked,
  Yes all → 10 POs, 17 parts, 17 log rows, the unticked part still waiting. A request with one stale order number
  changed nothing (409, all rolled back). A no-supplier group sent as Ranger's → refused.

### user-r3-2 — Order now: suppliers most urgent first, "order today", lead time "14 (default)", no-supplier parts not ticked

- **Supplier order:** new box **Suppliers: most urgent first** (default) / **A–Z** in the To order filters. Most urgent
  = Order now: by the vans each supplier is waiting on in build order (first van #, then the next van… — many suppliers
  share #1 ST0367), then earliest order-by; Coming up / Later / No date: earliest order-by, then the vans. A supplier
  with only "plan says ordered – check" rows comes after the others; **No supplier set** is always last. Each supplier
  line shows "first van #N …" in every section (was Order now only).
- **"order today":** a "needed now" line (van in production, borrowed part, or a planned van whose needed-by date has
  passed) says **needed now · order today** instead of an order-by date in the past; any other line whose order-by
  date has gone says **order today**; shelf top-ups say **order today**; the supplier line says "order today" instead
  of "earliest order-by 29/09". Dates still to come are shown as before. The Excel **To Order** sheet's "Order by"
  shows today's date instead of a past one (the data itself is unchanged).
- **Lead time box:** empty with **"14 (default)"** in grey until someone types the real lead time (amber label, as
  before, while it is only assumed). Emptying a typed lead time puts the supplier back to the 14-day default (not
  confirmed) — before, an empty box would have saved **0 days** (`setSupplierLead()` now treats '' as "not known").
- **No supplier set:** its lines are never pre-ticked and their tick boxes are greyed out ("Set the supplier on this
  part first"); there is no **Create PO for ticked** button there, only "set the supplier on these parts first" (opens
  Stock → Fix the catalogue → No supplier). Once a part has a supplier it moves to that supplier's block and can be
  ordered. Suppliers with nothing to order (only "to check" rows) no longer show a Create PO button either.
- Test copy: Order now starts Caravan & Camping, Plenty River, Power Science, Safety Dave… (all waiting on #1 ST0367,
  then the next vans), No supplier set last (153 lines, 0 ticked, 153 greyed, no Create PO); A–Z works; Arizon lead
  10 → saved and confirmed; emptied → 14, not confirmed, box shows "14 (default)".

### Tested

- `node --check` on every changed JS file; `npm test` (4 tests) passes.
- Fresh copy of the v2 data (`%TEMP%\fs-tools\v2\build-r4-b2`, port 3310): server starts, all clean-up steps run as
  before. After the tests: on hand = sum of movements for every item (answering only adds PO lines and log rows).
- Screen (own browser tab): Purchasing (To order, Check, Special parts, Purchase orders), Dashboard, Vans, a van page,
  Stock, Production plan, Excel export (200), /floor (200) — no console errors apart from the deliberate 409 test.

### Files

src/inventory.js (`checkOrdered` first van / sort, new `vanTiming`, new `answerOrderedMany`, `setSupplierLead` empty =
default), server.js (`POST /api/check-ordered/all`), src/exportXlsx.js (To Order "Order by" never in the past),
public/purchasing.js (To order: supplier sort, order today, lead box, no-supplier block; Check tab: first van, supplier
filter, Yes all on order), public/styles.css.

### Carrying over to the office PC

Copy the changed files. Nothing runs at start-up for this batch and nothing to run by hand. Suppliers whose lead time was
never typed now show an empty box with "14 (default)" — type the real ones as they become known.

---

## Worker app preview (2026-10-18)

Makes the worker screen installable as a phone app ("Stallion Floor") and adds a preview page.
No data changes, no migration.

- `public/floor.webmanifest` (new): app name, horse icon, full screen (standalone), espresso/limestone
  colours, opens at `/floor`.
- `public/assets/app/` (new): icon-192.png, icon-512.png, icon-maskable-512.png (Android round icons),
  apple-touch-icon.png (iPhone) — limestone horse on espresso, made from `assets/brand/mark-limestone.png`.
- `public/floor-sw.js` (new): offline helper. Keeps the screens (not the data) on the phone so the app
  still opens when the Wi-Fi drops; `/api` is never cached and pages are fetched fresh first, so office
  PC updates show straight away. Only registers on a secure link (https or localhost).
- `public/floor.html`: links the manifest, iPhone app title/icon/status bar, registers the helper.
- `public/app-preview.html` (new): phone-shaped preview — home screen with the Stallion icon → opening
  screen → the real worker screen. Open `http://<office PC>:3000/app-preview.html`.
- Note: the full "Install app" prompt needs https (comes with Tailscale `serve` or Cloudflare Tunnel).
  Over plain http on the Wi-Fi, phones can still "Add to Home Screen". The offline helper could not be
  tested in the Claude desktop browser pane (it blocks service workers); test it on a real phone.

---

## Small fixes & phone round 1

### Batch 1 — PO search, cleaned-up wording, clear stock numbers, search both stock tabs (user-r4-1 … user-r4-4)

No data changes and no start-up migration in this batch: the database keeps every text exactly as it came in.

**user-r4-1 — an exact PO number comes first (Purchasing → Purchase orders → "Find a PO").**
Typing "36" listed 15 POs (every PO for ST0367 mentions 36) with PO 36 13th. Now, when what you type is one
word, the PO whose number is exactly that is moved to the top and marked (light row, dark edge on the left),
then POs whose number starts with it, then the other matches in their usual order. The count says
"13 purchase orders · PO 36 first, then 12 more that mention “36”". An exact PO number is shown even when the
Open / Closed filter would hide it, so a typed PO number is never "not found". "PO36" / "po#36" work too.
Files: `public/purchasing.js` (`renderPosTab`), `public/styles.css`.

**user-r4-2 — typos cleaned on screen; one dealer name on every van.**
New `public/wording.js` (loaded first on the office screens and the worker screen): one list of typo → correct
word ("Battert" → Battery, "Mattt" → Matt, "Barthroom" → Bathroom, "Tpilet" → Toilet, "Roof Baw" → Roof Bow,
"Controler" → Controller, "Seperating/Seperate" → Separating/Separate, "Aeria" → Area (not "AERIAL"),
"Servise" → Service, "Tethford/Thedford" → Thetford, "Reflecters" → Reflectors, "Caravan Treading Center" →
"Caravan Trading Center"). Whole words only, the original's capitals are kept ("SERVISE DOORS" → "SERVICE DOORS").
It cleans every text people read on the page (and hover tips) as the screens draw it — Dashboard, Purchasing,
van pages, Special parts, Production plan headings, Vans list, the worker screen — but never the text inside
boxes you type in, nor the hidden keys the screens send back, so saving something never rewrites the plan text
by accident. The Excel export and a re-import still use the spreadsheet's own text, as before.
The dealer box on a van's Details tab shows "Caravan Trading Center" (saving the van's details stores that).
Searches on Stock also find the cleaned words ("battery stop" finds "Battert Stop"). To fix another typo
everywhere, add one line to the list in `public/wording.js`.
Files: `public/wording.js` (new), `public/index.html`, `public/floor.html`, `public/floor-sw.js` (wording.js kept
for offline; cache name → `stallion-floor-v2` so phones pick it up), `public/app.js` (dealer box),
`public/stockcheck.js` (`itemSearchText`).

**user-r4-3 — Stock numbers that explain themselves.**
- Shelf stock: one banner "160 parts not counted yet. Their Free figure is a guess until the rack is counted."
  with **Count a rack…** and **Show them** (filters to "Not counted yet"), instead of a "Not counted yet" badge
  and a "not counted yet" note on every row. The Last counted column still says "never"; the greyed Free figure
  has a hover tip.
- New **Still to order** column next to **Short**: Short = needed by vans in production or due soon and not yet
  set aside (unchanged); Still to order = what is left of that after what is already on order, worked out exactly
  as Purchasing → To order does (set aside → that van's PO → free shelf stock → shelf POs, in build order), so the
  two pages agree and it is never more than Short. Swift rangehood: short 6, on order 10 → still to order 0
  (shown green); Shower mirror: short 10, on order 3 → still to order 7. Lines waiting on "Check: already
  ordered?" are left out, as on To order. New API `GET /api/items/still-to-order` (`inv.stillToOrderByItem`).
- Special-part counts say what they count: Stock → Special parts to confirm "97 still to order · 160 in all",
  Purchasing → Special parts "97 still to order · 160 in all" (tab badge stays 97, hover says both), van page
  "3 still to order · 7 in all" (ST0367). "Still to order" = the lines on the Purchasing list; the rest already
  have their part set aside or are waiting on an answer. New API `GET /api/placeholders/count[?van=]`
  (`inv.placeholderCounts`, same filters as the lists).
Files: `src/inventory.js`, `server.js`, `public/app.js` (`renderStock`, van page), `public/purchasing.js`,
`public/styles.css`.

**user-r4-4 — the Stock search looks in both tabs.**
Typing "aircon" on Shelf stock gave "0 of 160 items" and no hint. Now a blue line under the filters says
"3 matches in Bought for vans – show" (or "Also N matches in Shelf stock – show" from the other tab); **show**
switches tab keeping the search (category / item / trade filters cleared so the matches are not hidden).
Files: `public/app.js` (`renderStock`), `public/styles.css`.

**Phone (this batch's screens).** Under 600px wide: the Stock and "Find a PO" search boxes take the full width,
the not-counted banner and special-part counts wrap under their titles, and the Purchase orders tab's
"POs to check" / "Overdue deliveries" headers keep the title on one line with the help text below.
Desktop layout unchanged.

Carrying over to the office PC: copy the changed files. Nothing runs at start-up and nothing to run by hand.

### Batch 2 — real ordered dates, multi-part plan texts, "to check" numbers that match, check-only suppliers (user-r4-5 … user-r4-8)

**user-r4-5 — a PO's ordered date is only shown when it is real (Purchasing → Purchase orders).**
All 37 POs from the plan said "Ordered 11/10/2026" (the day the plan was imported); the 7 Battery Stop POs made by
"Yes, all on order" showed nothing. Now every PO from the plan (the import's pink cells, and the ones made by "Yes, on
order" / "Yes, all on order") shows **unknown (from plan)** until someone types the date; a typed date shows as normal.
Same on the PO page ("Ordered: unknown (from plan) – type it with Edit details when you know it"), in "POs to check"
next to the Ordered box, and the printed PO leaves the ordered date out when it is not known. The Excel export's
Ordered column is blank for these (it was the import date). POs made in the office (+ Blank PO, Create PO for ticked,
marking a line "ordered" with a number) still get today's date as before.
- Plan import (`src/importPlan.js`): pink-cell POs are made with a blank ordered date (was the import day).
- Start-up clean-up step 10 (`stepPo`, `src/tidy.js`): now only dates blank POs that are **not** from the plan.
- **Migration — new start-up step `po_dates` (`tidy_po_dates_v1`; runs once, backup first, shown in the Clean-up
  report):** on a database where step 10 already ran, a plan PO whose ordered date is still exactly the day it was
  entered gets a blank date ("unknown (from plan)"). A date someone typed (any other day) is kept. Nothing is lost:
  the day it was entered stays in the PO's `created_at`, and each cleared date is in the report (before → after).
  On the baseline copy: 37 POs changed. On a fresh import: 0 (nothing to clear).
- "From the plan" = the PO's notes say "Imported from the production plan" or "Order number from the production
  plan" (`PLAN_PO_SQL` in `src/inventory.js`; `from_plan` on `/api/pos`, `/api/pos/:id`, `/api/pos/to-check`).
  No new column.
Files: `src/importPlan.js`, `src/tidy.js`, `src/inventory.js` (`listPOs`, `getPO`, `posToCheck`), `public/purchasing.js`.

**user-r4-6 — a plan text that names several parts says so and offers to add each; a dealer's name is not a part
(Purchasing → Special parts, Stock → Special parts to confirm, van pages).**
- ST0381 COOKER "induction cooker + CAMEC MICROWAVE 28LTR + AIR FRYER AND CONVECTION OVEN" now says **This text
  names 2 parts**: "induction cooker" – suggested Induction cooker; "CAMEC MICROWAVE 28LTR + AIR FRYER AND CONVECTION
  OVEN" – suggested Camec 28L microwave / air fryer / convection (bits that are the same real part are shown once).
  New button **Add each part…**: a dialog lists each part with its suggestion ticked (or a box to find the part);
  **Add ticked parts** puts each on the van as its own line (same plan column, same plan text, note "Part of the plan
  text: “…”"), set aside and ordered like any other part. When every part not on the van yet gets one, the plan line
  itself becomes the first of them (its stock and van POs move with it, as with Link). Otherwise it stays "to
  confirm" for the parts left, and the ones already added show "on this van: …". A part the van already has is
  refused (use Same thing? / Link), and so is the same part picked twice. Logged as "add part" (history / "Why?"),
  never as "link", so "the same text was linked to … before" does not learn from part of a text.
- How a text is split: at "+", "&" and ";", and at "and" only when both sides have a model number ("pr7350 and
  pr7320"). A bit counts only if it has a real word or a model number, so "White + Frost", "Black + Frost",
  "L & S 150", "C&C …" and "3200ATM" are not split. Also shown now: "Teko Tuff Ride + DO35 3500ATM" (DO35 already on
  the van), "Roller Rocker + DO35", "pr7350 and pr7320", "black pr7530 … and in ensuite pr 7570".
- ST0384 CHASSIS "Caravan Treading Center": a plan cell that holds only a dealer's name (any dealer on the vans,
  either spelling) is marked **Not a part – the dealer's name** with status "not a part", and is not counted as
  "still to order". Purchasing → Special parts leaves it out and says so under the list ("Not listed – not a part:
  ST0384 CHASSIS “Caravan Trading Center” (the dealer's name)"). It still shows, marked, on the van page and on
  Stock → Special parts to confirm, and Link / One-off still work if it ever needs a real part.
  Counts on the baseline copy: 96 still to order · 160 in all (was 97 · 160).
- New API `POST /api/van-lines/:id/add-parts { parts: [{ text, item_id }] }`; `/api/placeholders` lines carry
  `parts` and `not_part`; `/api/placeholders/count` also returns `not_part` (the lines left out).
No data change at start-up (the parts are worked out when the list is shown).
Files: `src/relink.js` (`textParts`, `partsFor`, `notAPart`, `addTextParts`), `src/inventory.js` (`placeholderLines`,
`placeholderCounts`), `server.js`, `public/stockcheck.js` (`placeholderPanelHtml`, `addPartsDialog`),
`public/purchasing.js`, `public/styles.css`.

**user-r4-7 — "N to check" on To order matches the Check tab.**
"Battery Stop · 47 to check" against "7 order numbers, 75 parts": both were right. 47 are the parts for the vans in
that section, 75 are all the parts on those 7 order numbers (other vans too). Now the supplier line says
"47 to check (75 in all)", the row inside says "47 to check for vans in this list · 75 in all on these 7 order
numbers", and the Check tab it opens says "Showing the 7 order numbers for Battery Stop from the to-order list:
75 parts in all — 47 of them for the vans in Order now." When the two numbers are the same only one is shown.
Files: `public/purchasing.js` (`renderOrderTab`, `renderCheckTab`).

**user-r4-8 — suppliers with nothing to order are no longer their own blocks under Order now.**
Apex RV, NCE and Purple Line ("0 lines · N to check") are now one small line at the end of the section:
"Only to check (nothing to order): Apex RV (2), NCE (2 · 4 in all), Purple Line (7 · 12 in all) – see Check: already
ordered?". Each name opens the Check tab on its order numbers. Same in Coming up / Later / No date, and for "No
supplier set" when it has only lines to check. "N suppliers — click one" counts only suppliers with lines to order.
Files: `public/purchasing.js`, `public/styles.css`.

**Phone (this batch's screens), under 600px wide only — desktop unchanged:**
- To order: an opened supplier's lines are small cards (tick, part, van + "needed by / order today", amount) instead
  of a 5-column table squeezed to one letter per line; the supplier's facts ("14 to check (23 in all)") wrap instead
  of being cut off; the "Only to check" line wraps.
- Special parts lists (Purchasing, Stock, van page): each line is a card (text, its parts, amount + status, buttons).
- "Add each part" dialog fits the phone (one box per part, full-width search).

**Tested (batch 2; port 3410; copies under %TEMP%\fs-tools\v2\sp-build-r1-fixes-2):**
- Copy already cleaned up by the old code: at start-up only `po_dates` ran — 37 changes; all 37 plan POs show
  "unknown (from plan)". Fresh baseline copy: step 10 dated no plan PO, `po_dates` 0 changes; "Yes, all on order" for
  Battery Stop made 8 POs, all "unknown (from plan)" (45 of 45 plan POs).
- Add each part: ST0381 cooker (both parts) → plan line became Induction cooker plus a new Camec line, "plan line
  done"; ST0391 taps (1 of 2) → new Tapware black line, plan line stays with 1 part left and the added one shown "on
  this van"; the same part twice is refused. Special parts 96 → 95 still to order.
- To order vs Check: Caravan & Camping "19 to check (35 in all)" → Check tab "7 order numbers … 35 parts in all — 19
  of them for the vans in Order now"; Purple Line "(7 · 12 in all)" → "2 order numbers … 12 parts … 7 of them".
- Phone 375×812: To order, Special parts, van page, Add each part dialog — no sideways scroll. Desktop 1280 wide:
  To order table, the "Only to check" line and Special parts keep their layout.
- `npm test` (4 pass); node --check on every changed JS file; Dashboard, Stock, van page, PO page, Clean-up report,
  worker screen and Excel export all load.

Carrying over to the office PC: copy the changed files. At the next start the clean-up runs one new step
(`po_dates`, backup first) — nothing to run by hand.

### Batch 3 — customer-supplied parts on dealer orders, "merge all" that moves nothing, dates on "Yes, all on order", spare van POs shown (user-r4-9, check-r4-1 … check-r4-3)

**user-r4-9 — "customer sending / customer supply / supplied by customer" on a dealer order (New dealer order).**
No dealer PDF was at hand, so this was built and tested on the order text in `_extracted/st0367.pdf.txt` (fed to the
same preview the PDF goes through).
- New `customerSays(text)` in `src/lineState.js`: `'auto'` for the plain wording the system already acted on
  ("customer supply", "supplied by customer(s)", "cust supply"), `'suggest'` for the wider wording ("customer sending
  black Jack maxi", "customer to supply", "customer will send", "provided by customer"). Not matched: "customer will pay
  extra", "as per customers request", "customers bbq", "customer will leave on while travelling".
- Parts list on the preview: a line whose order text says so shows **"The order says the customer sends / supplies
  this. [Customer supplies]"** — one click marks it (chip "Customer supplies", free stock shows "–", it drops out of
  "not fully in stock"); **Undo – we supply it** puts it back. Plain "customer supply" lines start marked (as before)
  and can be undone. A blue line above the list counts them ("1 line on this order says the customer supplies the part:
  1 marked …"), with **Customer supplies – all N** when there are two or more.
- Check by hand (options no parts rule covers, e.g. "JOCKEY WHEEL: customer sending black Jack maxi"): the same
  one-click button; when saved, the van gets a reminder "Customer supplies — Jockey Wheel: customer sending black Jack
  maxi (nothing to order – check it has arrived before fitting)" for that trade (once per option; a revised order
  updates it). The save message says how many.
- Saving: `POST /api/vans` takes `customer_items` (accepted), `normal_items` (plain wording undone) and
  `customer_fields` (Check-by-hand options). The line is made "Customer supplies" (nothing ordered or set aside) and
  logged as 'dealer order' in its history ("Customer supplies – accepted on the dealer order ("…")"); an undo is logged
  too, so re-running the rules never undoes the office's answer. Not offered for vans whose parts come from the plan.
- Note: a rule line that joins two order options (e.g. ceiling fans "customer sending 2x white; 1 in each Bunk white")
  is one line — marking it marks all of it; the text is shown so the office can decide.
Files: `src/lineState.js`, `src/inventory.js` (`previewOrder`, `createVan`, `applyRules`), `src/layout.js`
(`customerReminders`), `server.js`, `public/app.js` (`showPreview`), `public/styles.css`.

**check-r4-1 — a forced "Merge all" that moves nothing is not a merge (`src/relink.js` `linkLine`).**
ST0375: the pelmet plan line forced into the SLIDE-DOOR-KIT line (both already received) moved 0 and kept 1, but still
wrote "merged from the plan line …" plus the plan line's own "probably not the same part as this van's Sliding door rail
+ pelmet line" on the kit line, set its merged plan column and logged a 'merged' row.
- Now, when nothing would move (no room on the van's line or nothing on the placeholder, nothing fitted on the plan
  line, and the plan line keeps its whole need) the van's line is **not touched** — no "merged from" note, no merged
  column, no 'merged' history row. Result `kept`; the office sees **"Nothing moved – both lines already have a part for
  this van; the plan line stays to check"**. The plan line stays "to confirm" with one note "to check: merge with this
  van's "…" line asked, but nothing moved – both lines already have a part for this van" (shown as its flag on Special
  parts) and a 'flag' history row. The merge question already says "Nothing would move …" for such a line
  (`linkPreview` → `nothing: 1`); "link all with this text" counts them separately.
- A real merge never copies the plan line's warnings ("possible duplicate of …", "two deliveries were received … probably
  not the same part …", "to check: …") onto the line it merges into (`withoutFlags`); the rest of its note is kept.
- **Migration — start-up step `merge_notes` (`tidy_merge_notes_v1`; once, backup first, in the Clean-up report):** for
  merges already made this way a note is ADDED, nothing removed (old notes, merged columns and history stay): a line whose
  note warns about itself gets "the warning above came with the plan line merged in – it is about this line itself,
  nothing to check here"; a 'merged' row that moved nothing gets its line noted "nothing moved in the merge from the plan
  line … (date) – both lines already have a part for this van; the plan line stays to check". Baseline copy: 0 changes;
  a copy with the ST0375 forced merge done by the old code: 2 changes; second start: not run again.
Files: `src/relink.js`, `src/tidy.js`, `src/inventory.js` (`LINK_FLAG_RE`), `public/stockcheck.js` (`confirmMerges`,
link messages, `LINK_FLAG_TEXT`), `test/merge-and-shortages.test.js` (the round-4 test now expects `kept`).

**check-r4-2 — "Yes, all on order" asks for the dates (Purchasing → Check: already ordered? → Yes, all on order).**
- The dialog has **Ordered on** and **Expected by** (both today by default, each with "not known"). They are written on
  every PO it creates; a PO already in the system keeps its own dates. "not known" ordered = "unknown (from plan)" as
  before.
- A new PO from "Yes, all on order" with no expected date is put on **POs to check** as **"no delivery date"** (it is
  marked "(Yes, all on order)" in its notes, `poProblems`). Typing the date on the PO, or "Looks right", clears it.
  POs with an expected date show under Overdue deliveries once late, as any PO.
- Found while testing: Coast to Coast could not be answered at all ("Nothing left to answer for that order number")
  because one van has the same part on two order numbers (ST0390 service doors on 137 and 143) — answering the first
  made the second look already answered and the whole batch stopped. The batch now answers every line that was waiting
  when it started (`stillOpen`). Single "Yes" is unchanged.
- API: `POST /api/check-ordered/all` takes `ordered_at`, `expected` ('' = not known; a bad date is refused).
- Not changed: POs made by "Yes, all on order" before this version cannot be told apart from single "Yes" POs, so they
  are not flagged after the fact.
Files: `src/inventory.js` (`answerOrdered`, `answerOrderedMany`, `poProblems`), `server.js`, `public/purchasing.js`
(`yesAllFlow`), `public/styles.css`.

**check-r4-3 — another van's spare PO covering a line is shown (van page, item page, POs to check).**
- `shortages()` now records, PO line by PO line, what covers each van line from a shelf PO or another van's spare PO
  (returned as `cover`, and `covered_by` on To order rows). It is worked out each time (nothing stored), so it is always
  current. The numbers are worked out exactly as before (Order now on the baseline copy: 107 parts, unchanged).
- Van page: a line fully covered that way shows **"Ordered – PO 50, Caravan & Camping (ST0367's, spare)"** instead of
  "Not ordered" (hover says why); a partly covered line says "1 of 2 coming on PO 50 (…) – ST0367's, spare" under its
  status.
- Item page: a box **"Coming on other vans' POs"** — "PO 50 Caravan & Camping – ST0367's line is spare → covers
  ST0390" — and under "Needed by vans" the covered van's row says "ST0390: coming on PO 50 (…) – ST0367's, spare".
- **POs to check** also lists open POs with lines still coming for a finished or cancelled van: "1 still coming for
  ST0380 (van finished) – counted as spare for other vans" (shelf parts), or "– bought for that van, no van needs it now"
  (per-van parts, never handed on by themselves). "Looks right" takes it off the list. The count on the Dashboard, the
  "to check" chip on the PO list and the PO page banner use the same rule (`PO_TO_CHECK_SQL`). Baseline copy: none
  (16 POs to check, as before).
- `getVan` / `itemDetail` use `shortagesCached()` (worked out again only after any database change), so the van page
  stays quick.
Files: `src/inventory.js` (`shortages`, `coverText`, `lineCover`, `shortagesCached`, `getVan`, `itemDetail`,
`posToCheck`, `getPO`, `listPOs`, summary count), `public/purchasing.js` (`lineStatusHtml`, PO list / PO page),
`public/app.js` (item page `spareHtml`, Dashboard wording), `public/styles.css`.

**Phone (this batch's screens), under 600px wide only — desktop unchanged:**
- Van page parts list as small cards: the part, then "Need / Set aside / Issued" on one line, then the status (with the
  spare-PO text), then the buttons — no sideways scrolling to see the status.
- POs to check: long reasons wrap instead of being cut off. "Yes, all on order": the two date boxes stack full width.
- Item page: the "Needed by vans" table fits the phone; the "coming on PO …" note has its own row.
- New dealer order: the customer-supplies line and buttons wrap under the part.

**Tested (port 3410; copies under %TEMP%\fs-tools\v2\sp-build-r1-fixes-3*):**
- ST0375 forced merge with the old code reproduced, then the new start-up step added the 2 notes; with the new code the
  same "Merge all" → `kept`, kit line unchanged, no 'merged' row. A real merge (dup flag on the plan line) → no flag on the
  van's line.
- Yes-all: E time with no dates → 10 POs "no delivery date" under POs to check (16 → 26); typing a date clears one;
  Ranger with dates → written, not flagged; Coast to Coast (11 order numbers, same van+part twice) now works; in the
  browser Aussie Traveller "ordered 12/10, expected not known" → 16 POs with those values.
- WHEEL-BRACE +1 → ST0390 shows "Ordered – PO 50 … (ST0367's, spare)" on its van page and on the item page; ST0380 set
  to completed → PO 50 and 11 other POs listed "still coming for ST0380 (van finished)"; "Looks right" removes one.
- Dealer order preview from the st0367 text: JOCKEY WHEEL / VANITY SINK (Check by hand) and a ceiling-fan rule line
  with "customer sending" offered; accepted → line "Customer supplies" (logged, kept after Rebuild), reminders added;
  the plain "wpc supplied by customer" undone → stays normal after Rebuild.
- Phone 375×812: van page cards, POs to check, Yes-all dialog, item page, New dealer order preview — no sideways scroll.
  Desktop 1280: same screens keep their layout.
- `npm test` 9 pass (5 new); node --check on every changed JS file; Dashboard, Stock, Vans, Production plan, Clean-up
  report, worker screen and Excel export all load.

Carrying over to the office PC: copy the changed files. At the next start the clean-up runs one new step
(`merge_notes`, backup first; nothing to change on the current data) — nothing to run by hand.

### Batch 4 — a lead time of only spaces is "not known" (check-r4-4)

**check-r4-4 — blank-looking lead time no longer saves as 0 days confirmed (`setSupplierLead`, `src/inventory.js`).**
`PUT /api/suppliers {name:'Arizon', lead_days:'   '}` saved 0 days, confirmed (`Number('   ')` is 0). A text value is
now trimmed before the "empty" check, so spaces count as an emptied box: back to the 14-day default, not confirmed
(same as `''` or no value). " 7 " still saves 7 days confirmed; 0 typed as a number or "0" still means 0 days
confirmed; "abc" is still refused. No data change and no start-up migration (a supplier already saved this way keeps
its value; type the lead time again or empty the box).
Files: `src/inventory.js`.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r1-fixes-4):** Arizon "21" → 21 confirmed; "   " → 14 not
confirmed; " 7 " → 7 confirmed; 0 → 0 confirmed; "" → 14 not confirmed; "abc" → refused, unchanged. node --check
`src/inventory.js`; the server starts, the office screen and worker screen load.

Carrying over to the office PC: copy `src/inventory.js`. Nothing runs at start-up and nothing to run by hand.

### Phone batch 1 — Purchasing fits a phone, a top bar with Menu, a Dashboard that starts with "Today", tables as cards, one "still missing" number (C1 … C4)

Everything that changes the layout is under `@media (max-width: 600px)` (the top bar under 900px). The desktop
pages keep their layout; the only things a PC user sees change are the Dashboard headline wording, the "N still
missing" line under each van's parts bar, the "Still missing" tile on the van page, "How this list works" (open) on
To order, and the reminder × that now asks first.

**C1 — Purchasing on phones** (`public/purchasing.js`, `public/stockcheck.js`, `public/app.js`, `public/styles.css`)
- To order lines are small cards: the tick on the left over 3 rows, the part + spec across, then the van #, then
  needed-by / order-by, with the amount box on the right (grid 36px | 1fr | auto; `table.pur` is `table-layout:auto`
  on phones, every cell `width:auto`, no borders). Part names no longer print one letter per line.
- A supplier wraps to two lines: name + counts, then lead time and a full-width 44px "Create PO for ticked".
- Special parts and "Waiting on a decision" tables are wrapped in `.table-wrap` and get `ph-table`: each line is a
  card (text, then amount + status side by side, then the buttons at 50% each, 44px tall) — Link / One-off are no
  longer cut off by the panel.
- The 4 tabs stay on one line and scroll sideways (all tab strips on phones, 44px tall).
- The To order explanation is folded into "How this list works" (open on a PC, folded on a phone; on a phone it also
  lists what Order now / Coming up / Later / No date mean, which the section headers no longer repeat there). On a
  phone the 5 filters sit behind "Filters (n on)". The first supplier is now on the first screen (460px down on 390×844).
- The chosen tab is in the address: `#/purchasing/order`, `/check`, `/special`, `/po` (kept with `replaceState`), so
  Back from a PO or van returns to the same tab. `#/purchasing` alone still opens the last tab, and Dashboard links
  still open the tab they point to.
- Purchase orders list as cards (see C4).

**C2 — Top bar with Menu under 900px** (`public/index.html`, `public/styles.css`, `public/app.js` route / `setMenu`)
- The 285px block of 12 links is gone. `.side` is a sticky 52px bar (safe-area aware): horse mark, the page name (set
  in `route()`), and a 44px "Menu" button with one red badge = Purchasing count + Stock checks count.
- Menu opens the links as a full-screen Espresso list with 48px rows; Dashboard, Vans, Factory floor and Purchasing
  come first. Picking a page (or the page you are on, or the worker screen), Escape, or widening past 900px closes
  it; the page behind does not scroll while it is open.
- A page opened from a link now starts at the top (the old page's scroll position used to carry over on phones).
- Above 900px nothing changes (the bar's pieces are hidden there).

**C3 — Dashboard** (`public/app.js` renderHome / needsActionHtml / goLiveHtml, `public/factory.js`, `public/styles.css`)
- 900px query: `.grid2/.grid3` use `minmax(0,1fr)` and their children `min-width:0`, so wide tables scroll inside
  their own box — the page no longer pans sideways (scrollWidth 390 on 390).
- Phone order: a "Today" row of tiles (vans late · due in 2 weeks · waiting on parts · deliveries overdue), each
  opening that list (the Vans page filtered, with "Showing the 5 vans late … Show all vans", or Purchasing →
  Purchase orders with Overdue deliveries opened); then the van cards; then the to-do panel, reminders, waiting on
  parts…; the go-live checklist starts folded near the end. The PC keeps its order.
- Headline is about vans: "5 vans late · 11 waiting on parts" (both tap through to the Vans list). The counts that
  used to be added into "184 needs action" are listed beside it under "Office to-do", unchanged.
- Reminders: late ones first, then today, then by date. "+ 13 more" is a "Show all 23" button. Long text shows 2
  lines, tap to see it all. The delete × is at the far end of the row (44px on phones, the tick 44px too) and asks
  "Delete this reminder?" — the same on the Factory floor van panel.
- "Waiting on parts" says what it counts: "N to order / on order" per van, with that van's "N still missing" under it.

**C4 — Tables as cards and one "still missing" number** (`src/lineState.js`, `src/inventory.js`, `src/layout.js`,
`public/app.js`, `public/purchasing.js`, `public/factorymap.js`, `public/floor3d.js`, `public/floor.js`,
`public/floor.css`, `public/styles.css`)
- New shared class `cards-sm` (phones): header hidden, each row a card, `td[data-label]::before` labels in --muted.
  - Vans list and Dashboard "Vans by delivery date": "#1 ST0367 · In production" / model / "due 18/9 · 31 days late"
    / full-width parts bar + "57 still missing"; the whole card opens the van; the Build order box (44px) sits on
    the right (Customer hidden on phones). The long build-order explanation folds into "How the build order works".
  - Stock: photo + name with Receive (44px) on the right, then "On hand 8 ea · Free 0 · On order 2 · Short 12 · Still
    to order 10" (empty ones left out); Supplier, Location, Set aside, Reorder at, Last counted hidden on phones.
  - Purchase orders: "PO 29 · Arizon · Open" / "For ST0377, ST0387" / "Expected …  Received 0 / 16", then a
    full-width 44px "Receive…". Ordered date and line count hidden on phones.
  - Van page tiles: two across on phones, the delivery date no longer runs out of its tile.
- **One "still missing" count**: `STILL_MISSING` (lineState.js) = a van line where needed − set aside − issued > 0,
  customer supplies / to be decided left out; `stillMissingByVan()` (inventory.js) splits it into to order / on
  order · to check (plan order number not answered) · special (as-per-plan catch-alls). Returned as `still` on
  `/api/vans`, the van page, `/api/layout` (the map badge) and `/api/floor/map`. Used on the factory map badge and
  3D label, the Dashboard van cards, the Vans list ("57 still missing" under the bar, the split on hover), a new
  first tile on the van page ("57 Still missing — 44 to order / on order · 9 to check · 4 special"; the tiles after
  it add up to it), and the worker screen's van cards ("46 parts left for you · 35 still missing" for that trade —
  "parts left for you" stays: it counts parts still to fit, which is a different thing).
- **The off-by-one explained and fixed**: the map badge counted customer supplies / to be decided lines, the Vans
  list did not. ST0375 and ST0393 each have one such line still open, so map 41 / 76, list 40 / 75. Now both say
  40 / 75 (checked: every van's list figure equals its map badge, 0 mismatches). ST0367: 57 everywhere (44 + 9 + 4).
- Small fix: the Vans list no longer prints a trailing " · " when a van has no floor plan.

No data changes and no start-up migration. Nothing to run by hand.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r1-phone-1):** phone 390×844 — Dashboard (Today tiles,
van cards, headline, reminders; scrollWidth 390), Menu open / close and page name, Purchasing To order (supplier on
the first screen, an opened supplier's line cards), Special parts buttons 158×44 side by side, Purchase orders cards,
`#/purchasing/po` → PO → Back returns to the Purchase orders tab, Vans "late" filter (5 vans), Stock cards, van page
tiles, Factory floor, worker screen van list. Desktop 1280 — Dashboard, Purchasing, Vans keep their layout.
`/api/vans` vs `/api/layout` still missing: 0 mismatches. node --check on every changed JS file; `npm test` 9 pass;
`/`, `/floor`, the Excel export and `/api/summary` load.

Carrying over to the office PC: copy `public/index.html`, `public/styles.css`, `public/app.js`, `public/purchasing.js`,
`public/stockcheck.js`, `public/factory.js`, `public/factorymap.js`, `public/floor3d.js`, `public/floor.js`,
`public/floor.css`, `src/lineState.js`, `src/inventory.js`, `src/layout.js`, then restart.

### Phone batch 2 — van page on a phone, worker panels that always show Take, worker home with the bay vans, Back closes windows (C5 … C8)

**C5 — Van page on phones** (`public/app.js` renderVan, `public/styles.css`)
- Tiles: three small tiles across (8px padding, 20px numbers, 10px labels). The first row is "57 Still missing"
  (two tiles wide, with "44 to order / on order · 9 to check · 4 special") and the delivery date.
- The delivery tile now says how late the van is, in the Dashboard's words ("31 days late", red), on the PC too —
  only for planned / in-production vans.
- "Print picking list" is hidden on phones (`no-phone`); the other three buttons sit on one line.
- "Special parts to confirm" and "Waiting on a decision" fold to one line each on a phone (tap to open; an opened
  one stays open when the page redraws after a change). The PC shows them as before.
- Parts list as cards: the part, then its coloured status across the full width, then "Need 1 ea · Set aside 0 ·
  Issued 0" (labels from `data-label`). The Normal / Customer supplies chooser, Edit and Why? are behind a 44px
  "Change…" on each card (they open as a row of 44px buttons; "Close" folds them away). Category headings stay one
  full-width line. No sideways scrolling (scrollWidth 390 on 390).
- The filter box is full width; the status drop-down and + Add part are 44px tall under it.
- New status filter "Missing (not here yet)" = not ordered + on order + to check. On a phone the list opens on it,
  with "Showing the 57 missing · Show all 116" above the list; the drop-down choice is kept when switching tabs.
  The PC still opens on "All statuses" (it can pick Missing too).

**C6 — Worker Take / Book in panels** (`public/floor.js` sheet / flash / takeSheet / extraSheet / borrowSheet /
receiveScreen, `public/floor.css`)
- Bug fixed: the pop-up's rule `.done { position: fixed }` also matched the "✓ Taken" tags (`span.tag.done`), so in the
  Done tab they floated in a pile at the bottom of the screen. The pop-up rules are now `#done …`; the tags sit in
  their cards again (checked with 2 taken parts).
- Panels: `max-height: 92dvh` (room for the phone's own toolbars), flex column, no scroll leaking to the page.
  The main button and Cancel are wrapped in `.sheet-actions`, stuck to the bottom of the screen with the safe-area
  padding and a soft shadow — Take / Book in / Take it for … are always on screen, even with a photo and a note.
  Photos are at most min(300px, 30vh).
- Every panel has a 48px × pinned at the top right (it stays there while the Find panel scrolls).
- Pop-up: above the iPhone home bar (`bottom: calc(16px + safe-area)`); tap or swipe it away (Undo still works);
  it is put away when the worker opens another screen (one shown in the last second, like "Booked in" on the way
  home, stays). The van screen's "Undo last" banner is unchanged.

**C7 — Worker home on a phone** (`public/floor.js` homeScreen / vanCard / vansScreen, `public/floor.css`)
- Under 600px: a big "Back to ST0367 (Bay 3) · 45 parts left for you" at the top (from the `lastVan` the van screen
  already saved; only if that van is still on the list). Then "In the bays": the bay vans as van cards in bay order
  ("Bay 1 · ST0377 … 46 parts left for you"), using the van list's sort (now one `byArea()` helper for both). Then the
  badge key, a "Show map" button (remembered on the phone) with the map fitted to the width (all 6 bays visible,
  no sideways scrolling inside the card), "In the yard" (yard vans as cards), then "Not on the floor".
- A PC or tablet (over 600px) keeps the map at the top as before.

**C8 — Back closes windows; office windows fill the phone** (`public/app.js` modal / route / itemDialog,
`public/floor.js` sheet / route, `public/styles.css`)
- Opening an office window or a worker panel adds a history step. The phone's Back (or the browser's) closes the top
  window / panel and stays on the page — the worker keeps their place on the van. Closing it any other way (×,
  Cancel, Save, outside tap, Escape) takes the step off again quietly, so Back afterwards goes where it used to. A
  window opened straight from another (Item → Receive) re-uses the step; a page change closes any window left open;
  a step left behind by a window closed while opening another page is skipped when Back lands on it. The address
  never changes for a window. Escape now closes only the top window.
- Under 600px office windows are full-screen sheets: no padding, no rounded corners, the title + 48px × stuck at the
  top and the buttons stuck at the bottom (safe-area aware), so Save is always in reach. The first box is no longer
  focused automatically on a phone (the keyboard covered the window); a PC still focuses it.
- Item window: tiles two across; Receive / Count / adjust / Edit item are in the bottom bar on a phone (on the PC
  they stay where they were). `modal()` takes an optional `footerClass`.
- Receive delivery: each van row is a small card — "#8 for ST0393 …", then "2 to come" + the amount box, then
  "arrives [date]" and "supplier cancelled" on their own lines; nothing sticks out past the right edge.

**Small fix:** under 900px the top bar no longer stretches to half the screen while a page is loading (the page
grid's rows are `auto 1fr`).

No data changes and no start-up migration. Nothing to run by hand.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r1-phone-2):** phone 390×844 — van ST0367 (tiles,
"31 days late", parts list starts on Missing with 57 shown, Change… opens / closes, Show all, folds stay open after a
redraw, scrollWidth 390); Stock → item window (full screen, bottom bar), Back closes it and stays on Stock, × then
Back goes to the previous page in one press, Item → Receive → Back closes it; a link out of an open window then Back
twice goes van page → Vans; PO → Receive delivery (390 wide, date / cancelled on their own lines). Worker screen:
home (Back to ST0367, 6 bay cards, Show map fits 350px with all bays), Take panel with photo + note (Take on
screen), Back closes the panel and stays on the van, × closes, 2 parts taken → Done tab tags inside their cards,
pop-up tap-to-dismiss and gone after going home, Find panel × stays at the top when scrolled, Book in on screen for
a per-van part with several vans. Desktop 1280 — van page, parts table, item window (buttons in the window, no
bottom bar, Escape closes), worker home map unchanged. `node --check` on every changed JS file; `npm test` 9 pass;
`/`, `/floor`, `/api/summary`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `public/app.js`, `public/styles.css`, `public/floor.js`, `public/floor.css`,
then restart.

### Phone batch 3 — worker van screen you can trust, deliveries / undo / part places on the phone, office touch basics, factory floor and plan safe for the owner (C9 … C12)

**C9 — Worker van screen** (`public/floor.js` vanScreen / takeSheet / homeScreen / nameScreen, `public/floor.css`,
`src/inventory.js` floorVan / floorStats)
- Which tab a van opens on: the last tab is kept only while the worker stays on the same van (a redraw after a
  take, closing a panel, coming back to it). Another van — or restarting the app — opens on "On shelf" when it has
  any parts there (else "None", else "All"). The old saved `floor.vanFilter` setting is no longer read.
- Honest stock wording: when the shelf has some but every one is set aside for other vans, the part gets an amber
  "Set aside for other vans" tag, and the Take panel says "On shelf but set aside for ST0367, ST0375, LG027 +3 more —
  ask before taking" (the van list comes from the server, in build order). "Not in stock" / "The system shows none on
  the shelf…" stay for a real 0. The middle tab is now called "None for this van".
- Phones (under 600px): reminders fold into one "⏰ 4 reminders · 1 due" row that opens them; opened, each reminder is
  one line (tap it to read it all) and its ✓ sits on the left, away from where the right thumb scrolls. The four
  filter chips share the width with short labels "Shelf 26 / None 19 / Done 0 / All" (all four on screen, 48px tall;
  the PC keeps the long labels). Notes, the name/trade pill and Back are 48px. A big "‹ Back to vans" button at the
  bottom of every van screen.
- Home: "You took 2 parts today · team took 5" (takes only; deliveries are no longer mixed into this count). The
  "that's N today" after a take uses the same count.
- The notes box uses the normal font (it was the browser's monospace). The trade tiles were already buttons; they now
  tell a screen reader which one is picked (`aria-pressed`) and are `type="button"`.

**C11 — Deliveries, undo, part places** (`public/floor.js` receiveScreen / bookInSheet / findSheet / placeSheet /
takeSheet / celebrate, `public/floor.css`, `server.js`, `src/inventory.js` receive / receiveDelivery / undoTake /
undoReceive / floorWaiting / setItemPlace)
- Delivery with nothing typed shows "Waiting for": every part still to come on open purchase orders (46 in the test
  copy), grouped under the supplier (unknown supplier last), with "18 ea on order" and the due date when the PO has
  one. Typing searches all parts as before (a part on order shows its "on order" amount and supplier).
- The amount starts at what is still on order ("18 ea on order from Allytech" → 18), not 1.
- After Book in the worker stays on Delivery with the search cleared, ready for the next part; "Done" (next to the
  search box) goes home.
- The "Booked in 18 × …" pop-up has Undo (9 seconds, like takes). Undo puts back everything the booking changed: the
  shelf count, the PO lines it ticked off (and re-opens a PO it closed), and what it set aside for vans (logged as
  "delivery undone"). It is refused after 15 minutes, or when anything else has happened to that part since (a take,
  a count, another delivery) — "ask the office". New route `POST /api/floor/receive/undo`; `/api/floor/receive` now
  answers `{ vans, movement_id }` (the phone also still reads the old plain list). The office Receive is unchanged
  (its answer just gains `movement_id`).
- Put back on shelf: the phone keeps a list of today's takes from this phone. Opening a taken part (Done tab) shows
  "Taken from this phone today: 1 × at 1:08 — ↩ Put back on shelf", using the same undo as the pop-up. The server
  allows this until the end of the day, as long as that part wasn't booked in or counted since; otherwise — and for
  takes from other phones or earlier days — "Taken earlier — too late to put it back from here. Ask the office." The
  panel still offers "Take 1 more for …" (broken / lost part). `POST /api/floor/undo` takes `put_back: true` for
  this; without it the 15-minute rule is unchanged.
- Find a part → "Set place": tap the rack on the small map or one of the rack buttons (Rack A–D, Timber rack, Probond
  / sheet stack — the storage areas drawn on the floor map), type a shelf if wanted ("Shelf 3"), Save place. Saved to
  the part's rack (`items.area_id`) and shelf (`items.location`), logged in the part's history ("set on the floor").
  The place then shows on the "On shelf · Rack A · Shelf 3" tag and in the Take panel. Nothing is filled in
  automatically. New route `POST /api/floor/items/:id/place` (a rack that no longer exists is refused).
- "Needed by" rows in Find a part are buttons now: tapping one opens that van with the search set to the part (on the
  "All" tab, and shown even if it belongs to another trade).

**C10 — Office touch basics** (`public/styles.css`, `public/app.js`, `public/purchasing.js`, `public/stockcheck.js`,
`public/index.html`)
- 16px text in every box on screens up to 900px wide and on any touch screen (iPhones / iPads no longer zoom in on a
  count, receive or build-order box).
- Windows don't put the cursor in the first box on a touch screen (a tablet too), so the keyboard doesn't cover them.
- `inputmode="decimal"` on Purchasing → To order amounts; `inputmode="numeric"` on the Vans build-order boxes (whole
  numbers, so no "." key).
- Touch screens (`pointer: coarse`): buttons at least 44px (small ones 38px), link buttons with more padding, the ×
  of a window at least 44px (48px on a phone), ticks and radio buttons 22px, tabs 44px, "Check: already ordered?"
  lines 8px more padding, the supplier fold arrow 44 × 44. On Purchasing at 390px no visible button / tick is under
  36px tall (0 of 314).
- Phones: base text 15px, small text 13px, table headings 12px, chips 12.5px; the faint grey and hints use the darker
  muted grey (readable outside). Messages (toasts) run across the bottom, above the iPhone home bar.
- Help that was only in a tooltip shows as a hint line on touch screens: under "One-off" (Special parts) and under
  "Why?" (van page, inside Change… on a phone). Touch wording: "Tap to choose the PDF" (New dealer order), "Add photo
  uses the camera" (item window), "Tap a cell to see it…" (Production plan), "Tap a van for details" (Factory floor).
  A mouse PC keeps the click / drag / Ctrl+V wording.
- `index.html`: `theme-color` #201e16 and `viewport-fit=cover` (the page keeps clear of the notch when the phone is
  turned sideways).

**C12 — Factory floor, Production plan, change buttons** (`public/factory.js`, `public/app.js` renderPlan /
planCellDialog / renderVans, `public/styles.css`)
- Factory floor on a phone: a "Bays" list above the map ("Bay 1 · ST0377 · 86 still missing · 1% done", tap → van
  page; an empty bay says so) and a warning line "⚠ In production but not in a bay: ST0380, ST0382". The map scrolls
  sideways in its own box at a readable 720px. 3D view and Edit layout are hidden on a phone (only the 2D map, so
  three.js never loads there); after tapping a van the panel's title no longer hides under the top bar.
- Touch screens: tapping a van shows its details; dragging vans is off until "Move vans" is pressed ("✓ Done moving"
  turns it off); the hint reads "Tap a van for details". "Not on the floor yet" says "Tap a van to place it" (HTML
  drag and drop, which iPhones don't do, is off there).
- Change buttons on a phone sit behind "More actions ▾": Move the line along (Factory floor), Gone out the gate and
  Already fitted (van panel), Re-prioritise stock (Vans). Each still has its own confirm step as before.
- Production plan on a phone: only the chassis column (110px) is pinned, with the model and "due 18/09" under the
  chassis; the Van and Due columns are hidden; the grid box is the screen height minus the top bar; "Show columns
  matching…" comes first, full width. On a touch screen a tap that ends a scroll doesn't open a cell, and in the cell
  window the first tap on Mark ordered / received / fitted only asks ("Tap again: Mark fitted", 4 seconds).
- A mouse PC keeps everything as before (checked at 1280: map with drag, 3D / Edit layout, buttons where they were).

No start-up migration and nothing to run by hand. What is saved: a delivery booked on the floor now keeps an undo
record in its movement (the `movements.undo` column takes already use), and "Set place" writes the part's rack /
shelf (the same fields the office Factory floor page sets). Nothing existing is changed or removed.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r1-phone-3):** phone 390×844 (touch) — worker: van
ST0367 opens on "Shelf 26" with an old saved "none" tab ignored; chips 4 × 86px, 48px tall, page 390 wide; reminders
fold / open, ✓ on the left; ST0380 None tab: Ceiling fan "Set aside for other vans" + the "set aside for ST0367,
ST0375, LG027 +3 more" note, real zeros still "Not in stock"; took a part → Done tab kept after the redraw → Put back
on shelf after ageing the take 40 minutes (worked, list empty after); API: plain undo of a 30-minute-old take →
"Too late", with put_back → done, again → "Nothing to undo"; Delivery: 46 waiting, by supplier, Awning plate starts at
18, Book in stayed on Delivery with the search empty, Undo → shelf count, 9 PO lines and set-asides back exactly as
before (checked in the database); Find a part → Set place by tapping Rack A on the map + "Shelf 3" → shown in the
part and on the van's "On shelf" tag; Needed by → ST0382 with the search set; an unknown rack refused. Office:
Factory floor bays list, warning, map 720 in a 356 box, tap a van → panel with More actions; plan (chassis cell with
model / due, filter first, cell "Tap again"); Vans (More actions, build order 16px numeric); Purchasing (390 wide);
New dealer order touch wording; van page Change… shows the Why? hint. Desktop 1280 (mouse) — factory floor, Vans,
worker van screen as before; inputs 14px, root 14px. `node --check` on every changed JS file; `npm test` 9 pass;
`/`, `/floor`, `/api/summary`, `/api/export/plan.xlsx`, `/api/floor/waiting` load.

Carrying over to the office PC: copy `server.js`, `src/inventory.js`, `public/index.html`, `public/styles.css`,
`public/app.js`, `public/purchasing.js`, `public/stockcheck.js`, `public/factory.js`, `public/floor.js`,
`public/floor.css`, then restart.

## Small fixes & phone round 2

### Fixes batch 1 — special parts "still to order", one split on the van page, Excel "Still to order", dates on existing POs (sp-r1-1 … sp-r1-4)

**sp-r1-1 — "Special parts still to order" no longer counts lines already on order** (`src/inventory.js`,
`public/purchasing.js`, `public/app.js`)
- Why: the list titled "Special parts still to order" showed lines with "on order" next to them (ST0367 L&S Doors and
  Tool Box, ST0393 Kitchen sink / L&S Doors, LG027 L&S Doors: 7 of the 96), and answering "Yes, all on order" for
  Ranger moved LG024 "2 Ranger Order 123" from "to check" into "still to order" (96 → 97).
- Now one rule (`SPECIAL_TO_ORDER` / `SPECIAL_ON_ORDER` in inventory.js): a special line is still to order when it is
  a real shortage (not customer supplies / to be decided, not waiting on "Check: already ordered?") and its van's own
  open PO does not cover what is still needed (on order for the van < needed − set aside − fitted). A covered line
  is "on order", as the Stock "Still to order" column already counts it. `placeholderLines` gives each line
  `is_short` (still to order), `is_on_order` and `is_check`; `placeholderCounts` gives `short`, `on_order`, `check`
  and `all`.
- The Purchasing → Special parts tab (title and badge), Stock → Special parts to confirm and the van page's Special
  parts fold all use it and say the parts: "89 still to order · 7 on order · 14 to check · 160 in all" (on the fresh
  copy: 96 → 89, the 7 lines with a van PO now count as on order). Answering Yes now lowers the number or leaves it
  as it is (Ranger: 89 → 89, LG024's Order 123 line from "to check" to "on order").

**sp-r1-2 — one split of "still missing" on the van page** (`src/inventory.js` stillMissingByVan, `public/app.js`)
- Why: ST0367 showed "56 still missing – 44 to order / on order · 8 to check · 4 special" next to tiles of 18 Waiting
  on PO, 29 Still to order and 9 Check. Special lines were their own group in the split, but counted by status in the
  tiles (Roof Bow "121 / NCE" was "special" in one and "check" in the other).
- `stillMissingByVan` now splits by status only: `check` = waiting on "Check: already ordered?" (special lines
  included), `order` = the rest (to order or on order), so order + check = missing. `special` is an "of which"
  count (plus `special_order` / `special_check`).
- Van page: the Still missing tile says what it is made of in the words of the tiles next to it — "57 still missing
  – 18 waiting on PO · 29 still to order · 10 to check · 4 of them special parts" (18 + 29 + 10 = 57, the Check tile
  says 10). The Special parts fold says "1 still to order · 2 on order · 1 to check · 7 in all" (the 4 special parts
  missing, plus 3 already set aside). Checked on every active van (19): waiting on PO + still to order + to check =
  still missing and to check = the Check tile on all of them, and the special parts counted by status = the "of them"
  number.
- Elsewhere (Dashboard, Vans list, factory map, worker van cards) the total "still missing" number is unchanged;
  the hover text now reads "47 to order / on order · 10 to check · 4 of them special parts". Dashboard → Waiting on
  parts: "47 to order / on order: Fridge, … (+ 3 special parts)" (the names listed are the normal parts, as before).

**sp-r1-3 — Excel Stock sheet: "Still to order" as on the Stock screen** (`src/exportXlsx.js`)
- Why: the sheet's "Suggested order" took every PO for the part off the shortfall (one van's PO against another
  van's shortage), so it said to order less than the screen for 7 parts (SVC-DOOR 0 vs 4, RADIO-ANT 0 vs 2,
  LIGHT-READ-BLACK 2 vs 6, WM-AT-3KG, SKYLIGHT-450, SVC-DOOR-TOILET, BMV-712 0 vs 1), and gave a figure for special
  (PLAN-…) parts that the screen leaves out.
- New "Still to order" column next to "Short for vans", from `stillToOrderByItem()` (the same numbers as the Stock
  screen and Purchasing → To order): blank for special parts, 0 when what is on order covers the shortfall, blank
  when nothing is short. The old "Suggested order" column is removed (shelf top-ups to the reorder level are on the
  "To Order" sheet). Checked: all 263 Stock rows equal the screen (0 mismatches); the 7 parts above now match.

**sp-r1-4 — "Yes, all on order" writes the typed dates on POs already in the system** (`src/inventory.js`
answerOrdered / poProblems / checkOrdered, `public/purchasing.js` yesAllFlow)
- Why: when an order number already had an open PO (e.g. from the plan's pink cells), Yes-all added the lines but
  wrote neither date nor a "no delivery date" flag, so those lines never showed under Overdue deliveries or POs to
  check (White Vision 11 and 12, Onex 08).
- Now, for an existing PO, a BLANK ordered / expected date is filled with the date typed — a date already there is
  never overwritten. If it still has no expected date it gets the "(Yes, all on order)" note line and is flagged
  "no delivery date" on POs to check, like a new Yes-all PO. `poProblems` "no delivery date" now looks for an open
  line with no date of its own (it used to need every line without one), so parts added to an existing PO count.
- The window says it before you press Yes: "add to PO 11 (already in the system, no dates yet)" / "(…: expected
  5/11)", the date boxes also show when only existing POs have blank dates, and the hint reads "Written on the 2 new
  POs and the blank dates of the 2 POs already in the system (a date a PO already has is kept)". After saving, when
  existing POs were added to, a "Saved" window lists each one: "PO 11: ordered date set to 19/10, no delivery date –
  listed under POs to check" / "PO 08: ordered date set to 19/10, expected date set to 5/11" / "kept its expected
  date …". With only new POs it is the short message as before.

No start-up migration: nothing stored changes shape. Existing POs are only changed when someone answers Yes.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r2-fixes-1):** API — special count 96 → 89 still to
order + 7 on order, no line in the still-to-order list has a van PO covering it; Ranger Yes-all (18 lines, ordered
19/10, expected 2/11) left it at 89 (on order 7 → 8); White Vision with no dates: new POs 08 / 10 and existing 11 /
12 all on POs to check as "no delivery date"; Onex with ordered 19/10, expected 5/11: existing PO 08 got both dates
and is not flagged, new PO 06 got them too. Van page check on all 19 active vans (0 mismatches). Excel Stock sheet vs
`/api/items/still-to-order` + `/api/items` (0 mismatches). Browser phone 390×844: van ST0367 tiles and fold,
Purchasing → Special parts title, Yes-all window for White Vision (existing POs with "no dates yet", the "Saved"
list, OK back to the Check tab); desktop 1280: van page as before; no console errors. `node --check` on every
changed JS file; `npm test` 9 pass; `/`, `/floor`, `/api/summary`, `/api/layout`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `src/inventory.js`, `src/exportXlsx.js`, `public/app.js`,
`public/purchasing.js`, then restart (and Ctrl+F5 once in the browser so it picks up the new screens).

### Fixes batch 2 — Undo can never hit another worker's take, one "special" split on the van page, van parts list fits a tablet (sp-r1-5, planner-r1-1, planner-r1-3)

**sp-r1-5 — a phone's Undo / "Put back on shelf" can't undo somebody else's take or delivery** (`src/db.js`,
`src/inventory.js` undoTake / undoReceive, `server.js` `/api/floor/undo` + `/api/floor/receive/undo`, `public/floor.js`)
- Why: movements used `INTEGER PRIMARY KEY` without AUTOINCREMENT, so deleting the newest movement (what Undo does)
  freed its number and the next take or delivery got it again (undone delivery 722 → next delivery 722). A phone
  that still listed the old number (Undo went through but the reply was lost on the Wi-Fi) could then "Put back on
  shelf" another worker's take for another van.
- Two guards, either one is enough:
  1. **Numbers are never reused.** Start-up migration in `src/db.js` (`movementsAutoincrement`): when the
     `movements` table has no AUTOINCREMENT it is rebuilt once with `id INTEGER PRIMARY KEY AUTOINCREMENT` — the
     same columns (taken from the table's own definition, so later-added columns stay), every row with its own
     number, the indexes put back — inside one transaction, checked (row count and quantity total must match, or it
     rolls back and leaves the table as it was). The counter starts above the highest number used (also the "last
     movement" a rack count noted). New databases are created with AUTOINCREMENT. It logs "Movements: numbers are
     never reused from now on (… movements kept, next number after …)" once; later starts do nothing.
  2. **The phone says what it is undoing.** Undo / Put back on shelf send `line_id` and `van_id` with the movement
     number; Undo of a delivery sends `item_id`. The server answers "Nothing to undo — it was already undone" (404,
     nothing changed) when the movement is for another line, van or part. The phone already forgets a take on 404.
     (An older phone that sends only the number still works; guard 1 covers it.)
- Undoing a delivery now also leaves a line in the part's history (allocation log "delivery undone", on hand before →
  after, with the time it was booked and the reference), since the movement itself is removed. Undoing a take was
  already logged ("floor take undone").
- Migration: yes — the one-off `movements` rebuild above, at start-up, no information lost (same rows, same numbers).

**planner-r1-1 — the van page's "special parts" numbers say the same thing in both places** (`public/app.js`
renderVan, phCountText)
- Why: under "57 Still missing" the special parts were one number ("4 of them special parts"), while the Special parts
  fold below said "1 still to order · 2 on order · 1 to check · 7 in all" — so it looked like 4 vs 1 (or 3) special.
  On ST0384 they really differed: 9 special in the small line, 7 + 1 in the fold, because a plan cell that is only
  the dealer's name ("CHASSIS: Caravan Treading Center") is never "still to order" in the fold but was not mentioned.
- Now the small line splits the special parts with the fold's own rule and words: "18 waiting on PO · 29 still to
  order · 10 to check — 4 of them special parts (1 still to order · 2 on order · 1 to check)". The fold (and the Stock
  tab's special-parts count) adds "· 1 not a part" when there is one: ST0384 reads "… — 9 of them special parts (7
  still to order · 1 to check · 1 not a part)" next to a fold of "7 still to order · 1 to check · 1 not a part · 10 in
  all". The fold's extra lines ("in all") are the special parts already set aside.
- Checked on all 19 active vans: waiting on PO + still to order + to check = still missing, and the special split in
  the small line = the fold's still to order / on order / to check / not a part on every van (0 differences, nothing
  left over). No data change.

**planner-r1-3 — van parts list fits a tablet without scrolling sideways** (`public/styles.css`)
- Why: the card layout only started at phone width; on a 768 px tablet the table was 951 px in a 719 px box, so
  Normal / Customer supplies, Edit and Why? were off to the right on every line.
- From 601 px to 900 px wide (and up to 1100 px on a touch screen — a tablet turned sideways), each part line is a
  two-column card: the part (photo, chips, "for:", spec, notes) on the left; its status, then "Need 1 ea · Set aside 1
  · Issued 0", then the Normal / Customer supplies drop-down, Edit and Why? on the right — always shown, no "Change…"
  tap needed. The van page's due-date tile uses a smaller figure there so "18/09/2026" fits its tile (it made the
  page 1 px wider than the screen).
- Only `screen` widths: the printed picking list and a PC with a mouse wider than 900 px keep the table exactly as
  before (1280 px: same column widths as before). Phones keep their own cards.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r2-fixes-2):** start-up rebuilt `movements` (676 rows,
same numbers, 4 indexes back); a second start did nothing; `npm test` (new empty database) 9 pass. API scenario: take
A (ST0367 diesel heater, movement 716) → Undo → take B on ST0380 got 717 (not 716) → replaying the first Undo with
put_back → 404 "Nothing to undo"; B's movement with A's line/van → 404, nothing changed; B with its own line → undone.
Deliveries the same way (718 undone, next 719; replay 404; 719 with another part → 404). Browser: tablet 768×1024 van
ST0367 — 116 lines, none past the box, page not wider than the screen, Missing filter shows 57; 1024 px with a mouse
and 1280 px — table unchanged; phone 390×844 ST0384 — small line and fold match, cards as before; `/floor` loads.
`node --check` on every changed JS file; `/`, `/floor`, `/api/summary`, `/api/layout`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `src/db.js`, `src/inventory.js`, `server.js`, `public/app.js`,
`public/floor.js`, `public/styles.css`, then restart (the movements rebuild runs once; it prints the line above) and
Ctrl+F5 once in the browser. Phones pick up the new `floor.js` on their next open (the worker app loads the network
copy first).

### Phone batch 1 — one "still missing" split on the van page, the floor-map van card leads with what is missing, moving a van asks first and can be undone, the production plan "By van" on a phone (owner-r1-1 … owner-r1-4)

**owner-r1-1 — the van page shows one breakdown of "still missing"** (`public/app.js` renderVan)
- Why: the small line under "57 Still missing" and the "Special parts to confirm" fold each split the special parts
  their own way ("4 of them special parts (1 still to order · 2 on order · 1 to check)" next to a fold of "1 still to
  order · 2 on order · 1 to check · 7 in all"), so the owner couldn't tell which split was right or what "7" meant.
- Now the small line uses only the tiles' own groups and says which of them are special parts: "18 waiting on PO
  (incl. 2 special) · 29 still to order (incl. 1 special) · 10 to check (incl. 1 special)" — the three numbers are the
  three tiles and add up to the 57. A special line that is only the dealer's name says so: "(incl. 7 special, 1 not a
  part)".
- The fold says the same in the same words: "4 still missing: 2 waiting on PO · 1 still to order · 1 to check · 2 set
  aside · 1 waiting on a decision" — the special parts counted as missing are exactly the "incl." numbers above, and
  the rest of the fold's lines are named (set aside / waiting on a decision) instead of "7 in all". A dealer-name line
  reads "8 still to order (incl. 1 not a part)".
- Both now group by the van line's own status (the one its tile uses), so they can't disagree. Purchasing → Special
  parts keeps its own wording.
- Checked on all 19 active vans: the small line's three numbers add up to "Still missing", and the fold's "N still
  missing" equals the "incl." numbers (0 differences). No data change.

**owner-r1-2 — the floor-map van card says what is missing and how late, first** (`public/factory.js` vanPanel,
`src/layout.js` getLayout / vanFloorInfo, `public/styles.css`)
- Why: the card led with "0 of 116 parts fitted (0%)" while the badge next to it said 57 still missing, it didn't say
  the van was 31 days late, and 116 didn't match the Dashboard's bar (58/115).
- The card now reads "57 still missing · 31 days late" (red; green "Nothing missing" when nothing is), then "Fitted so
  far" with the bar and "0 of 115 parts fitted (0%) · not counting 1 customer supplies / to be decided".
- Totals agree: the map, the phone's bay list ("% done") and the card count parts the Dashboard's way (customer
  supplies / to be decided lines are reminders, not parts, unless something was already issued for them). The van
  card's "still missing" comes from the same server count as the badge, Dashboard and Vans list.
- Checked: map total / done / still missing = Vans list line count / issued / still missing on all 19 active vans.

**owner-r1-3 — moving a van from the van card asks first on a touch screen, and every move can be undone**
(`public/factory.js`, `public/app.js` toastUndo, `public/styles.css`)
- Why: picking "Bay 4 (swap with ST0386)" in the drop-down at the top of the van card swapped two vans straight away,
  with no question and no undo — on a phone the picker opens right under the thumb.
- On a phone or tablet the "Move from Bay 3 to…" drop-down now sits under **More actions** ("Move this van"), and
  picking a spot asks first: "Swap ST0367 (Bay 3) with ST0386 (Bay 4)?", "Move ST0367 from Bay 3 to Yard 2?", "Take
  ST0367 (Bay 3) off the map?". Cancel leaves everything as it was. The empty-spot "Put a van here" drop-down asks
  the same when the van it moves is already on the floor.
- After any move (van card, dragging a van, "Put a van here") a message shows for 10 seconds with an **Undo** button:
  "ST0367 → Bay 4 (swapped with ST0386) · Undo". Undo puts the van back (a swap swaps back; a van that came off the map
  for it goes back too; a planned van that a bay had marked "in production" goes back to planned).
- With a mouse the drop-down stays where it was and moves at once, as before — now with the same Undo message.
- No data change.

**owner-r1-4 — the production plan has a per-van summary on a phone** (`public/app.js` renderPlan, planVanSheet,
planCellDialog, `public/styles.css`)
- Why: on a phone the plan was still a ~21,000 px wide grid; to see where a van was up to you swiped across ~140
  columns, late vans weren't marked, and the header said "Chassis" twice (the pinned column and the plan's own one).
- On a phone the plan now opens **By van** (a "By van | Full grid" switch at the top, remembered for the session): one
  card per van with "due 18/09/2026 · 31 days late" (red), a colour bar in the spreadsheet's colours and "Not ordered
  39 · Ordered 18 · Received 57 · Fitted 0" (plan items, the same cells the grid colours). Find van and Show columns
  matching… still work (the counts follow the column filter). The big grid isn't even built in this view, so the page
  opens fast on a cheap phone.
- Tapping a van opens a full-screen window with its plan items grouped Not ordered / Material ordered / Material
  received / Fitted (plus "Plan notes (not parts)" for plan text with no part line), each item showing its column and
  plan text. Tapping an item opens the usual plan cell window (nothing changes until a button there is tapped twice);
  after a change the van window and the cards redraw with the new counts.
- Full grid on a phone: the pinned column is headed "Van" (not a second "Chassis") and shows "31 days late" in red
  under the due date.
- The PC (wider than 600 px) shows the grid exactly as before. No data change.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r2-phone-1):** phone 390×844 — van ST0367 small line and
fold (above), ST0384 "(incl. 7 special, 1 not a part)" / "8 still to order (incl. 1 not a part)", all 19 active vans
consistent; factory floor: ST0367 card, Move under More actions, cancel → nothing moved, OK → swapped + Undo message,
Undo → both back; planned ST0388 (off the map) into Bay 4 → in production, ST0386 off; Undo → ST0388 off and planned,
ST0386 back in Bay 4; plan By van (19 cards, page 390 px wide), ST0367 window, marking insulation received (two taps)
→ 38 / 18 / 58 in the window and the card; Full grid header "Van" and "31 days late". Desktop 1280: plan grid as
before (no switch, "Chassis"), van card with the drop-down in place and no question, Undo works, van page tiles.
No console errors. `node --check` on every changed JS file; `npm test` 9 pass; `/`, `/floor`, `/api/summary`,
`/api/layout`, `/api/plan`, `/api/floor/map`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `src/layout.js`, `public/app.js`, `public/factory.js`, `public/styles.css`, then
restart and Ctrl+F5 once in the browser. No start-up migration.

### Phone batch 2 — the pop-up never covers Take, card "on shelf" = the van's Shelf tab, a big clear-search button, Undo only for the person who took it (worker-r1-1 … worker-r1-4)

**worker-r1-1 — the pop-up from the last take goes away as soon as a panel opens** (`public/floor.js` sheet /
closeSheet / bookInSheet / receiveScreen / placeSheet, `public/floor.css`)
- Why: taking a part and opening the next one within a second left "1 × AU Focus diesel heater → ST0367 · Undo" on
  top of the new panel's "TAKE 4 FOR ST0367" for its whole 9 seconds, with its Undo right where the thumb taps Take.
- Opening any panel now puts the pop-up away at once (no "1 second" exception). Undo is still there: the van
  screen's "↩ Undo Sam's last take" banner, and — new — Delivery's "↩ Undo Sam's last booking: 3 × AL-KO ESC"
  banner (the same 15 minutes the server allows), since the "Booked in" pop-up's Undo also goes when the next part's
  panel opens.
- A pop-up that appears while a panel is open (an error like "No signal") shows at the top of the screen
  (`body.sheet-open`), never over the panel's Take / Cancel. "Place saved" now shows after the part's panel has
  re-opened, so it isn't put away by it.

**worker-r1-2 — "on shelf" on the van cards is the van's Shelf tab** (`src/layout.js` floorMap, `public/floor.js`
vanCard)
- Why: ST0377 (builder) said "25 parts left · 17 still missing · 17 on shelf" while the van said Shelf 8 / None 17;
  the card counted any stock on the shelf (even stock set aside for other vans), the van screen counts stock it can
  actually take.
- `floorMap` now counts "on shelf" with the van screen's own test (set aside for this van, or free stock — on hand
  minus what every active van has set aside — and not customer supplies / to be decided). The card reads
  "25 parts left for you · 8 on shelf · 17 not on shelf"; the two numbers are the van's Shelf and None tabs and
  always add up to the parts left. ("Still missing" — the office's count — differed from the None tab by 1–3 on a
  few vans, so the card no longer mixes the two; the office screens and the map keep "still missing".) Reminders
  still show on the right.
- Checked: all 19 vans × 6 trades (114 cards): on shelf = Shelf tab and parts left = Shelf + None on every one
  (was wrong on 109).

**worker-r1-3 — a big clear button on every search box, and no "nothing on the shelf" when it's the search**
(`public/floor.js` searchBox / wireSearch / noMatch / vanScreen / celebrate, `public/floor.css`)
- Why: after Find a part → Needed by → ST0367 and a take, the list said "Nothing on the shelf for you on this van
  right now." under "Shelf 25" — the search box still held "victron battery protect 100a", and with gloves the only
  way out was selecting the text.
- Every worker search box (van parts, Van list, Find a part, Delivery, "I took a part that's not on this list") has a
  48 × 48 "×" while it has text. When the van's search hides everything: 'No parts match "victron battery
  protect …" in this tab' with a big "× Clear search" button.
- A take from a van opened via Needed by clears that search and goes back to the usual tab (On shelf, if any), so
  the van's other parts show straight away. A search the worker typed is kept after a take, as before.

**worker-r1-4 — "Undo last" and "Taken from this phone today" are only for the person who took it**
(`public/floor.js` lastTake / myTakes / todaysTakes / forgetTake / celebrate / takeSheet)
- Why: Sam (electrician) took a heater; the phone was changed to Ben (builder), and ST0367 still offered Ben
  "↩ Undo last: 1 × AU Focus diesel heater" — one tap puts back a heater already in the van.
- Each take saved on the phone now keeps the name (`by`). The banner reads "↩ Undo Sam's last take: …" and only shows
  while Sam is the name on the phone; "Taken from this phone today → Put back on shelf" in the part's panel only lists
  that person's takes. Ben sees "Taken by Sam — only they can put it back from this phone. Or ask the office."
  Changing back to Sam brings his Undo back (within the 15 minutes). Switching names no longer forgets other
  people's takes. Takes saved before this update have no name and are no longer offered (they expire the same day).

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r2-phone-2):** phone 390×844 — took a fridge and opened
the next part 0.5 s later: pop-up gone at once and still gone 2 s later, Undo banner on the van; an error pop-up with
a panel open sits at the top (31–108 px, Take bar from 714 px). Home cards (builder): ST0377 "25 · 8 on shelf · 17
not on shelf". Name Ben/builder: no banner, no Put back, "Taken by Sam"; back to Sam: banner and Put back. Find a
part → Victron Battery Protect 100A → ST0367 → take: search cleared, on Shelf 25, 25 parts listed; typed "zzzz" →
'No parts match "zzzz" in this tab' + Clear search; × is 48×48 and clears; Van list and Delivery × work, page 390 px
wide. Delivery: booked 3 × AL-KO ESC, banner shown, next part's panel hid the pop-up, banner Undo → "Booking undone".
Desktop 1280: worker home map as before. `node --check` on floor.js and layout.js; `npm test` 9 pass; `/`, `/floor`,
`/api/summary`, `/api/layout`, `/api/plan`, `/api/floor/map`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `src/layout.js`, `public/floor.js`, `public/floor.css`, then restart. Phones
pick up the new screens on their next open (the worker app loads from the PC first). No start-up migration, no data
change.

## Small fixes & phone round 3

### Fixes batch 1 — a phone delivery stays with the vans whose order it ticks off (check-r2-1)

**check-r2-1 — booking a shelf part in on a phone no longer sends a van that is on order back to "Check: already
ordered?"** (`src/inventory.js` receiveDelivery, receive, new helpers stockIn / vanNeedLocked, receivePO;
`test/merge-and-shortages.test.js`)
- Why: on /floor → Delivery a shelf part is booked with no van. The delivery is ticked off the open PO lines oldest
  first (e.g. PO 200 for ST0380 and ST0382), but the stock itself was then handed out in build order (ST0367 #1,
  ST0380 #2). ST0382's PO line was now "received" yet ST0382 had no part and no open order, so its line came back
  in "Check: already ordered?" as "Battery Stop 200" (one more line there than To order's check rows + special
  lines), while ST0367 kept its own PO line open as well as the part. Answering Yes would have ordered the part a
  second time. Since "Yes, all on order" makes a PO line per van for shelf parts (77 for Battery Stop), this would
  happen on normal deliveries.
- Now a delivery booked on the floor or the item page does what receiving the PO on the PO screen already does:
  what is ticked off a van's PO line is set aside and **locked for that van** (up to what the van still needs).
  Only what is left — PO lines for the shelf, more than was ordered, or a van that no longer needs it (customer
  supplies / to be decided / fitted) — goes to the van the worker picked, or out in build order as before.
  A delivery booked for a van still ticks off that van's lines first.
- Still one stock movement per booking (so the 15-minute Undo on the phone still puts back the shelf count, the PO
  lines, any PO it closed and every set-aside change). The movement's note says where it went, e.g.
  "For ST0380 (1), ST0382 (1)", so the part's history shows it.
- The "what the van still needs locked" sum the PO screen used is now one helper (`vanNeedLocked`) shared by both;
  the PO screen's behaviour is unchanged.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r3-fixes-1):** before the fix, after Battery Stop
"Yes, all on order" (77 lines; Check 305 = 291 check rows + 14 special), booking 2 × SW-AC with no van brought
ST0382 back in Check (306 vs 291 + 14) and a second booking brought back LG027. After the fix: two bookings of
2 × SW-AC ticked PO 200 for ST0380, ST0382, ST0375, LG027 and each of those vans has 1 locked; no SW-AC line in
Check; Check stays 305 = 291 + 14; Undo of a booking restores on hand, PO lines and every set-aside exactly. Sweep
over all 35 stock parts with open van PO lines — half the open quantity with no van, one more than is on order with
no van, and 1 for a picked van, each undone: 421 checks, none failed, counts back to the start. PO screen receive
of one van PO line still locks it to that van. New test "check-r2-1" in `npm test` (10 pass). `node --check
src/inventory.js`; `/`, `/floor`, `/api/pos`, `/api/shortages`, `/api/check-ordered` load.

Carrying over to the office PC: copy `src/inventory.js` (and `test/merge-and-shortages.test.js`), then restart. No
start-up migration, no data change — stock already handed out by an earlier phone booking stays where it is (which
van "should" have had it can't be known for sure afterwards); any van left short that way still shows in "Check:
already ordered?" for the office to answer, as before.

### Phone batch 1 — the plan's "By van" counts parts the van page's way, with "To check" apart; the Dashboard folds on a phone (owner-r2-1, owner-r2-2)

**owner-r2-1 — Production plan "By van": "Not ordered 29 · To check 10", tagged items, and the same numbers as the
van page** (`src/inventory.js` planGrid, `server.js` /api/plan, `public/app.js` By van card / van window / plan cell
window, `public/styles.css`)
- Why: on a phone, Production plan → By van → ST0367 said "Not ordered 39" and listed parts whose plan text says they
  were ordered ("Probond Order 101", "Battery Stop 200", "Onex 08" …) with no marker, while the van page said 29
  still to order + 10 to check; and "Received 57" sat next to the van page's "58 set aside". The card counted plan
  **cells** with the spreadsheet's colours: two parts in one cell (Suspension, Cerbo GX + Smart Shunt) counted once,
  and a "customer supplies" part with stock counted as received — so 57 cells against 58 parts.
- Now `/api/plan` also sends, for each cell, the van page's own status of each part in it (`ps`, same order as the
  cell's part ids; the same rule as the van page — lineStatus plus "coming on a shelf PO / another van's spare PO
  line"), and the part names (`pn`) when a cell holds more than one part. The By van card and the van window count
  **parts** with it: "Not ordered 29 · To check 10 · Ordered 18 · Received 58 · Fitted 0 · To decide 1" — the van
  page's Still to order / Check: already ordered? / Waiting on PO / Set aside / Issued / Waiting on a decision.
  The window says "Counted in parts, the same as the van page."
- The van window has a "Check: already ordered?" group (yellow) between Not ordered and Material ordered; each of its
  items carries a small "check: already ordered?" tag, with a line saying what that means and a link "Answer in
  Purchasing → Check: already ordered?". Customer supplies / to be decided parts sit under "Waiting on a decision"
  with their own tag (they were mixed into Not ordered / Received before). Two parts in one plan cell now show as two
  items, each with its part name ("1 set × Cruisemaster XT airbag suspension", "1 × Cruisemaster DO45 hitch …"); a
  tap opens just that part. A part merged from another plan line is listed once, with both column names.
- The part window (from the van window or the grid) shows the same "check: already ordered?" tag next to the plan
  colour for such a part.
- Unchanged: the PC grid, the phone's "Full grid", the cell colours and the Excel export (still the spreadsheet's
  white / pink / grey / blue per cell — `planGrid` only adds `ps`/`pn` when the plan page asks).
- Checked: all 65 vans (with finished ones) — every part's By van status = its van page status, part count = the
  van page's line count. /api/plan grows from 189 KB to 228 KB for the 19 active vans.

**owner-r2-2 — Dashboard on a phone: 8 vans with "Show all 19 vans", the lists fold to one line each, no second
"waiting on parts" headline** (`public/app.js` renderHome / wireDashboardLinks, `public/styles.css`)
- Why: on a phone the Dashboard was ~9,800 px tall — all 19 van cards, then Reminders (23), Waiting on parts with
  long part lists, Order now, Waiting on a decision and Recent stock movements all open; the "11 waiting on parts"
  Today tile was said again straight after.
- On a phone (≤ 600 px) only:
  - Vans by delivery date shows the first 8 vans and a full-width "Show all 19 vans" button ("Show the first 8 only"
    to fold back; remembered for this visit).
  - Reminders, Waiting on parts, Order now, Overdue deliveries (when there are any), Waiting on a decision and Recent
    stock movements are one-line panels with their count — "Reminders 23" (+ "N overdue" in red), "Missing parts by
    van 11 vans", "Order now 107 parts" (the Office to-do number), "Waiting on a decision 7", "Recent stock
    movements last 12" — 52 px tall, opened with a tap; an opened one stays open while you move around the app
    (this visit only). The Go-live checklist was already folded; it keeps that.
  - The big "N vans late · N waiting on parts" headline above Office to-do is hidden (the Today tiles at the top
    show the same two numbers and open the same lists), and the waiting-on-parts panel's line is "Missing parts by
    van" instead of a second "Waiting on parts (11 of 11 vans)". Office to-do rows at 0 are left out.
  - An Office to-do link to a folded panel ("Decisions waiting") opens it and scrolls to it (clear of the top bar).
- The PC (and anything wider than 600 px) shows the Dashboard exactly as before: same panels, headings and order.

**Tested (port 3410; copy under %TEMP%\fs-tools\v2\sp-build-r3-phone-1):** phone 390×844 — Dashboard 2,585 px
tall (was ~9,800), page 390 px wide, 8 van cards + "Show all 19 vans" (→ 19 and back), six folds at 52 px, Reminders
opens with its 10 rows + Show all, "Decisions waiting" opens Waiting on a decision; desktop 1280: no folds, 19 vans,
headline and headings as before. Plan By van ST0367: card and window "Not ordered 29 · To check 10 · Ordered 18 ·
Received 58 · Fitted 0 · To decide 1" = van page (29 / 10 / 18 / 58 / 1); the 10 to-check items (H mould "Probond
Order 101", Pump/AC switch "Battery Stop 200", Radio antenna "Onex 08", Grab handles "…Ordered 2 and need to order 2"
…) each tagged; tapping H mould → "Not ordered · check: already ordered?" → Mark ordered (tap twice, order 101) →
window and card redraw as "To check 9 · Ordered 19", van page 9 / 19. Column filter "switch" with finished vans:
counts follow the filter. Suspension (2 parts in one cell) shows both part names. Desktop plan grid and legend
unchanged. `node --check` on app.js, inventory.js, server.js; `npm test` 10 pass; `/`, `/floor`, `/api/summary`,
`/api/plan`, `/api/vans`, `/api/layout`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `src/inventory.js`, `server.js`, `public/app.js`, `public/styles.css`, then
restart (phones and PCs pick up the new page on their next load). No start-up migration, no data change.

## Small fixes & phone follow-up round 1

### Stock batch — deliveries go to vans in build order; undoing the take that started a van puts it back to planned (chk-r3-1, chk-r3-2)

**chk-r3-1 — a delivery booked on a phone or the item page ticks van PO lines in build order** (`src/inventory.js`
receiveDelivery, allocateItem, receive / stockIn, receivePO; `test/merge-and-shortages.test.js`)
- Why: since round 3 (check-r2-1) a delivery booked with no van goes to the van whose PO line it ticks off, and is
  locked to it. The PO lines were ticked in line-number order, so a delivery went to later vans first: after "Yes,
  all on order" for Onex, 2 × Radio antenna booked on /floor went to ST0380 (#2) and ST0382 (#4), while ST0367 (#1,
  in production, 31 days late) and ST0375 (#3) on the same PO 08 got nothing.
- Now the open PO lines are ticked in this order: the van the worker picked; then lines for the shelf (no van);
  then other vans' lines in the shared build order (the same PRIORITY every list uses — in production first, build
  order number, due date …), lines for finished vans last; the PO and line number only break a tie. The rule from
  round 3 stays: what is ticked off a van's line is set aside and locked for that van. On a copy after "Yes, all on
  order" for Onex, booking 2 × RADIO-ANT with no van now ticks PO 08's lines for ST0367 and ST0380 and locks one to
  each ("For ST0367 (1), ST0380 (1)"); Undo puts every line back.
- Found while testing, fixed with it: a van with the part on two lines (ST0387 Service door: one plain line, one
  "2 Coast Order 137") got the delivery of PO 137 on the plain line first, so the "Order 137" line came back in
  "Check: already ordered?" and the plain line dropped off Order now. Stock received for a van on an order now fills
  that van's line naming the order number first (`allocateItem` option `poRef`; the PO screen's Receive does the
  same). Only the order of that one van's lines changes — never which van gets it.

**chk-r3-2 — Undo / Put back of the floor take that started a planned van puts the van back to planned**
(`src/inventory.js` takeForVan, undoTake, updateVan; `public/stockcheck.js` history wording; test)
- Why: a take for a planned van moves it to "in production", but Undo did not move it back. Borrowing an annex light
  for planned ST0381 and undoing it left ST0381 in production: it jumped from #17 to #8 in the build order, got first
  call on free shelf stock and all its short lines went into Order now (Dashboard 107 parts / 413 lines → 117 / 477,
  in production 8 → 9).
- Now the take's undo record notes that it started the van (where the van stood on the floor map and a history
  mark), and the van's history gets a line "van status: planned → in production — ST0381 started: first part taken
  on the floor". Undo / Put back of that take puts the van back to planned, with a history line "van status: in
  production → planned — back to planned: the take that started it was undone", but only when:
  - nothing else was issued for the van since (no other floor take, office "Issue stock", or "Already fitted");
  - the office hasn't set the van's status by hand since (status changes on the van page are now written to the
    history as "Van status set by the office", and such a van is left alone);
  - it hasn't been moved on the floor map since.
  If a later floor take for the same van is still there, the note passes to that take, so undoing both (in either
  order) still puts the van back to planned.
- Takes saved before this change have no note: Undo leaves their van's status as it is (as before). A take for a van
  already in production never changes the status.

**Tested (port 3510; copy under %TEMP%\fs-tools\v2\fu-build-r1-stock):** Onex "Yes, all on order" (11 lines on PO
08 / 06), 2 × RADIO-ANT on /floor with no van → PO 08 lines for ST0367 and ST0380 ticked and locked (before: ST0380
and ST0382); Undo → all 13 Onex PO lines back to 0 received. Sweep on a second copy after "Yes, all on order" for all
32 suppliers: every one of the 73 stock parts with open van PO lines booked with no van (half the open quantity, and
one more than is on order) and for the last van in build order (1) — 219 bookings, each ticked in build order (shelf
lines first, an earlier van never left open while a later one was ticked), "Check: already ordered?" stayed at 32
lines, every Undo put the part back exactly (before the `poRef` fix: SVC-DOOR added ST0387 to Check). ST0381
annex light: take → in production, #8, Order now 117 / 477; Undo → planned, #17, 107 / 413 (as at the start);
take + office sets planned then in production + Undo → stays in production; Put back → planned. Line history shows
both "van status" lines. `npm test` 13 pass (check-r2-1 now expects build order, new tests chk-r3-1 ×2 and
chk-r3-2). `node --check` on src/inventory.js, public/stockcheck.js and the test; `/`, `/floor`, `/api/summary`,
`/api/pos`, `/api/shortages`, `/api/check-ordered`, `/api/vans`, `/api/plan`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `src/inventory.js`, `public/stockcheck.js` (and
`test/merge-and-shortages.test.js`), then restart. No start-up migration, no data change: stock already handed out
by an earlier booking stays where it is, and vans already moved to "in production" by a take that was undone before
this change stay in production for the office to set back by hand on the van page if needed.

### Planner batch — one special-parts badge, "Expected by" from the lead time, To order rows the same on a tablet, typos, two model numbers in one text, the Menu badge explained (planner-r3-1 … planner-r3-6)

**planner-r3-1 — Stock and Purchasing show the same special-parts badge** (`public/app.js` renderStock)
- Why: Stock → "Special parts to confirm" said 160 (every special line) and Purchasing → "Special parts" said 89
  (still to order), so the two pages seemed to disagree.
- Now both tabs show the "still to order" number (89 on the copy) in the same quiet badge. "160 in all" (with on
  order / to check / not a part) stays in the Stock tab's heading and in the hover text of both badges.

**planner-r3-2 — "Yes, all on order": Expected by starts at today + the supplier's lead time; "not known" empties
the box** (`public/purchasing.js` yesAllFlow)
- Why: Expected by opened as today, so OK made every new PO due today and overdue tomorrow; ticking "not known"
  greyed the box but still showed today's date.
- Now Expected by starts at today + the supplier's lead time from To order (14 days when none is typed), with a note
  under it: "today + 21 days (Onex's lead time)" / "today + 14 days (no lead time set for Coast to Coast yet)".
  Ordered on stays today. Ticking "not known" empties the box (and greys it); unticking brings the date back.
  Nothing changes on the server: a PO saved with no expected date still goes on "POs to check" as before.

**planner-r3-3 — To order: every supplier on the same two lines on a tablet** (`public/styles.css`, new block at the end)
- Why: at 768px Caravan & Camping put "lead time [14 (defau] days" and Create PO on a second line at the left, while
  the other suppliers kept the lead time on the right and pushed only Create PO underneath; the box cut off
  "14 (default)".
- Now from 601px to 900px (and up to 1100px on a touch screen) every supplier is: ▸ name · facts (· N ticked) on the
  first line; lead time on the left and "Create PO for ticked" on the right of the second line. The empty lead-time
  box is 140px there (120px on a PC, was 100px) so "14 (default)" fits at the tablet's 16px. Phones keep their own
  layout (128px box); a PC wider than 900px stays on one line as before.

**planner-r3-4 — typos fixed on screen, and the part code PLAN-ROOF-BAW → PLAN-ROOF-BOW** (`public/wording.js`;
`src/relink.js`, `src/tidy.js`, `src/importPlan.js`, `src/inventory.js`)
- Wording list (screen only — the database and the Excel export keep the plan's own text): Wheel Braze → Wheel Brace
  ("Braze" only inside "Wheel Braze", as brazing is a real word), Axel → Axle, Flar → Flat, God STD → Gold STD,
  shelvesv → shelves, LArge → Large, brush nickel → brushed nickel. A fix of several words now keeps each word's
  case ("God STD" → "Gold STD", "Brush Nickel" → "Brushed Nickel", "WHEEL BRAZE" → "WHEEL BRACE").
  On the copy: ST0388 and Purchasing → Special parts show none of the old spellings.
- Part code: new start-up clean-up step `sku_fix` ("Typo in a part code fixed …", in the Clean-up report) renames
  the catch-all PLAN-ROOF-BAW to PLAN-ROOF-BOW and its name "Roof Baw (as per plan)" to "Roof Bow (as per plan)".
  It keeps its id, so its 52 van lines, movements and history stay on it; the old code is written in the part's
  notes ("part code was PLAN-ROOF-BAW (typo fixed)") and in the report (before → after). If a part with the new
  code already existed, nothing would be renamed and the report would say so. It runs once and is safe to run
  again (a renamed part is skipped).
- The old code still finds the part (`skuNow` / `skuNames` in relink.js): the production plan update / start again
  (the sheet's column is still headed "Roof Baw", which makes PLAN-ROOF-BAW), a stock count sheet with the old code,
  older notes "was PLAN-ROOF-BAW" / "Re-linked from PLAN-ROOF-BAW", and learned links. An "Update from spreadsheet"
  on a copy afterwards created no second Roof Baw/Bow part.

**planner-r3-5 — "This text names 2 parts" for two model numbers with no separator** (`src/relink.js` textParts)
- Why: ST0385 Taps "kitchen pr7350 vanitypr7155" stayed one line with no "names 2 parts" offer.
- Now a text with two DIFFERENT model numbers is offered as two parts, each running up to its model number:
  "kitchen pr7350" + "vanity pr7155". A model number stuck to a word ("vanitypr7155") is cut off it when another
  model number in the text has the same letters ("pr…"). A model number is one word of 1–3 letters then 3+ digits;
  sizes ("x450MM", "345 H x 290 W", "28LTR"), van numbers ("ST0339"), "Order141" and the same number twice never
  count. Checked against all 2,428 plan texts on the copy: only three split this way, all two taps
  ("kitchen pr7350 vanitypr7155", "brushed stainless kitchen pr7350 vanitypr7155", "Gold kitchen pr7830 vanity
  pr7820"); every other text is read as before.

**planner-r3-6 — the Menu badge is the "Order now" number; stock checks are a dot, and the open menu says so**
(`public/index.html`, `public/app.js` refreshNavCount, `public/styles.css`)
- Why: the phone / tablet Menu badge said 108 (107 to order + 1 stock check) while Purchasing and the Dashboard
  said 107, and nothing said what 108 was.
- Now the badge shows 107 (the same as Purchasing / Dashboard "Order now"), with a small red dot when stock checks
  are waiting. The opened menu starts with "107 to order on Purchasing · 1 on Stock checks" (also the button's
  hover text). Only under 900px; the PC sidebar is unchanged.

**Tested (port 3510; copy under %TEMP%\fs-tools\v2\fu-build-r1-planner):** Stock tab badge 89 = Purchasing badge
89 (hover "89 still to order · 7 on order · 14 to check · … · 160 in all"); Coast to Coast "Yes, all on order":
Expected by 2/11/2026, "not known" empties / restores the box, saved 11 POs ordered 19/10 expected 2/11; Onex with a
21-day lead time: 9/11, saved with "not known" → no expected date, on POs to check. To order at 768×1024: every
supplier row 82px high ("No supplier set" 57px), lead time at the same place on line 2, box 140px, no sideways scroll; 1280px: one 48px line
as before; 390px: phone layout unchanged. ST0388 / Special parts: no old spellings left. ST0385: "This text names
2 parts: kitchen pr7350 · vanity pr7155". Menu at 390px: "MENU 107" + dot, open menu line as above; at 1280px the
dot and line are hidden. Start-up log: "Typo in a part code fixed … — 1 change(s)"; Clean-up report lists it.
`npm test` 16 pass (new `test/planner-r3.test.js`: the model-number split incl. texts that must not split, the
rename + old code still found + safe twice, the rename skipped when the new code exists). `node --check` on every
changed JS file; `/`, `/floor`, `/api/summary`, `/api/pos`, `/api/shortages`, `/api/check-ordered`, `/api/vans`,
`/api/plan`, `/api/placeholders`, `/api/tidy/report`, `/api/export/plan.xlsx` load; no console errors.

Carrying over to the office PC: copy `public/app.js`, `public/purchasing.js`, `public/wording.js`,
`public/styles.css`, `public/index.html`, `src/relink.js`, `src/tidy.js`, `src/importPlan.js`, `src/inventory.js`
(and `test/planner-r3.test.js`), then restart. The start-up clean-up takes its usual backup, then renames the one
part code (logged in the Clean-up report, which then asks to be checked again, as after every new clean-up step).

### Owner batch — "date to check" is not late, the three still-missing groups everywhere, a short Purchasing on a phone, how late each bay is, no stock buttons under the thumb, bigger reminder targets, "plan says ordered <date>", the go-live fold (owner-r3-1 … owner-r3-8)

**owner-r3-1 (medium) — a planned van whose date has passed is a "date to check", not "253 days late"**
(`public/app.js`, `public/stockcheck.js`, `public/factory.js`, `src/layout.js`)
- Why: ST0388 (planned, #18, due 8/02/2026) said "Date passed – check" but also "253 days late" on the Dashboard,
  Vans list, plan and floor map; it was counted in the Today tile ("5 vans late") and listed first in "Not on the
  floor yet" (and offered first in "Move the line along") because of its old date.
- Now one rule on every screen, the same one the server's build order already used: only a van **in production**
  past its due date is late. A **planned** van whose date has passed shows "due 8/2 · Date passed – check" (never
  "N days late") until the office fixes the date (`dateToCheck` / `vanLateDays` in app.js; `dueFlag` uses it).
  - Dashboard: Today tile "4 vans late" with "+ 1 date to check" under it; the PC headline says 4. Tapping it lists
    the 4 vans, and the banner adds "Not counted as late: ST0388 – planned, but the due date has passed (date to check)".
  - Vans list and Dashboard van cards, plan "By van" card and window, the plan grid, the van page's delivery tile and
    the floor-map van card: "Date passed – check" instead of the days late.
  - Factory floor: `/api/layout` now lists vans in build order (the shared PRIORITY) with their `build_pos`, so "Not
    on the floor yet" starts "#2 ST0380 …" and shows "#18 ST0388 … Date passed – check" in its place; "Move the line
    along" offers the next van in build order (ST0380 — it offered ST0388 before) and marks "– date to check". The
    worker app's van list keeps its bay order; vans not on the floor follow the build order there too.
- No data change: confirming the date = typing the right date on the van (Van details), as before.

**owner-r3-2 — Dashboard "Missing parts by van": "18 waiting on PO · 29 still to order · 10 to check"**
(`src/inventory.js` new `missingSplitByVan`, listVans, summary; `public/app.js`)
- Why: it said "57 still missing" then "47 to order / on order", with 10 unexplained.
- `/api/vans` and `/api/summary` now carry `split` for each active van: its still-missing lines by the van page's own
  status (lineStatus + a shelf PO / another van's spare PO line covering it — the same rule as getVan and the plan's
  "By van"). The fold shows "18 waiting on PO · 29 still to order · 10 to check" (adds up to 57), then "To order / on
  order: …" by name; vans in production also say how late they are. The van cards' hover text uses the same words.
  Checked on the copy: for all 19 active vans `split` = the van page's counts, and it adds up to "still missing".
- `summary()` now reuses the cached shortages (listVans has just worked them out for the split): `/api/summary` takes
  about 0.45 s, as before.

**owner-r3-3 — Purchasing on a phone: a short summary, closed suppliers are one line, "tap", the "to check" numbers
said plainly** (`public/purchasing.js`, `public/styles.css`)
- Phone only, above the tabs: four tappable boxes that open their tab — "107 parts to order now / from 40
  suppliers", "63 order numbers to check / for vans due soon · 144 in all · 382 parts", "37 open POs", "0 deliveries
  overdue" (that one scrolls to Overdue deliveries).
- A closed supplier on a phone shows only ▸ name and its facts — no "41 ticked", no lead-time box and no Create PO
  until it is opened (then they are there as before; ticks are kept while it is closed). On a phone only Order now
  starts open (Coming up is one tap away; a section you open is still remembered). "40 suppliers — tap one to see its
  lines, tick them and make the PO" on a touch screen ("click" with a mouse).
- The three numbers now say what they count: the Check tab badge's hover "63 order numbers for vans due soon · 144 in
  all · 382 parts"; the Check tab heading "63 order numbers for vans due soon + 81 later = 144 · 382 parts"; each To
  order section "+ 181 parts the plan says were ordered (73 order numbers) – check, not counted".
- Phone To order page 16,075 px → 4,892 px tall, no sideways scroll. The PC is unchanged (no summary, the same
  sections open, "click"). The Check tab keeps its 63 answer cards (each one needs its own Yes / No).

**owner-r3-4 — Factory floor: how late each bay is, "% fitted"** (`public/factory.js`, `public/factorymap.js`, `public/floor3d.js`)
- Bays list: "BAY 3 ST0367 · 57 still missing · 31 days late · 0% fitted" (late in red; otherwise "due in 9 days",
  "no due date" or "date to check"). "⚠ In production but not in a bay:" lists each van on its own 44 px line with
  "19 days late" / "7 days late". The van label on the 2D map (office and worker), its hover text and the 3D label
  say "% fitted" / "parts fitted" instead of "% done" — the van card's words.

**owner-r3-5 — nothing that changes stock under the thumb** (`public/app.js`, `public/styles.css`)
- Vans list on a phone: the build order is plain text ("#1" on the card, plus "build order no. 3" when the office set
  a number); the number boxes appear only after More actions → **Change build order**, with a sticky line "Build
  order: 1 = build first, blank = by due date. Saved when you leave the box. [Done]" (remembered for this visit).
  Tablet and PC: the boxes as before.
- Van page on a phone: the only button under the title is **More actions…**. It holds Issue stock to floor (says
  what it does, still asks first), Already fitted…, Change due date or build order… (opens Van details), then the
  old Re-run parts rules / Mark completed / Delete van. The PC keeps its buttons.

**owner-r3-6 — reminders grouped by van, 44 px targets, the van card's reminders cut to 2 lines** (`public/app.js`,
`public/factory.js`, `public/styles.css`)
- Dashboard Reminders: one heading per van ("ST0367 · 9 reminders · N overdue"; the van with the most urgent
  reminder first) instead of "ST0367 ·" in front of every line; the first 10 reminders show, then "Show all 23 (+ 13 more)".
  On the PC too.
- On a phone or touch screen: van links (Reminders, Missing parts by van), "+ 36 more", the tick (44 × 44, box 24 px),
  × (44 × 44) and "Show all" are 44 px. The floor-map van card's reminders use the same row: 2 lines until tapped,
  a 44 px tick and × (× still asks first).

**owner-r3-7 — "Order 29/06/2026" in the plan gets "plan says ordered 29/06/2026 – check"** (`public/app.js`,
`public/purchasing.js`, `src/lineState.js`)
- A not-ordered part whose plan text says "Order" / "Ordered" followed by a date gets a small yellow tag "plan says
  ordered 29/06/2026 – check" in Production plan → By van (and the part window), on the van page line and on its
  Purchasing → To order row. Counts unchanged. On the copy: Pressing sheets on ST0367, ST0377 and ST0393.
- Found with it: the PO text for these lines was "Urban republic /06/2026" ("Order 29" was taken out as if it were an
  order number). `specForPo` now takes out an order date as a whole → "Urban republic". Order numbers as before
  ("… Order 34 16/04/2026" → "… 16/04/2026"; "Order 86/88" is not a date and is unchanged).

**owner-r3-8 — the Go-live checklist folds like the others on a phone** (`public/app.js`, `public/styles.css`)
- Phone: "GO-LIVE CHECKLIST" with "0 of 6 done" on the right, 54 px like the other folds; "Work through it in this
  order." is the first line inside. The PC keeps its line.

**Tested (port 3510; copy under %TEMP%\fs-tools\v2\fu-build-r1-owner):** phone 390×844 — Dashboard: Today "4 vans
late + 1 date to check", ST0388 card "due 8/2 · Date passed – check", six folds and go-live all 54 px, Reminders
grouped (ST0367 9, ST0387 7 …), van links / "+ 36 more" / ticks / × 44 px, Missing parts by van ST0367 "18 waiting on
PO · 29 still to order · 10 to check"; the late list = ST0367, ST0380, ST0375, ST0382 + the ST0388 note; Vans list:
no number boxes until Change build order (19 boxes, 44 px), Done hides them; van page: one "More actions…" button,
dialog buttons 44 px, Change due date → Van details; ST0388 tile "Date passed – check"; plan By van ST0388 "Date
passed – check", Pressing sheets tagged (and in its part window); Factory: bays with days late / due in / "% fitted",
warning on 44 px lines, Not on the floor yet starts "#2 ST0380", "#18 ST0388 … Date passed – check", Move the line
along defaults to ST0380; van card reminder 39 px clamped → 115 px when tapped, × and tick 44 × 44; Purchasing
summary as above, closed supplier 103 px with no ticks / lead time / Create PO, opened: all there; the summary's
Check box opens the Check tab; page 390 px wide everywhere. PC 1280: Dashboard headline 4, panels / headings /
go-live line as before, van page's 4 buttons, Vans list 19 boxes, Purchasing with no summary, "click", Coming up
open; factory van card fine. `/floor` loads. All 19 active vans: `split` = the van page's statuses (0 differ).
`npm test` 18 pass (new `test/owner-r3.test.js`: specForPo with dates; the split = the van page and adds up).
`node --check` on every changed JS file; `/`, `/floor`, `/api/summary`, `/api/pos`, `/api/shortages`,
`/api/check-ordered`, `/api/vans`, `/api/plan`, `/api/layout`, `/api/floor/map`, `/api/reminders`, `/api/vans/51`,
`/api/vans/51/floor`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `public/app.js`, `public/purchasing.js`, `public/factory.js`,
`public/factorymap.js`, `public/floor3d.js`, `public/stockcheck.js`, `public/styles.css`, `src/inventory.js`,
`src/layout.js`, `src/lineState.js` (and `test/owner-r3.test.js`), then restart. No start-up migration, no data
change (a PO already made keeps the text it was saved with).

### Worker batch a — the reminder count after a tick, late vans in red, "On order" on the van, where a delivery goes, a header and Delivery box that fit (worker-r3-1 … worker-r3-5)

**worker-r3-1 — ticking a reminder updates "⏰ N reminders" straight away** (`public/floor.js` vanScreen, `public/floor.css`)
- Why: the fold kept "⏰ 4 reminders" with 3 rows under it (or "⏰ 1 reminder" with none) until the van was opened again.
- Now the fold is re-counted from the cards left the moment a tick is saved: "⏰ 3 reminders" (and "· N due" with the
  orange edge only while a due one is left). Ticking the last one shows a quiet grey "✓ No reminders left" row (not
  a button any more). Undo redraws the van, so it says "⏰ 4 reminders" again with the 4 rows.

**worker-r3-2 — late vans look late, in the office's words** (`public/floor.js` new `dueHtml`, vanCard, vanScreen; `public/floor.css`)
- Why: every due date was the same grey and "late" appeared nowhere on the worker screens.
- Home cards (In the bays / In the yard / Not on the floor), the Van list and the van header now say
  "due 18/09 · 31 days late" in red (bold) for a van **in production** past its date, "due today" in red on the day,
  and "due 08/02 · Date passed – check" in amber for a **planned** van whose date has passed — the same rule the
  office uses since owner-r3-1 (only a van in production is late). Other vans keep the plain grey "due 19/11".
- On a phone the card's first line may now wrap, so a long "due … · 31 days late" drops under the van number
  (right-aligned) instead of squeezing it.

**worker-r3-3 — a part on an open order says "On order", with the supplier and due date** (`src/inventory.js` new
`floorOrderInfo`, floorVan; `public/floor.js` van list tags, new `orderNote` in the Take panel; `public/floor.css`)
- Why: Radio antenna (Onex 08) on ST0367 had the orange "Not in stock" tag and the panel said only "The system shows
  none on the shelf…", so the worker couldn't tell whether to wait or chase the office.
- `/api/floor/vans/:id` now marks each part that is still short with the van page's own rule (lineStatus with this
  van's and the shelf's open PO lines; a line fully covered by a shelf PO or another van's spare PO line counts as
  ordered too): `order` = { qty, suppliers, expected } or `plan_ordered` = the plan text when the plan gives an order
  number the office hasn't confirmed ("Check: already ordered?").
- Van list: a blue "On order · due 02/11" tag (or just "On order" with no date) instead of the orange "Not in stock";
  a purple "Plan says ordered – ask the office" tag for the unconfirmed ones. "Set aside for other vans" still wins
  when there is stock on the shelf (the panel shows both). Take panel: "📦 1 on order from Onex · due 02/11" (or
  "· due date not known"), above "The system shows none on the shelf yet…"; for an unconfirmed one: "The plan says it
  was ordered ("Onex 08"), but the office hasn't confirmed the order yet. Ask the office if you need it now."
- Counts, tabs and what can be taken are unchanged (an "On order" part is still in the None tab and can still be
  taken if it is in the worker's hand).

**worker-r3-4 — the "Booked in" pop-up names only where this delivery went** (`src/inventory.js` receiveDelivery,
`server.js` /api/floor/receive, `public/floor.js` new `bookedWhere`, `public/floor.css`)
- Why: booking 1 × Victron Battery Protect 100A said "Set aside for ST0367, ST0380, ST0375, ST0386, ST0377, ST0383"
  — every van holding the part — although the system knows which one this box is for.
- `receiveDelivery` now also returns `to` (each van this delivery was newly set aside for, net, with how many, in
  build order) and `shelf` (how many went on the shelf for no van); `/api/floor/receive` passes them on (the old
  `vans` list stays for anything else that reads it).
- The pop-up: "1 → ST0387 · Timber rack · Shelf 2", "1 → ST0367, 1 → ST0380, 1 → ST0375", "2 → ST0380, 1 on the
  shelf (not for a van yet) · Rack C", or "Goes on the shelf (not for a van yet) · Timber rack · Shelf 2" (the place is
  the part's rack and shelf when one is set). "1 → ST0380" never breaks over two lines. Undo as before.

**worker-r3-5 — the app header and the Delivery search box fit on a narrow phone** (`public/floor.js` setTop,
receiveScreen, pickItemScreen; `public/floor.css`)
- Name button: the trade icon + first name ("⚡ Sam") on phones up to 400px wide (the full name on wider screens; the
  button's spoken label still says the full name and trade).
- Title: on screens 360px wide and less (the 336px app preview) the short word — "Floor", "Vans", "Delivery", "Find"
  (a van's number and "Welcome" are short already). Wider screens keep "Factory floor", "Pick the van", "What arrived?".
- Delivery's search box says "Part name or brand" (Find a part: "Part name, brand or code"); searching by code still
  works. An empty search box no longer keeps room for its "×" (that only shows with text), so the placeholder fits
  beside Done even at 336px (needs 164px, has 176px; 188px at 390px).

**Tested (port 3510; copy under %TEMP%\fs-tools\v2\fu-build-r1-worker-a):** 390×844 — ST0367 as electrician: tick the
only reminder → "✓ No reminders left" (grey, 52px); Undo → "⏰ 1 reminder" + 1 row. As builder: 4 → tick 1 → "⏰ 3
reminders" + 3 rows; Undo → 4 + 4 rows. Home cards / Van list: ST0367 "due 18/09 · 31 days late", ST0380 "19 days
late", ST0375 "9 days late", ST0382 "7 days late" in red (rgb 180,35,24); ST0388 "due 08/02 · Date passed – check"
in amber; the rest grey; van header "… · due 18/09 · 31 days late". After "Yes, all on order" for Onex 08 (expected
2/11) on the copy: Radio antenna "On order · due 02/11", panel "📦 1 on order from Onex · due 02/11"; AC / Pump /
Stove switch "Plan says ordered – ask the office"; builder NCE washer/dryer "On order", panel "1 on order from NCE ·
due date not known". Delivery: 1 × Battery Protect 100A → "1 → ST0387" (its PO 29 line; the movement says "For
ST0387"); with a place set, 1 more → "Goes on the shelf (not for a van yet) · Timber rack · Shelf 2"; 4 × Radio
antenna → "1 → ST0382, 1 → ST0386, 1 → ST0393, 1 → ST0383". 336×726: title "FLOOR" / "VANS" / "DELIVERY" / "FIND" /
"ST0367" and "⚡ Sam", nothing cut (scrollWidth = width), placeholder fits; no sideways scroll at 336 or 390.
1280: "FACTORY FLOOR", "⚡ Sam Sparky", the map and reminders list as before. `npm test` 20 pass (new
`test/worker-r3.test.js`: `to` / `shelf` for a PO line, free stock in build order and the shelf, and Undo; `order`
with supplier + date, a shelf PO with no date, `plan_ordered`, nothing ordered). `node --check` on `public/floor.js`,
`src/inventory.js`, `server.js` and the test; `/`, `/floor`, `/floor.js`, `/floor.css`, `/floor-sw.js`,
`/app-preview.html`, `/api/floor/map`, `/api/floor/vans/51` (0.24 s), `/api/summary`, `/api/export/plan.xlsx` load.

Carrying over to the office PC: copy `public/floor.js`, `public/floor.css`, `src/inventory.js`, `server.js` (and
`test/worker-r3.test.js`), then restart. No start-up migration, no data change. Phones pick up the new screens the
next time the app opens (the app helper fetches the screens from the PC first).


### Worker batch b — bigger van tags on the phone map with 48px taps, another trade's part stays under Done, name buttons keep their order and trade, the reminder badge on its own line, a 48px Undo and readable note times (worker-r3-6 … worker-r3-10)

**worker-r3-6 — van tags on the fitted phone map are big enough to read and tap** (`public/factorymap.js` drawVan /
render, `public/floor.js` homeScreen)
- Why: on a 390px phone the fitted map is 350×300, so the tags were 64×19 / 37×64 with a ~7px van number, a ~4px
  "% done" line and no zoom.
- `FactoryMap.render` takes three new options, used only by the worker home map: `bigTags` (the chassis tag drawn
  1.6× bigger — 51×16 at 390px, van number ~11px high; the small "% fitted" line left off; the red / orange badges on
  the tag's top-right corner, side by side, so a tag never reaches the next yard spot's), `minTap` (a tap anywhere on a
  van's parking spot or tag opens it, and every van's tap area is at least that many screen pixels each way — an
  invisible box; where two would overlap, the nearer van wins) and `pinchZoom` (two fingers zoom in on the map).
- Phones (600px and less): `bigTags`, `minTap: 48`, `pinchZoom`. PC / tablet: the full-size map exactly as before
  plus `minTap: 44` (a tap on a bay with a van in it opens that van). The office's Factory map (factory.js) passes
  none of these and is unchanged; the Find a part / Set place mini-maps are unchanged.

**worker-r3-7 — taking another trade's part from "Needed by" no longer makes it vanish** (`public/floor.js` vanScreen,
takeSheet, borrowSheet, celebrate, new `otherTrade` / `otherTradeIcon`; `public/floor.css`)
- Why: as electrician, Find a part → Dometic 190L → Needed by → ST0380 showed the fridge with no hint it was the
  Builder's; after "Take 1 for ST0380" it disappeared and "0 of 49" dropped to "0 of 48", so the take looked lost.
- The part opened from Find a part now stays on that van's list for as long as the worker is on that van (it was only
  kept for the first drawing). Its card says "🔨 Builder part" ("— on their list" once taken); the Take panel says
  "🔨 This is a Builder part — you're taking it for them. It stays on this van's list under Done."
- The header counts it openly: "0 of 49 parts done (48 yours + 1 Builder part)" → after the take "1 of 49 parts done
  (48 yours + 1 Builder part)", Done 1, Shelf 29. The pop-up: "1 × Dometic 190L compressor fridge → ST0380 · Taken for
  the Builder — it's on their list, and under Done here" (also through "Whose part is this?"). Undo as before.
  Opening another van (or the app again) shows only the worker's own trade, as before.

**worker-r3-8 — name buttons stay in A–Z order and bring back each name's trade** (`public/floor.js` nameScreen;
`public/floor.css`)
- Why: the buttons swapped places after each switch, and tapping "Sam Sparky" left Builder selected, so on a shared
  phone the next person saw the wrong trade's parts.
- Each name on the phone now remembers its trade (phone storage `floor.nameTrades`; the name already on the phone gets
  the trade it had). The buttons are sorted A–Z and show the trade icon ("🔨 Ben Builder", "⚡ Sam Sparky"); the name
  on the phone now is marked. Tapping a name — or typing a name the phone knows, any capitals — also picks its trade;
  a new name leaves the trade as it is. Buttons are 48px high. The phone still keeps the last 8 names.

**worker-r3-9 — card text no longer runs into the reminder badge** (`public/floor.js` vanCard; `public/floor.css`)
- Why: at 336–390px "⏰ 4 reminders" sat beside "24 parts left for you · 9 on shelf" as a two-line 83×36 box and
  "15 not on shelf" wrapped under it with a leading "·".
- Phones (600px and less): "24 parts left for you" on one line, "9 on shelf · 15 not on shelf" on the next (never split),
  then "⏰ 4 reminders" on a line of its own. Home cards and the Van list. A PC / tablet keeps one line with the badge on
  the right (the badge never wraps).

**worker-r3-10 — a 48px Undo, and note times like the rest of the screen** (`public/floor.css`, `public/floor.js`
notesSheet, new `noteWhen`)
- The green pop-up's Undo button is now 48px high and at least 76px wide (was 73×42), 17px text.
- Notes say "19/10 3:05 pm · Ben Builder" (was "2026-10-19 03:05"); office notes say "· Office"; an old note saved
  without a name says "· name not saved".

**Tested (port 3510; copy under %TEMP%\fs-tools\v2\fu-build-r1-worker-b):** 390×844 — Welcome: start as Ben Builder
(Builder), then Sam Sparky (Electrician); the buttons stay "🔨 Ben Builder, ⚡ Sam Sparky"; tapping Ben picks Builder,
Sam picks Electrician, typing "ben builder" picks Builder; buttons 48px. Home: bay cards two lines + "⏰ 1 reminder"
on its own line (each line 17–19px, one line); map 350×300, tags 51×16 with an 11px number, no "% fitted";
simulated taps 14px above / below a tag and on its spot open the van, an empty spot doesn't; touch-action
"pan-x pan-y pinch-zoom". As electrician: Find a part → Dometic 190L → ST0380: "0 of 49 parts done (48 yours + 1 Builder
part)", card "🔨 Builder part", panel note; Take 1 → "1 of 49 … ", Done 1 (fridge "— on their list"), Shelf 29, pop-up
as above; Undo 48×76. Note added → "19/10 4:08 am · Sam Sparky". 336×720 Van list: all 19 cards one line per row, no
sideways scroll. 1200×800: one-line card numbers, full-size map with "% fitted", office Factory map unchanged (6 vans,
"% fitted"). `node --check` on `public/floor.js` and `public/factorymap.js`; `npm test` 20 pass; `/` and `/floor` load.

Carrying over to the office PC: copy `public/floor.js`, `public/floor.css` and `public/factorymap.js`, then refresh.
No server change, no start-up migration, no data change.
### Follow-up: Undo after "Already fitted" (stock check f1, medium)

- `src/inventory.js` `undoTake`: undoing the floor take that moved a planned van to "in production" no
  longer puts the van back to planned if the office has marked any part on that van **Already fitted**
  since the take (history reason `fitted`), even when no stock was used. No data change, no migration.

## Logins and job roles

Everyone now logs in with their own **username and password**, and what they can do depends on their **job role**.
Before this there was no login: anyone on the network could do anything, and the worker's name was typed in on the
phone and sent as `by`. Nothing else in the app changed (Excel export / import, theme, phone layouts, every feature).

### Job roles (as built — the table is `API_RULES` in `src/auth.js`)

| Role | Key | Can do |
|---|---|---|
| Owner | `owner` | Everything, plus the **Logins** page |
| Office | `office` | Everything in the office app except the logins |
| Stores | `stores` | Sees Dashboard, Vans, Production plan, Factory floor, Stock, Purchasing, Stock checks (read-only). **Stock**: receive, Count a rack / stocktake, Count / adjust, rack & shelf of a part (incl. Put on rack), item photos (camera / file, not "From internet"), tick Stock checks, bought-for-van check, **Issue stock to floor** / return to shelf. **Purchasing**: see POs, **Receive delivery** — not create / edit / close / delete / merge POs, not "Check: already ordered?", not lead times. The worker app for every trade |
| Leading hand | `leadhand` | Sees Dashboard, Vans, Production plan, Stock (read-only). **Factory floor**: move vans (incl. Undo of a move), Gone out the gate, Move the line along, notes (add / delete), reminders (add / tick / delete) — not Edit layout. The worker app for every trade |
| Worker | `worker` | The worker app (`/floor`) only, for **their own trade** (set on the login): take parts, undo **their own** takes, extra part, book a delivery (and undo their own), find a part (and set its place), notes, tick reminders |

- **Default deny:** an `/api` route that is not in the table is owner-only. Read-only GETs of the office pages are
  open to owner / office / stores / leading hand; workers only get what `/floor` uses (`/api/floor/*`, `/api/trades`,
  `/api/me`, `GET /api/items`, `GET /api/items/:id`, `GET /api/layout`, `GET /api/vans/:id/floor`,
  `POST /api/vans/:id/notes`, `PUT /api/reminders/:id`, photos).
- Two routes have **field limits** (`only` in the table): stores may `PUT /api/items/:id` with only `area_id` /
  `location` (where it is kept); a leading hand may `PUT /api/vans/:id` with only `status` = planned / in production
  (needed by "Undo" of a van move into a bay).
- A **worker** always gets their own trade: `/api/floor/map` ignores `?trade=` for them (the answer now says which
  `trade` it used). Everyone else picks a trade view on `/floor` as before.
- **Who did it** now always comes from the login (its display name): movements, notes, reminders, counts,
  allocation log, PO notes, plan imports, the Clean-up report "Checked by"… `by` in a request body or query is still
  accepted (older pages) but ignored. The office windows' "Your name" boxes are gone ("Saved under <name>").
  Office deliveries booked on the item page now record the name too (they had none before).
- A refused request answers **403 "Your login can't do that — ask the owner"** (shown as a normal message);
  not logged in: **401 "Please log in"** and the page goes to the log in page.

### Data (src/db.js, created on start — no change to existing tables)

- `users`: id, username (unique, capitals ignored), name, role, trade ('' or a trade; required for workers),
  pass_hash, active, must_change, created_at, created_by, last_login.
- `sessions`: token_hash (sha256 of a random 32-byte token) PK, user_id, created_at, last_seen, expires_at (ms), ip, ua.
- Passwords: `crypto.scrypt`, random 16-byte salt, stored `scrypt$16384$8$1$<salt>$<hash>` (64 bytes), checked with
  `timingSafeEqual`; at least 8 characters. Passwords and hashes are never logged or sent to a page.
- Sessions: cookie `fs_session` — HttpOnly, SameSite=Lax, Path=/, Secure on https (`req.secure`; proxy headers only
  with `TRUST_PROXY=1`, and then only from a proxy on this PC). Sliding expiry: 30 days from the last use ("last
  seen" written at most every 5 minutes). Expired sessions are cleared every hour.
- Changing your own password ends your other sessions (this one stays); an owner's **reset**, **turning a login off**
  or a **new job role / trade** ends all of that person's sessions; Log out deletes the session.
- Login throttling (in memory): 5 wrong tries for a username from one address → that username locked for that
  address 15 minutes; 30 wrong tries from one address in 15 minutes → the address locked 15 minutes. Wrong
  username, wrong password and a turned-off login all say "Wrong username or password"; locked: "Too many tries —
  wait 15 minutes". A wrong username takes as long as a wrong password (a dummy hash is checked).
- Backups (`npm run backup`) include the two tables: logins come back with a restore (passwords only as scrypt hashes).

### First-time setup and recovery

- With **no logins at all**, the log in page shows **Create the owner login**. `POST /api/setup` only works then, and
  only when the request comes from the office PC itself (the connection's own address is 127.0.0.1 / ::1 /
  ::ffff:127.0.0.1 — never a header; a request carrying proxy headers such as X-Forwarded-For or CF-Connecting-IP is
  refused too, so a tunnel on this PC can't be used for it). From another PC: "Open this on the office PC itself to
  create the first login". The start-up log says `Logins: NONE YET - open http://localhost:3000 on THIS PC …`.
- `scripts/users.js` / `npm run users -- list | add <username> <role> [trade] | reset <username> | disable <username> |
  enable <username>`: passwords are typed at the prompt (shown as *), never on the command line; works while the app
  runs (the app checks the database on every request). It also refuses to turn off the last owner.

### Screens

- **`/login`** (new `public/login.html`, `login.js`, `login.css`): Stallion look, phone-sized, also inside the
  installed "Stallion Floor" app (same manifest). Log in → workers and leading hands go to `/floor`, everyone else to
  the office app; `?next=` is followed only for paths of this app (one leading `/`, never `//…` or another site); the
  `#…` part of the address is kept. A temporary password → "Choose a new password" first (nothing else works until
  then: `403 {mustChange: true}`). Show / Hide on password boxes.
- **Pages need a login:** `/` and `/floor` go to `/login?next=…`; a worker opening `/` goes to `/floor`. Styles,
  scripts, fonts, logos, app icons, manifest and service worker stay public (no data in them). **`/photos`** needs a
  login (`Cache-Control: private`).
- **Office app** (`public/index.html`, `app.js`, `styles.css`): who is logged in (name + job role) with **Change
  password** and **Log out** at the bottom of the sidebar, and at the end of the phone Menu. Menu items a role can't
  use are hidden, and opening one by its address says "Your login can't open this page — ask the owner". Buttons are
  marked `data-need="office|stock|issue|poReceive|floor|layout|export|settings|webImage|users"` and hidden for roles
  without that right (CSS on `body.can-…`, set from `/api/me`), so stores and leading hands see read-only pages.
  The Factory floor: no dragging / Move vans / Move the line along for stores, no Edit layout except office / owner.
  The phone Menu badge ("Order now") only shows for logins that can open Purchasing.
- **Logins page** (owner only, menu item **Logins**, `#/logins`): list (name, username, job role, trade, last log in,
  on / turned off), **+ Add login** (name, username, role, trade for workers, a suggested temporary password, "They
  choose their own password the first time they log in" ticked), **Edit** (name / role / trade), **Reset password**,
  **Turn off / Turn on**. The last active owner can't be turned off or given another role; owners can't turn off
  themselves or change their own role. Table as cards on a phone. (No "delete": a turned-off login keeps its name on
  everything it did.)
- **Worker app** (`public/floor.js`, `floor.css`): the "What's your name?" screen is gone — the name comes from the
  login. A worker's trade is fixed (shown, no picker). Other roles pick a trade view the first time on the phone
  (remembered per login; the trade picked before logins is used if there was one). The name button at the top opens
  a panel: the trade view (not for workers), **Office app** (roles that have it), **Change password**, **Log out**.
  Quick undo, Put back, Delivery undo etc. work as before (the server now also checks a worker only undoes their own).
- **Service worker** (`public/floor-sw.js`, cache v3): never keeps `/api/*`, `/login`, `/`, `/index.html` or photos,
  never keeps a page that came back as a redirect, and `/floor` is no longer pre-loaded; Log out on `/floor` clears
  everything it kept.

### Also

- **Host allow-list** for changes (`POST/PUT/DELETE /api/*`, incl. log in and setup): localhost, 127.0.0.1, [::1], this
  PC's network addresses and name (also `<name>.local` / `<name>.<anything>`), plus env `ALLOWED_HOSTS` (comma list,
  e.g. the future tunnel name; `*` turns the check off). Stops "DNS rebinding". A refused name is written once to the
  log with a hint.
- Security headers on every answer: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: SAMEORIGIN`; `X-Powered-By` off. The existing Origin / Sec-Fetch-Site guard is unchanged.
- `PORT=0` now means "any free port" (the tests use it); unset is still 3000. The start-up log shows the number of logins.
- Log lines for log in, first login, logins added / changed / reset / turned off (who did it) — never passwords.

### Files

New: `src/auth.js`, `scripts/users.js`, `public/login.html`, `public/login.js`, `public/login.css`,
`test/auth.test.js`, `test/auth-http.test.js`. Changed: `server.js`, `src/db.js`, `package.json` (`npm run users`),
`public/index.html`, `public/app.js`, `public/styles.css`, `public/purchasing.js`, `public/stockcheck.js`,
`public/factory.js`, `public/floor.js`, `public/floor.css`, `public/floor-sw.js`, `README.md`, `HANDOVER.md`.

### Tested

- `npm test`: **46 pass** (21 before + 12 in `test/auth.test.js`: hash / verify, log in right / wrong / unknown /
  turned off, username and address lockout, session expiry and sliding, log out, own change / reset / role change /
  turn off end sessions, setup only from this PC and only with no logins, the permission table for every role,
  field limits, last-owner protection, host allow-list; + 13 in `test/auth-http.test.js`, which starts the real
  server on a temp database and a free port: not logged in → 401 / redirects / public assets, setup refused from the
  LAN address and through a proxy header then made from this PC and only once, one login per role, temporary
  password flow, worker blocked from office routes and trade forced, `by` ignored and the login name recorded on a
  note / take / delivery / reminder, worker can't undo another worker's take, stores can receive and set a rack but not
  create a PO or rename a part, leading hand can move vans and set planned / in production but not edit rules / layout
  or receive, office can't manage logins, last owner protected, role change / turn off log out, log out, 5-try
  lockout, Origin and Host refused).
- Clicked through on a copy of the data (port 3710, `%TEMP%\fs-tools\v2\auth-build`): owner created on this PC with
  the setup screen (the `#/vans` part kept through the redirect), the same request from the LAN address refused;
  Logins page add / turn off / turn on / own-role refusal (desktop and 390 px phone); stores and leading hand at
  1280 px and 390 px (menus, read-only Van / Stock / item / Purchasing / Factory floor, a leading hand's van move +
  Undo); office: refused page message, 403 message, change password, a session removed on the server → back to the
  log in page with `next=/#/stock`; worker on a 390 px phone: temporary password → "Choose a new password" → `/floor`
  with ⚡ Electrician fixed, take + Undo, name panel (Change password / Log out), `/` → `/floor`; `npm run users`
  list / reset / add / refusing to turn off the last owner, while the app ran.
- The service worker could not be tried in the built-in browser (it refuses every service worker, also a one-line
  test one) — check it once on a phone over https / localhost.

### Carrying over to the office PC

Copy the files above, then restart. On start the two new tables are made (nothing else changes). **Until the owner
login is made, nobody can use the app:** straight after the restart, on the office PC itself, open
`http://localhost:3000` and create the owner login, then add everyone else's on **Logins**. Phones that had the worker
app open go to the log in page; each worker logs in once (30 days, renewed by use).

### Logins — fixes after review

**#1 — workers could read three office stock lists** (`src/auth.js`, tests)
- Why: the table line `GET /api/items/:id` (everyone) came before `GET /api/items/unassigned`, `/many-specs` and
  `/still-to-order` (office pages), and the first matching line won — so a worker got those lists.
- Now, of the lines that match, the one with the fewest `:x` parts wins (a named path always beats `:id`), and the
  three lines sit next to `/api/items`. A new test checks that **every** line of the table can be reached (it fails
  on any line swallowed by another), and the HTTP test checks a worker gets 403 on the three lists.

**#2 — "undo only your own" and the floor stats went by the display name** (`src/db.js`, `server.js`,
`src/inventory.js` floorStats, `src/auth.js`, tests)
- Why: two logins called "Sam Smith" / "sam smith" could undo each other's takes and deliveries, and the phone's
  "You took N today" counted both.
- New column `movements.user_id` (start-up `addColumn`, empty on old rows). Every stock movement a change request
  makes is stamped with the login's id (in the `h()` wrapper: the movements numbered above the highest one before a
  handler that doesn't wait are that request's own) — takes, extra parts, phone and office deliveries, counts,
  adjustments, PO receipts, issue / return, already fitted.
- A worker's Undo / Put back / delivery Undo compares the login id; only movements from before logins (no id) still
  go by the name. The floor stats count own movements by id (old ones by name).
- Two logins can't have the same display name (capitals and spaces ignored), when adding or renaming: "Someone
  already has the name "Sam Smith" — add a surname or an initial so the two can be told apart".
- No data change; old movements keep no id.

**#3 — small fixes** (`server.js`, `src/auth.js`, `public/floor.js`, `views/`, tests)
- A wrong "current password" on Change password now counts like a wrong log in (same lockout, username + address):
  5 wrong → "Too many tries — wait 15 minutes", and log in for that username is locked too.
- `/photos` also needs the new password chosen first (a login that must change it gets 401, like everything else).
- Log out on the worker app also forgets what the phone remembered for that person: today's takes, the last take,
  the last delivery booking and the last van (`floor.takes`, `floor.lastTake`, `floor.lastBooking`, `floor.lastVan`).
- `index.html` and `floor.html` moved from `public/` to **`views/`**: odd addresses (`/%69ndex.html`, `//index.html`,
  `/index.html::$DATA`) went through the static files and served the page shell without the login check. Only the
  `/` and `/floor` routes send them now. (`app-preview.html` stays public: no data in it.)
- `PUT /api/vans/<gone>`, `DELETE /api/vans/<gone>` and `POST /api/vans/<gone>/rebuild` answered 500 "Something went
  wrong"; now 404 "That van no longer exists — refresh".
- Carrying over: move `public/index.html` and `public/floor.html` to `views/` (delete them from `public/`).

**#13 — user test: handing over logins, locks, "you've been logged out", role dashboards** (`server.js`,
`src/auth.js`, `public/app.js`, `public/login.js`, `public/login.css`, `public/floor.js`, `public/purchasing.js`,
`public/styles.css`, tests)
- **Hand-over box:** after *Add login* and *Reset password* a window shows where to open the app, the username and
  the temporary password in large letters, with **Copy** and **Print** (a one-page slip). On the office PC itself
  (localhost) the address is the PC's network address from Settings. It is shown once; the app never shows a
  password again.
- **Locks:** the Logins page shows "Locked until 3:45 pm (wrong passwords)" for a username locked from any device,
  with an **Unlock** button (owner; `POST /api/users/:id/unlock`). *Reset password* lifts the lock too.
  (`npm run users -- reset` runs in another program and can't lift it — Unlock, or wait 15 minutes.)
- **Log in page:** after a wrong password it warns "Wrong username or password — 2 tries left, then a 15-minute
  wait" (and "1 try left"); when locked: "Too many tries — wait 15 minutes. You can try again at 3:45 pm." The
  server's error text is unchanged ("Wrong username or password" for every case); it now also sends `left` and,
  when locked, `until`. The same applies on "Choose a new password".
- **Session ended:** when the browser still has a session that has ended (turned off, new job role, password reset,
  logged out on another device, 30 days unused), the server says so (`ended: true` on the 401, `&ended=1` on the
  page redirect) and clears the old cookie; the log in page says "You've been logged out — your login may have been
  changed or turned off. Ask the owner if you can't log in." Someone who was never logged in doesn't see it.
- **Dashboard for stores and leading hands:** no Office to-do or Go-live checklist (pages they can't open). Stores
  see "Stores to-do": overdue deliveries, purchase orders to receive, stock checks, parts not counted yet; leading
  hands see "Floor to-do": vans late, reminders overdue / due today / open. Order now and Overdue deliveries panels
  only for logins that can open Purchasing; Waiting on a decision only for the office. Owner / office unchanged.
- **Stores can set where a part is kept** in the office app: item window → **Place** (rack + shelf / bin), the two
  fields the server already let stores change.
- Own row on Logins: the job-role box is greyed out with "You can't change your own job role — another owner can."
- Hints that pointed at buttons a role can't see are hidden or reworded (production plan "Click a cell to mark it
  ordered…" → "Click a cell to see it"; van "Check by hand" text about + Add part / Parts rules; van details note
  about Completed; Purchasing "tick them and make the PO").
- Item history said the van twice for floor takes ("issue · ST0386 · ST0386"): the reference is left out when it
  is the van.
- A leading hand logging in goes back to the app they used last on that device (office app or worker app;
  remembered per login). Workers always go to the worker app, everyone else to the office app as before.
- The session cookie's name carries the port (`fs_session_3000`): a second copy of the app on the same PC (e.g. a
  test copy on another port) no longer logs the real one out. Everyone logs in once more after this update.

**Tested (after #1–#13):** `npm test` **52 pass** (new: every table line reachable; workers refused the three item
lists; movements carry the login id, undo by id with the name only for old rows; no two logins with the same name;
floor stats by id; odd page addresses; photos / password-change lockout; 404 for a van that is gone; tries left /
lock end / Unlock / reset lifts the lock; session-ended answer and cookie cleared; per-port cookie). Clicked through
on the test copy (port 3710): log in page warnings and lock time (390 px); Logins page lock + Unlock, Reset password
→ hand-over box (network address, Copy), own role greyed; a session removed on the server → "You've been logged
out…"; stores dashboard and item Place; leading hand dashboard, first log in → worker app, then office app
remembered; worker-app Log out clears the remembered takes / bookings / van.
