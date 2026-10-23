// Shared test set-up: a brand-new, empty database for each test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, run } from '../src/db.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

// Opens an in-memory PGlite (nothing on disk, gone when closed) and applies every
// supabase/migrations/*.sql in name order — the same files the cloud database is built from.
export async function freshDb() {
  await closeDb();
  await openDb({ pgliteDir: 'memory://' });
  for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    await run(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
}
