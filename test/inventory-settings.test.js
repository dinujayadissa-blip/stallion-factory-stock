// Settings read by inventory.js (the ignore list, the plan columns): bad JSON falls back to the default, but a
// database error is never mistaken for it. Runs on a new, empty in-memory database (PGlite).   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { run, insert, writeTx, setSetting, closeDb } from '../src/db.js';
import * as inv from '../src/inventory.js';

before(freshDb);
after(closeDb);

test('bad JSON in the ignore list / plan columns falls back to the default', async () => {
  await setSetting('ignore', 'not json');
  await setSetting('plan_columns', '{oops');
  assert.deepEqual(await inv.ignoreList(), []);
  assert.deepEqual((await inv.planGrid()).columns, []);
  await setSetting('ignore', '["COLOUR"]');
  await setSetting('plan_columns', '["Battery"]');
  assert.deepEqual(await inv.ignoreList(), ['COLOUR']);
  assert.deepEqual((await inv.planGrid()).columns, ['Battery']);
});

test('a database error reading the settings is passed on, not taken for "no setting"', async () => {
  const van = await insert(`INSERT INTO vans(chassis) VALUES('ST9301')`);
  await run('DROP TABLE settings'); // (the last test in this file: the database is thrown away after it)
  const missing = /relation "settings" does not exist/;
  await assert.rejects(inv.ignoreList(), missing);
  await assert.rejects(inv.planGrid(), missing);
  // inside a write transaction: the real error comes back, not "current transaction is aborted"
  await assert.rejects(writeTx(() => inv.applyRules(van)), missing);
});
