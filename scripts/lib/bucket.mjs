// The private Supabase Storage bucket `item-photos`, where the online app keeps the item pictures.
// ensurePrivateBucket() makes it (private) when it is missing, then reads it back and REFUSES to go on when it
// is public: a public bucket would hand every picture to anyone who guesses a name. Used by
// scripts/copy-to-cloud.js and scripts/restore-photos.mjs before they upload, and by scripts/deploy-api.ps1
// after a deploy (through scripts/ensure-bucket.mjs). Only the bucket's name and HTTP statuses are printed.
export const BUCKET = 'item-photos';

export async function ensurePrivateBucket({ base, key, fetch = globalThis.fetch } = {}) {
  const root = String(base || '').replace(/\/+$/, '');
  if (!root) throw new Error('SUPABASE_URL is not set (https://<project ref>.supabase.co)');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const headers = { Authorization: `Bearer ${key}`, apikey: key };

  // Make it. Already there is fine (Storage answers 400/409 "Duplicate" / "already exists").
  const made = await fetch(`${root}/storage/v1/bucket`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  const madeText = made.ok ? '' : await made.text().catch(() => '');
  if (!made.ok && !/exist|duplicate/i.test(madeText)) {
    throw new Error(`Creating the photo bucket ${BUCKET} failed: HTTP ${made.status} ${madeText.slice(0, 200)}`);
  }

  // Check it: never public.
  const got = await fetch(`${root}/storage/v1/bucket/${BUCKET}`, { method: 'GET', headers });
  if (!got.ok) throw new Error(`Checking the photo bucket ${BUCKET} failed: HTTP ${got.status}`);
  const info = await got.json().catch(() => null);
  if (!info || typeof info !== 'object') throw new Error(`Checking the photo bucket ${BUCKET} failed: no answer`);
  if (info.public === true) {
    throw new Error(`The photo bucket ${BUCKET} is PUBLIC: anyone could see the pictures. Make it private first `
      + `(Supabase dashboard > Storage > ${BUCKET} > Edit bucket: turn "Public bucket" off), then run this again. Nothing was uploaded.`);
  }
  return { created: made.ok };
}
