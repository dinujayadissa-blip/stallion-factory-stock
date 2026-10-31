// Settings, clearing demo stock, and the Excel export of the plan.
import os from 'node:os';
import { all, countQueries, getSetting, run, setSetting } from '../db.js';
import * as inv from '../inventory.js';
import { h, importHistory, now } from './common.js';

const exportWorkbook = async () => (await import('../exportXlsx.js')).exportWorkbook();
function lanAddresses() {
  try {
    return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  } catch { return []; }
}

// (the second argument: what createApp knows about this server and each request — see `ctx` in src/app.js)
export function settingsRoutes(app, { cloud }) {
  // ── Settings / export ──
  // floorUrls: the worker screen's address to open on the phones — this PC's network addresses locally;
  // online the one public address (PUBLIC_URL, e.g. https://factory-stock.pages.dev) when it is set.
  const floorUrls = req => (cloud
    ? (process.env.PUBLIC_URL ? [`${String(process.env.PUBLIC_URL).replace(/\/+$/, '')}/floor`] : [])
    : lanAddresses().map(ip => `http://${ip}:${req.socket.localPort}/floor`));
  app.get('/api/settings', h(async req => ({ ignore: await inv.ignoreList(), dealer: await getSetting('dealer', ''), demo: (await getSetting('demo')) === '1',
    planImportedAt: await getSetting('plan_imported_at', ''), importHistory: (await importHistory()).slice(0, 10),
    lastBackup: await getSetting('last_backup', ''), floorUrls: floorUrls(req) })));
  app.put('/api/settings', h(async req => {
    if (Array.isArray(req.body.ignore)) await setSetting('ignore', JSON.stringify(req.body.ignore.map(s => String(s).trim()).filter(Boolean)));
    if (req.body.dealer != null) await setSetting('dealer', String(req.body.dealer));
  }));
  // Shelf stock counts go to zero (logged, like a stocktake). Per-van parts already received for a
  // van stay with that van.
  app.post('/api/settings/clear-stock', h(async () => {
    await run(`DELETE FROM movements WHERE type = 'adjust' AND note = 'Demo stock level'`);
    for (const { id: itemId } of await all(`SELECT id FROM items WHERE kind = 'stock' AND on_hand <> 0 ORDER BY id`)) {
      await inv.adjust(itemId, { mode: 'set', qty: 0, note: 'Set to zero before stocktake', type: 'adjust' }); // not a count
    }
    await setSetting('demo', '0');
  }));
  app.get('/api/export/plan.xlsx', async (req, res) => {
    try {
      const buf = await countQueries(req.dbStats, exportWorkbook); // (counted for Server-Timing, as in h())
      // Melbourne's date, whatever the server's own time zone (UTC in the cloud: yesterday until ~10am here).
      const stamp = inv.today();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Production Plan ${stamp}.xlsx"`);
      // The whole plan (customers' names): this browser only, and not even kept there. The address ends in .xlsx,
      // which a cache in front of the cloud function could otherwise keep by its address alone.
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(buf);
    } catch (e) {
      console.error(now(), req.method, req.originalUrl, e);
      res.status(e.status === 503 ? 503 : 500).send(e.status === 503 ? e.message : 'Export failed');
    }
  });
}
