# Factory Stock in the cloud: owner's notes

These notes are for the owner. You do not need to be a programmer. Each step says exactly where to click.

Rule for everything below: **passwords and keys stay on your computer or in your password manager. Never paste them into a chat.**

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

1. Open **File Explorer** and go to the Factory Stock folder (the one that has `server.js` and `Start Factory Stock.bat` in it).
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
