// Makes sure the photo bucket item-photos exists and is PRIVATE (scripts/lib/bucket.mjs). Run by
// scripts/deploy-api.ps1 after a deploy; can be run by hand too:
//   (PowerShell, with $env:SUPABASE_URL and $env:SUPABASE_SERVICE_ROLE_KEY set as in HANDOVER-CLOUD.md step 2)
//   node scripts/ensure-bucket.mjs
// The key is read from the environment only, never from the command line. Exit code 1 if it is public or
// the check fails.
import { ensurePrivateBucket, BUCKET } from './lib/bucket.mjs';

try {
  const r = await ensurePrivateBucket({ base: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
  console.log(r.created ? `Created the private photo bucket ${BUCKET}` : `The photo bucket ${BUCKET} is there and private`);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
