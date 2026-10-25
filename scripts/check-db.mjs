// Tries the database address in DATABASE_URL once: exit 0 and "ok" when it connects, exit 1 with the reason
// (never the address) when it doesn't. Used by scripts/load-cloud.ps1 to pick the right pooler address.
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
const sql = postgres(url, { prepare: false, connect_timeout: 10, max: 1, onnotice: () => {} });
try {
  await sql`select 1`;
  console.log('ok');
  await sql.end();
  process.exit(0);
} catch (e) {
  console.error(String(e.message || e).replace(url, '<address>'));
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
}
