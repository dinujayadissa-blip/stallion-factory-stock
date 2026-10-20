'use strict';
// Purchasing: "Order now / Coming up / Later", "Check: already ordered?", POs to check, purchase
// orders and the receive dialog; plus the one plain status per van line and the "waiting on a
// decision" list. Uses the helpers in app.js / stockcheck.js ($, api, modal, esc, q, toast, act, busy,
// officeName…), which are loaded by the time anything here runs.

const fmtShort = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${+m[3]}/${+m[2]}` : ''; };
const tradeLabel = t => (typeof TRADE_NAMES !== 'undefined' && TRADE_NAMES[t]) || 'Other';
// Plan text that only says "Yes" isn't a description.
const specText = s => { const t = String(s || '').trim(); return /^(yes|y|ok)$/i.test(t) ? '' : t; };
const addDaysIso = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

// Like api(), but a refusal that needs an answer (409 with `confirm`) comes back instead of throwing.
async function apiAsk(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, data };
  authCheck(res, data); // not logged in any more → the log in page
  if (data.confirm) return { ok: false, confirm: data.confirm, error: data.error };
  throw new Error(data.error || `Request failed (${res.status})`);
}

// A small question with buttons; resolves with the chosen value (null = closed).
function askChoice(title, html, choices) {
  return new Promise(resolve => {
    const m = modal(title, html, { footer: choices.map((c, i) => `<button class="btn ${c.primary ? 'primary' : ''}" data-ch="${i}">${esc(c.label)}</button>`).join('') });
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    $$('[data-ch]', m.el).forEach(b => { b.onclick = () => finish(choices[Number(b.dataset.ch)].value); });
    // Closing with × / Escape / outside click = no answer.
    new MutationObserver((_, obs) => { if (!document.body.contains(m.el)) { obs.disconnect(); finish(null); } }).observe(document.body, { childList: true });
  });
}

// ───────── one plain status per van line ─────────

function lineStatusHtml(l) {
  switch (l.status) {
    case 'issued': return '<span class="chip issued">Fitted</span>';
    case 'customer': return '<span class="chip cust">Customer supplies</span>';
    case 'tbd': return '<span class="chip tbc">To be decided</span>';
    case 'ready': return '<span class="chip ready">In stock for this van</span>';
    case 'check': return `<span class="chip check" title="The production plan has an order number for this part, but there is no purchase order for it in the system. Answer on the Purchasing page.">Check: plan says 'Order ${esc(l.po_ref)}'</span>${coverHtml(l)}`;
    case 'on_order': {
      const p = (l.po_list || [])[0];
      // check-r4-3: covered by another van's PO that van no longer needs ("PO 50 – ST0367's, spare").
      const words = p ? `Ordered – PO ${esc(p.po_no)}${p.supplier ? `, ${esc(p.supplier)}` : ''}${p.spare_of ? ` (${esc(p.spare_of)}'s${p.inactive ? ', van finished' : ''}, spare)` : p.shelf ? ' (for the shelf)' : ''}` : 'Ordered';
      if (p?.spare_of) return `<span class="chip on_order" style="white-space:normal" title="${esc(`${p.spare_of} no longer needs this part from PO ${p.po_no}, so when it arrives it goes to this van (build order). Purchasing → To order counts it the same way.`)}">${words}</span>`
        + `${(l.po_list || []).length > 1 ? ` <span class="small muted">+${l.po_list.length - 1} more</span>` : ''}${l.expected ? `<div class="small muted">Arrives ${fmtShort(l.expected)}</div>` : ''}`;
      const more = (l.po_list || []).length > 1 ? ` <span class="small muted">+${l.po_list.length - 1} more</span>` : '';
      const when = l.late ? `<div class="late">Late for due date – arrives ${fmtShort(l.expected)}</div>`
        : l.expected ? `<div class="small muted">Arrives ${fmtShort(l.expected)}</div>` : '';
      return `<span class="chip on_order" style="white-space:normal">${words}</span>${more}${when}${l.cover?.spare ? coverHtml(l) : ''}`;
    }
    default: return `<span class="chip to_order">Not ordered</span>${coverHtml(l)}`;
  }
}
// "1 of 2 coming on PO 50 (Caravan & Camping) – ST0367's, spare" under a line's status (check-r4-3).
const coverHtml = l => (l.cover?.text ? `<div class="small cover-note">${esc(l.cover.text)}</div>` : '');

// Customer supplies / to be decided / normal, from the drop-down on a van line. Returns true if saved.
async function setLineStateFlow(l, state) {
  const by = officeName();
  try {
    let r = await apiAsk('POST', `/api/van-lines/${l.id}/state`, { state, by });
    if (!r.ok && r.confirm?.stock) {
      const stock = await askChoice('Parts already here for this van', `<p style="margin-top:0">${esc(r.confirm.message)}</p>
        <p class="muted small">Keep = they stay set aside for this van. Shelf = they become free stock for other vans.</p>`,
        [{ label: 'Keep for the van', value: 'keep', primary: true }, { label: 'Put on the shelf', value: 'shelf' }]);
      if (!stock) return false;
      r = await apiAsk('POST', `/api/van-lines/${l.id}/state`, { state, stock, by });
    }
    if (!r.ok) { toast(r.error || 'Not saved', true); return false; }
    toast(state === 'customer' ? 'Marked: customer supplies' : state === 'tbd' ? 'Marked: to be decided' : 'Back to a normal part');
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

// "Waiting on a decision": customer supplies / to be decided lines, by trade.
function decisionsPanelHtml(list, { showVan = true } = {}) {
  const groups = new Map();
  for (const l of list) { const k = tradeLabel(l.trade); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  return [...groups.entries()].map(([trade, ls]) => `<div style="border-top:1px solid var(--line)">
    <div class="row" style="padding:8px 16px;background:#fafbfc"><strong>${esc(trade)}</strong><span class="muted small">${ls.length}</span></div>
    <div class="table-wrap"><table class="ph-table dec-table"><tbody>${ls.map(l => `<tr>${showVan ? `<td class="nowrap dec-van"><a href="#/vans/${l.van_id}"><strong>${esc(l.chassis)}</strong></a></td>` : ''}
      <td><strong>${esc(l.name)}</strong>${l.plan_column ? ` <span class="forcol">for: ${esc(l.plan_column)}</span>` : ''}${specText(l.spec) ? `<div class="spec">${esc(l.spec)}</div>` : ''}
        ${l.reserved_firm > 0 ? `<div class="warn-text">${q(l.reserved_firm)} received for this van – check</div>` : ''}</td>
      <td class="nowrap small ph-st">${l.state === 'customer' ? '<span class="chip cust">Customer supplies</span>' : '<span class="chip tbc">To be decided</span>'}</td></tr>`).join('')}</tbody></table></div></div>`).join('');
}

// Open PO lines that should have arrived already.
function overduePanelHtml(list) {
  return `<div class="table-wrap"><table><thead><tr><th>PO</th><th>Part</th><th>For</th><th>Expected</th><th class="num">Still to come</th></tr></thead><tbody>
    ${list.map(o => `<tr><td class="nowrap"><a href="#/pos/${o.po_id}"><strong>${esc(o.po_no)}</strong></a><div class="small muted">${esc(o.supplier || 'no supplier')}</div></td>
      <td>${esc(o.name)}${specText(o.spec) ? `<div class="spec">${esc(o.spec)}</div>` : ''}</td>
      <td class="nowrap">${o.chassis ? `<a href="#/vans/${o.van_id}">${esc(o.chassis)}</a>` : '<span class="faint">shelf</span>'}</td>
      <td class="nowrap late">${fmtDate(o.expected)}</td><td class="num">${q(o.open)} ${esc(o.unit)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ───────── Purchasing page ─────────

const GROUPS = [
  ['now', 'Order now', 'Vans in production, parts borrowed on the floor, and anything whose order-by date is within a week — in build order (#1 first).'],
  ['soon', 'Coming up', 'Order-by date within the next weeks shown in the filter.'],
  ['later', 'Later', 'Not needed yet — nothing here is ticked.'],
  ['nodate', 'No date – check', 'The van has no due date, or a planned van\'s date has passed. Fix the date on the van to place these.'],
];

// Ordered date: shown only when it is real. A PO from the production plan with no date typed yet says
// "unknown (from plan)" — the plan never says when it was ordered (Small fixes & phone round 1, user-r4-5).
const orderedHtml = p => (p.ordered_at ? fmtDate(p.ordered_at) : `<span class="faint">${p.from_plan ? 'unknown (from plan)' : 'unknown'}</span>`);

function purFilter() {
  try { return JSON.parse(sessionStorage.getItem('purFilter') || '{}'); } catch { return {}; }
}
const ssGet = (k, d = '') => { try { return sessionStorage.getItem(k) ?? d; } catch { return d; } };
const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private window */ } };

// Purchasing is split into tabs (round 3, user-r2-1) so nothing is 80,000px down the page:
//   To order — Order now / Coming up / Later / No date, each supplier folded to one line
//   Check: already ordered? — plan order numbers nobody has confirmed
//   Special parts — "as per plan" lines still to link
//   Purchase orders — search, Receive delivery, overdue deliveries, POs to check
const PUR_TABS = ['order', 'check', 'special', 'pos'];
// The chosen tab is kept in the address (#/purchasing/po …), so Back from a van or PO returns to it (phone batch 1, C1).
const PUR_HASH = { order: 'order', check: 'check', special: 'special', pos: 'po' };
const PUR_FROM_HASH = { order: 'order', check: 'check', special: 'special', po: 'pos' };
// Dashboard links that ask for one part of the page open the tab it is on.
const PUR_TAB_FOR = { chk: 'check', 'po-chk-box': 'pos', 'overdue-box': 'pos', 'pur-order': 'order', 'ph-pur': 'special' };
// "47 to check – see Check: already ordered?" opens that tab showing only those order numbers.
let chkFocus = null; // { sup, labels: [...] } — kept while the page is redrawn
// Ticks and quantities typed on the To order tab survive a redraw (filter change, lead time…) as long as
// the same rows are there (keyed by van line / shelf top-up).
const purTicks = new Map();

async function renderPurchasing(hashTab) {
  const [sh, checks, toCheck, pos, phGroups, overdue] = await Promise.all([api('GET', '/api/shortages'), api('GET', '/api/check-ordered'),
    api('GET', '/api/pos/to-check'), api('GET', '/api/pos'), api('GET', '/api/placeholders?short=1'), api('GET', '/api/pos/overdue')]);
  // Special parts in two clear numbers, the same as the Stock tab and the van pages (user-r4-3).
  const phCounts = await api('GET', '/api/placeholders/count').catch(() => null);
  const phAll = phCounts ? phCounts.all : null;
  // Round 2 (sp-r1-1): lines whose van PO already covers them are "on order", not "still to order".
  const phOn = phCounts?.on_order || 0, phChk = phCounts?.check || 0;
  const phText = n => `${n} still to order${phOn ? ` · ${phOn} on order` : ''}${phChk ? ` · ${phChk} to check` : ''}${phAll != null ? ` · ${phAll} in all` : ''}`;
  // Plan cells that only hold the dealer's name are not parts: left off this list, said so under it (user-r4-6).
  const notParts = phCounts?.not_part || [];
  const goTo = ssGet('scrollTo');
  let tab = PUR_TAB_FOR[goTo] || PUR_FROM_HASH[hashTab] || ssGet('purTab', 'order');
  if (!PUR_TABS.includes(tab)) tab = 'order';
  ssSet('purTab', tab);
  const openPos = pos.filter(p => p.status === 'open');
  const nearChecks = checks.filter(g => g.near).length;
  const chkParts = checks.reduce((n, g) => n + g.lines.length, 0);
  const phCount = phGroups.reduce((s, g) => s + g.lines.length, 0);
  const tabLabel = {
    order: `To order${sh.orderNow.parts ? `<span class="badge">${sh.orderNow.parts}</span>` : ''}`,
    check: `Check: already ordered?${checks.length ? `<span class="badge ${nearChecks ? '' : 'quiet'}" title="${nearChecks ? `${nearChecks} order numbers for vans due soon · ${checks.length} in all · ${chkParts} parts` : `${checks.length} order numbers · ${chkParts} parts`}">${nearChecks || checks.length}</span>` : ''}`,
    special: `Special parts${phCount ? `<span class="badge quiet" title="${phText(phCount)}">${phCount}</span>` : ''}`,
    pos: `Purchase orders <span class="small">(${openPos.length} open)</span>${overdue.length ? `<span class="badge" title="Overdue deliveries">${overdue.length} late</span>` : ''}`,
  };
  app.innerHTML = `
    <div class="page-head"><h1>Purchasing</h1><div class="actions"><button class="btn" id="newpo" data-need="office">+ Blank PO</button>
      <a class="btn" href="/api/export/plan.xlsx" data-need="export">Export to Excel</a></div></div>
    ${isPhone() ? purSummaryHtml({ sh, checks, nearChecks, chkParts, openPos, overdue }) : ''}
    <div class="tabs tabs-scroll" id="pur-tabs">${PUR_TABS.map(t => `<button data-ptab="${t}" class="${t === tab ? 'active' : ''}">${tabLabel[t]}</button>`).join('')}</div>
    <div id="pur-tab"></div>`;
  const data = { sh, checks, toCheck, pos, phGroups, overdue };
  const show = (t, { keepFocus = false } = {}) => {
    if (!keepFocus && t !== 'check') chkFocus = null;
    ssSet('purTab', t);
    const want = `#/purchasing/${PUR_HASH[t]}`;
    if (location.hash !== want) history.replaceState(history.state, '', want);
    $$('#pur-tabs [data-ptab]').forEach(b => b.classList.toggle('active', b.dataset.ptab === t));
    const root = $('#pur-tab');
    if (t === 'order') renderOrderTab(root, data, show);
    else if (t === 'check') renderCheckTab(root, data, show);
    else if (t === 'special') {
      root.innerHTML = phGroups.length ? `<div class="panel flush" id="ph-pur"><h2>Special parts still to order — by van <span class="ph-count">${phText(phCount)}</span></h2>
        <p class="muted small" style="padding:0 16px;margin-top:-6px">Parts the plan only describes in words (“as per plan”). Link each to the real part to order it with the rest.${phAll > phCount ? ` The other ${phAll - phCount} (on Stock → Special parts to confirm and the van pages) already have their part set aside, are on order for their van, are waiting on an answer, or are not parts.` : ''}</p>
        <div id="ph-pur-list">${placeholderPanelHtml(phGroups)}</div>${notPartsHtml(notParts)}</div>` : `<div class="panel empty">No special parts left to order. 👍${notPartsHtml(notParts)}</div>`;
      if ($('#ph-pur-list')) wirePlaceholderPanel($('#ph-pur-list'), phGroups);
    } else renderPosTab(root, data);
  };
  $$('#pur-tabs [data-ptab]').forEach(b => b.onclick = () => { if (b.dataset.ptab === 'check') chkFocus = null; show(b.dataset.ptab, { keepFocus: false }); });
  // The phone summary's parts open their tab (and Order now / overdue deliveries scroll to their part).
  $$('[data-psum]').forEach(a => a.onclick = e => {
    e.preventDefault();
    const t = a.dataset.psum;
    if (t === 'check') chkFocus = null;
    if (t === 'order') ssSet('purOpen-now', '1');
    show(t, { keepFocus: false });
    const el = a.dataset.psumTo && document.getElementById(a.dataset.psumTo);
    (el || $('#pur-tabs')).scrollIntoView({ block: 'start' });
  });
  show(tab, { keepFocus: true });
  $('#newpo').onclick = async () => { await items(); newPODialog('', []); };
}

// Follow-up round 1 (owner-r3-3): on a phone, one short summary above the tabs; each part opens its tab.
// "Order now: 107 parts from 40 suppliers · Check: 63 order numbers for vans due soon (144 in all · 382 parts) ·
// 37 open POs · 0 deliveries overdue". The numbers are the tabs' own: To order's Order now number, the Check tab's
// order numbers (its badge = the ones for vans due soon) and parts, the Purchase orders tab.
function purSummaryHtml({ sh, checks, nearChecks, chkParts, openPos, overdue }) {
  const nowSups = new Set(sh.rows.filter(r => r.group === 'now' && !r.check && r.suggest > 1e-9).map(r => r.supplier || '')).size;
  const item = (tab, to, n, html, cls = '') => `<a href="#/purchasing/${PUR_HASH[tab]}" class="psum-i ${cls}" data-psum="${tab}" ${to ? `data-psum-to="${to}"` : ''}><b>${n}</b> ${html}</a>`;
  return `<nav class="pur-sum" aria-label="Purchasing summary">
    ${item('order', 'pur-order', sh.orderNow.parts, `part${sh.orderNow.parts === 1 ? '' : 's'} to order now<span class="psum-s">from ${nowSups} supplier${nowSups === 1 ? '' : 's'}</span>`, sh.orderNow.parts ? 'bad' : '')}
    ${item('check', '', nearChecks, `order number${nearChecks === 1 ? '' : 's'} to check<span class="psum-s">for vans due soon · ${checks.length} in all · ${chkParts} parts</span>`, nearChecks ? 'warn' : '')}
    ${item('pos', '', openPos.length, `open PO${openPos.length === 1 ? '' : 's'}`)}
    ${item('pos', 'overdue-box', overdue.length, `deliver${overdue.length === 1 ? 'y' : 'ies'} overdue`, overdue.length ? 'bad' : '')}
  </nav>`;
}

// "Not listed: ST0384 CHASSIS “Caravan Trading Center” – the dealer's name, not a part" (user-r4-6).
function notPartsHtml(list) {
  if (!list.length) return '';
  return `<div class="small muted not-parts">Not listed – not a part: ${list.map(x => `<a href="#/vans/${x.van_id}">${esc(x.chassis)}</a> ${esc(x.plan_column)}
    “${esc(x.spec)}” (${esc(x.why.replace(/, not a part$/, ''))})`).join('; ')}. Still shown on the van page and Stock → Special parts to confirm.</div>`;
}

// ── To order tab ──
function renderOrderTab(root, { sh, checks }, show) {
  const f = { sup: '', trade: '', van: '', win: String(sh.settings.short_weeks), sort: 'urgent', ...purFilter() };
  const win = Number(f.win) || sh.settings.short_weeks;
  const winEnd = addDaysIso(sh.today, win * 7);
  // Coming up / Later follow the window picked in the filter.
  const rows = sh.rows.map((r, i) => ({ ...r, key: i, tk: r.line_id ? `l${r.line_id}` : `t${r.item_id}`,
    grp: r.group === 'now' || r.group === 'nodate' ? r.group : (r.order_by <= winEnd ? 'soon' : 'later') }));
  // Tick + quantity per row: what was typed before the redraw, else ticked for Order now (never a
  // "plan says ordered – check" row, never a part with no supplier — it can't go on a PO until it has one)
  // with the suggested quantity.
  // Untouched rows always follow the latest suggestion (it changes when something is ordered or received).
  const live = new Set(rows.map(r => r.tk));
  for (const k of [...purTicks.keys()]) if (!live.has(k)) purTicks.delete(k);
  for (const r of rows) {
    const e = purTicks.get(r.tk);
    if (!e || !e.touched) purTicks.set(r.tk, { on: r.grp === 'now' && !r.check && !!r.supplier, qty: q(Math.round(r.suggest * 1000) / 1000), touched: false });
    if (!r.supplier) purTicks.get(r.tk).on = false;
  }
  const today = sh.today;
  // An order-by date that has already gone is shown as "order today" (round 4, user-r3-2).
  const orderByText = d => (d && d <= today ? '<strong class="need-now">order today</strong>' : `order by ${fmtDate(d)}`);
  const tickOf = r => purTicks.get(r.tk);
  // "N to check" in words that match the Check tab (Small fixes & phone round 1, user-r4-7): N = parts for the
  // vans in this list; the Check tab shows every van on those order numbers ("7 order numbers, 75 parts").
  const chkByLabel = new Map((checks || []).map(g => [g.label, g]));
  const checkInfo = chk => {
    const labels = [...new Set(chk.map(r => r.check_label || r.po_ref).filter(Boolean))];
    const groups = labels.map(l => chkByLabel.get(l)).filter(Boolean);
    return { labels, numbers: groups.length, total: Math.max(chk.length, groups.reduce((s, g) => s + g.lines.length, 0)) };
  };
  // order numbers behind a section's "to check" parts (Check tab groups by supplier + order number)
  const chkNums = list => new Set(list.filter(r => r.check).map(r => `${r.supplier}|${r.check_label || r.po_ref}`)).size;
  const secTitle = g => (GROUPS.find(x => x[0] === g) || [])[1] || '';
  const goCheck = (sup, chk, g) => {
    const ci = checkInfo(chk);
    chkFocus = { sup, labels: ci.labels, here: chk.length, total: ci.total, where: secTitle(g) };
    show('check', { keepFocus: true });
    window.scrollTo(0, 0);
  };
  // Every row is shown — parts with no supplier too, in their own "No supplier set" block (round 2).
  const noSup = rows.filter(r => !r.supplier);
  const noSupItems = new Set(noSup.map(r => r.item_id)).size;
  const noSupNow = new Set(noSup.filter(r => r.grp === 'now').map(r => r.item_id)).size;
  const vans = [...new Map(rows.filter(r => r.van_id).map(r => [r.van_id, r.chassis])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const sups = [...new Set(rows.map(r => r.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const trades = [...new Set(rows.map(r => r.trade || ''))].sort();
  const leads = new Map(sh.suppliers.map(s => [s.name, s]));
  const shown = r => (!f.sup || r.supplier === f.sup) && (!f.trade || (r.trade || '') === f.trade) && (!f.van || String(r.van_id) === f.van);
  // Which supplier blocks are open (closed by default; remembered while the page is redrawn).
  let openSet;
  try { openSet = new Set(JSON.parse(ssGet('purOpenSup', '[]'))); } catch { openSet = new Set(); }
  const saveOpen = () => ssSet('purOpenSup', JSON.stringify([...openSet]));

  const rowHtml = r => {
    const t = tickOf(r);
    const spec = specText(r.po_spec);
    const inProd = r.van_status === 'in_production';
    return `<tr data-row="${r.key}">
      <td style="width:32px"><input type="checkbox" ${t.on ? 'checked' : ''} ${r.supplier ? 'aria-label="Order this"' : 'disabled aria-label="Set the supplier first" title="Set the supplier on this part first, then it can go on a PO"'}></td>
      <td><strong>${esc(r.name)}</strong>${spec ? ` – <span>${esc(spec)}</span>` : ''} <span class="small faint">${esc(r.sku)}</span>
        ${r.check ? '' : planOrderedTag(r.spec)}
        ${r.plan_column ? `<div class="forcol">for: ${esc(r.plan_column)}</div>` : ''}
        <div class="small muted">${r.on_order > 0 ? `already on order: ${q(r.on_order)} · ` : ''}${r.topup ? `top up shelf stock (free ${q(r.free_now)}${r.reorder_level > 0 ? ` · reorder at ${q(r.reorder_level)}` : ''})` : ''}
          ${r.not_counted && r.kind === 'stock' ? 'not counted – check shelf first' : ''}</div></td>
      <td class="nowrap">${r.topup ? '<span class="small muted">shelf</span>' : `${r.build_pos ? `<span class="chip bo" title="Place in the build order (#1 gets parts first) — same as the Vans page">#${r.build_pos}</span> ` : ''}<a href="#/vans/${r.van_id}"><strong>${esc(r.chassis)}</strong></a>`}
        ${r.urgent ? ' <span class="chip urgent" title="Its part was taken for another van on the floor">Order now</span>' : ''}
        ${inProd ? '<div class="small muted">in production</div>' : ''}${r.date_passed ? '<div class="dueflag">Date passed – check</div>' : ''}</td>
      <td class="when">${r.topup ? '<strong class="need-now">order today</strong>'
        : inProd || (r.urgent && r.needed_by) || (r.needed_by && r.needed_by <= today) ? '<strong class="need-now">needed now</strong><div><strong class="need-now">order today</strong></div>'
        : r.needed_by ? `needed by <strong>${fmtDate(r.needed_by)}</strong><div>${orderByText(r.order_by)}</div>` : 'No date – check'}</td>
      <td class="right nowrap"><input class="qty" type="number" min="0" step="any" inputmode="decimal" value="${esc(t.qty)}" aria-label="How many to order"> ${esc(r.unit)}</td></tr>`;
  };
  // "Plan says ordered – check" rows: ONE row per supplier block, pointing at the Check tab (user-r2-1).
  const checkRowHtml = (sup, chk) => {
    const { labels, numbers, total } = checkInfo(chk);
    const n = total > chk.length ? `${chk.length} to check for vans in this list · ${total} in all on ${numbers === 1 ? 'this order number' : `these ${numbers} order numbers`}` : `${chk.length} to check`;
    return `<tr class="is-check"><td></td><td colspan="4"><strong>${n}</strong>
      <span class="small muted">— the plan says ${chk.length === 1 ? 'it was' : 'these were'} already ordered (${esc(labels.slice(0, 4).join(', '))}${labels.length > 4 ? ` + ${labels.length - 4} more` : ''}), not counted here.</span>
      <a href="#/purchasing" class="small" data-gochk="${esc(sup)}">See Check: already ordered? →</a></td></tr>`;
  };
  const blockKey = (g, sup) => `${g}|${sup}`;
  const blockBody = (sup, list) => {
    const real = list.filter(r => !r.check), chk = list.filter(r => r.check);
    return `<table class="pur"><tbody>${real.map(rowHtml).join('')}${chk.length ? checkRowHtml(sup, chk) : ''}</tbody></table>`;
  };
  const tickedIn = list => list.filter(r => !r.check && tickOf(r).on).length;
  // A supplier block's urgency: its first van in the build order (lowest #) and earliest order-by date
  // ("plan says ordered – check" rows don't count — they aren't ordered from here).
  const urgencyOf = list => {
    const real = list.filter(r => !r.check);
    const earliest = real.map(r => r.order_by).filter(Boolean).sort()[0] || '';
    const firstVan = real.filter(r => r.build_pos).sort((a, b) => a.build_pos - b.build_pos)[0] || null;
    const vanPos = [...new Set(real.map(r => r.build_pos).filter(Boolean))].sort((a, b) => a - b);
    return { earliest, firstVan, real: real.length, vanPos };
  };
  // Many suppliers share the same first van (#1 needs nearly everything): then the next van decides, and so on.
  const cmpVans = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] == null || b[i] == null) return a[i] == null ? 1 : -1; // more vans waiting = more urgent
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  // Suppliers "most urgent first" (default, round 4 user-r3-2): Order now by the first van's # then
  // order-by date; the other sections by order-by date then first van #. Or A–Z. Either way a supplier with
  // only "to check" rows comes after the others, and "No supplier set" is last.
  const supOrder = (g, [sa, la], [sb, lb]) => {
    if (!sa !== !sb) return !sa ? 1 : -1;
    if (f.sort === 'az') return sa.localeCompare(sb);
    const a = urgencyOf(la), b = urgencyOf(lb);
    if (!a.real !== !b.real) return !a.real ? 1 : -1;
    const pos = cmpVans(a.vanPos, b.vanPos);
    const date = (a.earliest || '9999').localeCompare(b.earliest || '9999');
    return (g === 'now' ? pos || date : date || pos) || sa.localeCompare(sb);
  };
  const supBlock = (g, sup, list) => {
    const s = leads.get(sup) || { lead_days: 14, lead_confirmed: 0 };
    const real = list.filter(r => !r.check), nc = list.length - real.length;
    const { earliest, firstVan } = urgencyOf(list);
    const open = openSet.has(blockKey(g, sup));
    const name = sup ? `<strong>${esc(sup)}</strong>` : '<strong style="color:var(--bad)">No supplier set</strong>';
    // Lead time not typed yet: the box is empty and says "14 (default)" — the 14 days are only assumed
    // (round 4, user-r3-2). Emptying a typed one puts it back to the default.
    const lead = sup ? `<label class="lead ${s.lead_confirmed ? '' : 'assumed'}" data-need="office" title="${s.lead_confirmed ? 'Supplier lead time in days. Empty the box to go back to the 14-day default.' : `Lead time not known yet — ${s.lead_days} days assumed. Type the real one.`}">lead time
        <input type="number" class="lead-in" min="0" max="365" step="1" value="${s.lead_confirmed ? s.lead_days : ''}" placeholder="14 (default)" data-lead="${esc(sup)}" data-was="${s.lead_confirmed ? s.lead_days : ''}" aria-label="Lead time for ${esc(sup)} in days"> days</label>`
      : `<a href="#/stock" class="small nosup-fix" title="Set the supplier on each part (Stock → Fix the catalogue); the lines then move to that supplier and can be ordered">set the supplier on these parts first</a>`;
    const facts = [`${real.length} line${real.length === 1 ? '' : 's'}`];
    if (earliest) facts.push(earliest <= today ? 'order today' : `earliest order-by ${earliest.slice(8, 10)}/${earliest.slice(5, 7)}`);
    if (firstVan) facts.push(`first van #${firstVan.build_pos} ${firstVan.chassis}`);
    if (nc) { const t = checkInfo(list.filter(r => r.check)).total; facts.push(t > nc ? `${nc} to check (${t} in all)` : `${nc} to check`); }
    const n = tickedIn(list);
    return `<div class="sup-block ${open ? 'open' : ''}" data-sup="${esc(sup)}" data-grp="${g}">
      <div class="row sup-head" data-toggle><button type="button" class="sup-tog" aria-expanded="${open}" aria-label="Show or hide the lines">${open ? '▾' : '▸'}</button>${name}
        <span class="muted small sup-facts">${esc(facts.join(' · '))}</span><span class="small sup-ticked">${n ? `${n} ticked` : ''}</span>
        <span class="grow"></span>${lead}
        ${sup && real.length ? `<button class="btn small primary" data-need="office" data-po="${esc(sup)}">Create PO for ticked</button>` : ''}</div>
      <div class="sup-body">${open ? blockBody(sup, list) : ''}</div></div>`;
  };
  const filtered = !!(f.sup || f.trade || f.van);
  const touchScreen = matchMedia('(pointer: coarse)').matches || isPhone(); // "tap" on a touch screen (owner-r3-3)
  const sections = new Map(); // grp → Map(supplier → rows)
  const sectionHtml = ([g, title, help]) => {
    const list = rows.filter(r => r.grp === g && shown(r));
    // Suppliers most urgent first (or A–Z, from the filter), "No supplier set" last.
    const grouped = new Map();
    for (const r of list) { if (!grouped.has(r.supplier)) grouped.set(r.supplier, []); grouped.get(r.supplier).push(r); }
    const bySup = new Map([...grouped.entries()].sort((a, b) => supOrder(g, a, b)));
    sections.set(g, bySup);
    // On a phone only Order now starts open (Coming up is one tap away), so the page is short (owner-r3-3).
    const open = g === 'now' || (g === 'soon' && !phone);
    const real = list.filter(r => !r.check), chk = list.length - real.length;
    // Suppliers with nothing to order here, only "plan says ordered – check" rows: one small line at the
    // end, not a block each (Small fixes & phone round 1, user-r4-8).
    const blocks = [...bySup.entries()].filter(([, ls]) => ls.some(r => !r.check));
    const onlyChk = [...bySup.entries()].filter(([, ls]) => !ls.some(r => !r.check));
    const onlyChkHtml = onlyChk.length ? `<div class="only-chk small"><span class="muted">Only to check (nothing to order):</span>
        ${onlyChk.map(([s2, ls]) => { const t = checkInfo(ls).total; return `<a href="#/purchasing" data-gochk-sup="${esc(s2)}" data-grp="${g}">${s2 ? esc(s2) : 'no supplier'} (${ls.length}${t > ls.length ? ` · ${t} in all` : ''})</a>`; }).join(', ')}
        <span class="muted">– see Check: already ordered?</span></div>` : '';
    // Order now: THE number — the same as the Dashboard and the menu badge (sh.orderNow, user-r1-3).
    const count = g === 'now'
      ? `<span class="order-count">${esc(sh.orderNow.text)}</span>${filtered ? ` <span class="small muted">· showing ${real.length} line(s) (filtered)</span>` : ''}`
      : `${real.length} line(s)`;
    return `<details class="pur-sec" data-grp="${g}" ${open ? 'open' : ''}><summary><span class="sec-title">${title}</span>
      <span class="muted small">${count}${chk ? ` · + ${chk} part${chk === 1 ? '' : 's'} the plan says ${chk === 1 ? 'was' : 'were'} ordered (${chkNums(list)} order number${chkNums(list) === 1 ? '' : 's'}) – check, not counted` : ''}${g === 'soon' ? ` · next ${win} weeks` : ''}</span><span class="small muted sec-help">${help}</span></summary>
      ${blocks.length ? `<div class="sec-tools small"><span class="muted">${blocks.length} supplier${blocks.length === 1 ? '' : 's'} — ${touchScreen ? 'tap' : 'click'} one to see its lines${phone ? ', tick them and make the PO' : ''}.</span>
          <button class="btn small link" data-openall="${g}">Open all</button><button class="btn small link" data-closeall="${g}">Close all</button></div>
        ${blocks.map(([s, ls]) => supBlock(g, s, ls)).join('')}` : list.length ? '' : '<div class="empty" style="padding:14px">Nothing here.</div>'}
      ${onlyChkHtml}</details>`;
  };

  // Phone batch 1 (C1): the explanation folds into "How this list works" (open on a PC, folded on a phone), and on
  // a phone the filters sit behind "Filters (n on)", so the first supplier is on the first screen.
  const nOn = [f.sup, f.trade, f.van].filter(Boolean).length + (win !== sh.settings.short_weeks ? 1 : 0) + (f.sort === 'az' ? 1 : 0);
  const phone = isPhone();
  const filtOpen = ssGet('purFiltOpen', '0') === '1';
  root.innerHTML = `
    <div class="panel flush" id="pur-order"><h2>To order</h2>
      <details class="how-help pur-how" ${phone ? '' : 'open'}><summary class="small">How this list works</summary>
      <p class="muted small">One line per van and part. <strong>Order now</strong> is in build order (#1, #2… — the same as the
        Vans page and the receive dialog): vans in production first, then planned vans. Parts already on a PO, already set aside, or
        free on the shelf are taken off first. Needed by = due date − ${sh.settings.build_weeks} weeks build time (now, for vans in production);
        order by = needed by − the supplier's lead time (14 days until you type it); a date already gone says <strong>order today</strong>.
        Suppliers are listed most urgent first (the first van #) — or A–Z, from the box below. Parts with no supplier are never ticked:
        set their supplier first.</p>
      <ul class="muted small sec-help-list">${GROUPS.map(([, t, h]) => `<li><strong>${t}</strong> – ${h}</li>`).join('')}</ul></details>
      <button type="button" class="btn small filt-tog" id="pf-tog" aria-expanded="${filtOpen}" aria-controls="pf-row">Filters${nOn ? ` (${nOn} on)` : ''} ${filtOpen ? '▴' : '▾'}</button>
      <div class="row filters ${filtOpen ? 'filt-open' : ''}" id="pf-row">
        <select id="pf-sup"><option value="">All suppliers</option>${sups.map(s => `<option ${f.sup === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select id="pf-trade"><option value="">All trades</option>${trades.map(t => `<option value="${esc(t)}" ${f.trade === t ? 'selected' : ''}>${esc(t ? tradeLabel(t) : 'No trade')}</option>`).join('')}</select>
        <select id="pf-van"><option value="">All vans</option>${vans.map(([id, c]) => `<option value="${id}" ${f.van === String(id) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="pf-win">${[2, 4, 8].map(w => `<option value="${w}" ${win === w ? 'selected' : ''}>Coming up: next ${w} weeks</option>`).join('')}</select>
        <select id="pf-sort" aria-label="Order of the suppliers"><option value="urgent" ${f.sort !== 'az' ? 'selected' : ''}>Suppliers: most urgent first</option>
          <option value="az" ${f.sort === 'az' ? 'selected' : ''}>Suppliers: A–Z</option></select>
        <label class="small muted" data-need="office">Build takes <input type="number" id="pf-build" min="0" max="52" step="1" value="${sh.settings.build_weeks}" style="width:56px"> weeks</label>
        <span class="grow"></span>
        ${noSupItems ? `<a href="#/stock" id="nosup" class="small" style="color:var(--bad);font-weight:600">${noSupItems} part(s) have no supplier – fix${noSupNow ? ` (${noSupNow} needed now)` : ''}</a>` : ''}
      </div>
      ${GROUPS.map(sectionHtml).join('')}
    </div>`;

  const saveF = patch => { ssSet('purFilter', JSON.stringify({ ...f, ...patch })); reload(); };
  $('#pf-tog', root).onclick = e => {
    const open = !$('#pf-row', root).classList.contains('filt-open');
    $('#pf-row', root).classList.toggle('filt-open', open);
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.textContent = `Filters${nOn ? ` (${nOn} on)` : ''} ${open ? '▴' : '▾'}`;
    ssSet('purFiltOpen', open ? '1' : '0');
  };
  $('#pf-sup', root).onchange = e => saveF({ sup: e.target.value });
  $('#pf-trade', root).onchange = e => saveF({ trade: e.target.value });
  $('#pf-van', root).onchange = e => saveF({ van: e.target.value });
  $('#pf-win', root).onchange = e => saveF({ win: e.target.value });
  $('#pf-sort', root).onchange = e => saveF({ sort: e.target.value });
  $('#pf-build', root).onchange = async e => { await act(() => api('PUT', '/api/purchasing/settings', { build_weeks: e.target.value }), 'Build time saved'); reload(); };
  [$('#nosup', root), ...$$('.nosup-fix', root)].filter(Boolean).forEach(a => {
    a.onclick = e => { e.stopPropagation(); ssSet('stockTab', 'fix'); ssSet('fixFilter', JSON.stringify({ m: 'supplier' })); };
  });
  // Lines are drawn when a supplier is opened (the page stays small and fast); ticks and quantities are
  // kept in purTicks, so a closed block still orders what is ticked in it.
  const listOf = el => sections.get(el.dataset.grp)?.get(el.dataset.sup) || [];
  const wireBody = el => {
    $$('tr[data-row]', el).forEach(tr => {
      const r = rows[Number(tr.dataset.row)];
      const t = tickOf(r);
      $('input[type=checkbox]', tr).onchange = e => { t.on = e.target.checked; t.touched = true; refreshTicked(el); };
      $('input.qty', tr).oninput = e => { t.qty = e.target.value; t.touched = true; };
    });
    $$('[data-gochk]', el).forEach(a => a.onclick = e => {
      e.preventDefault();
      goCheck(a.dataset.gochk, listOf(el).filter(r => r.check), el.dataset.grp);
    });
  };
  const refreshTicked = el => { const n = tickedIn(listOf(el)); $('.sup-ticked', el).textContent = n ? `${n} ticked` : ''; };
  const setOpen = (el, open) => {
    el.classList.toggle('open', open);
    $('.sup-tog', el).textContent = open ? '▾' : '▸';
    $('.sup-tog', el).setAttribute('aria-expanded', String(open));
    const body = $('.sup-body', el);
    if (open && !body.firstElementChild) { body.innerHTML = blockBody(el.dataset.sup, listOf(el)); wireBody(el); }
    if (open) openSet.add(blockKey(el.dataset.grp, el.dataset.sup)); else openSet.delete(blockKey(el.dataset.grp, el.dataset.sup));
    saveOpen();
  };
  $$('.sup-block', root).forEach(el => {
    if (el.classList.contains('open')) wireBody(el);
    $('[data-toggle]', el).onclick = e => {
      if (e.target.closest('input, a, button:not(.sup-tog), label')) return; // lead time box, links, Create PO
      setOpen(el, !el.classList.contains('open'));
    };
  });
  $$('[data-gochk-sup]', root).forEach(a => a.onclick = e => {
    e.preventDefault();
    const sup = a.dataset.gochkSup;
    goCheck(sup, (sections.get(a.dataset.grp)?.get(sup) || []).filter(r => r.check), a.dataset.grp);
  });
  $$('[data-openall]', root).forEach(b => b.onclick = () => $$(`.sup-block[data-grp="${b.dataset.openall}"]`, root).forEach(el => setOpen(el, true)));
  $$('[data-closeall]', root).forEach(b => b.onclick = () => $$(`.sup-block[data-grp="${b.dataset.closeall}"]`, root).forEach(el => setOpen(el, false)));
  $$('[data-lead]', root).forEach(inp => {
    inp.onclick = e => e.stopPropagation();
    inp.onchange = async () => {
      const v = inp.value.trim();
      if (v === inp.dataset.was) return;
      await act(() => api('PUT', '/api/suppliers', { name: inp.dataset.lead, lead_days: v }),
        v === '' ? `Lead time for ${inp.dataset.lead}: back to the 14-day default` : `Lead time for ${inp.dataset.lead} saved`);
      reload();
    };
  });
  $$('[data-po]', root).forEach(b => b.onclick = e => {
    e.stopPropagation();
    const sup = b.dataset.po;
    if (!sup) return toast('Set the supplier on these parts first', true);
    // Ticked lines of this supplier in every section (Later too, if someone ticked them), open or closed.
    const lines = rows.filter(r => r.supplier === sup && shown(r) && !r.check && tickOf(r).on).map(r => ({
      item_id: r.item_id, van_id: r.kind === 'per-van' ? r.van_id : null, qty: Number(tickOf(r).qty), spec: specText(r.po_spec),
      name: r.name, unit: r.unit, chassis: r.kind === 'per-van' ? r.chassis : '', forVans: r.chassis })).filter(l => l.qty > 0);
    if (!lines.length) return toast('Tick at least one line', true);
    newPODialog(sup, lines);
  });
  // Order now / Coming up / Later / No date open-or-closed is remembered while the page is redrawn.
  $$('details.pur-sec[data-grp]', root).forEach(d => {
    const k = `purOpen-${d.dataset.grp}`, v = ssGet(k, null);
    if (v != null) d.open = v === '1';
    d.ontoggle = () => ssSet(k, d.open ? '1' : '0');
  });
}

// ── Check: already ordered? tab ──
function renderCheckTab(root, { checks, sh }, show) {
  const focus = chkFocus;
  // Supplier filter (round 4, user-r3-1): '' = all, '-' = no supplier, else one supplier.
  const supsHere = [...new Set(checks.map(g => g.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const nGroups = s => checks.filter(g => (s === '-' ? !g.supplier : g.supplier === s)).length;
  let supF = focus ? '' : ssGet('chkSup', '');
  if (supF && !nGroups(supF)) { supF = ''; ssSet('chkSup', ''); } // all answered: back to every supplier
  const list = focus ? checks.filter(g => focus.labels.includes(g.label))
    : supF ? checks.filter(g => (supF === '-' ? !g.supplier : g.supplier === supF)) : checks;
  // One supplier on screen → "Yes, all on order" for every order number shown.
  const shownSups = [...new Set(list.map(g => g.supplier))];
  const oneSup = list.length > 1 && shownSups.length === 1 && shownSups[0] ? shownSups[0] : '';
  const filterRow = focus ? '' : `<div class="row filters"><select id="chk-sup-f" aria-label="Show one supplier">
      <option value="">All suppliers (${checks.length} order numbers)</option>
      ${supsHere.map(s => `<option value="${esc(s)}" ${supF === s ? 'selected' : ''}>${esc(s)} (${nGroups(s)})</option>`).join('')}
      ${nGroups('-') ? `<option value="-" ${supF === '-' ? 'selected' : ''}>No supplier (${nGroups('-')})</option>` : ''}</select>
      <span class="small muted">Pick one supplier to answer all its order numbers at once.</span></div>`;
  const allBox = oneSup ? `<div class="chk-allsup"><strong>${esc(oneSup)}</strong><span class="small">${list.length} order numbers, ${list.reduce((s, g) => s + g.lines.length, 0)} parts.
      Checked with them and everything is on order?</span><span class="grow"></span>
      <button class="btn small primary" id="chk-yes-all" data-need="office">Yes, all on order</button></div>` : '';
  // Same numbers as the To order line it came from (user-r4-7): "47 for vans in Order now · 75 in all".
  const focusParts = list.reduce((s, g) => s + g.lines.length, 0);
  const focusHere = focus && focus.here != null && focus.here < focusParts ? ` — ${focus.here} of them for the vans in ${esc(focus.where || 'that list')}` : '';
  root.innerHTML = `${focus ? `<div class="banner row">Showing the ${list.length === 1 ? 'order number' : `${list.length} order numbers`} for <strong>${esc(focus.sup || 'parts with no supplier')}</strong> from the to-order list:
      ${focusParts} part${focusParts === 1 ? '' : 's'} in all${focusHere}. <span class="grow"></span><button class="btn small" id="chk-all">Show all ${checks.length}</button></div>` : ''}
    ${list.length ? checkPanelHtml(list, sh.settings.short_weeks, { flat: !!focus || !!supF, top: filterRow + allBox })
      : `<div class="panel empty">${focus ? 'All of these are answered. 👍' : supF ? `${filterRow}Nothing left to check for this supplier. 👍` : 'Nothing to check — every plan order number has an answer. 👍'}</div>`}`;
  const all = $('#chk-all', root);
  if (all) all.onclick = () => { chkFocus = null; show('check', { keepFocus: true }); };
  const sf = $('#chk-sup-f', root);
  if (sf) sf.onchange = () => { ssSet('chkSup', sf.value); show('check', { keepFocus: true }); };
  const ya = $('#chk-yes-all', root);
  if (ya) ya.onclick = () => yesAllFlow(oneSup, list, ya, sh);
  wireCheckGroups(checks);
}

// "Yes, all on order" for one supplier: says exactly which POs get which parts, then answers every order
// number shown in one go (all or nothing). Parts unticked in a group are left out, as with the single Yes.
async function yesAllFlow(sup, list, btn, sh) {
  const picks = list.map(g => {
    const el = $$('.chk-group').find(x => x.dataset.key === g.key);
    const ids = el ? $$('.lines input[type=checkbox]', el).filter(c => c.checked).map(c => Number(c.value)) : g.lines.map(l => l.id);
    return { g, ids };
  }).filter(p => p.ids.length);
  if (!picks.length) return toast('Tick at least one part', true);
  const items = picks.map(({ g, ids }) => {
    const vans = [...new Set(g.lines.filter(l => ids.includes(l.id)).map(l => l.chassis))];
    // An existing PO says which dates it already has (round 2, sp-r1-4: a blank one is filled with the dates below).
    const has = g.target.exists ? [g.target.ordered_at ? `ordered ${fmtShort(g.target.ordered_at)}` : '', g.target.expected ? `expected ${fmtShort(g.target.expected)}` : ''].filter(Boolean).join(', ') : '';
    return `<li>${g.target.exists ? `add to <strong>PO ${esc(g.target.po_no)}</strong> (already in the system${has ? `: ${esc(has)}` : ', no dates yet'})` : `new <strong>PO ${esc(g.po_ref)}</strong>`}:
      ${ids.length} part(s) for ${esc(vans.join(', '))}</li>`;
  }).join('');
  // Small fixes & phone round 1 (check-r4-2): one "ordered on" and "expected by" date for every new PO (today by
  // default; "not known" allowed). A new PO with no expected date goes on "POs to check" as "no delivery date".
  // Round 2 (sp-r1-4): a PO already in the system gets them too where its own date is blank (never overwritten),
  // and with no expected date it is flagged "no delivery date" like a new one.
  const newPos = picks.filter(({ g }) => !g.target.exists).length;
  const blankOld = new Set(picks.filter(({ g }) => g.target.exists && (!g.target.ordered_at || !g.target.expected)).map(({ g }) => g.target.po_no)).size;
  const askDates = newPos + blankOld;
  const datesFor = [newPos ? (newPos === 1 ? 'the new PO' : `the ${newPos} new POs`) : '',
    blankOld ? `the blank dates of ${blankOld === 1 ? 'the PO' : `the ${blankOld} POs`} already in the system` : ''].filter(Boolean).join(' and ');
  const d = new Date();
  const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Follow-up round 1 (planner-r3-2): "Expected by" starts at today + the supplier's lead time (14 days when none
  // is set), so the new POs aren't overdue tomorrow. "Ordered on" stays today.
  const supLead = (sh?.suppliers || []).find(s => s.name === sup);
  const leadSet = !!(supLead && supLead.lead_confirmed && Number(supLead.lead_days) >= 0);
  const leadDays = leadSet ? Number(supLead.lead_days) : 14;
  const startVal = { ord: todayIso, exp: addDaysIso(todayIso, leadDays) };
  const leadNote = { ord: '', exp: `<span class="small muted ya-lead">today + ${leadDays} days (${leadSet ? `${esc(sup)}’s lead time` : `no lead time set for ${esc(sup)} yet`})</span>` };
  const dateBox = (id, label) => `<div class="ya-date"><label class="field">${label}<input type="date" id="ya-${id}" value="${startVal[id]}"></label>
      <label class="small ya-unk"><input type="checkbox" id="ya-${id}-unk"> not known</label>${leadNote[id]}</div>`;
  const choice = askChoice(`Yes, all on order — ${sup}`, `<p style="margin-top:0">Every order number below is marked as on order with <strong>${esc(sup)}</strong>:</p>
    <ul style="margin:0 0 8px;padding-left:18px;max-height:320px;overflow:auto">${items}</ul>
    ${askDates ? `<div class="ya-dates">${dateBox('ord', 'Ordered on')}${dateBox('exp', 'Expected by')}</div>
    <p class="muted small" style="margin-top:4px">Written on ${datesFor}${blankOld ? ' (a date a PO already has is kept)' : ''}.
      A PO left with no expected date shows under <strong>POs to check</strong> as “no delivery date” until you type it.</p>` : ''}
    <p class="muted small">Each part goes on ${esc(sup)}'s PO with its own number, for its van, and drops off the to-order list. Parts you unticked are left as they are.</p>`,
    [{ label: 'Cancel', value: null }, { label: `Yes, all ${picks.length} on order`, value: 'yes', primary: true }]);
  // Read the dates as they change (the dialog is gone once a button is pressed).
  const dates = { ord: askDates ? startVal.ord : '', exp: askDates ? startVal.exp : '' };
  for (const k of ['ord', 'exp']) {
    const box = $(`#ya-${k}`), unk = $(`#ya-${k}-unk`);
    if (!box || !unk) continue;
    // "not known" empties the box (planner-r3-2); unticking it brings back the last date shown.
    let kept = box.value;
    const sync = () => { box.disabled = unk.checked; dates[k] = unk.checked ? '' : box.value; };
    box.oninput = box.onchange = () => { kept = box.value; sync(); };
    unk.onchange = () => {
      if (unk.checked) { kept = box.value || kept; box.value = ''; } else box.value = kept || startVal[k];
      sync();
    };
  }
  const ok = await choice;
  if (ok !== 'yes') return;
  const by = officeName();
  await busy(btn, async () => {
    const r = await apiAsk('POST', '/api/check-ordered/all', { supplier: sup, by, ordered_at: dates.ord, expected: dates.exp,
      groups: picks.map(({ g, ids }) => ({ key: g.key, po_ref: g.po_ref, line_ids: ids })) }).catch(e => { toast(e.message, true); return null; });
    if (!r) return;
    if (!r.ok) return toast(r.error || 'Not saved', true);
    const made = r.data.po_list.filter(p => p.new);
    const old = r.data.po_list.filter(p => !p.new);
    const head = `${sup}: ${r.data.lines} part(s) on ${r.data.groups} PO(s)${made.length ? ` (${made.length} new${dates.exp ? '' : ' – no delivery date, listed under POs to check'})` : ''}`;
    reload();
    if (!old.length) return toast(head);
    // Which POs already in the system got the parts, and what happened to their dates (sp-r1-4).
    const oldLine = p => {
      const bits = [];
      if (p.set_ordered) bits.push(`ordered date set to ${fmtShort(p.set_ordered)}`);
      else if (p.kept_ordered) bits.push(`kept its ordered date ${fmtShort(p.kept_ordered)}`);
      if (p.set_expected) bits.push(`expected date set to ${fmtShort(p.set_expected)}`);
      else if (p.kept_expected) bits.push(`kept its expected date ${fmtShort(p.kept_expected)}`);
      if (p.no_date) bits.push('<strong>no delivery date</strong> – listed under POs to check');
      return `<li>PO ${esc(p.po_no)}: ${bits.length ? bits.join(', ') : 'dates as before'}</li>`;
    };
    askChoice('Saved', `<p style="margin-top:0">${esc(head)}.</p>
      ${made.length ? `<p>New: ${made.map(p => `PO ${esc(p.po_no)}`).join(', ')}${dates.exp ? ` (expected ${fmtShort(dates.exp)})` : ''}.</p>` : ''}
      <p style="margin-bottom:4px">Added to POs already in the system:</p><ul style="margin:0;padding-left:18px">${old.map(oldLine).join('')}</ul>`,
      [{ label: 'OK', value: 1, primary: true }]);
  });
}

// ── Purchase orders tab: search, Receive delivery, overdue deliveries, POs to check ──
function renderPosTab(root, { pos, toCheck, overdue, sh }) {
  const st = { q: ssGet('poQ', ''), status: ssGet('poStatus', 'open') };
  root.innerHTML = `
    <div class="panel flush" id="po-list"><h2>Purchase orders</h2>
      <div class="row filters">
        <input type="search" id="po-q" placeholder="Find a PO: number, supplier, van (e.g. 141, Nikpol, ST0380)" value="${esc(st.q)}" style="width:360px" data-keep>
        <select id="po-st"><option value="open">Open</option><option value="all">All</option><option value="closed">Closed / received</option></select>
        <span class="grow"></span><span class="small muted" id="po-n"></span></div>
      ${overdue.length ? `<details class="pur-sec" id="overdue-box" ${ssGet('poOverdueOpen') === '1' ? 'open' : ''}><summary><span class="sec-title">Overdue deliveries (${overdue.length})</span>
        <span class="small muted">PO lines that should have arrived — chase the supplier, or Receive / change the date on the PO.</span></summary>${overduePanelHtml(overdue)}</details>` : ''}
      ${toCheck.length ? `<details class="pur-sec" id="po-chk-box" ${ssGet('poChkOpen') === '1' ? 'open' : ''}>
        <summary><span class="sec-title">POs to check (${toCheck.length})</span><span class="small muted">No real number, no supplier, a number used twice, no delivery date, or still coming for a finished van.
          Fill in what you know and Save, merge a vague one into the real PO, or close it if it was never ordered.</span></summary>
        <div id="po-chk">${toCheck.map(poCheckHtml).join('')}</div></details>` : ''}
      <div class="table-wrap"><table id="po-table" class="cards-sm"><thead><tr><th>PO #</th><th>Supplier</th><th>For vans</th><th>Ordered</th><th>Expected</th>
        <th class="num">Lines</th><th class="num">Received</th><th>Status</th><th></th></tr></thead><tbody>
        ${pos.length ? pos.map(p => {
          const late = p.status === 'open' && p.next_expected && p.next_expected < sh.today;
          return `<tr class="clickable" data-href="#/pos/${p.id}" data-st="${p.status === 'open' ? 'open' : 'closed'}" data-po="${esc(String(p.po_no || '').toLowerCase())}"
              data-text="${esc(`${p.po_no} ${p.supplier || ''} ${p.vans || ''} ${p.notes || ''}`.toLowerCase())}">
            <td class="po-no"><strong><span class="sm-only">PO </span>${esc(p.po_no)}</strong><span class="sm-only po-sup-in"> · ${esc(p.supplier) || '<span class="faint">no supplier</span>'}</span>${(p.to_check ?? p.needs_check) && p.status === 'open' ? ' <span class="chip check">to check</span>' : ''}</td>
            <td class="po-sup sm-hide">${esc(p.supplier) || '<span class="faint">none</span>'}</td><td class="small po-vans" ${p.vans ? 'data-label="For"' : ''}>${esc(p.vans)}</td><td class="small sm-hide ${p.ordered_at ? 'nowrap' : 'po-unk'}">${orderedHtml(p)}</td>
            <td class="small nowrap po-exp ${late ? 'late' : ''}" ${p.next_expected ? 'data-label="Expected"' : ''}>${fmtDate(p.next_expected)}</td>
            <td class="num sm-hide">${p.line_count}</td><td class="num po-rcv" data-label="Received">${q(p.received)} / ${q(p.qty)}${p.closed > 0 ? `<div class="small muted">${q(p.closed)} cancelled</div>` : ''}</td><td class="po-st">${chip(p.status)}</td>
            <td class="right nowrap po-btn">${p.status === 'open' && p.qty - p.received - (p.closed || 0) > 1e-9 ? `<button class="btn small primary" data-need="poReceive" data-recv="${p.id}">Receive…</button>` : ''}</td></tr>`;
        }).join('') : ''}
        <tr class="hidden" id="po-none"><td colspan="9" class="empty">${pos.length ? 'No purchase order matches.' : 'No purchase orders yet.'}</td></tr></tbody></table></div></div>`;
  $('#po-st', root).value = st.status;
  const apply = () => {
    const t = $('#po-q', root).value.trim().toLowerCase(), s = $('#po-st', root).value;
    ssSet('poQ', $('#po-q', root).value); ssSet('poStatus', s);
    const words = t.split(/\s+/).filter(Boolean);
    // An exact PO number goes first ("36" → PO 36 at the top, then the POs that only mention 36, e.g.
    // every PO for ST0367). Small fixes & phone round 1, user-r4-1. An exact match is shown even when the
    // Open / Closed filter would hide it, so a typed PO number is never "not found".
    const exact = words.length === 1 ? words[0].replace(/^po#?/, '') : '';
    const body = $('#po-table tbody', root), none = $('#po-none', root);
    const rows = $$('tr[data-href]', body);
    rows.forEach((tr, i) => { if (tr.dataset.i == null) tr.dataset.i = i; });
    const rank = tr => !exact ? 2 : tr.dataset.po === exact ? 0 : tr.dataset.po.startsWith(exact) ? 1 : 2;
    rows.sort((a, b) => rank(a) - rank(b) || a.dataset.i - b.dataset.i).forEach(tr => body.insertBefore(tr, none));
    let n = 0, top = 0;
    rows.forEach(tr => {
      const hit = rank(tr) === 0;
      const ok = hit || ((s === 'all' || tr.dataset.st === s) && words.every(w => tr.dataset.text.includes(w)));
      tr.classList.toggle('hidden', !ok);
      tr.classList.toggle('po-exact', ok && hit);
      if (ok) n++;
      if (ok && hit) top++;
    });
    none.classList.toggle('hidden', n > 0);
    $('#po-n', root).textContent = `${n} purchase order${n === 1 ? '' : 's'}${top && n > top ? ` · PO ${exact} first, then ${n - top} more that mention “${exact}”` : ''}`;
  };
  $('#po-q', root).oninput = apply;
  $('#po-st', root).onchange = apply;
  apply();
  $$('tr[data-href]', root).forEach(tr => tr.onclick = e => { if (!e.target.closest('button')) location.hash = tr.dataset.href; });
  $$('[data-recv]', root).forEach(b => b.onclick = e => {
    e.stopPropagation();
    return busy(b, async () => {
      const d = await act(() => api('GET', `/api/pos/${b.dataset.recv}`));
      receivePODialog(d.po, d.lines);
    });
  });
  wirePoChecks(toCheck, pos);
  const pcb = $('#po-chk-box', root);
  if (pcb) pcb.ontoggle = () => ssSet('poChkOpen', pcb.open ? '1' : '0');
  const ob = $('#overdue-box', root);
  if (ob) ob.ontoggle = () => ssSet('poOverdueOpen', ob.open ? '1' : '0');
}

// ── "Check: already ordered?" ──

// One group per supplier + order number ("Battery Stop 200"). Vans in production / due soon first, each
// group showing its first van and how late it is ("#1 ST0367 – 26 days late") and sorted by that van's
// place in the build order; the rest folded under "Later vans". Each group says which PO a "Yes" adds to.
// `flat`: show every group given (no "Later vans" fold) — used when the To order tab sends one supplier's
// groups, or one supplier is picked in the filter. `top`: filter row / "Yes, all on order" box.
function checkPanelHtml(checks, weeks, { flat = false, top = '' } = {}) {
  const near = flat ? checks : checks.filter(g => g.near), later = flat ? [] : checks.filter(g => !g.near);
  const parts = gs => gs.reduce((s, g) => s + g.lines.length, 0);
  // The count says it is order numbers, and how they add up (owner-r3-3): "63 order numbers for vans due soon + 81 later = 144 · 382 parts".
  return `<div class="panel flush"><h2>Check: already ordered? <span class="ph-count">${flat ? `${near.length} order number${near.length === 1 ? '' : 's'} · ${parts(near)} parts`
    : `${near.length} order number${near.length === 1 ? '' : 's'} for vans due soon${later.length ? ` + ${later.length} later = ${near.length + later.length}` : ''} · ${parts(near) + parts(later)} parts`}</span></h2>
    <p class="muted small" style="padding:0 16px;margin-top:-6px">The production plan gives a supplier's order number for these parts, but there is no
      purchase order for them here. One answer per supplier and number. Until it is answered, the To order tab shows them as one
      “N to check” line per supplier (not ticked, not in the Order now number), so nothing urgent is hidden.
      Each order number shows the first van that needs it (#1 = first in the build order) and how late that van is.</p>
    ${top}
    <div id="chk">
      ${near.length ? near.map(checkGroupHtml).join('') : `<div class="empty" style="padding:12px 16px">Nothing to check for vans in production or due in the next ${weeks} weeks.</div>`}
      ${later.length ? `<details class="chk-later" ${sessionStorage.getItem('chkLaterOpen') === '1' ? 'open' : ''}><summary><strong>Later vans</strong>
        <span class="small muted">${later.length} order number(s), ${parts(later)} part(s) — not needed in the next ${weeks} weeks</span></summary>
        ${later.map(checkGroupHtml).join('')}</details>` : ''}
    </div></div>`;
}

function checkGroupHtml(g) {
  const vans = [...new Set(g.lines.map(l => l.chassis))];
  // The first van in the build order that needs this order and how late it is: "#1 ST0367 – 26 days late"
  // (round 4, user-r3-1 — before, every group said "needed by now").
  const f = g.first || {};
  const need = f.chassis ? `<span class="chk-need ${f.late_days > 0 ? 'today' : f.needed_now ? 'now' : ''}" title="First van in the build order that needs this order${vans.length > 1 ? ` (${vans.length} vans in all)` : ''}">${esc(f.label)}</span>`
    : '<span class="chk-need">no date</span>';
  const others = (g.open_pos || []).filter(p => !g.target.po_id || p.id !== g.target.po_id);
  const yesText = g.supplier
    ? (g.target.exists ? `“Yes” adds them to <strong>PO ${esc(g.target.po_no)} – ${esc(g.supplier)}</strong> (already in the system).`
      : `“Yes” makes a new <strong>PO ${esc(g.po_ref)} for ${esc(g.supplier)}</strong>.`)
    : `No supplier is set for ${g.lines.length === 1 ? 'this part' : 'these parts'} or named in the plan text: type who order ${esc(g.po_ref)} is with — “Yes” adds them to that supplier's PO ${esc(g.po_ref)}.`;
  const fromText = g.supplier && g.from_text ? ` <span class="small muted" title="The supplier is named in the plan text">(supplier from the plan text)</span>` : '';
  return `<div class="chk-group" data-key="${esc(g.key)}">
    <div class="row"><strong>${esc(g.supplier ? `${g.supplier} ${g.po_ref}` : `Order ${g.po_ref}${g.part ? ` – ${g.part}` : ''}`)}</strong>${fromText}${g.supplier ? '' : ' <span class="chip check">no supplier</span>'}
      ${need}<span class="muted small">${g.lines.length} part(s) for ${vans.length} van(s)</span>
      <span class="grow"></span>
      ${g.supplier ? '' : `<input type="text" class="chk-sup" data-need="office" list="sup-dl" placeholder="Supplier…" aria-label="Supplier for order ${esc(g.po_ref)}">`}
      <span data-need="office"><button class="btn small primary" data-yes>Yes, on order</button> <button class="btn small" data-no>No, still to order</button></span></div>
    <div class="chk-yes">${yesText}${others.length ? ` <span class="small">(PO ${esc(g.po_ref)} also exists for ${esc(others.map(p => p.supplier || 'no supplier').join(', '))} — a different order.)</span>` : ''}</div>
    <details><summary class="small muted" style="cursor:pointer">Show the parts (untick any that are different)</summary><div class="lines">
      ${g.lines.map(l => `<label><input type="checkbox" checked value="${l.id}"><span>${l.build_pos ? `<span class="chip bo" title="Place in the build order">#${l.build_pos}</span> ` : ''}<a href="#/vans/${l.van_id}"><strong>${esc(l.chassis)}</strong></a>
        ${l.when ? `<span class="small ${l.late_days > 0 ? 'late-txt' : 'muted'}">(${esc(l.when)})</span>` : ''} ·
        ${q(l.short)} ${esc(l.unit)} ${esc(l.name)}${specText(l.spec) ? ` <span class="muted">– ${esc(l.spec)}</span>` : ''}</span></label>`).join('')}</div></details></div>`;
}

function wireCheckGroups(groups) {
  if (!$('#sup-dl')) { const dl = document.createElement('datalist'); dl.id = 'sup-dl'; document.body.append(dl); }
  if ($('.chk-sup')) api('GET', '/api/suppliers').then(s => { $('#sup-dl').innerHTML = s.map(x => `<option value="${esc(x.name)}">`).join(''); }).catch(() => {});
  const later = $('details.chk-later');
  if (later) later.ontoggle = () => sessionStorage.setItem('chkLaterOpen', later.open ? '1' : '0');
  $$('.chk-group').forEach(el => {
    const g = groups.find(x => x.key === el.dataset.key);
    if (!g) return;
    const ids = () => $$('.lines input[type=checkbox]', el).filter(c => c.checked).map(c => Number(c.value));
    const label = g.supplier ? `${g.supplier} ${g.po_ref}` : `Order ${g.po_ref}${g.part ? ` – ${g.part}` : ''}`;
    const answer = async ans => {
      const lineIds = ids();
      if (!lineIds.length) return toast('Tick at least one part', true);
      const typed = ($('.chk-sup', el)?.value || '').trim();
      if (ans === 'yes' && !g.supplier && !typed) return toast(`Type who order ${g.po_ref} is with first`, true);
      const by = officeName();
      await busy($$('button', el), async () => {
        const body = { po_ref: g.po_ref, answer: ans, line_ids: lineIds, key: g.key, group: g.supplier, supplier: typed, by };
        const r = await apiAsk('POST', '/api/check-ordered', body).catch(e => { toast(e.message, true); return null; });
        if (!r) return;
        if (!r.ok) return toast(r.error || 'Not saved', true);
        const po = (r.data.po_list || [])[0];
        toast(ans === 'yes' ? `${label}: ${r.data.lines} part(s) added to ${po ? `${po.new ? 'new ' : ''}PO ${po.po_no}${po.supplier ? ` – ${po.supplier}` : ''}` : 'the PO'}`
          : `${label}: ${r.data.lines} part(s) moved to the order list`);
        reload();
      });
    };
    $('[data-yes]', el).onclick = () => answer('yes');
    $('[data-no]', el).onclick = () => answer('no');
  });
}

// ── POs to check ──

function poCheckHtml(p) {
  return `<div class="po-chk" data-pc="${p.id}">
    <div class="row"><a href="#/pos/${p.id}"><strong>${esc(p.po_no)}</strong></a><span class="muted small">${esc(p.supplier || 'no supplier')}</span>
      ${p.problems.map(x => `<span class="chip check">${esc(x)}</span>`).join(' ')}<span class="grow"></span>
      <span class="small muted">${p.lines.length} line(s)${p.vans.length ? ` for ${esc(p.vans.join(', '))}` : ''}</span></div>
    <div class="small muted" style="margin-top:4px">${p.lines.slice(0, 6).map(l => `${q(l.qty)} ${esc(l.name)}${specText(l.spec) ? ` (${esc(specText(l.spec).slice(0, 40))})` : ''}`).join(' · ')}${p.lines.length > 6 ? ' …' : ''}</div>
    <div class="form-grid" data-need="office">
      <label class="field">PO number<input type="text" data-f="po_no" value="${/\(no number\)$/.test(p.po_no) ? '' : esc(p.po_no)}" placeholder="e.g. 148"></label>
      <label class="field">Supplier<input type="text" data-f="supplier" list="sup-dl" value="${esc(p.supplier)}"></label>
      <label class="field">Ordered${p.ordered_at ? '' : ` <span class="faint small">${p.from_plan ? 'unknown (from plan)' : 'unknown'}</span>`}<input type="date" data-f="ordered_at" value="${esc(p.ordered_at)}"></label>
      <label class="field">Expected<input type="date" data-f="expected" value="${esc(p.expected)}"></label>
    </div>
    <div class="row" style="margin-top:8px" data-need="office"><button class="btn small primary" data-save>Save</button>
      <button class="btn small" data-ok title="It's right as it is">Looks right</button>
      <button class="btn small" data-merge>Merge into PO…</button>
      <button class="btn small danger" data-close title="Never ordered, or the supplier won't deliver: the parts go back on the to-order list">Close</button></div></div>`;
}

function wirePoChecks(list, allPos) {
  if (!list.length) return;
  if (!$('#sup-dl')) {
    const dl = document.createElement('datalist');
    dl.id = 'sup-dl';
    document.body.append(dl);
  }
  api('GET', '/api/suppliers').then(s => { $('#sup-dl').innerHTML = s.map(x => `<option value="${esc(x.name)}">`).join(''); }).catch(() => {});
  $$('.po-chk').forEach(el => {
    const p = list.find(x => x.id === Number(el.dataset.pc));
    const by = officeName();
    const put = (body, msg) => busy($$('button', el), async () => { await act(() => api('PUT', `/api/pos/${p.id}`, { ...body, by }), msg); reload(); });
    $('[data-save]', el).onclick = () => {
      const body = {};
      $$('[data-f]', el).forEach(i => { body[i.dataset.f] = i.value.trim(); });
      if (!body.po_no) delete body.po_no; // still no number: keep the "(no number)" name
      return put(body, 'PO saved');
    };
    $('[data-ok]', el).onclick = () => put({ checked: true }, 'Marked as checked');
    $('[data-close]', el).onclick = () => {
      if (!confirm(`Close ${p.po_no}? Anything not delivered comes off "on order" and goes back on the to-order list.`)) return;
      return put({ status: 'closed' }, 'PO closed');
    };
    $('[data-merge]', el).onclick = () => {
      const others = allPos.filter(o => o.id !== p.id && o.status === 'open');
      const m = modal(`Merge ${p.po_no} into…`, `<p class="muted" style="margin-top:0">All ${p.lines.length} line(s) move onto the PO you pick; ${esc(p.po_no)} is then closed. Nothing is lost.</p>
        <label class="field">PO<select id="mg-to">${others.map(o => `<option value="${o.id}" ${p.supplier && o.supplier === p.supplier ? '' : ''}>${esc(o.po_no)} – ${esc(o.supplier || 'no supplier')}${o.vans ? ` (${esc(o.vans)})` : ''}</option>`).join('')}</select></label>`,
        { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="mg-go">Merge</button>' });
      const same = others.find(o => p.supplier && o.supplier === p.supplier && !/\(no number\)$/.test(o.po_no));
      if (same) $('#mg-to', m.el).value = String(same.id);
      $('[data-close]', m.el).onclick = m.close;
      $('#mg-go', m.el).onclick = e => busy(e.currentTarget, async () => {
        const r = await act(() => api('POST', `/api/pos/${p.id}/merge`, { into: Number($('#mg-to', m.el).value), by }));
        toast(`${r.moved} line(s) moved`); m.close(); reload();
      });
    };
  });
}

// ── new PO ──

function newPODialog(supplier, lines) {
  const m = modal('New purchase order', `
    <form id="pof" class="stack"><div class="form-grid">
      <label class="field">PO number<input type="text" name="po_no" required placeholder="e.g. 148"></label>
      <label class="field">Supplier<input type="text" name="supplier" value="${esc(supplier)}"></label>
      <label class="field">Ordered<input type="date" name="ordered_at" value="${localToday()}"></label>
      <label class="field">Expected<input type="date" name="expected"></label></div>
      <label class="field">Notes<input type="text" name="notes"></label>
      ${lines.length ? `<div class="table-wrap" style="max-height:300px;overflow:auto"><table><tbody>${lines.map(l => `<tr><td>${esc(l.name)}${l.spec ? ` – ${esc(l.spec)}` : ''}</td>
        <td class="small muted">${l.chassis ? `for ${esc(l.chassis)}` : `shelf${l.forVans ? ` (for ${esc(l.forVans)})` : ''}`}</td><td class="num nowrap">${q(l.qty)} ${esc(l.unit || '')}</td></tr>`).join('')}</tbody></table></div>
        <div class="muted small">Shelf stock with the same description is put on one line.</div>` : `
      <div id="po-lines" class="stack"></div><button type="button" class="btn small" id="po-add">+ Add line</button>`}
    </form>`, { wide: lines.length > 0, footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="pof-save">Create PO</button>' });
  fillItemDatalist();
  $('[data-close]', m.el).onclick = m.close;
  const addRow = () => {
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `<div class="grow">${itemPicker('item')}</div><input type="text" class="spec-in" placeholder="Colour / size / model" style="width:180px">
      <input class="qty" type="number" name="qty" min="0" step="any" value="1">`;
    $('#po-lines', m.el).append(div);
  };
  if (!lines.length) { addRow(); $('#po-add', m.el).onclick = addRow; }
  $('#pof-save', m.el).onclick = e => busy(e.currentTarget, async () => {
    const f = formData($('#pof', m.el));
    const ls = lines.length ? lines.map(({ item_id, van_id, qty, spec }) => ({ item_id, van_id, qty, spec }))
      : $$('#po-lines .row', m.el).map(r => ({ item_id: pickedItemId($('input[name=item]', r)), qty: Number($('input.qty', r).value), spec: $('.spec-in', r).value.trim() }));
    let r;
    try {
      r = await apiAsk('POST', '/api/pos', { ...f, lines: ls });
      if (!r.ok && r.confirm?.warnings) {
        if (!confirm(`${r.confirm.warnings.join('\n')}\n\nCreate the PO anyway?`)) return;
        r = await apiAsk('POST', '/api/pos', { ...f, lines: ls, confirm: true });
      }
    } catch (err) { toast(err.message, true); return; }
    if (!r.ok) return toast(r.error || 'Not saved', true);
    toast(`PO ${f.po_no} created`);
    m.close(); location.hash = `#/pos/${r.data.id}`;
  });
}

// ── one PO ──

async function renderPO(poId) {
  const { po, lines, vans } = await api('GET', `/api/pos/${poId}`);
  const open = lines.some(l => l.open > 1e-9);
  const today = localToday();
  app.innerHTML = `
    <div class="page-head"><a href="#/purchasing" class="muted no-print">← Purchasing</a><h1>PO ${esc(po.po_no)}</h1>${chip(po.status)}
      <span class="muted">${esc(po.supplier || 'no supplier')}</span>
      <div class="actions"><button class="btn" onclick="window.print()">Print</button><button class="btn" id="edit" data-need="office">Edit details</button>
      ${po.status === 'open' ? '<button class="btn" id="close" data-need="office">Close PO</button>' : '<button class="btn" id="reopen" data-need="office">Re-open</button>'}
      <button class="btn danger" id="del" data-need="office">Delete</button></div></div>
    <div class="print-only"><h2>Purchase order ${esc(po.po_no)} — Stallion Caravans</h2>
      <div>Supplier: <strong>${esc(po.supplier)}</strong>${po.ordered_at ? ` · Ordered ${fmtDate(po.ordered_at)}` : ''}${po.expected ? ` · Expected ${fmtDate(po.expected)}` : ''}</div></div>
    ${(po.to_check ?? po.needs_check) && po.status === 'open' ? `<div class="banner no-print">To check: ${esc(po.problems.join(', ') || 'please check this PO')}
      <button class="btn small" id="okchk" data-need="office" style="margin-left:8px">Looks right</button></div>` : ''}
    <div class="panel"><div class="kv">
      <div>Ordered</div><div>${orderedHtml(po)}${po.ordered_at ? '' : ' <span class="small muted no-print">– type it with Edit details when you know it</span>'}</div>
      <div>Expected</div><div class="${po.expected && po.expected < today && open ? 'late' : ''}">${fmtDate(po.expected) || '<span class="faint">not set</span>'}</div>
      <div>For vans</div><div>${vans.length ? vans.map(esc).join(', ') : '<span class="faint">shelf stock</span>'}</div>
      ${po.notes ? `<div>Notes</div><div style="white-space:pre-line">${esc(po.notes)}</div>` : ''}</div></div>
    <div class="panel flush"><table><thead><tr><th>Part</th><th>For van</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Still to come</th><th class="no-print">Expected</th></tr></thead><tbody>
      ${lines.map(l => `<tr><td><strong>${esc(l.name)}</strong>${specText(l.spec) ? ` – ${esc(l.spec)}` : ''}<div class="small muted">${esc(l.sku)}</div></td>
        <td>${l.chassis ? `<a href="#/vans/${l.van_id}">${esc(l.chassis)}</a>` : '<span class="faint">shelf</span>'}</td>
        <td class="num">${q(l.qty)} ${esc(l.unit)}</td><td class="num">${q(l.received)}</td>
        <td class="num">${l.open > 1e-9 ? q(l.open) : '✓'}${l.closed > 0 ? `<div class="small muted">${q(l.closed)} cancelled</div>` : ''}</td>
        <td class="no-print small ${l.open > 1e-9 && l.expected_eff && l.expected_eff < today ? 'late' : ''}">${l.open > 1e-9 ? fmtDate(l.expected_eff) : ''}</td></tr>`).join('')}
    </tbody></table>
    ${open && po.status === 'open' ? `<div class="row no-print" style="padding:12px 16px" data-need="poReceive"><button class="btn primary" id="recv">Receive delivery…</button>
      <span class="hint">Book what arrived. Parts for a van are kept for that van.</span></div>` : ''}</div>`;
  const by = () => officeName();
  const r = $('#recv'); if (r) r.onclick = () => receivePODialog(po, lines);
  const c = $('#close'); if (c) c.onclick = async () => {
    if (open && !confirm('Close this PO? Anything not delivered comes off "on order" and goes back on the to-order list.')) return;
    await act(() => api('PUT', `/api/pos/${poId}`, { status: 'closed', by: by() }), 'PO closed'); reload();
  };
  const o = $('#reopen'); if (o) o.onclick = async () => { await act(() => api('PUT', `/api/pos/${poId}`, { status: 'open', by: by() }), 'PO re-opened'); reload(); };
  const ok = $('#okchk'); if (ok) ok.onclick = async () => { await act(() => api('PUT', `/api/pos/${poId}`, { checked: true, by: by() }), 'Marked as checked'); reload(); };
  $('#edit').onclick = () => {
    const m = modal(`PO ${po.po_no}`, `<form id="pe" class="stack"><div class="form-grid">
        <label class="field">PO number<input type="text" name="po_no" value="${esc(po.po_no)}"></label>
        <label class="field">Supplier<input type="text" name="supplier" value="${esc(po.supplier)}"></label>
        <label class="field">Ordered<input type="date" name="ordered_at" value="${esc(po.ordered_at)}"></label>
        <label class="field">Expected<input type="date" name="expected" value="${esc(po.expected)}"></label></div>
        <label class="field">Notes<textarea name="notes" rows="3">${esc(po.notes)}</textarea></label>
        <div class="hint">A changed number or supplier is noted with the old one.${po.ordered_at ? '' : ` Ordered date ${po.from_plan ? 'unknown (from plan)' : 'unknown'}: leave it empty until you know it.`}</div></form>`,
      { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="pe-save">Save</button>' });
    $('[data-close]', m.el).onclick = m.close;
    $('#pe-save', m.el).onclick = e => busy(e.currentTarget, async () => {
      await act(() => api('PUT', `/api/pos/${poId}`, { ...formData($('#pe', m.el)), by: by() }), 'PO saved'); m.close(); reload();
    });
  };
  $('#del').onclick = async () => {
    if (!confirm(`Delete PO ${po.po_no}?`)) return;
    await act(() => api('DELETE', `/api/pos/${poId}`), 'PO deleted'); location.hash = '#/purchasing';
  };
}

// Receive a delivery: one "Total arrived" box per part fills its van rows in build order (rows are
// already in that order). Short: the rest stays on order with its own date, or the supplier cancelled it.
function receivePODialog(po, lines) {
  const openLines = lines.filter(l => l.open > 1e-9);
  const byItem = new Map();
  for (const l of openLines) { if (!byItem.has(l.item_id)) byItem.set(l.item_id, []); byItem.get(l.item_id).push(l); }
  const m = modal(`Receive delivery — PO ${po.po_no}`, `
    <div class="row" style="margin-bottom:10px">${nameField().replace('Your name', 'Received by')}<span class="grow"></span>
      <span class="hint">Type the total that arrived for each part; it is shared out to the vans <strong>in build order, top row first</strong>
        (#1 = first call: vans in production, most overdue first). Change a van's number if the docket says otherwise.</span></div>
    ${[...byItem.values()].map(ls => `<div class="rcv-item" data-item="${ls[0].item_id}">
      <div class="row"><strong>${esc(ls[0].name)}</strong><span class="muted small">${q(ls.reduce((s, l) => s + l.open, 0))} ${esc(ls[0].unit)} still to come</span><span class="grow"></span>
        <label class="small">Total arrived <input type="number" class="qty tot" min="0" step="any" inputmode="decimal"></label></div>
      <table><tbody>${ls.map(l => `<tr data-pl="${l.id}" data-open="${l.open}">
        <td class="nowrap">${l.build_pos ? `<span class="chip" title="Place in the build order">#${l.build_pos}</span>` : ''}</td>
        <td>${l.chassis ? `for <strong>${esc(l.chassis)}</strong>${l.build_why ? `<div class="small muted">${esc(l.build_why)}</div>` : ''}` : 'shelf'}${specText(l.spec) ? `<div class="small muted">${esc(specText(l.spec))}</div>` : ''}</td>
        <td class="small muted nowrap">${q(l.open)} to come</td>
        <td class="nowrap"><input type="number" class="qty got" min="0" step="any" value="0"> ${esc(l.unit)}</td>
        <td class="rest small"></td></tr>`).join('')}</tbody></table></div>`).join('')}`,
    { wide: true, footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="rc-save">Save delivery</button>' });
  $('[data-close]', m.el).onclick = m.close;
  // Under / over per row: backorder date or "cancelled", or the "more than ordered" warning.
  const refreshRow = tr => {
    const open = Number(tr.dataset.open), got = Number($('.got', tr).value) || 0;
    const cell = $('.rest', tr);
    const bo = $('.bo', cell)?.value || '', cancelled = !!$('.cancel', cell)?.checked; // keep what was already picked
    if (got > open + 1e-9) { cell.innerHTML = `<span class="warn-text">${q(got - open)} more than ordered – put on shelf</span>`; return; }
    if (got >= open - 1e-9) { cell.innerHTML = ''; return; }
    cell.innerHTML = `${got > 0 ? `Rest (${q(open - got)}): ` : 'Not arrived: '}<label>arrives <input type="date" class="bo" value="${esc(bo)}"></label>
      <label><input type="checkbox" class="cancel" ${cancelled ? 'checked' : ''}> supplier cancelled ${got > 0 ? 'the rest' : 'it'}</label>`;
  };
  $$('tr[data-pl]', m.el).forEach(tr => { refreshRow(tr); $('.got', tr).oninput = () => refreshRow(tr); });
  $$('.rcv-item', m.el).forEach(box => {
    $('.tot', box).oninput = e => {
      let left = Number(e.target.value) || 0;
      const trs = $$('tr[data-pl]', box);
      trs.forEach((tr, i) => {
        const open = Number(tr.dataset.open);
        const give = i === trs.length - 1 ? left : Math.min(left, open); // anything extra goes on the last row (→ shelf)
        $('.got', tr).value = q(Math.max(0, give));
        left -= Math.max(0, give);
        refreshRow(tr);
      });
    };
  });
  $('#rc-save', m.el).onclick = e => {
    const by = readName(m.el);
    if (!by) return toast('Type who received it', true);
    const body = { lines: [], backorder: {}, close_balance: [], by };
    for (const tr of $$('tr[data-pl]', m.el)) {
      const id = Number(tr.dataset.pl), got = Number($('.got', tr).value) || 0;
      if (got > 0) body.lines.push({ id, qty: got });
      if ($('.cancel', tr)?.checked) body.close_balance.push(id);
      else if ($('.bo', tr)?.value) body.backorder[id] = $('.bo', tr).value;
    }
    if (!body.lines.length && !body.close_balance.length && !Object.keys(body.backorder).length) return toast('Enter what arrived', true);
    return busy(e.currentTarget, async () => {
      const r = await act(() => api('POST', `/api/pos/${po.id}/receive`, body));
      m.close();
      await reload();
      if (r.warnings?.length) {
        const w = modal('Delivery saved — please note', `<ul style="margin:0;padding-left:18px">${r.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`,
          { footer: '<button class="btn primary" data-close>OK</button>' });
        $('[data-close]', w.el).onclick = w.close;
      } else toast('Delivery saved');
    });
  };
}
