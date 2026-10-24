// The two ways of reaching Postgres, behind one small shape so src/db.js doesn't care which:
//   { url }       — a real server (Supabase) through the `postgres` client
//   { pgliteDir } — PGlite, Postgres compiled to WebAssembly, running inside this process: a folder on
//                   disk for local runs, or 'memory://' for tests (nothing written, gone when closed)
// Both give back { query(sql, params) → { rows, count }, begin(fn), close() }. `begin(fn)` runs fn with a
// connection object of the same { query } shape that stays inside one transaction (COMMIT when fn
// resolves, ROLLBACK when it throws). Each client is loaded only when it's used, so the cloud never
// loads PGlite's WebAssembly and tests never need a server.

// COUNT(*), SUM(integer) (int8, OID 20) and numeric (OID 1700) arrive as strings by default, to keep
// precision past 2^53. Stock figures and counts are nowhere near that, and the code does sums and
// comparisons on them, so read them as plain JS numbers.
const INT8 = 20, NUMERIC = 1700;
const toNumber = x => (x === null ? null : Number(x));

export async function makeDriver({ url, pgliteDir } = {}) {
  if (url) return postgresDriver(url);
  if (pgliteDir) return pgliteDriver(pgliteDir);
  throw new Error('makeDriver needs a url or a pgliteDir');
}

async function postgresDriver(url) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, {
    // Supabase's pooler (transaction mode) can't keep prepared statements between calls.
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {}, // "already exists, skipping" and the like
    // (a new name: the client's own `number` type is what reads integer / double precision)
    types: { wide_number: { to: INT8, from: [INT8, NUMERIC], serialize: String, parse: toNumber } },
  });
  // No params → the simple protocol, which also runs several statements at once (a migration file).
  const on = s => async (text, params = []) => {
    const res = await s.unsafe(text, params);
    return { rows: Array.from(res), count: res.count ?? 0 };
  };
  return {
    query: on(sql),
    begin: fn => sql.begin(t => fn({ query: on(t) })),
    close: () => sql.end({ timeout: 5 }),
  };
}

// (the name is in a variable so the Edge Function's bundler doesn't pack PGlite — never used in the cloud)
const PGLITE = '@electric-sql/pglite';
async function pgliteDriver(dir) {
  const { PGlite } = await import(PGLITE);
  const pg = await PGlite.create({ dataDir: dir, parsers: { [INT8]: toNumber, [NUMERIC]: toNumber } });
  // PGlite's query() takes one statement; exec() takes several but no params. Use exec only when
  // there are no params, the same split the postgres client makes.
  const on = c => async (text, params = []) => {
    if (params.length) {
      const r = await c.query(text, params);
      return { rows: r.rows, count: r.affectedRows ?? 0 };
    }
    const rs = await c.exec(text);
    const last = rs[rs.length - 1] || { rows: [] };
    return { rows: last.rows, count: last.affectedRows ?? 0 };
  };
  return {
    query: on(pg),
    begin: fn => pg.transaction(t => fn({ query: on(t) })),
    close: () => pg.close(),
  };
}
