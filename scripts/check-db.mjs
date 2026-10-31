// Tries the database address in DATABASE_URL once: exit 0 and "ok" when it connects, exit 1 with the reason
// (never the address) when it doesn't. Used by scripts/load-cloud.ps1 to pick the right pooler address.
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
// Not an address at all: say what looks wrong with it (never the address or the password).
try { new URL(url); } catch {
  const why = [];
  if (/^\s|\s$/.test(url) || /^["']|["']$/.test(url)) why.push('it has spaces or quotes at the start or end — paste only the address');
  else if (!/^postgres(ql)?:\/\//.test(url)) why.push('it should start with postgresql://');
  const pass = /^[a-z]+:\/\/[^:/]*:(.*)@[^@]*$/i.exec(url.trim())?.[1] ?? '';
  if (/[#/?%\s"'\\]/.test(pass)) why.push('the password has a character an address can\'t hold as it is (# / ? % \\ a quote or a space) — easiest: reset the database password in Supabase to letters and numbers only');
  console.error(`That is not a database address${why.length ? ': ' + why.join('; ') : ' — copy it again from Supabase (Connect > Session pooler)'}`);
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//.test(url)) { console.error('That is not a database address: it should start with postgresql://'); process.exit(1); }
if (/\[YOUR-PASSWORD\]/i.test(url)) { console.error('The address still says [YOUR-PASSWORD]: put your database password there, without the [ ]'); process.exit(1); }
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
