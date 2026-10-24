// The Clean-up report page (#/cleanup) on Postgres: what the one-off stock clean-up changed, read back from
// the allocation log and the settings it left. The clean-up itself (src/tidy.js) is SQLite-only and ran on
// the original version before the move (the `sqlite-final` checkout); this only shows its results and
// records "Checked". STEPS mirrors the keys and labels of tidy.js's STEPS — keep them the same.
import { all, getSetting, setSetting } from './db.js';

export const STEPS = [
  { key: 'lock', label: 'Parts received for a van are locked to it' },
  { key: 'plan_qty', label: 'Quantities read wrongly from the plan' },
  { key: 'merge_dupes', label: 'Exact duplicate lines merged' },
  { key: 'placeholder', label: '"As per plan" catch-all items marked' },
  { key: 'relink', label: 'Catch-all lines moved onto real parts' },
  { key: 'autolink', label: 'Special parts that plainly name a catalogue part linked to it' },
  { key: 'parts_r3', label: 'Thetford 175L fridge and white round Razor basin added, plan lines that name them linked' },
  { key: 'notes_r3', label: 'Notes name the plan line instead of a line number ("merged from the plan line …")' },
  { key: 'merged_cols', label: 'Merged plan lines keep their colour on the Production plan and in the Excel export' },
  { key: 'state', label: 'Customer supplies / to be decided lines marked' },
  { key: 'state_dots', label: '"...." next to a count or description: back to a normal part' },
  { key: 'po_ref', label: 'Order numbers read wrongly from the plan (dates, sizes, quantities) fixed' },
  { key: 'given', label: 'Parts the plan says were given to someone ("Gave to Alex") booked out to that van' },
  { key: 'kind', label: 'Shelf stock vs bought for one van (fridges, aircons, heaters…)' },
  { key: 'supplier', label: 'Blank suppliers filled from the part\'s purchase orders' },
  { key: 'po_spec', label: 'Colour, size and model copied onto van PO lines' },
  { key: 'po', label: 'Imported purchase orders named, dated and marked to check' },
  { key: 'po_dates', label: 'Purchase orders from the plan: ordered date "unknown (from plan)" instead of the import date' },
  { key: 'merge_notes', label: '"Merge all" that moved nothing: a note on the van\'s line (nothing removed)' },
  { key: 'sku_fix', label: 'Typo in a part code fixed: PLAN-ROOF-BAW → PLAN-ROOF-BOW (the old code still finds it)' },
];
const flagKey = key => `tidy_${key}_v1`;

// Per step, what changed (before -> after) and what was flagged — the same answer as tidy.js's tidyReport().
export async function tidyReport() {
  const rows = await all(`SELECT a.*, v.chassis, i.sku, i.name AS item_name FROM allocation_log a
                    LEFT JOIN vans v ON v.id = a.van_id LEFT JOIN items i ON i.id = a.item_id
                    WHERE a.reason ILIKE 'tidy:%' ORDER BY a.id`);
  const raw = await getSetting('tidy_report_checked', '');
  let checked = null;
  try { checked = JSON.parse(raw || 'null'); } catch { checked = null; }
  const steps = [];
  for (const s of STEPS) {
    const mine = rows.filter(r => r.reason === `tidy:${s.key}`);
    steps.push({ key: s.key, label: s.label, doneAt: await getSetting(flagKey(s.key), ''),
      changes: mine.filter(r => r.field !== 'flag'), flagged: mine.filter(r => r.field === 'flag') });
  }
  return { backup: await getSetting('tidy_backup', ''), checked, steps };
}

export async function markReportChecked(by = '') {
  await setSetting('tidy_report_checked', JSON.stringify({ at: new Date().toISOString(), by }));
}
