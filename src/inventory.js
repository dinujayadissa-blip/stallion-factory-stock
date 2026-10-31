// Stock, allocation and purchasing logic. All quantities live in Postgres (src/db.js); every function that
// changes stock runs inside writeTx (one writer at a time, all or nothing) so the numbers can't drift apart.
// Every function that reads or writes the database is async (returns a Promise); the pure helpers
// (lineStatus, qtyCheckFor, coverText, orderNowCount, orderNowText, orderGroupOf, httpError …) are not.
//
// Split into src/inventory/*.js (one file per area); this file re-exports exactly what it always did, so
// `import * as inv from './inventory.js'` and every named import keep working.

// Melbourne's date 'YYYY-MM-DD', whatever time zone the server runs in (lineState.js).
export { today } from './lineState.js';

export { PRIORITY, vanRanks, buildOrderInfo, ignoreList, activeRules, nearVanSql, listItems, getItem, firstCountDone, lineStatus, LINE_STATUS_TEXT, purchasingSettings, savePurchasingSettings, httpError, MAX_QTY, goodQty, checkQty } from './inventory/shared.js';
export { allocateItem, reprioritisePreview, reprioritiseAll } from './inventory/allocation.js';
export { previewOrder, createVan, applyRules, stillMissingByVan, NO_MISSING, missingSplitByVan, listVans, activeVanFields, getVan, itemMedians, qtyCheckFor, updateVan, useUpVan, deleteVan, addLine, updateLine, deleteLine, issue, returnLine } from './inventory/vans.js';
export { receive, receiveDelivery, adjust, stocktake, itemDetail } from './inventory/stock.js';
export { vanNeededBy, listSuppliers, setSupplierLead, shortages, coverText, shortagesCached, lineCover, orderNowCount, orderNowText } from './inventory/shortages.js';
export { orderGroupOf, checkOrdered, checkOrderedCount, answerOrdered, answerOrderedMany } from './inventory/ordered.js';
export { setLineState, decisionLines, placeholderLines, placeholderCounts, stillToOrderByItem, LINK_FLAG_RE, supplierFromText, supplierMatcher, manySpecs } from './inventory/special.js';
export { listPOs, getPO, poProblems, PO_TO_CHECK_SQL, posToCheck, updatePO, mergePO, setPOStatus, overdueLines, createPO, receivePO, datesToCheck, qtyChecks } from './inventory/pos.js';
export { summary } from './inventory/summary.js';
export { planGrid, setLineStatus } from './inventory/plan.js';
export { takeForVan, floorExtra, undoTake, undoReceive, floorWaiting, setItemPlace, floorVans, floorVan, floorStats } from './inventory/floor.js';
export { markFitted, fittedQuickStart } from './inventory/fitted.js';
export { countChoices, openCount, checkCount, saveCount, boughtForVanList, checkBoughtLine } from './inventory/counts.js';
export { unassignedPerVan, assignToVan, keepSpare } from './inventory/spare.js';
export { reorderSuggestions } from './inventory/reorder.js';
export { supplierSuggestions, catalogueGaps, putOnRack } from './inventory/catalogue.js';
export { lineHistory, itemHistory } from './inventory/history.js';
export { stockChecks, stockChecksCount, ackCheck } from './inventory/checks.js';
