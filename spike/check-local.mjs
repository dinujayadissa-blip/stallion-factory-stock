// Local sanity checks in Node (Deno is not needed): run from the repo root with  node spike/check-local.mjs
//  1. the embedded hash verifies with the app's own src/auth.js verifyPassword  (needs DATA_DIR set to a temp dir)
//  2. node:crypto scrypt and @noble/hashes/scrypt both verify it, and reject a wrong password
//  3. the exceljs 70 x 120 build works and how long it takes in Node
//  4. src/parseOrder.js reads spike/sample-order.pdf
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-data-'));

// Pull the constant out of the Edge Function source so we test exactly what gets deployed.
const src = fs.readFileSync(path.join(here, 'edge', 'index.ts'), 'utf8');
const hash = /SPIKE_HASH =\s*'([^']+)'/.exec(src)[1];
const t = async (name, fn) => { const a = performance.now(); const r = await fn(); console.log(`${name}: ${(performance.now() - a).toFixed(1)} ms`, r ?? ''); };

const auth = await import(pathToFileURL(path.join(repo, 'src', 'auth.js')).href);
await t('src/auth.js verifyPassword (right)', async () => await auth.verifyPassword('spike-pass-1', hash));
await t('src/auth.js verifyPassword (wrong)', async () => await auth.verifyPassword('not-the-password', hash));

const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$(.+)\$(.+)$/.exec(hash);
const [N, r, p] = [+m[1], +m[2], +m[3]], salt = Buffer.from(m[4], 'base64'), want = Buffer.from(m[5], 'base64');
await t('node:crypto scryptSync', () => crypto.timingSafeEqual(crypto.scryptSync('spike-pass-1', salt, 64, { N, r, p, maxmem: 256 << 20 }), want));
const { scrypt } = await import('@noble/hashes/scrypt');
await t('noble scrypt (right)', () => Buffer.from(scrypt(new TextEncoder().encode('spike-pass-1'), salt, { N, r, p, dkLen: 64, maxmem: 256 << 20 })).equals(want));
await t('noble scrypt (wrong)', () => Buffer.from(scrypt(new TextEncoder().encode('not-the-password'), salt, { N, r, p, dkLen: 64, maxmem: 256 << 20 })).equals(want));

const ExcelJS = (await import('exceljs')).default;
await t('exceljs 70x120 build+write', async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Plan');
  for (let rr = 1; rr <= 70; rr++) { const row = ws.getRow(rr); for (let c = 1; c <= 120; c++) { const cell = row.getCell(c); cell.value = `R${rr}C${c}`; if (rr === 1) cell.font = { bold: true }; if (rr === 1 || (rr + c) % 17 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }; } }
  return `${(await wb.xlsx.writeBuffer()).byteLength} bytes`;
});

const { parseOrderPdf } = await import(pathToFileURL(path.join(repo, 'src', 'parseOrder.js')).href);
await t('parseOrder on sample-order.pdf', async () => { const x = await parseOrderPdf(fs.readFileSync(path.join(here, 'sample-order.pdf'))); return `${x.fields.length} fields, chassis ${x.header.chassis}`; });
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* the SQLite file is still open; the OS temp cleaner removes it */ }
process.exit(0);
