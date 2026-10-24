// Puts a folder of item photos (the `photos/` folder of the private backup repo) back into the
// private Supabase Storage bucket `item-photos`. Used when restoring a backup (docs/RESTORE.md).
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/restore-photos.mjs <photos folder>
// Creates the bucket (private) if it isn't there yet. Safe to run twice: existing files are overwritten.
import fs from 'node:fs';
import path from 'node:path';

const BUCKET = 'item-photos';
const dir = process.argv[2];
const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!dir || !base || !key) {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/restore-photos.mjs <photos folder>');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${key}`, apikey: key };

async function main() {
  // Every .jpg under the folder, sub-folders included; names inside the bucket keep their sub-path.
  const files = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (/\.jpe?g$/i.test(e.name)) files.push(r);
    }
  };
  walk('');

  const made = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (made.ok) console.log(`Created the private bucket ${BUCKET}`);
  else if (!/exist/i.test(await made.text())) throw new Error(`Creating bucket ${BUCKET} failed: HTTP ${made.status}`);

  let done = 0;
  const queue = [...files];
  const worker = async () => {
    for (let name; (name = queue.shift()) !== undefined;) {
      const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${name.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
        body: fs.readFileSync(path.join(dir, name)),
      });
      if (!res.ok) throw new Error(`Uploading ${name} failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      done++;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`Uploaded ${done} of ${files.length} photos to ${BUCKET}`);
  if (done !== files.length) process.exit(1);
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
