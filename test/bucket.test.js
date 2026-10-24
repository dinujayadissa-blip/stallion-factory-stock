// scripts/lib/bucket.mjs: the photo bucket item-photos is made private if it is missing, and a public one
// stops everything (scripts/copy-to-cloud.js, scripts/restore-photos.mjs, scripts/deploy-api.ps1). A fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePrivateBucket, BUCKET } from '../scripts/lib/bucket.mjs';

const BASE = 'https://example.test/', KEY = 'test-key';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A fake Storage API: `exists` / `isPublic` say what the bucket is like; every call is kept.
function storage({ exists = false, isPublic = false, createFails = false, readFails = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body });
    if ((init.method || 'GET') === 'POST') {
      if (createFails) return json(500, { error: 'Internal', message: 'storage is down' });
      if (exists) return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      exists = true;
      return json(200, { name: BUCKET });
    }
    if (readFails || !exists) return json(404, { error: 'not found' });
    return json(200, { id: BUCKET, name: BUCKET, public: isPublic });
  };
  return { fetch, calls };
}

test('a missing bucket is made, private', async () => {
  const s = storage();
  const r = await ensurePrivateBucket({ base: BASE, key: KEY, fetch: s.fetch });
  assert.deepEqual(r, { created: true });
  assert.equal(BUCKET, 'item-photos');
  assert.equal(s.calls[0].url, 'https://example.test/storage/v1/bucket');
  assert.equal(s.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(s.calls[0].body), { id: 'item-photos', name: 'item-photos', public: false });
  assert.equal(s.calls[0].headers.get('authorization'), 'Bearer test-key');
  assert.equal(s.calls[0].headers.get('apikey'), 'test-key');
  assert.equal(s.calls[1].url, 'https://example.test/storage/v1/bucket/item-photos');
  assert.equal(s.calls[1].method, 'GET');
});

test('a private bucket that is already there is fine', async () => {
  const s = storage({ exists: true });
  assert.deepEqual(await ensurePrivateBucket({ base: BASE, key: KEY, fetch: s.fetch }), { created: false });
  assert.equal(s.calls.length, 2);
});

test('a PUBLIC bucket stops it, with a clear message', async () => {
  const s = storage({ exists: true, isPublic: true });
  await assert.rejects(ensurePrivateBucket({ base: BASE, key: KEY, fetch: s.fetch }), e => /item-photos is PUBLIC/.test(e.message) && /private/i.test(e.message));
});

test('Storage refusing or not answering stops it too', async () => {
  await assert.rejects(ensurePrivateBucket({ base: BASE, key: KEY, fetch: storage({ createFails: true }).fetch }), /Creating the photo bucket item-photos failed: HTTP 500/);
  await assert.rejects(ensurePrivateBucket({ base: BASE, key: KEY, fetch: storage({ exists: true, readFails: true }).fetch }), /Checking the photo bucket item-photos failed: HTTP 404/);
  await assert.rejects(ensurePrivateBucket({ base: '', key: KEY, fetch: storage().fetch }), /SUPABASE_URL/);
  await assert.rejects(ensurePrivateBucket({ base: BASE, key: '', fetch: storage().fetch }), /SUPABASE_SERVICE_ROLE_KEY/);
});
