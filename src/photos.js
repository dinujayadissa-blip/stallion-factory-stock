// Item photos. The browser shrinks the picture and sends two JPEGs (full ~1200px and a small
// thumbnail) as data URLs; we check they really are JPEGs and store them as `<id>-<time>.jpg` (full) and
// `<id>-<time>-t.jpg` (thumbnail).
//
// Where they are kept: on disk under DATA_DIR/photos when SUPABASE_URL is not set (local runs, tests);
// otherwise in the private Supabase Storage bucket `item-photos`, through its REST API with the service-role
// key (plain fetch, so it works in Node and in Deno). The env vars are read each time, not at load.
//
// This file only keeps the files. Which item has which photo (items.photo) is the caller's job (src/app.js).
import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_DIR } from './db.js';
import { httpError } from './inventory.js';

const MAX_BYTES = 4 * 1024 * 1024;
const BUCKET = 'item-photos';
// The only file names we ever make: <item id>-<milliseconds>.jpg, or the same with -t before .jpg.
// No dots except the extension, no slashes: nothing can climb out of the folder or the bucket.
const NAME_RE = /^[0-9]+-[0-9]+(-t)?\.jpg$/;

function decodeJpeg(dataUrl, what) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpError(400, `The ${what} isn't a JPEG picture`);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw httpError(400, `The ${what} isn't a JPEG picture`);
  if (buf.length > MAX_BYTES) throw httpError(400, 'That picture is too big');
  return buf;
}

// Unsafe = could point outside the folder / bucket. Those are refused with 400 everywhere.
function checkSafe(name) {
  if (typeof name !== 'string' || /[/\\\0]|\.\./.test(name)) throw httpError(400, 'Bad picture name');
  return name;
}
function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw httpError(400, 'Bad picture name');
  return name;
}
const thumbOf = (name) => name.replace(/\.jpg$/, '-t.jpg');
const fullOf = (name) => name.replace(/-t\.jpg$/, '.jpg');

// ── Supabase Storage (REST) ──
function storage() {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return { url: `${base.replace(/\/+$/, '')}/storage/v1/object/${BUCKET}`, key };
}
const authHeaders = (key) => ({ Authorization: `Bearer ${key}`, apikey: key });
const objectUrl = (s, name) => `${s.url}/${encodeURIComponent(name)}`;

async function storageFail(what, res) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 200); } catch { /* no body */ }
  return new Error(`Storage ${what} failed (${res.status})${detail ? `: ${detail}` : ''}`);
}

async function storagePut(s, name, buf) {
  const res = await fetch(objectUrl(s, name), {
    method: 'POST',
    headers: { ...authHeaders(s.key), 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw await storageFail('upload', res);
}

// ── Public ──
// Saves both pictures; returns the full picture's file name (the thumbnail is the same name with -t).
export async function savePhoto(itemId, fullDataUrl, thumbDataUrl) {
  const fullBuf = decodeJpeg(fullDataUrl, 'photo');
  const thumbBuf = decodeJpeg(thumbDataUrl, 'thumbnail');
  const id = Number(itemId);
  if (!Number.isInteger(id) || id < 0) throw httpError(400, 'Bad item');
  // A new name each time, so browsers never show an old cached picture.
  const name = `${id}-${Date.now()}.jpg`;
  const s = storage();
  if (s) {
    await storagePut(s, name, fullBuf);
    try {
      await storagePut(s, thumbOf(name), thumbBuf);
    } catch (e) {
      // Don't leave a lone full picture behind (best effort; the upload error is what the caller sees).
      try { await fetch(s.url, { method: 'DELETE', headers: { ...authHeaders(s.key), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [name] }) }); } catch { /* ignore */ }
      throw e;
    }
  } else {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(path.join(PHOTO_DIR, name), fullBuf);
    fs.writeFileSync(path.join(PHOTO_DIR, thumbOf(name)), thumbBuf);
  }
  return name;
}

// Removes the picture and its thumbnail. No name (an item without a photo) or already gone is fine.
export async function deletePhoto(name) {
  if (!name) return;
  const full = fullOf(checkName(name));
  const names = [full, thumbOf(full)];
  const s = storage();
  if (s) {
    const res = await fetch(s.url, {
      method: 'DELETE',
      headers: { ...authHeaders(s.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: names }),
    });
    if (!res.ok) throw await storageFail('delete', res);
  } else {
    for (const f of names) {
      try { fs.unlinkSync(path.join(PHOTO_DIR, f)); } catch { /* already gone */ }
    }
  }
}

// The picture (full, or the `-t` thumbnail name) as bytes, or null when there is no such picture.
export async function readPhoto(name) {
  checkSafe(name);
  if (!NAME_RE.test(name)) return null; // safe, but not a name we ever made: no such picture
  const s = storage();
  if (s) {
    const res = await fetch(objectUrl(s, name), { method: 'GET', headers: authHeaders(s.key) });
    if (res.ok) return { body: new Uint8Array(await res.arrayBuffer()), type: 'image/jpeg' };
    // Storage says "not found" as a 404, or as a 400 with statusCode "404" in the JSON.
    let text = '';
    try { text = await res.text(); } catch { /* no body */ }
    if (res.status === 404 || (res.status === 400 && /not[_ ]found|"404"|"statusCode":\s*404/i.test(text))) return null;
    throw new Error(`Storage download failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  try {
    return { body: new Uint8Array(fs.readFileSync(path.join(PHOTO_DIR, name))), type: 'image/jpeg' };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
