// Item photos: the disk backend (no SUPABASE_URL) and, with a fake fetch, the Supabase Storage backend.
// DATA_DIR must point at a throwaway folder before src/db.js (and so photos.js) is loaded.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-photos-'));
process.env.DATA_DIR = tmp;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const { savePhoto, deletePhoto, readPhoto } = await import('../src/photos.js');
const realFetch = globalThis.fetch;

after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

// A tiny but JPEG-looking file (FF D8 FF … padded past the 100-byte minimum).
const jpeg = (fill) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, fill)]);
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;
const FULL = jpeg(1), THUMB = jpeg(2);
const thumbName = (n) => n.replace(/\.jpg$/, '-t.jpg');

test('save, read and delete a photo', async () => {
  const name = await savePhoto(7, dataUrl(FULL), dataUrl(THUMB));
  assert.match(name, /^7-\d+\.jpg$/);
  const full = await readPhoto(name);
  assert.equal(full.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(full.body), FULL);
  const thumb = await readPhoto(thumbName(name));
  assert.deepEqual(Buffer.from(thumb.body), THUMB);
  await deletePhoto(name);
  assert.equal(await readPhoto(name), null);
  assert.equal(await readPhoto(thumbName(name)), null);
  await deletePhoto(name); // deleting twice is fine
  await deletePhoto('');   // nothing to delete is fine
});

test('a new save gets a new name', async () => {
  const a = await savePhoto(8, dataUrl(FULL), dataUrl(THUMB));
  await new Promise(r => setTimeout(r, 3));
  const b = await savePhoto(8, dataUrl(FULL), dataUrl(THUMB));
  assert.notEqual(a, b);
  await deletePhoto(a); await deletePhoto(b);
});

test('non-JPEG refused', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200)]);
  await assert.rejects(savePhoto(1, `data:image/png;base64,${png.toString('base64')}`, dataUrl(THUMB)), { status: 400 });
  await assert.rejects(savePhoto(1, dataUrl(png), dataUrl(THUMB)), { status: 400 });       // labelled JPEG, bytes aren't
  await assert.rejects(savePhoto(1, dataUrl(FULL), dataUrl(png)), { status: 400 });        // bad thumbnail
  await assert.rejects(savePhoto(1, 'not a data url', dataUrl(THUMB)), { status: 400 });
  await assert.rejects(savePhoto(1, dataUrl(Buffer.from([0xff, 0xd8, 0xff])), dataUrl(THUMB)), { status: 400 }); // tiny
  await assert.rejects(savePhoto(1, dataUrl(jpeg(3).subarray(0, 100)), undefined), { status: 400 });
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'photos')), []);                          // nothing was written
});

test('name with ../ refused', async () => {
  fs.writeFileSync(path.join(tmp, 'secret.jpg'), 'secret');
  for (const bad of ['../secret.jpg', '..\secret.jpg', 'a/b.jpg', '..', '1-2.jpg/../../x', '1-2.png', 'x.jpg', '%2e%2e/secret.jpg', '1-2.jpg\0']) {
    await assert.rejects(readPhoto(bad), { status: 400 }, `read ${JSON.stringify(bad)}`);
    await assert.rejects(deletePhoto(bad), { status: 400 }, `delete ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.readFileSync(path.join(tmp, 'secret.jpg'), 'utf8'), 'secret');
});

test('Storage backend: upload, download, delete go to the item-photos bucket', async () => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co/';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  const objects = new Map();
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body });
    const u = String(url);
    if (init.method === 'POST') { objects.set(u.split('/item-photos/')[1], init.body); return new Response('{"Key":"ok"}', { status: 200 }); }
    if (init.method === 'DELETE') { for (const n of JSON.parse(init.body).prefixes) objects.delete(n); return new Response('[]', { status: 200 }); }
    const o = objects.get(u.split('/item-photos/')[1]);
    return o ? new Response(o, { status: 200 }) : new Response('{"statusCode":"404","error":"not_found"}', { status: 400 });
  };
  const name = await savePhoto(5, dataUrl(FULL), dataUrl(THUMB));
  const ups = calls.filter(c => c.method === 'POST');
  assert.equal(ups.length, 2);
  assert.deepEqual(ups.map(c => c.url).sort(), [
    `https://proj.supabase.co/storage/v1/object/item-photos/${name}`,
    `https://proj.supabase.co/storage/v1/object/item-photos/${thumbName(name)}`].sort());
  for (const c of ups) {
    assert.equal(c.headers.Authorization, 'Bearer service-key');
    assert.equal(c.headers.apikey, 'service-key');
    assert.equal(c.headers['Content-Type'], 'image/jpeg');
    assert.equal(c.headers['x-upsert'], 'true');
  }
  const got = await readPhoto(thumbName(name));
  assert.deepEqual(Buffer.from(got.body), THUMB);
  assert.equal(got.type, 'image/jpeg');
  const dl = calls.at(-1);
  assert.equal(dl.method, 'GET');
  assert.equal(dl.headers.Authorization, 'Bearer service-key');
  assert.equal(await readPhoto('5-1.jpg'), null);          // not there -> null
  await deletePhoto(name);
  const del = calls.at(-1);
  assert.equal(del.method, 'DELETE');
  assert.equal(del.url, 'https://proj.supabase.co/storage/v1/object/item-photos');
  assert.equal(del.headers.Authorization, 'Bearer service-key');
  assert.deepEqual(JSON.parse(del.body), { prefixes: [name, thumbName(name)] });
  assert.equal(await readPhoto(name), null);
  // Nothing was written to disk.
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'photos')).filter(f => f.startsWith('5-')), []);
});

test('Storage backend: other failures throw, bad names never reach the network', async () => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let n = 0;
  globalThis.fetch = async () => { n++; return new Response('boom', { status: 500 }); };
  await assert.rejects(readPhoto('5-1.jpg'), /500/);
  await assert.rejects(savePhoto(5, dataUrl(FULL), dataUrl(THUMB)), /500/);
  await assert.rejects(deletePhoto('5-1.jpg'), /500/);
  n = 0;
  await assert.rejects(readPhoto('../x.jpg'), { status: 400 });
  await assert.rejects(deletePhoto('a/b.jpg'), { status: 400 });
  assert.equal(n, 0);
});
