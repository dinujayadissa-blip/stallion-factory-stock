// Fills an empty database with the starter catalogue and rules.
//   node src/seed.js           seed if empty
//   node src/seed.js --reset   wipe everything and seed again
//   node src/seed.js --demo    as --reset, plus made-up stock levels so you can try the app
import { db, all, get, run, tx, setSetting } from './db.js';
import { ITEMS, RULES, IGNORE } from './seed-data.js';

export function seed({ reset = false, demo = false } = {}) {
  tx(() => {
    if (reset || demo) {
      for (const t of ['movements', 'po_lines', 'purchase_orders', 'van_lines', 'order_fields', 'vans', 'rules', 'items', 'settings']) {
        run(`DELETE FROM ${t}`);
      }
    }
    if (get('SELECT COUNT(*) AS c FROM items').c > 0) return;

    const insItem = db.prepare(`INSERT INTO items(sku, name, category, supplier, unit, kind, reorder_level) VALUES(?,?,?,?,?,?,?)`);
    for (const it of ITEMS) insItem.run(...it);

    const ids = new Map(all('SELECT id, sku FROM items').map(r => [r.sku, r.id]));
    const insRule = db.prepare(`INSERT INTO rules(name, conditions, item_id, qty, spec_fields, sort) VALUES(?,?,?,?,?,?)`);
    RULES.forEach(([name, conditions, sku, qty, spec], i) => {
      if (!ids.has(sku)) throw new Error(`Rule "${name}" points at unknown SKU ${sku}`);
      insRule.run(name, conditions, ids.get(sku), qty, spec, (i + 1) * 10);
    });

    setSetting('ignore', JSON.stringify(IGNORE));
    setSetting('demo', demo ? '1' : '0');

    if (demo) {
      // Deterministic "random" stock so a few things come up short.
      let i = 0;
      for (const it of all(`SELECT * FROM items WHERE kind = 'stock'`)) {
        const qty = (i++ % 5 === 0) ? 0 : Math.max(1, Math.round(it.reorder_level * (1 + (i % 3))));
        if (!qty) continue;
        run('UPDATE items SET on_hand = ? WHERE id = ?', qty, it.id);
        run(`INSERT INTO movements(item_id, qty, type, note) VALUES(?, ?, 'adjust', 'Demo stock level')`, it.id, qty);
      }
    }
  });
}

// Add any starter items / rules that are missing (e.g. after an update). Never changes or
// removes what's already there.
export function syncCatalog() {
  tx(() => {
    const have = new Set(all('SELECT sku FROM items').map(r => r.sku));
    const insItem = db.prepare(`INSERT INTO items(sku, name, category, supplier, unit, kind, reorder_level) VALUES(?,?,?,?,?,?,?)`);
    for (const it of ITEMS) if (!have.has(it[0])) insItem.run(...it);
    // The first release called this item "Furniture, walls, doors & drawers"; walls and doors are separate now.
    run(`UPDATE items SET name = 'Furniture' WHERE sku = 'FURNITURE' AND name = 'Furniture, walls, doors & drawers'`);
    // The first 3kg washing machine rule also caught "Aussie Traveller top loader" (only if nobody has edited it).
    run(`UPDATE rules SET conditions = ? WHERE name = 'Washing machine AT 3kg' AND conditions = 'WASHING MACHINE ~ front loader|aussie traveller'`,
        'WASHING MACHINE ~ front loader|aussie traveller\nWASHING MACHINE !~ top\\W?load');

    const ids = new Map(all('SELECT id, sku FROM items').map(r => [r.sku, r.id]));
    const ruleNames = new Set(all('SELECT name FROM rules').map(r => r.name));
    const maxSort = get('SELECT COALESCE(MAX(sort), 0) AS s FROM rules').s;
    RULES.forEach(([name, conditions, sku, qty, spec], i) => {
      if (ruleNames.has(name) || !ids.has(sku)) return;
      run('INSERT INTO rules(name, conditions, item_id, qty, spec_fields, sort) VALUES(?,?,?,?,?,?)',
          name, conditions, ids.get(sku), qty, spec, maxSort + (i + 1) * 10);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const reset = process.argv.includes('--reset');
  const demo = process.argv.includes('--demo');
  // Wiping a database that has real vans in it needs --yes as well (testing only, never on the office PC).
  const vans = get('SELECT COUNT(*) AS c FROM vans').c;
  if ((reset || demo) && vans > 0 && !process.argv.includes('--yes')) {
    console.log(`Stopped: this database has ${vans} vans. ${demo ? '--demo' : '--reset'} would wipe everything.`);
    console.log(`Testing only - never on the office PC. To really wipe it, add --yes (npm run ${demo ? 'demo' : 'reset'} -- --yes).`);
    process.exit(1);
  }
  seed({ reset, demo });
  const c = get('SELECT (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM rules) AS rules');
  console.log(`Database ready: ${c.items} items, ${c.rules} rules${demo ? ' (demo stock levels loaded)' : ''}`);
}
