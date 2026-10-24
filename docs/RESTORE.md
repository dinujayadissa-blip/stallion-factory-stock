# Restoring Factory Stock from a backup

When to use this: the live Supabase project is lost, damaged or wrongly changed, and the nightly
backup has to bring the data back. Also use it once to **rehearse** a restore, so the steps are known to
work before they are needed.

The backups live in a **private** GitHub repo, `dinujayadissa-blip/stallion-factory-backups`:

- `db/factory-YYYY-MM-DD.dump` - the whole database, one file per night, 30 days kept
- `photos/` - every item picture

Steps marked **(owner)** need the owner's own logins. A helper can do the rest once the owner gives
them access to the private repo (as a collaborator) and, for the live project, the Supabase keys.
Never paste keys or passwords into chat, an email or any file in a repo.

## 0. What you need on the PC

- **Git** and **Node 20+** (https://nodejs.org).
- **PostgreSQL 17 command-line tools** (`pg_restore`, `psql`). On Windows, install PostgreSQL 17 from
  https://www.postgresql.org/download/windows/ and tick only "Command Line Tools". Check:
  `pg_restore --version` shows 17 (or newer).

## 1. Get the newest backup  **(owner, or a helper added to the private repo)**

```
gh repo clone dinujayadissa-blip/stallion-factory-backups
cd stallion-factory-backups
dir db
```

The newest `factory-YYYY-MM-DD.dump` is the last one in the list. To go back to an earlier day, pick
that day's file instead. The photos are in the `photos` folder next to it.

## 2. Make somewhere to restore into

Pick one:

- **A scratch Supabase project** (best for a rehearsal, and what is needed if the live project is
  gone). **(owner)**: sign in at supabase.com, New project, region Sydney, and write down the database
  password. Then open Project settings > Database > Connection string, choose **Session pooler**
  (port 5432) and copy it, filling in the password. Also copy the project URL and the `service_role` key
  from Project settings > API.
- **A local Postgres 17** on the PC: `createdb factory_restore`, and the URL is
  `postgres://postgres:<password>@localhost:5432/factory_restore`.

Call the database address `<url>` below. It looks like `postgres://...`.

## 3. Restore the database

```
pg_restore --clean --if-exists --no-owner -d "<url>" db/factory-YYYY-MM-DD.dump
```

Use the real file name. A few "already exists" or "does not exist, skipping" lines are normal on a
brand-new database. Real problems say `error:` and stop with a message about a table or the file.
The nightly backup holds only the app's own tables (schema `public`), so this brings back items, vans,
orders, movements, logins and settings.

## 4. Put the photos back

Only needed when the restore target is a Supabase project (a local Postgres keeps photos in a folder
instead). From a copy of the main repo (`git clone https://github.com/dinujayadissa-blip/stallion-factory-stock`),
in PowerShell, pointing at the backup's photos folder:

```
$env:SUPABASE_URL = "https://<project-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service_role key>"
node scripts/restore-photos.mjs "..\stallion-factory-backups\photos"
```

It creates the private bucket `item-photos` if needed (it stops, uploading nothing, if the bucket is public) and uploads every picture (safe to run twice).
It prints `Uploaded N of N photos`.

## 5. Check it is all there

Run this in the Supabase SQL editor (or `psql "<url>" -c "..."`), once on the restored database:

```sql
select 'items' t, count(*) from items union all
select 'vans', count(*) from vans union all
select 'van_lines', count(*) from van_lines union all
select 'purchase_orders', count(*) from purchase_orders union all
select 'po_lines', count(*) from po_lines union all
select 'movements', count(*) from movements union all
select 'users', count(*) from users union all
select 'items with a photo', count(*) from items where photo <> '';
```

Compare the numbers with the same query on the live project (if it still works), or with the
numbers you noted down earlier. They should match, apart from anything done since the backup night.
The photo count in the bucket (Supabase > Storage > item-photos) should be about twice "items with a
photo": each picture also has a small `-t.jpg` thumbnail.

## 6. Switch the app over  **(owner for the logins; the builder for the deploy)**

Only for a real recovery, not for a rehearsal. The app (the Supabase Edge Function behind
`stallion-stock.pages.dev`) reads its database and photo store from secrets with these names:

- `DATABASE_URL` - the restored project's connection string (the app's own deploy notes say which
  Supabase pooler mode the app uses)
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` - the restored project's URL and `service_role` key

Set them on the Edge Function of the restored project (`supabase secrets set NAME=value`, from the
owner's own terminal), deploy the function there, and point the Cloudflare Pages forwarding at the new
project's function address. Then change the three secrets of the backup repo
(`gh secret set ... -R dinujayadissa-blip/stallion-factory-backups`) so the nightly backup follows.

Finally sign in as the owner and check a van, a part with a picture, and the stock figures.

## Rehearsal checklist

Do this once soon after the first nightly backup, and again after any big change to the database:

1. Steps 1 to 5 into a scratch or local database.
2. Note the date of the dump used and that the step-5 numbers matched.
3. Delete the scratch project when done (it counts toward the free-plan limit of 2 projects).
