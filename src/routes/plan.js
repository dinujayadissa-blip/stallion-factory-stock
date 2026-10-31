// The production plan, re-prioritising, and the clean-up report.
import * as inv from '../inventory.js';
import { markReportChecked, tidyReport } from '../tidyReport.js';
import { NOT_ONLINE, OWN_TX, PLAN_IMPORT_GONE, gone, h, importHistory, worker } from './common.js';

// (the second argument: what createApp knows about this server and each request — see `ctx` in src/app.js)
export function planRoutes(app, { cloud }) {
  // ── Production plan ──
  app.get('/api/plan', h(req => inv.planGrid({ includeFinished: req.query.all === '1', parts: true })));
  // Importing the plan spreadsheet — preview, update, and "start again from the spreadsheet" (which made a
  // backup first) — is not part of this version: it is done on the original version before the move.
  app.post('/api/import/plan/*', h(gone(cloud ? NOT_ONLINE : PLAN_IMPORT_GONE), OWN_TX));
  app.get('/api/import/history', h(() => importHistory()));
  // "Plan changes to check" came from a plan import: none here (the go-live checklist shows 0 too).
  app.get('/api/plan-conflicts', h(() => []));
  app.post('/api/plan-conflicts/:id', h(gone(cloud ? NOT_ONLINE : PLAN_IMPORT_GONE), OWN_TX));
  // Re-prioritise in two steps: see what each van gains and loses, then confirm.
  app.get('/api/allocate/reprioritise/preview', h(() => inv.reprioritisePreview()));
  app.post('/api/allocate/reprioritise', h(req => inv.reprioritiseAll({ by: worker(req) || 'Office' })));

  // ── Clean-up report (what the clean-up on the original version changed) ──
  app.get('/api/tidy/report', h(() => tidyReport()));
  app.post('/api/tidy/checked', h(req => markReportChecked(worker(req) || 'Office')));
}
