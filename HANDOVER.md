# Handover — setting up Factory Stock on the office PC

This note is for Claude Code (and anyone helping) on the **office PC**. The app was built and tested
on the owner's home PC (2026-10-11 to 2026-10-13) and is moving here to become the live system.
Read this first, then `README.md` (how everything works, backups, restore, running 24/7).

## What this is

Factory Stock is the internal production / stock system for **Stallion Caravans** (caravan factory,
Victoria, Australia).

- Dealer order PDFs ("New Caravan Purchase Agreement") → parts list per van via editable rules →
  stock set aside by due date → purchase orders → Excel export. It replaces the manual
  "2026 Production Plan.xlsx" (already imported, with its colours = status).
- **Who uses it:** the owner (checks production), the office team (plans and orders), and a few
  workers on phones (`/floor`, filtered by trade: electrician, builder, aluminium & cladding,
  plumber, finisher, stores). **Dealers and customers never use it.**
- Factory floor map (2D + 3D), vans in 6 bays + 5 yard spaces, notes, reminders, item photos,
  Stallion website look (colours, logo, fonts — all stored locally).
- Node 24 + Express + built-in `node:sqlite`, no build step, works without internet on the LAN.
  `node_modules` is included in the zip, so no `npm install` is needed.

## Decisions already made by the owner

- It runs **here, on the office PC, 24/7** (not in the cloud). Office team and workers use it on the
  office Wi-Fi at `http://<this PC's address>:3000` (workers: `/floor`).
- The owner wants to reach it **from home** too. Remote access is **not set up yet**.
- A **downloadable worker app** comes later (built on top of this same system).

## Still to decide with the owner (ask, don't assume)

1. **Login** — done (2026-10): own username + password per person with five job roles; see *Logins and
   roles* below. (Workers have a password of at least 8 characters, not a 4-digit PIN.)
2. **Remote access** — recommended **Tailscale** (only the owner's devices can reach the PC) if only
   the owner works remotely; **Cloudflare Tunnel + Cloudflare Access** if office staff also need it
   from outside. The owner creates any accounts themselves; never put the app on the open internet.
3. **Parts question (orders-7):** on a 100/80 + Cerbo van, do they also fit a 100/50 solar controller,
   and how many 100/30s? Until answered, those controllers may be under-ordered on new 100/80 vans.
4. Yard van positions (the owner hasn't given them yet).

## Setting it up (do these with the owner, one at a time)

1. Node.js 24 LTS installed (nodejs.org, normal installer, all users). Check `node -v`.
2. The folder lives at **`C:\Factory Stock`** (not inside a user's Documents, because it runs as a
   Windows service-style task). The zip's `data\factory.db` is a clean, checked snapshot with no
   `-wal`/`-shm` files, and `data\photos` holds the item photos.
3. First start, before anything automatic: `cd "C:\Factory Stock"` then `node server.js`. Check the
   window says `Data folder: ... - 65 vans, 251 items` (numbers may be a little different, but
   **never "NO VANS"**). Open http://localhost:3000 and http://localhost:3000/floor, then stop it
   (Ctrl+C).
4. Pick the backup place with the owner (USB stick / second drive / OneDrive folder — not the same
   disk, not a mapped `Z:` drive). Then in PowerShell **as administrator** in the folder:
   `powershell -ExecutionPolicy Bypass -File "scripts\install-autostart.ps1" -BackupDir "<folder>"`
   (starts at boot with no login, restarts on errors, firewall on private networks, daily 5:30 pm
   backup). Check `logs\server.log` shows the van count and `logs\backup.log` shows "Backup saved".
5. Power & sleep → **Sleep: Never**, no hibernate. Office network set to **Private**.
6. Fixed address: DHCP reservation in the router (owner logs in to the router) or a static IP.
7. **Create the owner login on this PC** (see *Logins and roles* below), then the other logins.
8. Test from an office laptop and a worker's phone on the Wi-Fi. Settings page shows the addresses.
9. Tell the owner the home-PC copy is now retired — only this PC is live.

## Logins and roles

Every person has their own username + password; their **job role** decides what they can do (README →
*Logins and roles* has the full list). Owner = everything + the **Logins** page; Office = everything except logins;
Stores = read-only office pages + stock / counts / receiving POs + worker app; Leading hand = read-only office pages +
running the factory floor + worker app; Worker = the worker app for their own trade only. The rules are one table at
the top of `src/auth.js` (`API_RULES`): easy to change, and any route not in it is owner-only.

**First-time setup on the office PC** (once, straight after the app first starts with this version):

1. The start-up log (`logs\server.log`) says `Logins: NONE YET - open http://localhost:3000 on THIS PC …`. Until the
   owner login exists nobody can use the app.
2. **Sitting at the office PC itself**, open **http://localhost:3000** → *Create the owner login* → the owner's name,
   a username and a password (at least 8 characters; write it down somewhere safe). This screen only works from the
   office PC itself and only while there are no logins (from any other PC: "Open this on the office PC itself to
   create the first login"). Do this **before** any tunnel / remote access is set up.
3. Office app → **Logins** → **+ Add login** for each person: name, username, job role (and trade for a worker), the
   suggested temporary password. Give each person their username + temporary password; they choose their own at
   their first log in. A second owner login is a good idea (if one owner is away / locked out).
4. Workers open `http://<PC address>:3000/floor` on their phone (or the installed Stallion app) and log in once — they
   stay logged in for 30 days after their last use.

**Forgotten owner password** (or any login, when no owner can reset it): on the office PC, in PowerShell in the app
folder (`cd "C:\Factory Stock"`), run `npm run users -- reset <username>` and type the new password twice (the
username list: `npm run users -- list`). It works while the app is running; that person is logged out everywhere and
logs in with the new password. If the owner login was turned off, `reset` turns it back on. Other commands:
`npm run users -- add <username> <role> [trade]`, `disable <username>`, `enable <username>`. Anyone who can sit at
the office PC and open the app folder can do this — so keep the office PC itself locked (Windows password).

**Good to know**
- Logins and sessions are in `factory.db` (tables `users`, `sessions`), so backups include them; passwords are only
  stored as scrypt hashes, sessions only as sha256 of the cookie's token.
- Five wrong passwords for a username lock it for 15 minutes on that device; 30 wrong tries from one device in 15
  minutes lock that device for 15 minutes. Restarting the app clears the locks. The owner can Unlock a username on **Logins**.
- The session cookie is named after the port (`fs_session_3000`), so a test copy on another port on the same PC
  never logs the live app out.
- Changes (`POST/PUT/DELETE /api/…`, incl. log in) are only accepted when the browser used one of this PC's own
  names / addresses (localhost, the LAN / Tailscale addresses, the PC name, `<PC name>.local`) or a name in the env
  `ALLOWED_HOSTS`. If staff reach the PC by another name (e.g. a router DNS name), add it there; the log says
  `Refused a change sent to the address "…"` when that happens.

**To do before remote access (Tailscale / Cloudflare Tunnel)**
- Add the outside name to `ALLOWED_HOSTS` (comma list) in the auto-start task / `run-forever.bat` environment, e.g.
  `ALLOWED_HOSTS=factory.example.com` (Tailscale's 100.x address is already allowed; a MagicDNS name is not).
- If the tunnel / proxy runs **on this PC** (cloudflared, `tailscale serve`), set `TRUST_PROXY=1` so the login
  throttling sees each visitor's own address (otherwise everyone looks like 127.0.0.1 and 30 wrong tries from the
  internet would lock out the whole office for 15 minutes) and https gives the cookie its *Secure* flag. Make sure
  the tunnel passes the original Host header.
- Use https for anything outside the office network (Cloudflare / Tailscale both give it). On the plain office Wi-Fi
  the password and cookie travel unencrypted (as everything did before); acceptable on a private LAN, not outside.
- Cloudflare Access (or Tailscale ACLs) in front is still recommended as a second lock.

## Rules for working on this system

- **Live data is `data\`. Never edit it directly, never run `npm run reset` or `npm run demo` here.**
- Before changing code: `npm run backup -- "<backup folder>"`. Test changes on a copy: copy
  `factory.db` via a backup to a temp folder and run `node server.js` with env `DATA_DIR=<copy>` and
  `PORT=3100`. Restart the live app afterwards (`Stop-ScheduledTask` / `Start-ScheduledTask
  "Factory Stock"` as admin, see README).
- Keep the plain, simple wording staff see, the Stallion theme, and the existing features. No dealer
  or customer access.
- Ask the owner before installing remote-access software, changing the router, or anything that
  exposes the PC beyond the office network.

## Expert review (done 2026-10-13 before the move)

Six sectors were reviewed by expert agents, every finding checked by a second agent, fixed, and
signed off: security, stock/allocation/purchasing, dealer-order reading & rules, 24/7 reliability,
office app, worker screen. ~45 problems fixed (e.g. double taps taking parts twice, Undo leaving
phantom stock, plan re-import wiping notes/reminders/bay positions, "No…/Remove…" order answers
being ignored, internet-photo fetcher reaching the local network, no safe backup).

**Notes for when login is added** (from the security review — all done in "Logins and job roles", see
CHANGES.md: login check before the data routes and `/photos`, name from the session, office-only routes, Origin
guard kept, HttpOnly + SameSite=Lax cookie, Host allow-list with `ALLOWED_HOSTS`):
- Put the login check before the static file routes (`public`, `/vendor`, `/photos`) and before the
  `/api` Origin guard in `server.js`.
- Take the worker's name (`by`) from the login session, not from the request body.
- Office-only: `/api/web-image`, `/api/settings`, plan import, clear stock, re-prioritise,
  move-the-line-along, van leave/rebuild.
- Keep the Origin / Sec-Fetch-Site guard; use HttpOnly, SameSite=Lax (or Strict) cookies.
- Add a Host allow-list (localhost, this PC's LAN addresses and name, the tunnel name) to stop DNS
  rebinding; if a tunnel is used, make sure it passes the original Host header.

**Small known leftovers (low, optional):** decimal rounding of part counts (round to 4 places);
two rare reminder edge cases (labels over ~190 characters; a line removed from a revised order keeps
its reminder open); on the worker screen, a delivery re-opened after "No signal" could be booked
twice; Undo gives freed stock to the same van first.
