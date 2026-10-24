# Factory Stock online: owner's notes

These notes are for the owner. You do not need to be a programmer. Each step says exactly where to click.

**What is changing.** Factory Stock moves from the PC at home to the internet, so that the phones, the office PC and you all use the same live copy from anywhere. It stays free: the screens live on Cloudflare Pages at **https://stallion-stock.pages.dev**, and the data (and the item photos) live in your Supabase project in Sydney.

Rule for everything below: **passwords and keys stay on your computer or in your password manager. Never paste them into a chat, an email or a file.** Where a step needs one, you type or paste it yourself, into the dashboard or the black terminal window. Claude never needs to see it.

Steps marked **(you)** are yours. Steps marked **(Claude)** are done by Claude while you watch.

Contents:

1. One-time sign-ins (about 20 minutes, once)
2. Secrets: what each one is and where it goes
3. Install on Windows, iPhone and Android
4. Make a second owner login, and keep it safe
5. If the app says "asleep"
6. Cut-over day checklist
7. Where the backups are, and how to get them back
8. Things that work differently online
9. For whoever helps (technical appendix)

---

## 1. One-time sign-ins

You will do three things once: make the database project at Supabase, sign in to Supabase from the home PC, and make a free Cloudflare account and sign in to it from the home PC. It takes about 20 minutes. When you finish, tell Claude "sign-ins done" and send the Project Reference id (step 1B). That id is not a secret.

### 1A. Make the Supabase project

You already have a Supabase account for Ausventure. Use the same one.

1. Open **supabase.com** and click **Dashboard** (top right). Sign in the same way you do for Ausventure.
2. Click **New project**. If it asks which organisation, pick the one you use for Ausventure.
3. Fill in the form:
   - **Name:** `stallion-factory-stock`
   - **Database password:** click **Generate a password**, then click the copy icon and **save it in your password manager** straight away (call the entry "Supabase stallion-factory-stock database"). Supabase will not show it again later, only let you reset it.
   - **Region:** choose **Oceania (Sydney)**, which is `ap-southeast-2`. This matters: it keeps the data in Australia and close to the factory.
   - **Pricing plan:** the **Free** plan. No card is needed.
4. Click **Create new project** and wait a couple of minutes until the dashboard stops saying "Setting up project".
   - If Supabase says you have reached the limit of free projects, tell Claude. Do not upgrade anything.

### 1B. Copy the Project Reference id

1. In your new project, click the **gear icon (Project Settings)** at the bottom of the left menu.
2. Click **General**.
3. Find **Reference ID**. It is about 20 letters, like `abcdefghijklmnopqrst`. Click the copy icon.
4. Keep it for the message to Claude. It is safe to send because it is not a password.

### 1C. Open a terminal in the Factory Stock folder

1. Open **File Explorer** and go to the Factory Stock folder (the one called `factory-stock-cloud`, which has `server.js` and `Start Factory Stock.bat` in it).
2. Click once in the address bar at the top (the long box showing the folder path), type `cmd`, and press **Enter**. A black window opens. This is the terminal. Leave it open.

### 1D. Sign in to Supabase from the home PC

1. In the black window type this and press **Enter**:

   ```
   npx supabase login
   ```

2. If it asks "Ok to proceed?" type `y` and press Enter. This is just it fetching the Supabase tool.
3. Your web browser opens with a short code. Check the code matches the one in the black window, then click the button to allow it. If no browser opens, copy the link the window shows and paste it into your browser. Do not paste it anywhere else.
4. The black window says you are logged in.

### 1E. Make the free Cloudflare account

1. Open **cloudflare.com** and click **Sign up** (top right).
2. Enter your email and a new password, and save that password in your password manager ("Cloudflare"). Click **Sign up**.
3. Cloudflare emails you a link. Open the email and click it to verify your address.
4. Cloudflare may then offer to add a website or pick a plan. **You do not need to add a domain.** If you reach a screen asking you to choose a plan, choose **Free**. **Skip any payment step; the Free plan never needs a card.** If a screen insists on a card, stop and tell Claude.

### 1F. Sign in to Cloudflare from the home PC

1. Go back to the black window from 1C (or open a new one the same way).
2. Type this and press **Enter**:

   ```
   npx wrangler login
   ```

3. Type `y` if it asks to proceed. Your browser opens a Cloudflare page. Click **Allow**.
4. The black window says you are logged in. You can close it.

### 1G. Tell Claude

Send Claude one short message: "sign-ins done" and the Reference id from 1B. Do not send any passwords.

---

## 2. Secrets: what each one is and where it goes

You only deal with these on set-up day and cut-over day. **Save every one in your password manager straight away**, in an entry with a name you will recognise.

"Dashboard" means the company's website, in your normal browser. "Terminal" means a black window opened in the Factory Stock folder as in step 1C. For the commands below that start with `$`, open it as **PowerShell** instead: in the File Explorer address bar type `powershell` (not `cmd`) and press **Enter**.

| Name | What it is | Where you get it | Where it is pasted |
| --- | --- | --- | --- |
| Database password | The password you made in step 1A | Your password manager | Only inside the database address below |
| Database address, **transaction** kind (port 6543) | How the online app reaches the database | Supabase dashboard (below) | The terminal prompt `DATABASE_URL`, when Claude runs the deploy |
| Database address, **session** kind (port 5432) | How the copy, the first logins and the backup reach the database | Supabase dashboard (below) | The terminal (below), and GitHub (step 7) |
| Pass secret `PASS_SECRET` | A long random code that proves a request came through our own Cloudflare page. Without it the online app refuses everyone | You make it on your PC (below) | **Two places, the same value:** the terminal prompt `PASS_SECRET` during the deploy, and Cloudflare (below) |
| `API_ORIGIN` | The internet address of your Supabase project. Not secret | `https://` + your Reference id + `.supabase.co` | Cloudflare (below) |
| `ALLOWED_HOSTS` | The public address, `stallion-stock.pages.dev`. Not secret | You type it | The terminal prompt `ALLOWED_HOSTS` during the deploy |
| Service key `SUPABASE_SERVICE_ROLE_KEY` | A master key to your project's photo store | Supabase dashboard (below) | The terminal (cut-over day), and GitHub (step 7) |
| Project address `SUPABASE_URL` | Same as `API_ORIGIN`. Not secret | As above | The terminal (cut-over day), and GitHub (step 7) |

You do **not** set the project address or the service key on the online app itself: Supabase gives both to it automatically.

### Where to find the database address (Supabase)

1. Open the Supabase dashboard and click your project **stallion-factory-stock**.
2. Click the **Connect** button at the top of the page. A panel opens with tabs. Click **Connection string** (it may already be showing).
3. There is a drop-down (or a list of choices) for the type. Pick **Transaction pooler** for the online app, or **Session pooler** for everything else in the table. Each shows a long line starting `postgresql://postgres.`. The number after the last colon is the port: **6543** is transaction, **5432** is session.
4. In that line there is a piece in square brackets, `[YOUR-PASSWORD]`. **Replace that whole piece, brackets included,** with your database password.
5. Click the copy icon and paste it straight into the terminal prompt (below). Do not keep it in a text file.

If your database password has symbols such as `@`, `/` or `#` in it, tell Claude before you start: those need a special spelling inside the address.

Supabase changes its screens now and then. If yours looks different, look for the words "pooler" and "connection string", or tell Claude what you see. Do not send the address itself.

### Where to find the service key (Supabase)

1. In your project, click the **gear icon (Project Settings)** at the bottom of the left menu.
2. Click **API Keys** (or **API**).
3. Find the key called **service_role** (it may be under a tab named **Legacy API keys**). Click **Reveal**, then the copy icon. Treat it like a password: it can read and change everything in the project.

### Making the pass secret

1. In the terminal, type this on one line and press **Enter**:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. A line of about 43 random letters and numbers appears. Select it with the mouse and copy it.
3. Paste it into your password manager at once, in an entry called "Stallion pass secret". You will paste the same value twice more (deploy prompt and Cloudflare).

### Typing a secret into the terminal

When Claude runs the deploy, the terminal asks for each secret by name and **shows nothing as you type or paste** (on purpose). Right-click to paste, then press **Enter**. Leave one empty to keep what is already set.

For the copy and the logins, you set three values in your own PowerShell window first. Paste the lines below one at a time. After each, a prompt appears: paste the value (nothing shows) and press **Enter**.

```
$s = Read-Host "Database address (session kind)" -AsSecureString; $env:DATABASE_URL = [Net.NetworkCredential]::new('', $s).Password
$s = Read-Host "Project address" -AsSecureString; $env:SUPABASE_URL = [Net.NetworkCredential]::new('', $s).Password
$s = Read-Host "Service key" -AsSecureString; $env:SUPABASE_SERVICE_ROLE_KEY = [Net.NetworkCredential]::new('', $s).Password
```

These last only until you close that window. Do this again each time you open a new one.

### Pasting into Cloudflare

1. Open **dash.cloudflare.com** and sign in.
2. In the left menu click **Workers & Pages**, then click the project **stallion-stock**.
3. Click **Settings**, then **Variables and Secrets** (it may say **Environment variables**), then **Add**.
4. Add two, for **Production**:
   - Name `API_ORIGIN`, type **Text**, value `https://<your Reference id>.supabase.co` (nothing after `.co`).
   - Name `PASS_SECRET`, type **Secret**, value the pass secret from your password manager.
5. Click **Save**. They take effect the next time the screens are deployed, so tell Claude when they are saved.

### Pasting into GitHub (the nightly backup, step 7)

1. Open the private repository **stallion-factory-backups** on github.com (Claude makes it for you).
2. Click **Settings**, then **Secrets and variables** in the left menu, then **Actions**.
3. Click **New repository secret**. Type the name, paste the value, click **Add secret**. Do it three times:
   - `DATABASE_URL`: the **session** kind (port 5432).
   - `SUPABASE_URL`: the project address.
   - `SUPABASE_SERVICE_ROLE_KEY`: the service key.

---

## 3. Install on Windows, iPhone and Android

The address for everyone is **https://stallion-stock.pages.dev**. It works in any browser. Installing just puts an icon on the screen so it opens like an app. People stay logged in for 30 days.

### Windows (the office PC)

1. Open **Microsoft Edge** and go to **https://stallion-stock.pages.dev**. Log in.
2. Click the **three dots (⋯)** at the top right, then **Apps**, then **Install this site as an app**.
3. Click **Install**. If it asks, tick **Pin to taskbar** and **Create desktop shortcut**.
4. From now on it opens in its own window with the Stallion icon and no browser bars.

### iPhone (the staff)

It must be **Safari** (the blue compass). Chrome on an iPhone cannot add it to the home screen.

1. In Safari go to **https://stallion-stock.pages.dev**. Log in with the username and temporary password you were given. It asks you to choose your own password.
2. Tap the **Share** button (a square with an arrow pointing up) at the bottom of the screen.
3. Scroll down the list and tap **Add to Home Screen**.
4. Leave the name as it is and tap **Add** (top right).
5. Open the app from its new icon. The first time you take a photo, tap **Allow** when it asks for the camera.

Workers land on the factory-floor screen by themselves.

### Android (the owner)

The Android app is a small program that shows the same site full-screen. It is installed from a file (an "APK"), not from the Play Store. You make it once on the home PC with your free Expo account (`uvindu13`), with Claude beside you.

1. In the Factory Stock folder, open the terminal (step 1C). Type these, one at a time, pressing **Enter** after each:

   ```
   cd mobile
   npm install
   npx eas-cli login
   npx eas-cli build --profile preview --platform android
   ```

2. `eas-cli login` asks for your Expo email and password. Type them there (the password is not shown).
3. The first build asks to create the project and a signing key. Answer **y** (yes) each time. The key stays with Expo.
4. Wait 10 to 20 minutes. The window ends with a **build link**.
5. Open that link **on your Android phone**, tap **Download**, then tap the downloaded file to install.
6. If Android says it cannot install from this source, tap **Settings** in that message, turn on **Allow from this source** for your browser, go back and tap install again.
7. Open **Stallion** and log in.

Only send this link to people who should have the Android app. (A quicker option on any Android phone without the APK: open the address in Chrome, tap the three dots, then **Add to Home screen** or **Install app**.)

### Checks after installing **(Claude with you)**

Do each once, and tell Claude anything that does not work:

- **Android app:** open an item on the **Stock** page and tap **Add photo**. The phone should offer the camera; take a photo. It uploads and shows on the item. Then go to **Settings**, tap **Download Excel**. The file should download and open. (If the Excel download does nothing in the Android app, tell Claude: it can be fixed in the app.)
- **iPhone:** open the app from the home-screen icon (not from Safari), log in, and take an item photo with the camera on the Stock page (use an office or stores login), or open **Find a part** as a worker.
- **Windows:** open the installed app, log in, go to **Settings** and click **Download Excel**. The file should save to Downloads.

---

## 4. Second owner login: make it at cut-over and keep it safe

Why: the owner login is the only one that can add and change the other logins. If you forget its password, or it gets locked (five wrong tries lock it for 15 minutes), a second owner login lets you in to fix it. It is a spare key you do not use day to day.

There are no logins in the data that moves online, so at cut-over you make your own owner login first (step 6D), and then the spare, **the same way**:

1. Open PowerShell in the Factory Stock folder and set the three values as in step 2 ("Typing a secret into the terminal"). Only the first (`DATABASE_URL`) is needed for logins.
2. Type this, and change `owner-spare` if you like:

   ```
   npm run users -- add owner-spare owner
   ```

3. It asks for a name (press **Enter** to take the suggestion), then a password twice (nothing shows as you type), then "Must they choose their own password when they first log in?". Type **n**, because you are choosing it yourself.
4. **Use a long password nobody could guess**, and save it in your password manager in an entry called "Stallion owner spare", or write it on paper and keep that somewhere safe. Never type it into a chat.
5. Check that it works: open **https://stallion-stock.pages.dev** in a private window, log in as `owner-spare`, check you can see **Logins** in the menu, then log out.

Later, to see the logins or to fix a forgotten password (with the three values set as above):

```
npm run users -- list
npm run users -- reset <username>
```

Or, if you can log in as one owner, use **Logins** in the menu: **Edit**, **Reset password**, **Turn off / Turn on**, **Unlock**.

---

## 5. If the app says "asleep"

The free Supabase database goes to sleep if nobody has used it for a week. The nightly backup (step 7) touches it every night, so this should be rare. If a screen says **"The database is asleep or unreachable — try again in a minute"**:

1. Wait a minute and try again. Sometimes that is all it needs.
2. Open the Supabase dashboard and click your project **stallion-factory-stock**.
3. If it says the project is **paused**, click **Restore project** and wait a few minutes until it says the project is running. Your data is kept. (Restore it within about three months of the pause, so do not leave it.)
4. Go back to the app and reload.
5. Still stuck? Tell Claude exactly what the screen says. Do not change any settings.

If the Android app says "Waiting for signal…", that is the phone with no internet, not the database. Turn on mobile data or Wi-Fi and tap **Retry**.

---

## 6. Cut-over day checklist

Cut-over day is when the real data moves up and the online version becomes the one everyone uses. Pick a quiet day. It takes a couple of hours, with Claude doing the technical parts beside you. Until step I, the old version at the factory is untouched and still has all your data.

**Before the day (Claude, with your sign-ins and secrets):** the tables, the app and the screens are put online, you have typed the secrets (step 2), and you have tried every job role on made-up data on Android, iPhone and Windows. Anything found has been fixed.

**A. (you) Stop using the old version.** From now nobody enters anything in the old version. Tell everyone. Anything entered after the copy is taken will not be in the online version.

**B. (you, optional) Bring the production plan up to date in the original version.** The online version cannot read the production plan spreadsheet. ("Update from the production plan spreadsheet" and "Start again from the spreadsheet" are not there.) So do any plan update now, on the original version at the home PC, on a copy, exactly as before. Then stop it.

**C. (Claude) Take a safe copy and load it.** Claude copies the data and photos to a new folder, leaving the originals untouched, and loads the copy into the online database. The last line must be **ALL CHECKS PASSED**. If anything fails, the online database is left as it was. As the first part of this, the old start-up stock clean-up (the same one the factory version was due for) runs on the *copy* first, so some stock figures change a little. Step G is for that.

**D. (you) Make the first owner login, then the spare.** The data you moved has no logins, so you make the first yourself. In PowerShell in the Factory Stock folder, set the three values (step 2), then:

```
npm run users -- add <your-username> owner
```

Type your own password twice when asked (nothing shows). Do not say it aloud to anyone or type it into a chat. Type **n** to "must choose their own". Then make the second owner login (step 4).

Always do this **after** step C. Loading the data again would remove any logins.

**E. (you with Claude) Set up the nightly backup and run it once, before telling staff.** Claude makes the private backup repository on GitHub. You paste the three secrets into it (step 2, "Pasting into GitHub"). Claude then runs the backup by hand. It must show a **green tick**, and a file in `db/` with today's date. If it is red, fix it before going on.

**F. (you) Check on your own devices.** Log in on your Android phone, one iPhone and one Windows PC (step 3). Open **three vans** and **three items** and check them against the old data (Claude can open a copy of the old data beside you). Compare the number of vans, the stock on hand, a photo and a purchase order. Then do the checks at the end of step 3.

**G. (office, the same day) Glance over the stock figures.** The clean-up ran on the copy, so the office should look over **Stock checks**, the **Clean-up report** and the **Dashboard** shortages. In the trial it locked 673 lines of received stock to their vans, fixed some quantities and order numbers read wrongly from the plan, and marked some purchase orders "to check". Tick things off as you go. Tell Claude about anything that looks wrong; do not work around it.

**H. (you) Make the logins for staff.** Menu **Logins**, **Add login**: name, username, job role (and trade for a worker) and the suggested temporary password. They choose their own the first time they log in. Give each person their username and temporary password in person or on paper, not by text.

**I. (you) Tell everyone.** Send **https://stallion-stock.pages.dev** and the install notes (step 3: iPhone, Windows). Leave the old copy on the home PC **untouched for at least a month**. Do not start it again for real work: two live copies would drift apart.

If something is badly wrong in the first days, tell Claude. The old copy (as it was at the copy) and the nightly backups are there to go back to.

---

## 7. Where the backups are, and how to get them back

Every night at about 1 am, a robot on GitHub copies the whole database and every photo into a **private** repository: `dinujayadissa-blip/stallion-factory-backups`.

- `db/factory-YYYY-MM-DD.dump` is the whole database, one file per night. The last 30 are kept.
- `photos/` has every item picture (kept even if someone later removes the photo in the app).

Treat that repository like the live database: it holds your real data. Only add people you trust, and never make it public.

**Checking it works (30 seconds, once a week).** On github.com open the repository and click **Actions**. The newest run should have a **green tick** and be from the last day or two. Click **Code**, then the folder `db`, and check there is a file with a recent date. GitHub also emails you if a run fails.

**Getting it back (if the online database is lost or wrongly changed).** The step-by-step is in **`docs/RESTORE.md`** in the Factory Stock folder. It has you pick the newest dump, restore it into a new Supabase project, put the photos back and check the numbers. A helper can do the technical steps; the sign-in steps are marked **(owner)**. Do one practice restore soon after the first night's backup, so you know it works, and delete the practice project afterwards (the free plan allows two).

---

## 8. Things that work differently online

- **A save that fails saves nothing.** If a sheet fails part-way (for example a stocktake sheet with one bad row), none of it is saved. The message says what is wrong. Fix that row and send the sheet again.
- **The production plan spreadsheet cannot be read online.** Those buttons are hidden. Updating from it, or starting again from it, is done on the original version at the home PC.
- **Asleep and no signal.** See step 5.
- **Everyone sees the same live data.** Two people can work at the same time. If two change the same thing in the same moment, the second waits a fraction of a second.
- **The old home address stops being used.** Everyone uses **https://stallion-stock.pages.dev**.

---

## 9. For whoever helps (technical appendix)

This part is for Claude or another helper. The owner can skip it.

### How it fits together

Browser or app -> Cloudflare Pages `stallion-stock.pages.dev` (the screens, plus a pass-through that adds `x-pass-secret`, `x-forwarded-host`, `x-forwarded-for` and `x-forwarded-proto`) -> one Supabase Edge Function `api` (`supabase/functions/api`, which runs `src/app.js` with `CLOUD=1`) -> Postgres (Sydney) and the private Storage bucket `item-photos`. Locally the same code runs on PGlite.

### Secrets by name (none are stored in the repo)

| Where | Names |
| --- | --- |
| Edge Function (Supabase secrets) | `DATABASE_URL` (transaction pooler, port 6543), `PASS_SECRET`, `ALLOWED_HOSTS` (`stallion-stock.pages.dev`; required, without it every change is refused with 403), `CLOUD=1`. Optional `PUBLIC_URL`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically (the CLI refuses to set names starting `SUPABASE_`). |
| Cloudflare Pages (Production) | `API_ORIGIN` (`https://<ref>.supabase.co`), `PASS_SECRET` (the same value as the function's) |
| Private backup repo (GitHub Actions) | `DATABASE_URL` (session pooler, port 5432), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Owner's terminal, copy day | `DATABASE_URL` (session, 5432), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

The owner types or pastes every value. Do not ask for them in chat.

### Put the app online (after "sign-ins done"; repo folder, PowerShell)

```
npm install
powershell -ExecutionPolicy Bypass -File scripts\deploy-api.ps1 -Ref <ref> -SetSecrets
```

This runs `supabase link` (asks the database password), `db push` (tables), then prompts for each secret (typed by the owner), sets them plus `CLOUD=1`, and deploys the function. Later deploys: leave out `-SetSecrets`; `-SkipDbPush` skips the tables. Check (the owner types the pass secret; never echo it):

```
curl.exe -i -H "x-pass-secret: <secret>" https://<ref>.supabase.co/functions/v1/api/api/me      # 401 Please log in
curl.exe -i -H "x-pass-secret: <secret>" https://<ref>.supabase.co/functions/v1/api/api/setup   # 200: database reachable
curl.exe -i https://<ref>.supabase.co/functions/v1/api/api/me                                    # 403
```

The private `item-photos` bucket must exist before the copy uploads photos (`scripts/restore-photos.mjs` creates it if missing; check the migrations or create it in the dashboard, Storage, private).

The screens: create the project once (`npx wrangler pages project create stallion-stock --production-branch main`), the owner saves `API_ORIGIN` and `PASS_SECRET` in Cloudflare, then:

```
powershell -ExecutionPolicy Bypass -File scripts\deploy-pages.ps1
```

Variable changes in Cloudflare only take effect on the next deploy.

### Check the client address survives the Supabase gateway

After the first deploy, log in from two phones on different networks and read the function logs (Supabase dashboard > Edge Functions > api > Logs). The line `Logged in: <username> (<role>) from <ip>` must show **two different, real public addresses**. If every login shows the same address (or a Cloudflare or Supabase one), the gateway is replacing or dropping `x-forwarded-for` / `x-forwarded-host` / `x-forwarded-proto`: the login throttle would lock everyone together, the host check would refuse changes and cookies would lack `Secure`. Fall back to custom headers (for example `x-fs-client-ip`, `x-fs-host`) set in `functions/_forward.js` and read in `src/app.js` (`clientIp`, `hostOf`, `secure`), with a test. Also check, logged out, that `/index.html`, `//index.html`, `/%69ndex.html` and `/floor.html` go to `/login`, and that a worker opening `/` lands on `/floor`.

### Cut-over commands (owner's PowerShell, values set as in step 2)

1. Source copy: stop the original version and use its `npm run backup -- "<folder>"` (or copy `factory.db` and `photos\` once it has stopped). Optional plan import first, on a copy, in a `sqlite-final` checkout. The copy script itself opens the source read-only and works on a temporary copy.
2. Load, from this repo with the local `sqlite-final` tag present (the default `--prepare` runs the old start-up stock clean-up on the temporary copy first; `--no-prepare` only for a copy already prepared):

   ```
   node scripts/copy-to-cloud.js --from "<folder>\factory.db" --to $env:DATABASE_URL --photos "<folder>\photos" --wipe
   ```

   Expect the start-up counts, `Stock clean-up: 20 of 20 step(s)` and `ALL CHECKS PASSED`. `--wipe` is needed when the database has any rows (a server boot seeds the catalogue). A failed check rolls everything back. Use the session address (5432): it needs `TRUNCATE ... RESTART IDENTITY` and an advisory lock.
3. First logins (the data has none; first-time setup is off online): `npm run users -- add <username> owner`, then the spare. Never re-run the copy with `--wipe` after this: it removes the logins.
4. Backups: `gh repo create dinujayadissa-blip/stallion-factory-backups --private --source "<path to the local stallion-factory-backups folder>" --remote origin --push`. The owner adds the three secrets on the GitHub page (or `gh secret set NAME -R dinujayadissa-blip/stallion-factory-backups`, each prompting for a paste). Run once: `gh workflow run nightly.yml -R dinujayadissa-blip/stallion-factory-backups`, then `gh run watch -R dinujayadissa-blip/stallion-factory-backups`. Expect green, one `db/factory-<date>.dump`, `photos/` filled. The restore rehearsal in `docs/RESTORE.md` is what proves the `pg_dump --schema=public` / `pg_restore` round trip.
5. Android: `mobile/README.md` (optional Expo Go test with `npx expo start --tunnel`, then the EAS preview build). If the camera or the Excel download fails inside the WebView, a permission or download-handler fix is needed in `mobile/App.js`.
6. Remind the owner that the clean-up changed some figures; the office glances over Stock checks and the Clean-up report.

### After cut-over

The old home-PC copy stays untouched for at least a month. Before retiring it, take one last `npm run backup` of it.
