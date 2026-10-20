// Item photos. The browser shrinks the picture and sends two JPEGs (full ~1200px and a small
// thumbnail) as data URLs; we check they really are JPEGs and store them under data/photos.
import fs from 'node:fs';
import path from 'node:path';
import { get, run, PHOTO_DIR } from './db.js';
import { httpError } from './inventory.js';

const MAX_BYTES = 4 * 1024 * 1024;

function decodeJpeg(dataUrl, what) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpError(400, `The ${what} isn't a JPEG picture`);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw httpError(400, `The ${what} isn't a JPEG picture`);
  if (buf.length > MAX_BYTES) throw httpError(400, 'That picture is too big');
  return buf;
}

function removeFiles(name) {
  if (!name) return;
  for (const f of [name, name.replace(/\.jpg$/, '-t.jpg')]) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, path.basename(f))); } catch { /* already gone */ }
  }
}

export function savePhoto(itemId, { full, thumb }) {
  const item = get('SELECT id, photo FROM items WHERE id = ?', itemId);
  if (!item) throw httpError(404, 'Item not found');
  const fullBuf = decodeJpeg(full, 'photo');
  const thumbBuf = decodeJpeg(thumb, 'thumbnail');
  // A new name each time, so browsers never show an old cached picture.
  const name = `${item.id}-${Date.now()}.jpg`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), fullBuf);
  fs.writeFileSync(path.join(PHOTO_DIR, name.replace(/\.jpg$/, '-t.jpg')), thumbBuf);
  run('UPDATE items SET photo = ? WHERE id = ?', name, item.id);
  removeFiles(item.photo);
  return { photo: name };
}

export function deletePhoto(itemId) {
  const item = get('SELECT id, photo FROM items WHERE id = ?', itemId);
  if (!item) throw httpError(404, 'Item not found');
  run(`UPDATE items SET photo = '' WHERE id = ?`, item.id);
  removeFiles(item.photo);
}
