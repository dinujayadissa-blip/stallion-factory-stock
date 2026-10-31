// The home page summary, remembered until the data or the day changes.
import { dataVersion, getSetting, inTx } from '../db.js';
import { goLive } from '../golive.js';
import * as inv from '../inventory.js';
import { h } from './common.js';

export function dashboardRoutes(app) {
  // ── Dashboard ──
  // The whole answer is remembered until the data changes or the day does: the same key and rules as
  // shortagesCached() in inventory.js (data_version, bumped by every change on any server instance, and Melbourne's
  // date; never inside a transaction; a failed working-out isn't kept). Working it out is about 90 queries, and the
  // office app asks for it after every page (the menu badge). data_version is read from the database on every
  // request, so a server instance never answers with figures that another instance has changed since.
  let summaryMemo = null;
  // ("Check: already ordered?" is worked out once, for both the summary and the go-live checklist)
  const dashboard = async () => {
    const checks = await inv.checkOrdered();
    return { ...await inv.summary({ checks }), golive: await goLive({ checks }), demo: (await getSetting('demo')) === '1' };
  };
  app.get('/api/summary', h(async () => {
    if (inTx()) return dashboard();
    const key = `${await dataVersion()}|${inv.today()}`;
    if (summaryMemo?.key !== key) {
      const memo = { key, value: dashboard() };
      summaryMemo = memo;
      memo.value.catch(() => { if (summaryMemo === memo) summaryMemo = null; }); // (the request itself still gets the error)
    }
    return summaryMemo.value;
  }));
}
