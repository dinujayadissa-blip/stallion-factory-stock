# Factory Stock

Turns the dealer's **New Caravan Purchase Agreement** PDF into a parts list for that van, sets stock
aside for it, and tells you what to order — replacing the manual allocation in the production plan
spreadsheet.

## Running it

Needs **Node.js 22.13 or newer** (this PC has 24; give the office PC Node.js 24 LTS too).

- Double-click **`Start Factory Stock.bat`**, or run `npm start`.
- Open **http://localhost:3000** on this PC. Other PCs and tablets on the factory network use the
  address printed in the window (e.g. `http://192.168.1.20:3000`). Windows may ask to allow Node
  through the firewall the first time — allow it on *private* networks.
- All data lives in the `data` folder: `factory.db` (a SQLite file) and `photos/` (item photos).
  While the app runs, recent work is also held in `factory.db-wal` — so **don't back up by copying
  files**; use `npm run backup` (below).
- When it starts, the window shows `Data folder: ... - N vans, M items`. If it says **NO VANS**, it
  has opened an empty data folder — stop it and check before anyone enters work.

**Item photos:** open an item on the Stock page → *Add photo*. On a phone or tablet this offers the
camera. **From internet…** takes a picture link *or* a supplier's product page link (the page's
main product photo is used) and has a Google Images search button; you can also right-click a
picture on any website → *Copy image* and press Ctrl+V on the item, or drag it onto the photo.
The server does the downloading and will only fetch public internet addresses (never this PC or
anything on the factory network). Photos are shrunk in the browser before upload (a 5 MB camera shot becomes ~200 KB) and
show in the stock list, on van parts lists / picking lists and on the production plan.

| Command | What it does |
| --- | --- |
| `npm start` | Run the app |
| `npm run backup -- "E:\Factory Stock backups"` | Safe backup while the app runs (see *Backups*) |
| `npm run users -- list` (`add` / `reset` / `disable` / `enable`) | Logins from the command line (see *Logins and roles*) |
| `npm run demo` | **Testing only — never on the office PC.** Wipes everything and loads made-up stock levels |
| `npm run reset` | **Testing only — never on the office PC.** Wipes everything and loads the starter catalogue |

`reset` / `demo` refuse to run on a database that has vans in it unless `--yes` is added.

## Logins and roles

Everyone has their own **username and password**. What they can do depends on their **job role**:

| Job role | Can do |
| --- | --- |
| **Owner** | Everything, and makes / changes the logins (menu **Logins**) |
| **Office** | Everything in the office app except the logins |
| **Stores** | Sees the office pages; **stock** (receive, counts / stocktake, adjust, racks and shelves, item photos, Stock checks, issue to the floor) and **receiving POs** (not making or changing POs); the worker app for every trade |
| **Leading hand** | Sees the office pages; runs the **factory floor** (moves vans, Gone out the gate, Move the line along, notes, reminders — not Edit layout); the worker app for every trade |
| **Worker** | Only the worker app (`/floor`), for **their own trade** (set on their login) |

The server checks every request (the table is at the top of `src/auth.js`; anything not in it is owner-only).
Buttons a login can't use are hidden; if one is tried anyway the message is *"Your login can't do that — ask the owner"*.
Every change records the name of the person logged in.

**First time (on the office PC itself).** With no logins yet, open **http://localhost:3000** *on the office PC* —
the page says **Create the owner login** (name, username, password). This only works on the office PC itself and only
while there are no logins; from another PC it says "Open this on the office PC itself to create the first login".
Then on **Logins** add one login per person: name, username, job role (and trade for a worker) and a temporary
password (one is suggested). Tell them the username and temporary password; "They choose their own password the
first time they log in" is ticked, so the first log in asks for a new password.

**Logging in.** `http://<this PC's address>:3000` (office) or `.../floor` (phones) opens the log in page. Workers and
leading hands land on the worker app, everyone else on the office app. Phones stay logged in for 30 days after the
last use. Name + role, **Change password** and **Log out** are at the bottom of the menu (office app) or behind the
name button at the top (worker app). Changing your password logs you out on your other phones / PCs.

**The owner on Logins:** *Edit* (name, job role, trade — a new role logs them out), *Reset password* (logs them out
everywhere), *Turn off* (can't log in, logged out at once; their name stays on what they did) / *Turn on*. The last
owner can't be turned off or given another role, and nobody can turn off themselves.

**Forgotten password / from the command line** (on the office PC, in the app folder; works while the app runs):

```
npm run users -- list
npm run users -- reset <username>              new password for that login (e.g. the owner's)
npm run users -- add <username> <role> [trade] role: owner / office / stores / leadhand / worker
npm run users -- disable <username>            npm run users -- enable <username>
```

The password is typed at the prompt (shown as `*`), never on the command line. Five wrong passwords for a username
lock it for 15 minutes on that device (the log in page warns at 2 tries left and says when it can be tried again); the owner sees "Locked until …" on **Logins** and can **Unlock** it (Reset password unlocks too); restarting the app clears the locks. After Add login / Reset password the username and temporary password are shown once, with Copy and Print.

**Later, for remote access** (Tailscale / Cloudflare Tunnel): set `ALLOWED_HOSTS` to the name used from outside
(e.g. `ALLOWED_HOSTS=factory.example.com`) — changes are only accepted on this PC's own names and addresses — and,
when a tunnel or proxy runs on this PC, `TRUST_PROXY=1` (so login throttling sees the real address and https gives
the cookie its *Secure* flag). See HANDOVER.md.

## Backups

`npm run backup -- "<folder>"` (or set `BACKUP_DIR`) makes a complete copy of the database while the
app keeps running: `<folder>\2026-10-12_1730\factory.db`. Photos go into one shared `<folder>\photos`
(new photos only). The newest 30 copies are kept (change with `BACKUP_KEEP`); older ones are removed.

- **The backup folder must be on another drive, a USB stick or a cloud-synced folder** (OneDrive,
  Google Drive). A backup on the same disk is lost with the disk.
- **Don't use a mapped network drive letter** (like `Z:`): the daily backup runs before anyone logs
  in and can't see it. A USB stick or second disk is simplest (keep it plugged in, same drive letter).
- To back up every day automatically, give the folder to the auto-start installer
  (`-BackupDir`, see *Running it 24/7 on the office PC*). It makes one backup straight away to check
  the folder, then runs at 5:30 pm every day and writes to `logs\backup.log`.
- **Check it works.** A failed backup doesn't pop up anywhere. The day after installing, check a new
  dated folder appeared in the backup folder; after that, once a week, check the newest dated folder
  is from the last day or two. *Settings → Export* also shows *Last backup*.

## Moving to the office PC / restoring a backup

Copy **only this main folder** — not the old `factory-stock\factory-stock` copy inside it (it has old
data and also uses port 3000).

**Install on the office PC**

1. Install **Node.js 24 LTS** from nodejs.org with the normal installer (installs for all users).
2. Copy this folder to the office PC (e.g. `C:\Factory Stock`). Either copy `node_modules` from this
   PC as well (same Windows, works offline), or run `npm install --omit=dev` there (needs internet,
   including cdn.sheetjs.com).
3. On this PC, stop the app (close its window), then run `npm run backup -- "<USB stick>"`.
4. On the office PC, put the data in place as in *Restoring* below, **before starting the app the
   first time** — if it starts without data it quietly makes a new, empty database.
5. Set up *Running it 24/7* (below) — it starts the app. Wait a minute, then check the
   `Data folder: ... - N vans` line in `logs\server.log` shows the right number of vans. (Don't
   start it with *Start Factory Stock.bat* on the office PC: closing that window stops the app.)

**Restoring a backup** (or bringing the data to a new PC)

1. Stop the app: close its window, or if it runs on its own, run `Stop-ScheduledTask "Factory Stock"`
   in PowerShell as administrator, **then end any `node.exe` in Task Manager** (Details tab).
   Check http://localhost:3000 no longer opens.
2. In `data\`, **delete `factory.db-wal` and `factory.db-shm`** if they are there. If they stay, the
   old changes in them are put back on top of the backup and the restore doesn't take.
3. Copy the backup's `factory.db` into `data\`, and the backup's `photos\` files into `data\photos\`.
4. Start the app again: if it runs on its own, `Start-ScheduledTask "Factory Stock"` (or restart the
   PC), wait a minute and check the `Data folder: ... - N vans` line in `logs\server.log`. Otherwise
   double-click *Start Factory Stock.bat* and check the same line in its window.

## Running it 24/7 on the office PC

`scripts\install-autostart.ps1` sets the app to start when the PC starts (no window, no login needed),
start again by itself if it stops on an error, and allows port 3000 through the firewall on private
networks. Open PowerShell **as administrator** in this folder and run:

```
powershell -ExecutionPolicy Bypass -File "scripts\install-autostart.ps1" -BackupDir "E:\Factory Stock backups"
```

(`-BackupDir` adds the daily backup; `-Remove` takes everything off again.) Everything the app
prints, including errors with the date and time, goes to `logs\server.log` (over about 5 MB it is
moved to `server.old.log` when the app next starts, e.g. when the PC restarts). If someone also
double-clicks *Start Factory Stock.bat*, it just says the app is already running.

It runs as the Windows SYSTEM account. Fine for now on the office network; before remote access is
added, consider running it as a normal local account that can only change the app folder.

Also on the office PC:

- **Power & sleep → Sleep: Never** (and don't let it hibernate), or phones lose the app.
- Give it a **fixed address**: a DHCP reservation in the router (or a static IP), so the phone
  shortcuts (`http://<address>:3000/floor`) keep working.
- Set the office network to **Private** in Windows network settings.

## Worker screen (`/floor`)

A separate, very simple screen for the factory floor: open `http://<this PC's address>:3000/floor` on
a phone or tablet (Settings shows the exact address) and *Add to Home screen*. No office menus.

- Everyone logs in (see *Logins and roles*). A worker sees their own trade — ⚡ Electrician, 🔨 Builder,
  🧱 Aluminium & cladding, 🚿 Plumber or ✨ Finisher — set on their login. Stores, leading hands, office and the
  owner pick which trade to see (or 📦 Stores / all trades) the first time on the phone; the name button at the
  top changes it, and has Change password and Log out.
- **Home screen is the factory floor map.** Each van's red badge = parts left for *that trade*, orange
  = reminders for that trade. Tap a van → only that trade's parts, with their reminders on top
  (tick ✓ when done). Reminders set for "Everyone" show for all trades.
- Every part has a trade (guessed from its name; change it on the Stock page — there's a trade
  filter too). Automatic drawing/email/photo reminders get the trade of their order line; office
  reminders are set to a trade or Everyone when you add them.
- **Take parts for a van** → pick the van → tap a part (photo cards) → *Take 2 for ST0390*. Undo is
  offered for a few seconds. If the system showed none on the shelf but the part is in their hand,
  it's taken anyway: stock set aside for vans due later is borrowed, and if there really was none
  on record the count is corrected and logged under their name.
- **Delivery arrived** → find the part → how many → *Book in* (per-van parts ask which van).
- **Find a part** → how many on the shelf, shelf location, which vans need it.
- Every update records who did it; the home screen shows "parts you updated today" and the team total.

## Factory floor

**Factory floor** (office menu) shows the shed and yard from above (2D) or as a 3D scene you can
spin (drag), zoom (scroll/pinch) and pan (right-drag). Click a van for: what's not in the factory
yet, what's in stock waiting to be fitted, notes, reminders (with dates — they also show on the
dashboard), moving it, or *Gone out the gate* (marks it finished and frees its bay).

- The starting layout follows the factory: both roller doors on the front (left = chassis in,
  right = van out) with the office between, vans pushed round a loop (Bay 1 up the left side, Bay 3–4
  across the back, Bay 5–6 down the right), and 5 yard spaces out the front inside the fence. The
  orange arrows show the loop; vans face the way they move. The order comes from the bay numbers.
- **Move the line along ▶** does the daily push: the van in the last bay goes out to the first free
  yard space, every van moves one bay forward, and the next chassis (soonest due, or your pick) goes
  into Bay 1. It shows every move before you confirm, and refuses if the yard is full.
- **Drawing / email / photo reminders**: any dealer-order line that mentions a drawing ("as per
  drawing 3", "drawings provided"), an email ("as per email 23/09") or a photo/pic ("as per clients
  photo") becomes a 📐 / ✉️ / 📷 reminder on that van automatically — shown before
  you save the order, on the dashboard, in the van panel and on the worker screen's Notes. Loading
  the order again never duplicates them, and ticked-off ones stay done.
- **Drag** a van to another bay or yard space — dropping it on an occupied spot swaps the two.
  Vans not placed yet are listed on the right; drag them onto the map.
- **Edit layout**: drag anything to move it, drag the orange corner to resize, or type exact
  sizes in metres. Add bays, yard spaces, gates, racks, workstations and walls.
- **Racks are item locations**: click a rack to add the items stored there (plus shelf/bin), or set
  *Stored in (rack)* on an item. *Find a part* on the worker screen then shows the rack on a map.
- The worker screen's *Pick the van* has a **Map** view, and each van has **Notes** workers can add to.

The 3D view uses three.js served from this PC (`node_modules/three`), so it works without internet.

The caravan pictures (`public/assets/van-top.png`, `van-side-a.png` door side, `van-side-b.png` road
side) and the concrete floor (`concrete.png`) were generated with Runway, using the Mustang photo on
stallioncaravans.com.au as the reference. To use a different look, replace those files with images of
the same shape (A-frame pointing right on the roof and door-side pictures, left on the road side,
transparent background).

## Look and feel

The office app and worker screen use the Stallion Caravans website branding: Limestone, Bark,
Espresso and Olive colours, the logo and horse mark (`public/assets/brand/`), and the website's
fonts — Inter, Work Sans and DM Mono (`public/fonts/`, open-source licence). Everything is stored on
this PC, so it looks the same without internet. Colours are set at the top of `public/styles.css`
(office) and `public/floor.css` (worker screen). Status colours (red = short, green = gate in,
production-plan pink/grey/blue) are kept as they were so they still mean the same thing.

## Production plan

The **Production plan** page is the same grid as `2026 Production Plan.xlsx`: one row per van, one
column per part, with the same colours — white not ordered, pink ordered, grey received, blue
fitted / finished. Click a cell to mark it ordered (with the order number), received or fitted.

**Settings → Update from the production plan spreadsheet** brings in what changed: new vans and
lines, new dates and statuses, deliveries (grey cells) and fitted parts (blue cells). It always shows
what will change first and does nothing until you press **Confirm**. A delivery is never booked twice,
a line with parts already set aside is never changed without asking ("Plan changes to check": Use new /
Keep current), and nothing is deleted — vans or lines missing from the sheet are marked
"Not in latest plan – check". Every import is listed under "Last imports".

**Start again from the spreadsheet** (Settings, red panel) is the old full replace: it wipes vans,
lines, POs, stock figures and history and loads everything again. It makes a full backup first
(`Factory Stock backups (before start again)` next to the data folder, or `BACKUP_DIR`), needs RESET
typed, and runs the clean-up again afterwards.

- Grey cells on active vans become stock on hand, set aside for that van.
- Pink cells become open purchase orders, grouped by the order number written in the cell
  ("Order 98", "Arizon 24").
- Cell text is matched to stock items where it's clear (batteries, solar, fridges, doors, tanks…);
  anything else becomes an "as per plan" line that keeps the exact wording.
- The spreadsheet has no shelf-stock counts, so spare stock that isn't assigned to a van must be
  entered with a stocktake.

How each column is read is in `src/planMap.js`.

**Export to Excel** produces the same layout and colours, plus the part lines, to-order list and stock.

## How it works

1. **New dealer order** → drop the PDF. The app reads every option on the form and runs it through
   the **parts rules** to build the van's parts list. Anything no rule covers (custom requests like
   "drawers under main bed") is listed under **Check by hand**.
2. **Create van** → stock is set aside (reserved) for the van straight away. When stock is short,
   vans in production get it first — a **Build order** number you set (works for vans in the bays
   too), then the earliest due date, so the most overdue van is first; the bay only decides between
   vans due the same day (last bay first). Then planned vans: build order number, then due date.
   The Vans page shows each van's place (#1, #2…) and why ("In production · due 18/9 – 26 days late ·
   Bay 3"); the PO receive dialog shows the same #, and fills the van rows top first.
   *Vans → Re-prioritise* re-shuffles free shelf stock in that order.
   - **Already fitted…** (Van page / factory floor van panel): tick parts that were already in the van
     before the system was used. **Quick start**: "tick everything received for this van more than N
     weeks ago (or before the system started)" ticks the parts that arrived for the van and are kept
     for it in full — untick anything not in yet, then Save. Partly received parts are never ticked.
   - Plan text that says a part was **given to a worker** ("Black Jack Gave to Alex") closes that
     line as given out to the van: what was set aside for it comes off the shelf figure (an issue
     movement naming the person). Done once by the clean-up, and by every plan import / update.
3. **Purchasing** → four tabs: **To order**, **Check: already ordered?**, **Special parts** and
   **Purchase orders**. To order shows each supplier as one line ("8 lines · earliest order-by 30/09");
   click it to see the lines, tick, **Create PO for ticked**, enter your PO number, done. On the
   **Purchase orders** tab, find a PO by number, supplier or van and press **Receive…** — the stock is set
   aside for the waiting vans automatically (in build order).
   - **Order now** is one number everywhere (menu badge, Dashboard, Purchasing): "107 parts (413 van lines)".
     Its lines are in build order (#1, #2… — the same numbers as the Vans page): vans in production first.
   - **Check: already ordered?** — the plan gives an order number but there is no PO in the system. One answer
     per supplier and number ("Battery Stop 200", "Coast to Coast 137"); vans due soon first with the earliest
     "needed by", later vans folded away; each says which supplier's PO a "Yes" adds to. Until answered, the
     To order tab shows one "N to check" line per supplier (not ticked, not counted) that opens these.
   - **Special parts to confirm** ("as per plan" lines): the link box opens with a suggested part, **Link all N
     lines with this same text** does every van at once, and **Keep as a one-off special part for this van**
     gives custom items (L&S doors, wheel spats) their own orderable part. A part is never suggested on a
     supplier name alone, never when the van already has it ("This van already has Sliding door rail + pelmet –
     same thing?") and never for two lines of one van. Before anything is merged into a van's existing line the
     screen says what will happen and asks. When a delivery was already received on both lines it says "Two
     deliveries were received for this van – probably different parts" instead of "same thing?". A merge keeps the
     larger need ("need 1 → need 3"); stock the van's line has no room for stays on the plan line marked "to
     check" (never free shelf stock), and the merged plan cell keeps its colour on the plan and in the Excel export.
   - Changing a line on a van page keeps your place on the page (the changed line lights up for a moment).
4. **Issue stock to floor** on the van page when the parts go to production (prints a picking list too).
5. **Export** gives an Excel workbook: a production plan (one row per van, one column per part group,
   with PO numbers and status), every part line, the to-order list, and the stock list.

### Two kinds of items

- **Kept on the shelf** — batteries, switches, jacks, tanks, mouldings… Shared between vans in build order.
  Stock page tab **Shelf stock**.
- **Bought for one van** — fridges, aircons, heaters, washing machines, microwaves, toilets, hot water,
  awnings, doors, windows, TVs, chassis, cladding, furniture, vinyl… These are bought for one van and are
  **only ever set aside for the van they were ordered or received for**. Stock page tab **Bought for vans**;
  any on the shelf with no van shows as **Unassigned** with "Assign to a van" / "Keep on shelf as spare".

**Stock → Fix the catalogue** lists parts with no supplier, rack, unit size or reorder level, editable on
the line, with suggested suppliers and reorder levels to accept and a bulk **Put on rack**.
**Stock checks** (menu) is the weekly review of floor corrections, borrowings between vans, count
differences, over deliveries and bought-for-van checks, plus "Count these next". Every van line has a
**Why?** link and every item a **Set-aside history**: who moved what, when and why.
The **Dashboard** shows one "Needs action this month" number with links, "Waiting on parts" with the
missing part names, and the **Go-live checklist**.

### Parts rules

Each rule says *"when the order says X, the van needs item Y"*. Edit them under **Parts rules** —
the page explains the syntax and has a **Test against current vans** button. Examples:

```
BATTERIES ~ \b110\s*a          → Lithium battery 110Ah, qty  n      ("2 X 110 amp" → 2)
INVERTER ~ ^no                  → Battery Protect 65A, qty 1
WATER TANK AND TAP PROTECTOR ~ checker
                                → Tank cover, qty  n[FRESH WATER TANKS] + n[GREY WATER TANK]
*                               → Standard part on every van
```

After changing rules, open a van and use **More… → Re-run parts rules** to update it (parts added by
hand and anything already issued are kept).

## Before real use

The starter catalogue (177 items, 191 rules) was worked out from the four sample orders and the
`2026 Production Plan.xlsx` columns. It is a starting point — please check:

- **Item names, SKUs and suppliers** — rename them to match what you actually call things.
- **Quantities that depend on the floor plan** were set to typical values: 7 lengths of checker
  plate, 5 J-mould, 6 reading lights, 7 m of vinyl, 2 roof hatches + 1 skylight. Adjust per model with
  rules like `SIZE ~ 24.5` if they vary.
- **Settings → Set all stock to zero**, then do a stocktake (**Stock → Stocktake / bulk count**, paste
  `SKU, quantity` from Excel).

## Files

```
server.js            web server + API
src/auth.js          logins, passwords, sessions and the job-role table (who may do what)
scripts/users.js     logins from the command line (npm run users)
public/login.*       the log in page
views/               the office app and worker app pages (index.html, floor.html) — only served after a login check
src/parseOrder.js    reads the dealer PDF
src/rules.js         order options → parts list
src/inventory.js     stock, allocation, purchasing
src/exportXlsx.js    Excel export
src/seed-data.js     starter catalogue and rules
public/              the web pages
scripts/backup.js    safe backup (npm run backup)
scripts/install-autostart.ps1, run-forever.bat   start at boot, restart on errors
data/                your data: factory.db + photos (back up with npm run backup, not by copying)
logs/server.log      what the app printed, with times (when started automatically)
```
