'use strict';
// Office screens for the stock clean-up: clean-up report, "already fitted", blind rack counts,
// bought-for-van checks, "special parts to confirm" (as per plan lines) and re-prioritise preview.
// Uses the helpers in app.js ($, api, modal, esc, q, toast, act, busy…), which are loaded by then.

// ── small shared bits ──

// Due-date warning for a van still to be built.
function dueFlag(v) {
  if (!v || !['planned', 'in_production'].includes(v.status)) return '';
  if (!v.eta) return '<span class="dueflag">Due date missing</span>';
  if (dateToCheck(v)) return '<span class="dueflag">Date passed – check</span>';
  return '';
}

// Search with a few trade words that mean the same thing ("aircon" finds "air conditioner").
const SYNONYMS = [
  ['aircon', 'air con', 'air conditioner', 'air conditioning'], // not "ac": that also means AC chargers
  ['oven', 'cooker', 'grill', 'stove'],
  ['toilet', 'loo', 'wc'],
  ['sink', 'basin'],
  ['antenna', 'aerial'],
];
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function searchMatch(haystack, query) {
  const h = String(haystack || '').toLowerCase();
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(w => {
    if (h.includes(w)) return true;
    const group = SYNONYMS.find(g => g.some(s => s === w || (w.length > 3 && s.startsWith(w))));
    return !!group && group.some(s => (s.length <= 3 ? new RegExp(`\\b${reEsc(s)}\\b`).test(h) : h.includes(s)));
  });
}
// Also finds the cleaned-up wording (wording.js): "battery stop" finds "Battert Stop".
const itemSearchText = i => {
  const s = [i.sku, i.name, i.supplier, i.plan_column, i.category, i.location].join(' ');
  const t = typeof tidyWords === 'function' ? tidyWords(s) : s;
  return t === s ? s : `${s} ${t}`;
};

// Who did it: the name of the person logged in (logins and job roles). The server records the name of the
// login itself and ignores any name sent from the page; the windows just say whose name goes on it.
function officeName() { return (typeof ME !== 'undefined' && ME?.user?.name) || ''; }
const nameField = () => `<span class="small muted who-line">Saved under <b>${esc(officeName())}</b></span>`;
const readName = () => officeName();

// ── re-prioritise: preview, then confirm ──

async function reprioDialog() {
  const plan = await api('GET', '/api/allocate/reprioritise/preview');
  const list = items => items.map(x => `${q(x.qty)} ${esc(x.unit || '')} ${esc(x.name)}`).join(', ');
  const m = modal('Re-prioritise stock by build order', `
    <p style="margin-top:0"><strong>Only free shelf stock moves.</strong> Parts received for a van stay with that van, and parts
      bought for one van never go to another. Vans in production come first: the build order number you set, then the
      earliest due date (most overdue first), the bay only breaking a tie (last bay first). Then planned vans: build order number, then due date.</p>
    ${plan.length ? `<div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Van</th><th>Gets</th><th>Gives up</th></tr></thead><tbody>
      ${plan.map(v => `<tr><td><strong>${esc(v.chassis)}</strong></td><td class="small" style="color:var(--ok)">${list(v.gains) || '—'}</td>
        <td class="small" style="color:var(--bad)">${list(v.loses) || '—'}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Nothing would move — every van already has its fair share.</div>'}`,
    { wide: true, footer: `<button class="btn" data-close>Cancel</button>${plan.length ? '<button class="btn primary" id="rp-go">Confirm — move these parts</button>' : ''}` });
  $('[data-close]', m.el).onclick = m.close;
  const go = $('#rp-go', m.el);
  if (go) go.onclick = () => busy(go, async () => {
    await act(() => api('POST', '/api/allocate/reprioritise', { by: officeName() }), 'Stock re-allocated');
    m.close(); reload();
  });
}

// ── already fitted (set up before go-live) ──

async function alreadyFittedDialog(vanId, onDone) {
  // qs: quick start — which lines were received for this van, and when (round 2, user-r1-5).
  const [d, qs] = await Promise.all([api('GET', `/api/vans/${vanId}`), api('GET', `/api/vans/${vanId}/fitted-quick`).catch(() => null)]);
  const quick = new Map((qs?.lines || []).map(x => [x.id, x]));
  const open = d.lines.filter(l => l.issued < l.qty);
  const daysAgo = iso => (iso && qs ? Math.round((Date.parse(qs.today) - Date.parse(iso)) / 864e5) : null);
  // Received for this van and kept for it in full, before the system started or at least `weeks` ago.
  const quickIds = weeks => open.filter(l => {
    const x = quick.get(l.id);
    return x && x.covered && (x.before_start || (daysAgo(x.received_at) ?? -1) >= weeks * 7);
  }).map(l => l.id);
  const recTag = l => {
    const x = quick.get(l.id);
    if (!x || !(x.kept > 0)) return '';
    const when = x.before_start ? 'before the system started' : fmtDate(x.received_at);
    return x.covered ? `<span class="small" style="color:var(--ok)"> · received for this van ${esc(when)}</span>`
      : `<span class="small warn-text"> · partly received (${q(x.kept)} of ${q(l.qty - l.issued)}) ${esc(when)}</span>`;
  };
  const v = qs?.van;
  const where = !v ? '' : v.status === 'in_production'
    ? `${esc(d.van.chassis)} is in production${v.area_name ? ` (${esc(v.area_name)})` : ''}.`
    : `${esc(d.van.chassis)} is not in production yet — only tick what is really in it.`;
  const anyQuick = open.some(l => quick.get(l.id)?.covered);
  const quickHtml = anyQuick ? `
    <div class="panel" style="padding:10px 12px;margin-bottom:10px;border-left:4px solid var(--olive);background:var(--ok-soft)">
      <div><strong>Quick start</strong> — ${where} Parts that arrived for this van have usually gone in already.</div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap">
        <label class="small">Tick everything received for this van more than
          <input type="number" id="af-weeks" min="0" step="1" value="2" style="width:56px"> weeks ago (or before the system started)</label>
        <button class="btn small primary" id="af-quick">Tick these <span id="af-qn"></span></button></div>
      <div class="hint">Then untick anything that isn't in the van yet, and press Save. Parts only partly received are never ticked here.</div>
    </div>` : '';
  const tradeName = t => (typeof TRADE_NAMES !== 'undefined' && TRADE_NAMES[t]) || 'Other';
  const groups = new Map();
  for (const l of open) {
    const k = tradeName(l.trade);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const m = modal(`${d.van.chassis} — parts already fitted`, `
    <p class="muted" style="margin-top:0">Tick the parts that are already in the van (put in before the system was used).
      They are closed off: never short, never re-ordered. Only stock that was set aside for them comes off the shelf figure.</p>
    <div class="row" style="margin-bottom:10px">${nameField()}<span class="grow"></span><button class="btn small" id="af-all">Tick all fitted</button></div>
    ${quickHtml}
    ${open.length ? [...groups.entries()].map(([g, ls]) => `
      <div class="panel" style="padding:10px 12px;margin-bottom:10px"><div class="row"><strong>${esc(g)}</strong><span class="muted small">${ls.length} part(s)</span>
        <span class="grow"></span><button class="btn small link" data-gall>tick all</button></div>
        ${ls.map(l => `<label class="row" style="padding:3px 0;align-items:flex-start;flex-wrap:nowrap"><input type="checkbox" value="${l.id}">
          <span>${q(l.qty - l.issued)} ${esc(l.unit)} × ${esc(l.name)}${l.plan_column ? ` <span class="forcol">for: ${esc(l.plan_column)}</span>` : ''}
          ${recTag(l) || (l.reserved > 0 ? '<span class="small muted"> · set aside</span>' : '')}</span></label>`).join('')}</div>`).join('')
      : '<div class="empty">Every part on this van is already fitted.</div>'}`,
    { wide: true, footer: `<button class="btn" data-close>Cancel</button><span class="grow"></span>
      <button class="btn" id="af-none" title="For the go-live checklist: this van's list was checked">Nothing (else) is fitted — done</button>
      <button class="btn primary" id="af-save">Save — mark ticked parts fitted</button>` });
  $('[data-close]', m.el).onclick = m.close;
  $('#af-all', m.el).onclick = () => $$('input[type=checkbox]', m.el).forEach(c => { c.checked = true; });
  $$('[data-gall]', m.el).forEach(b => { b.onclick = () => $$('input[type=checkbox]', b.closest('.panel')).forEach(c => { c.checked = true; }); });
  const wk = $('#af-weeks', m.el);
  if (wk) {
    const weeks = () => Math.max(0, Number(wk.value) || 0);
    const showN = () => { $('#af-qn', m.el).textContent = `(${quickIds(weeks()).length})`; };
    wk.oninput = showN; showN();
    $('#af-quick', m.el).onclick = () => {
      const ids = new Set(quickIds(weeks()).map(String));
      $$('input[type=checkbox][value]', m.el).forEach(c => { if (ids.has(c.value)) c.checked = true; });
      toast(ids.size ? `${ids.size} part(s) ticked — untick anything not in the van yet, then Save` : 'Nothing received that long ago');
    };
  }
  // done: true — the office went through this van's list (go-live checklist step c).
  const send = (btn, ids) => {
    const by = readName(m.el);
    if (!by) return toast('Type your name first', true);
    return busy(btn, async () => {
      const r = await act(() => api('POST', `/api/vans/${vanId}/fitted`, { line_ids: ids, by, done: true }));
      toast(ids.length ? `${r.closed} part(s) marked fitted` : `${d.van.chassis} checked — nothing else fitted`);
      m.close();
      if (onDone) onDone(); else reload();
    });
  };
  $('#af-save', m.el).onclick = e => {
    const ids = $$('input[type=checkbox]:checked', m.el).map(c => Number(c.value));
    if (!ids.length) return toast('Tick the parts that are already fitted (or press "Nothing (else) is fitted")', true);
    return send(e.currentTarget, ids);
  };
  $('#af-none', m.el).onclick = e => {
    if ($$('input[type=checkbox]:checked', m.el).length) return toast('Some parts are ticked — use "Save — mark ticked parts fitted"', true);
    return send(e.currentTarget, []);
  };
}

// ── bought-for-van stock with no van (C9) ──

function unassignedPanelHtml(list) {
  if (!list.length) return '';
  return `<div class="panel flush warn-panel"><h2>Bought-for-van stock with no van – assign to a van (${list.length})</h2>
    <p class="muted small" style="padding:0 16px;margin-top:-6px">These parts are on the shelf but not set aside for any van. A part bought for one van only ever
      goes to its own van, so pick the van it is for (it is set aside and kept for that van), or keep it on the shelf as a spare.
      Either way it stays on this list as <strong>Unassigned</strong> until it is used.</p>
    <div class="table-wrap"><table><tbody>${list.map(r => `<tr data-un="${r.id}">
      <td><div class="item-cell">${thumbImg(r.photo, 36)}<div><strong>${esc(r.name)}</strong> <span class="small faint">${esc(r.sku)}</span>
        <div class="small"><strong style="color:var(--warn)">${q(r.unassigned)} ${esc(r.unit)}</strong> on the shelf with no van${r.spare ? ` <span class="muted">(${q(r.spare)} kept as spare before)</span>` : ''}</div></div></div></td>
      <td class="nowrap" data-need="office">${r.vans.length ? `<select class="un-van" aria-label="Van">${r.vans.map(v => `<option value="${v.van_id}">${esc(v.chassis)} — needs ${q(v.short)}${v.eta ? `, due ${fmtDate(v.eta)}` : ''}</option>`).join('')}</select>
          <input class="qty un-qty" type="number" min="0" step="any" value="${q(Math.min(r.unassigned, r.vans[0].short))}" aria-label="How many"> ${esc(r.unit)}
          <button class="btn small primary" data-assign>Assign to van</button>` : '<span class="small muted">No van needs this part right now.</span>'}</td>
      <td class="right nowrap" data-need="office"><button class="btn small" data-spare>Keep on shelf as spare</button></td></tr>`).join('')}</tbody></table></div></div>`;
}
function wireUnassignedPanel(root, list) {
  if (!root) return;
  $$('[data-un]', root).forEach(tr => {
    const r = list.find(x => x.id === Number(tr.dataset.un));
    const sel = $('.un-van', tr);
    if (sel) sel.onchange = () => { const v = r.vans.find(x => x.van_id === Number(sel.value)); $('.un-qty', tr).value = q(Math.min(r.unassigned, v.short)); };
    const as = $('[data-assign]', tr);
    if (as) as.onclick = () => busy(as, async () => {
      const qty = Number($('.un-qty', tr).value);
      if (!(qty > 0)) return toast('How many are for that van?', true);
      await act(() => api('POST', `/api/items/${r.id}/assign`, { van_id: Number(sel.value), qty, by: officeName() }),
        `${q(qty)} ${r.unit} ${r.name} set aside for ${sel.selectedOptions[0].textContent.split(' — ')[0]}`);
      itemsCache = null; reload();
    });
    const sp = $('[data-spare]', tr);
    sp.onclick = () => busy(sp, async () => {
      await act(() => api('POST', `/api/items/${r.id}/spare`, { by: officeName() }), `${r.name}: kept on the shelf as a spare`);
      reload();
    });
  });
}

// ── Fix the catalogue (C9): supplier, rack, unit size, reorder level ──

async function renderFixCatalogue(root) {
  const d = await api('GET', '/api/catalogue');
  const f = (() => { try { return JSON.parse(sessionStorage.getItem('fixFilter') || '{}'); } catch { return {}; } })();
  const cats = [...new Set(d.rows.map(r => r.category))].sort();
  const missChip = m => `<span class="chip miss">${esc(m)}</span>`;
  const isShelf = r => r.kind === 'stock';
  root.innerHTML = `
    <div class="tiles">${[['supplier', 'No supplier'], ['rack', 'No rack (shelf parts)'], ['unit size', 'No unit size'], ['reorder level', 'No reorder level (shelf parts)']]
      .map(([k, l]) => `<button class="tile ${f.m === k ? 'on' : ''}" data-miss="${k}"><div class="n">${d.counts[k]}</div><div class="l">${l}</div></button>`).join('')}</div>
    <div class="panel flush">
      <div class="row" style="padding:12px 16px">
        <input type="search" id="fx-q" placeholder="Search…" style="width:200px" value="${esc(f.t || '')}">
        <select id="fx-m"><option value="">Anything missing</option>${['supplier', 'rack', 'unit size', 'reorder level'].map(k => `<option ${f.m === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <select id="fx-tr"><option value="">All trades</option>${Object.entries(TRADE_NAMES).map(([k, l]) => `<option value="${k}" ${f.r === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select id="fx-c"><option value="">All categories</option>${cats.map(c => `<option ${f.c === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <span class="grow"></span><span class="small muted" id="fx-n"></span></div>
      <div class="row bulk-bar" style="padding:8px 16px" data-need="stock">
        <label class="row small"><input type="checkbox" id="fx-all"> tick all shown</label>
        <span class="small muted">Put the ticked parts on</span>
        <select id="fx-rack"><option value="">— pick a rack —</option>${d.racks.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
        <button class="btn small" id="fx-put">Put on rack</button>
        <span class="grow"></span>
        <span class="small muted">${d.counted ? '' : 'Reorder levels: best set after the first full count — the shelf figures are still guesses.'}</span></div>
      <datalist id="sup-dl">${d.suppliers.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <div class="table-wrap"><table id="fx"><thead><tr><th></th><th>Part</th><th>Supplier</th><th>Rack · shelf / bin</th><th>Unit · what one unit is</th>
        <th>Reorder at · order up to</th><th></th></tr></thead><tbody>
      ${d.rows.map(r => `<tr data-fx="${r.id}" data-miss="${esc(r.missing.join('|'))}" data-tr="${esc(r.trade || '')}" data-cat="${esc(r.category)}"
          data-text="${esc([r.sku, r.name, r.category, r.supplier].join(' ').toLowerCase())}">
        <td><input type="checkbox" class="fx-tick" ${isShelf(r) ? '' : 'disabled title="Bought for one van — no rack"'}></td>
        <td style="min-width:200px"><strong>${esc(r.name)}</strong> <span class="small faint">${esc(r.sku)}</span>
          ${isShelf(r) ? '' : '<span class="chip perv">bought for van</span>'}
          <div class="small muted">${esc(r.category)}${TRADE_NAMES[r.trade] ? ` · ${esc(TRADE_NAMES[r.trade])}` : ''}</div>
          <div class="fx-miss">${r.missing.map(missChip).join(' ')}</div></td>
        <td><input type="text" name="supplier" list="sup-dl" value="${esc(r.supplier)}" style="width:150px">
          ${r.suggest_supplier ? `<div class="small"><button class="btn small link" data-sugsup="${esc(r.suggest_supplier.supplier)}" title="${esc(r.suggest_supplier.why)}">Use “${esc(r.suggest_supplier.supplier)}”?</button>
            <div class="faint">${esc(r.suggest_supplier.why)}</div></div>` : ''}</td>
        <td class="nowrap">${isShelf(r) ? `<select name="area_id"><option value="">— no rack —</option>${d.racks.map(a => `<option value="${a.id}" ${a.id === r.area_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <input type="text" name="location" value="${esc(r.location)}" placeholder="shelf / bin" style="width:80px">` : '<span class="faint small">—</span>'}</td>
        <td class="nowrap"><input type="text" name="unit" value="${esc(r.unit)}" style="width:60px">
          <input type="text" name="unit_size" value="${esc(r.unit_size)}" placeholder="${/length/i.test(r.unit) ? '1 length = 6.5 m' : /set|kit/i.test(r.unit) ? 'set = 1 van' : 'e.g. box of 100'}" style="width:130px"></td>
        <td class="nowrap">${isShelf(r) ? `<input type="number" name="reorder_level" min="0" step="any" value="${r.reorder_level > 0 ? q(r.reorder_level) : ''}" style="width:64px" placeholder="0">
          <input type="number" name="order_up_to" min="0" step="any" value="${r.order_up_to > 0 ? q(r.order_up_to) : ''}" style="width:64px" placeholder="—">
          ${r.suggest_reorder?.level ? `<div class="small"><button class="btn small link" data-sugreo="${r.suggest_reorder.level}" title="${esc(r.suggest_reorder.why)}">Apply ${q(r.suggest_reorder.level)}</button>
            <span class="faint" title="${esc(r.suggest_reorder.why)}">${/one van/.test(r.suggest_reorder.why) ? "one van's use" : 'from use per week'}</span></div>`
            : r.suggest_reorder ? `<div class="small faint" title="${esc(r.suggest_reorder.why)}">no suggestion yet</div>` : ''}` : '<span class="faint small">ordered per van</span>'}</td>
        <td class="nowrap"><button class="btn small primary" data-need="office" data-fxsave>Save</button></td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">Nothing missing — the catalogue is complete. 👍</td></tr>'}
      </tbody></table></div></div>`;
  const filter = () => {
    const t = $('#fx-q', root).value.toLowerCase(), m = $('#fx-m', root).value, r = $('#fx-tr', root).value, c = $('#fx-c', root).value;
    sessionStorage.setItem('fixFilter', JSON.stringify({ t, m, r, c }));
    let n = 0;
    $$('tr[data-fx]', root).forEach(tr => {
      const ok = (!t || searchMatch(tr.dataset.text, t)) && (!m || tr.dataset.miss.split('|').includes(m)) && (!r || tr.dataset.tr === r) && (!c || tr.dataset.cat === c);
      tr.classList.toggle('hidden', !ok); if (ok) n++;
    });
    $('#fx-n', root).textContent = `${n} part(s)`;
    $$('[data-miss]', root).forEach(b => { if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.miss === m); });
  };
  ['#fx-q', '#fx-m', '#fx-tr', '#fx-c'].forEach(s => { $(s, root).oninput = filter; $(s, root).onchange = filter; });
  $$('button[data-miss]', root).forEach(b => { b.onclick = () => { $('#fx-m', root).value = $('#fx-m', root).value === b.dataset.miss ? '' : b.dataset.miss; filter(); }; });
  $('#fx-all', root).onchange = e => $$('tr[data-fx]:not(.hidden) .fx-tick:not(:disabled)', root).forEach(c => { c.checked = e.target.checked; });
  $('#fx-put', root).onclick = e => {
    const ids = $$('tr[data-fx] .fx-tick:checked', root).map(c => Number(c.closest('tr').dataset.fx));
    const area = $('#fx-rack', root).value;
    if (!ids.length) return toast('Tick the parts first', true);
    if (!area) return toast('Pick the rack', true);
    return busy(e.currentTarget, async () => {
      const r = await act(() => api('POST', '/api/items/rack', { ids, area_id: Number(area), by: officeName() }));
      toast(`${r.moved} part(s) put on ${$('#fx-rack', root).selectedOptions[0].textContent}`);
      itemsCache = null;
      await renderFixCatalogue(root);
    });
  };
  $$('tr[data-fx]', root).forEach(tr => {
    const id = Number(tr.dataset.fx);
    const row = d.rows.find(x => x.id === id);
    const sup = $('[data-sugsup]', tr);
    if (sup) sup.onclick = () => { $('[name=supplier]', tr).value = sup.dataset.sugsup; tr.classList.add('dirty'); };
    const reo = $('[data-sugreo]', tr);
    if (reo) reo.onclick = () => { $('[name=reorder_level]', tr).value = reo.dataset.sugreo; tr.classList.add('dirty'); };
    $$('input:not(.fx-tick), select', tr).forEach(i => { i.addEventListener('input', () => tr.classList.add('dirty')); });
    const save = $('[data-fxsave]', tr);
    save.onclick = () => busy(save, async () => {
      const body = { by: officeName() };
      for (const k of ['supplier', 'area_id', 'location', 'unit', 'unit_size', 'reorder_level', 'order_up_to']) {
        const el = $(`[name=${k}]`, tr);
        if (!el) continue;
        const v = el.value.trim();
        const old = row[k] == null ? '' : String(row[k]);
        if (k === 'area_id' ? String(v) !== String(row.area_id || '') : ['reorder_level', 'order_up_to'].includes(k) ? Number(v || 0) !== Number(row[k] || 0) : v !== old) body[k] = v;
      }
      if (Object.keys(body).length === 1) return toast('Nothing changed on this line');
      if (body.unit === '') return toast('A unit is needed (ea, length, set, m…)', true);
      await act(() => api('PUT', `/api/items/${id}`, body), `${row.name} saved`);
      Object.assign(row, body, { area_id: body.area_id !== undefined ? Number(body.area_id) || null : row.area_id });
      // What is still missing on this line, without redrawing the page.
      const shelf = row.kind === 'stock';
      row.missing = [!String(row.supplier || '').trim() && 'supplier', shelf && !row.area_id && 'rack',
        !/^(ea|pair)$/i.test(String(row.unit || '').trim()) && !String(row.unit_size || '').trim() && 'unit size', shelf && !(Number(row.reorder_level) > 0) && 'reorder level'].filter(Boolean);
      tr.dataset.miss = row.missing.join('|');
      $('.fx-miss', tr).innerHTML = row.missing.length ? row.missing.map(missChip).join(' ') : '<span class="chip ready">✓ complete</span>';
      tr.classList.remove('dirty');
      itemsCache = null;
    });
  });
  filter();
}

// ── "Why?" — the history behind one van line's numbers (C11) ──

const REASON_TEXT = {
  allocate: 'Set aside from shelf stock', receive: 'Delivery booked in', 'receive: over': 'Over delivery', 'receive: short': 'Short delivery',
  reprioritise: 'Re-prioritised (build order)', borrow: 'Borrowed for another van on the floor', 'borrow undone': 'Borrow undone',
  'floor take': 'Taken on the floor', 'floor take undone': 'Take undone on the floor', 'van finished': 'Van finished / cancelled',
  fitted: 'Already fitted', 'fitted: checked': 'Already-fitted list checked', count: 'Count', adjust: 'Correction', 'count: missing': 'Count: parts missing',
  trim: 'Shelf figure lowered', 'check: here': 'Bought-for-van part checked: here', 'check: missing': 'Bought-for-van part checked: missing',
  'assign to van': 'Assigned to a van (was unassigned)', spare: 'Kept on the shelf as a spare', state: 'Customer supplies / to be decided',
  'check ordered': 'Check: already ordered? answered', 'po: balance closed': 'PO balance cancelled', 'po: re-opened': 'PO re-opened',
  'plan update': 'Production plan update', 'plan import': 'Production plan import', link: 'Linked to a real part', catalogue: 'Catalogue changed',
  'tidy:given': 'Clean-up: plan says it was given to a worker', given: 'Given to a worker (plan note)',
  'van status': 'Van status set by the office',
};
const reasonText = r => REASON_TEXT[r] || (String(r).startsWith('tidy:') ? `Clean-up (${r.slice(5).replace(/_/g, ' ')})` : r);
function changeText(a) {
  const parts = [];
  if (a.change != null && Math.abs(a.change) > 1e-9) parts.push(`<strong class="${a.change < 0 ? 'diff-neg' : 'diff-pos'}">${a.change > 0 ? '+' : ''}${q(a.change)} set aside</strong>`);
  if (a.firm_change != null && Math.abs(a.firm_change) > 1e-9) parts.push(`<span class="small">${a.firm_change > 0 ? '+' : ''}${q(a.firm_change)} kept for the van</span>`);
  // Line status in plain words ('' = normal, 'not_ordered' = still to order).
  const st = v => a.field === 'state' ? ({ '': 'normal', not_ordered: 'still to order', customer: 'customer supplies', tbd: 'to be decided' }[v] ?? v) : v;
  if (!parts.length && (a.before !== '' || a.after !== '')) parts.push(`<span class="small">${esc(a.field === 'state' ? 'status' : a.field)}: ${esc(st(a.before) || '—')} → ${esc(st(a.after) || '—')}</span>`);
  return parts.join(' ');
}
function historyRows(rows) {
  return rows.map(a => `<tr><td class="small muted nowrap">${esc(String(a.at).slice(0, 16))}</td>
    <td class="small"><strong>${esc(reasonText(a.reason))}</strong>${a.chassis ? ` · ${esc(a.chassis)}` : ''}${a.note ? `<div class="faint">${esc(a.note)}</div>` : ''}</td>
    <td class="small">${changeText(a)}</td><td class="small">${esc(a.worker || '')}</td></tr>`).join('');
}

async function whyDialog(lineId) {
  const d = await api('GET', `/api/van-lines/${lineId}/log`);
  const l = d.line;
  const rows = [...d.log, ...d.borrowedFor.map(b => ({ ...b, reason: 'borrow', note: `${b.note} (from ${b.chassis}'s set-aside)` })),
    ...d.moves.map(m => ({ at: m.at, reason: m.type === 'issue' ? 'floor take' : m.type, chassis: '', note: [m.ref, m.note].filter(Boolean).join(' · '),
      field: 'stock', before: '', after: `${m.qty > 0 ? '+' : ''}${q(m.qty)} ${l.unit} on the shelf`, worker: m.worker, move: 1, id: -m.id }))]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.move || 0) - (b.move || 0));
  modal(`Why? — ${l.chassis} · ${l.name}`, `
    <div class="tiles"><div class="tile"><div class="n">${q(l.qty)}</div><div class="l">Needed (${esc(l.unit)})</div></div>
      <div class="tile"><div class="n">${q(l.reserved)}</div><div class="l">Set aside now${l.reserved_firm > 0 ? ` (${q(l.reserved_firm)} kept for this van)` : ''}</div></div>
      <div class="tile"><div class="n">${q(l.issued)}</div><div class="l">Fitted / taken</div></div></div>
    <p class="muted small" style="margin-top:0">Every change to this line, oldest first: who moved what and when. “Set aside” changes are on this van's line;
      shelf movements are deliveries, takes and counts of this part for ${esc(l.chassis)}.</p>
    ${rows.length ? `<div class="table-wrap" style="max-height:440px;overflow:auto"><table><thead><tr><th>When</th><th>What</th><th>Change</th><th>Who</th></tr></thead>
      <tbody>${historyRows(rows)}</tbody></table></div>` : '<div class="empty">Nothing recorded for this line yet.</div>'}`, { wide: true });
}

// ── "Plan changed after parts were set aside" (C12) ──

async function planConflictsPanel(root) {
  if (!root) return;
  let list;
  try { list = await api('GET', '/api/plan-conflicts'); } catch (e) { root.innerHTML = ''; return; }
  if (!list.length) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="panel flush warn-panel"><h2>Plan changes to check (${list.length})</h2>
    <p class="muted small" style="padding:0 16px;margin-top:-6px">The spreadsheet changed these lines after parts were already set aside or fitted, so they were not changed.
      <strong>Use new</strong> = the line takes the new text and quantity (if the part itself changed, what was set aside for the old part goes back on the shelf).
      <strong>Keep current</strong> = leave the line as it is.</p>
    <div class="table-wrap"><table><thead><tr><th>Van</th><th>Column</th><th>Was</th><th>Now on the plan</th><th>Set aside / fitted</th><th></th></tr></thead><tbody>
    ${list.map(c => `<tr data-pc="${c.line_id}"><td><a href="#/vans/${c.van_id}"><strong>${esc(c.chassis)}</strong></a></td><td>${esc(c.column)}</td>
      <td class="small">${q(c.was.qty)} × ${esc(c.was.name)}<div class="spec">${esc(c.was.spec)}</div></td>
      <td class="small"><strong>${q(c.now.qty)} × ${esc(c.now.name)}</strong><div class="spec">${esc(c.now.spec)}</div></td>
      <td class="small nowrap">${q(c.current.reserved)} set aside · ${q(c.current.issued)} fitted</td>
      <td class="right nowrap" data-need="office"><button class="btn small primary" data-use="new">Use new</button> <button class="btn small" data-use="current">Keep current</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('[data-pc] [data-use]', root).forEach(b => { b.onclick = () => {
    const tr = b.closest('[data-pc]');
    return busy($$('button', tr), async () => {
      await act(() => api('POST', `/api/plan-conflicts/${tr.dataset.pc}`, { use: b.dataset.use, by: officeName() }), b.dataset.use === 'new' ? 'Line changed to the new plan' : 'Kept as it is');
      planConflictsPanel(root);
    });
  }; });
}

// ── weekly "Stock checks" page (C11) ──

async function renderStockChecks() {
  const d = await api('GET', '/api/stock-checks');
  const tick = (kind, r) => `<input type="checkbox" data-need="stock" data-ack="${kind}:${r.id}" ${r.ack ? 'checked' : ''} aria-label="Seen">`;
  const when = at => `<span class="small muted nowrap">${esc(String(at).slice(0, 16))}</span>`;
  const open = list => list.filter(r => !r.ack).length;
  const section = (id, title, help, list, head, row) => `<div class="panel flush" id="${id}"><h2>${title} <span class="small muted">${open(list)} to look at${list.length > open(list) ? `, ${list.length - open(list)} ticked this week` : ''}</span></h2>
    <p class="muted small" style="padding:0 16px;margin-top:-6px">${help}</p>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th style="width:40px">Seen</th>${head}</tr></thead><tbody>
      ${list.map(r => `<tr class="${r.ack ? 'acked' : ''}">${row(r)}</tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="padding:12px">Nothing this week.</div>'}</div>`;
  app.innerHTML = `
    <div class="page-head"><h1>Stock checks</h1><span class="muted">Once a week: look at each change made outside the normal flow and tick it.</span></div>
    ${section('sc-borrow', 'Borrowed between vans', 'Parts taken on the floor for one van that were set aside for another. Make sure the van that lost them gets them re-ordered.',
      d.borrows, '<th>When</th><th>Part</th><th>From</th><th>To</th><th>Who</th><th>Re-ordered?</th>',
      r => `<td>${tick('a', r)}</td><td>${when(r.at)}</td><td>${q(r.qty_moved)} ${esc(r.unit)} ${esc(r.name)}</td><td><a href="#/vans/${r.van_id}"><strong>${esc(r.chassis || '')}</strong></a></td>
        <td>${esc(r.to)}</td><td class="small">${esc(r.worker)}</td>
        <td class="small">${r.reordered ? `<span style="color:var(--ok)">✓ ${esc(r.reordered)}</span>` : `<span class="late">Not re-ordered yet</span> <a href="#/purchasing">Order now →</a>`}</td>`)}
    ${section('sc-corr', 'Floor and office corrections', 'Shelf figures changed by hand, or corrected on the floor because the system showed none.',
      d.corrections, '<th>When</th><th>Part</th><th class="num">Change</th><th>Why</th><th>Who</th>',
      r => `<td>${tick('m', r)}</td><td>${when(r.at)}</td><td>${esc(r.name)}${r.chassis ? ` <span class="small muted">· ${esc(r.chassis)}</span>` : ''}</td>
        <td class="num ${r.qty < 0 ? 'diff-neg' : 'diff-pos'}">${r.qty > 0 ? '+' : ''}${q(r.qty)} ${esc(r.unit)}</td><td class="small">${esc(r.note)}</td><td class="small">${esc(r.worker)}</td>`)}
    ${section('sc-count', 'Count differences', 'Rack counts that changed the shelf figure.',
      d.counts, '<th>When</th><th>Part</th><th class="num">Difference</th><th>Note</th><th>Who</th>',
      r => `<td>${tick('m', r)}</td><td>${when(r.at)}</td><td>${esc(r.name)}</td>
        <td class="num ${r.qty < 0 ? 'diff-neg' : 'diff-pos'}">${r.qty > 0 ? '+' : ''}${q(r.qty)} ${esc(r.unit)}</td><td class="small">${esc(r.note)}</td><td class="small">${esc(r.worker)}</td>`)}
    ${section('sc-over', 'Over deliveries', 'More arrived than was ordered; the extra went on the shelf.',
      d.over, '<th>When</th><th>Part</th><th class="num">Extra</th><th>PO</th><th>Who</th>',
      r => `<td>${tick('m', r)}</td><td>${when(r.at)}</td><td>${esc(r.name)}</td><td class="num">+${q(r.qty)} ${esc(r.unit)}</td><td class="small">${esc(r.ref)}</td><td class="small">${esc(r.worker)}</td>`)}
    ${section('sc-bought', 'Bought-for-van parts checked', 'Answers to “Is ST0389\'s fridge here?”. A “missing” answer put the part back on the to-order list.',
      d.bought, '<th>When</th><th>Van</th><th>Part</th><th>Answer</th><th>Who</th>',
      r => `<td>${tick('a', r)}</td><td>${when(r.at)}</td><td>${esc(r.chassis || '')}</td><td>${esc(r.name)}</td>
        <td>${r.reason === 'check: missing' ? '<span class="late">Not here — back to short</span>' : '<span style="color:var(--ok)">Here</span>'}</td><td class="small">${esc(r.worker)}</td>`)}
    <div class="panel flush" id="sc-next"><h2>Count these next</h2>
      <p class="muted small" style="padding:0 16px;margin-top:-6px">Racks counted longest ago (never counted first). Counting one rack a week keeps every figure honest.</p>
      <div class="table-wrap"><table><thead><tr><th>Rack / place</th><th class="num">Parts</th><th>Last counted</th><th></th></tr></thead><tbody>
      ${d.next.map(p => `<tr><td><strong>${esc(p.name)}</strong></td><td class="num">${p.items}</td>
        <td class="small">${p.never ? `<span class="late">${p.never} part(s) never counted</span>` : `oldest count ${fmtDate(p.oldest)}`}</td>
        <td class="right"><button class="btn small" data-need="stock" data-count="${esc(p.scope)}">Count…</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No shelf parts yet.</td></tr>'}
      </tbody></table></div></div>`;
  $$('[data-ack]').forEach(cb => cb.onchange = async () => {
    const [kind, id] = cb.dataset.ack.split(':');
    try { await api('POST', '/api/stock-checks/ack', { kind, id: Number(id), ack: cb.checked }); cb.closest('tr').classList.toggle('acked', cb.checked); refreshNavCount(); }
    catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  });
  $$('[data-count]').forEach(b => b.onclick = () => countRackDialog(b.dataset.count));
}

// ── "as per plan" lines → a real part ──

// Round 3 (user-r2-3): "This van already has Sliding door rail + pelmet – same thing?" and "fits two lines".
function alreadyText(l) {
  const a = l.already;
  if (!a) return '';
  return `This van already has <strong>${esc(a.name)}</strong>${a.plan_column ? ` <span class="small muted">(for: ${esc(a.plan_column)}${specText(a.spec) ? `, “${esc(a.spec)}”` : ''})</span>` : ''} – same thing?`;
}
// Round 4 (check-r3-1): stock was already received for this van on both lines — not offered as "same thing?".
function differentText(l) {
  const a = l.different;
  if (!a) return '';
  return `Two deliveries were received for this van – probably different parts <span class="small muted">(this van's <strong>${esc(a.name)}</strong> line${a.plan_column ? `, for: ${esc(a.plan_column)}` : ''}, is not offered as “same thing?”)</span>`;
}
// The note a line gets when the office should look at it before linking (see LINK_FLAG_RE in inventory.js).
const LINK_FLAG_TEXT = /possible duplicate of[^·]*|two deliveries were received for this van[^·]*|to check: [\d.]+ (?:received|set aside)[^·]*|to check: merge with[^·]*/i;
function clashText(l) {
  const c = l.clash;
  if (!c) return '';
  return `Could be <strong>${esc(c.name)}</strong>, but that also fits the ${c.others.map(o => `“${esc(o)}”`).join(', ')} line on this van — pick by hand so it isn't ordered twice.`;
}
// Ask before any merge. `pv` = /api/van-lines/link-preview. Resolves 'ok' (nothing to merge), 'safe' (merge the
// lines that are clearly the same need, leave different ones "to confirm"), 'all' (merge them all) or null (cancel).
async function confirmMerges(pv) {
  const merges = pv.filter(p => p.result === 'merge'), dups = pv.filter(p => p.result === 'duplicate');
  if (!merges.length && !dups.length) return 'ok';
  // Round 4: the need after merging ("need 1 → need 3", check-r3-2); stock received on both lines (check-r3-1);
  // what the van's line has no room for stays on the plan line, marked "to check" — never free shelf stock.
  const li = p => `<li><strong>${esc(p.chassis)}</strong>: the plan line <strong>${esc(p.plan_line)}</strong>${p.spec ? ` (“${esc(p.spec)}”)` : ''}, need ${q(p.qty)}
    → this van's <strong>${esc(p.into.name)}</strong> line${p.into.plan_column ? ` (for: ${esc(p.into.plan_column)})` : ''}${p.into.spec ? ` (“${esc(p.into.spec)}”)` : ''},
    need ${q(p.into.qty)}${p.qty_after != null && Math.abs(p.qty_after - p.into.qty) > 1e-9 ? ` <strong>→ need ${q(p.qty_after)}</strong>` : ''}
    ${p.different ? `<div class="small warn-text">Two deliveries were received for this van – probably different parts.</div>` : ''}
    ${p.nothing ? `<div class="small warn-text">Nothing would move – both lines already have a part for this van. If you merge, both lines stay as they are and the plan line stays “to check”.</div>`
      : `${p.moved > 0 ? `<div class="small muted">${q(p.moved)} set aside on the plan line moves to the van's line.</div>` : ''}
    ${p.kept > 0 ? `<div class="small warn-text">${q(p.kept)} ${p.kept_firm > 0 ? 'received for this van' : 'set aside'} on the plan line stays on it, marked “to check” —
      it does not become free shelf stock of ${esc(p.into.name)}.</div>` : ''}`}</li>`;
  const allDifferent = dups.length && dups.every(p => p.different);
  const html = `
    ${merges.length ? `<p style="margin-top:0">${merges.length === 1 ? 'This van already has' : `${merges.length} vans already have`} this part. The plan line will be
      <strong>merged</strong> into the van's own line — one part to order, not two:</p><ul>${merges.map(li).join('')}</ul>` : ''}
    ${dups.length ? `<p ${merges.length ? '' : 'style="margin-top:0"'}>${dups.length === 1 ? 'This van already has' : `${dups.length} vans already have`} this part,
      but ${allDifferent ? 'stock was already <strong>received on both lines</strong>' : 'with a <strong>different amount or text</strong>, or stock already received on both lines'}:</p><ul>${dups.map(li).join('')}</ul>
      <p class="muted small">“Merge all” keeps the larger need on the van's line. Otherwise ${dups.length === 1 ? 'it stays' : 'they stay'} “to confirm”, marked for the office to check.</p>` : ''}
    <p class="muted small">Merging moves what the van's line still has room for. The note and the history (“Why?”) say
      “merged from the plan line …”, and the plan cell keeps its colour. Nothing is lost.</p>`;
  const choices = dups.length
    ? [{ label: 'Merge all', value: 'all', primary: true }, { label: merges.length || pv.some(p => p.result === 'link') ? 'Merge only the same ones' : 'Leave to confirm', value: 'safe' }, { label: 'Cancel', value: null }]
    : [{ label: 'Yes, merge – same part', value: 'safe', primary: true }, { label: 'Cancel', value: null }];
  return askChoice('Already on the van – merge?', html, choices);
}

// The dialog opens with the suggested part (if there is one) already in the search box and at the top of
// the list; "Link all N lines with this same text" links every van's line with that exact text at once;
// "Keep as a one-off special part for this van" gives the line its own part (still orderable).
async function linkPartDialog(line, onDone) {
  // The van page's lines don't carry the suggestion / same-text info: fetch it.
  if (!line.same || line.suggest === undefined) {
    const g = await api('GET', `/api/placeholders?van=${line.van_id}`).catch(() => []);
    const full = g.flatMap(x => x.lines).find(x => x.id === line.id);
    if (full) line = { ...line, ...full };
  }
  const list = (await items(true)).filter(i => !i.placeholder && i.active && !/^ONEOFF-/.test(i.sku));
  const same = line.same || [];
  const sug = line.suggest && list.find(i => i.id === line.suggest.item_id) ? line.suggest : null;
  const already = line.already || null; // round 3: the van already has the part it most likely is
  const vansText = ids => [...new Set(ids.map(x => x.chassis))].join(', ');
  const m = modal('Link to a real part', `
    <div class="stack">
      <div class="review-item"><div><div class="lbl">${esc(line.chassis || '')} · ${esc(line.plan_column || line.name)}</div><div>${esc(line.spec || '(no text)')}</div>
        ${line.note ? `<div class="small muted">${esc(line.note)}</div>` : ''}</div></div>
      ${same.length ? `<label class="lp-all"><input type="checkbox" id="lp-all" checked> <span><strong>Link all ${same.length + 1} lines with this same text</strong>
        <span class="small muted">(${esc(line.chassis || '')}${same.length ? `, ${esc(vansText(same))}` : ''})</span></span></label>` : ''}
      ${already ? `<div class="lp-sug lp-already"><div class="grow"><div class="small muted">Not suggested — it would be ordered twice</div>
        ${alreadyText(line)}<div class="small muted">${esc(already.why || '')}</div></div>
        <button class="btn primary small" id="lp-already-go">Yes, same thing – merge…</button></div>` : ''}
      ${line.different ? `<div class="small lp-clash">${differentText(line)}</div>` : ''}
      ${line.clash ? `<div class="small muted lp-clash">${clashText(line)}</div>` : ''}
      ${sug ? `<div class="lp-sug"><div class="grow"><div class="small muted">Suggested${sug.sure ? '' : ' – check it is right'}</div>
        <strong>${esc(sug.name)}</strong> <span class="small faint">${esc(sug.sku)}</span><div class="small muted">${esc(sug.why)}</div></div>
        <button class="btn primary small" id="lp-sug-go">Link to this</button></div>` : ''}
      <label class="field">Find the part<input type="search" id="lp-q" placeholder="Type name, SKU, supplier… (aircon, oven, toilet…)" value="${sug ? esc(sug.name) : ''}"></label>
      <div id="lp-list" class="stack" style="max-height:260px;overflow:auto"></div>
      <details><summary class="muted small" style="cursor:pointer">Not in the list? Create a new part from this text</summary>
        <div class="form-grid" style="margin-top:8px">
          <label class="field" style="grid-column:span 2">Name<input type="text" id="lp-name" value="${esc(`${(line.plan_column || '').trim()} ${(line.spec || '').replace(/\s*\/?\s*\d{1,3}\s*$/, '')}`.trim().slice(0, 80))}"></label>
          <label class="field">Supplier<input type="text" id="lp-sup" list="lp-sup-dl" value="${esc(line.supplier_guess || '')}"></label></div>
        <button class="btn small" id="lp-new" style="margin-top:8px">Create part and link</button></details>
      <div class="lp-oneoff"><div class="grow"><strong>Custom for this van only?</strong>
        <div class="small muted">e.g. L&amp;S doors cut to size, wheel spats. It stops counting as "to confirm" and goes on the order list as
          its own part for ${esc(line.chassis || 'this van')}.</div>
        <label class="small" style="display:inline-flex;gap:6px;align-items:center;margin-top:6px">Supplier <input type="text" id="lp-oo-sup" list="lp-sup-dl" value="${esc(line.supplier_guess || '')}" style="width:180px"></label></div>
        <button class="btn small" id="lp-oneoff">Keep as a one-off special part for this van</button></div>
      <datalist id="lp-sup-dl"></datalist>
      <div class="hint">Only what is set aside for a van moves to the real part. Parts already fitted stay in the history as they are.</div>
    </div>`, { wide: true, footer: '<button class="btn" data-close>Cancel</button>' });
  $('[data-close]', m.el).onclick = m.close;
  api('GET', '/api/suppliers').then(s => { $('#lp-sup-dl', m.el).innerHTML = s.map(x => `<option value="${esc(x.name)}">`).join(''); }).catch(() => {});
  const allIds = () => ($('#lp-all', m.el)?.checked ? [line.id, ...same.map(x => x.id)] : [line.id]);
  const done = msg => { toast(msg); m.close(); if (onDone) onDone(); else reload(); };
  // Round 3 (user-r2-3): before linking to an existing part, ask the server what would happen. If any van
  // already has a line for that part, say so in words and ask first — nothing is merged without a "yes".
  const send = async body => {
    const ids = allIds();
    let force = false;
    if (body.item_id) {
      const pv = await act(() => api('POST', '/api/van-lines/link-preview', { line_ids: ids, item_id: body.item_id }));
      const ans = await confirmMerges(pv);
      if (!ans) return;
      force = ans === 'all';
    }
    if (ids.length > 1) {
      const r = await act(() => api('POST', '/api/van-lines/link-many', { ...body, line_ids: ids, force, by: officeName() }));
      const ok = (r.linked || 0) + (r.merged || 0);
      return done(`${ok} of ${ids.length} line(s) linked${r.merged ? ` (${r.merged} merged into the van's own line for that part)` : ''}${r.duplicate ? ` · ${r.duplicate} left "to confirm" (that van already has the part with a different amount or text, or stock received on both lines)` : ''}${r.kept ? ` · ${r.kept} not merged: nothing moved – both lines already have a part for that van; the plan line stays to check` : ''}`);
    }
    const r = await act(() => api('POST', `/api/van-lines/${line.id}/link`, { ...body, force, by: officeName() }));
    if (r.result === 'kept') return done(r.message || 'Nothing moved – both lines already have a part for this van; the plan line stays to check');
    if (r.result === 'duplicate') return done(r.different
      ? `Kept as "to confirm" — two deliveries were received for this van, probably not the same part as "${r.into_line?.name || 'that part'}"`
      : `Kept as "to confirm" — this van already has "${r.into_line?.name || 'that part'}" with a different amount or text`);
    done(r.result === 'merged' ? `Merged into this van's "${r.into_line?.name || 'existing'}" line — one part, not two${r.kept ? ` · ${q(r.kept)} stays on the plan line to check` : ''}` : 'Linked');
  };
  const draw = () => {
    const t = $('#lp-q', m.el).value.trim();
    let hits = t ? list.filter(i => searchMatch(itemSearchText(i), t)).slice(0, 15) : [];
    if (sug && t === sug.name) hits = [list.find(i => i.id === sug.item_id), ...hits.filter(i => i.id !== sug.item_id)];
    $('#lp-list', m.el).innerHTML = hits.map(i => `<button class="btn" style="justify-content:flex-start;text-align:left" data-id="${i.id}">
      <span><strong>${esc(i.name)}</strong> <span class="small faint">${esc(i.sku)}</span>${sug && i.id === sug.item_id ? ' <span class="chip ready">suggested</span>' : ''}
        <div class="small muted">${esc(i.supplier || '')}${i.plan_column ? ` · ${esc(i.plan_column)}` : ''}</div></span></button>`).join('')
      || (t ? '<div class="muted small">No part found — create a new one below, or keep it as a one-off.</div>' : '');
    $$('[data-id]', $('#lp-list', m.el)).forEach(b => { b.onclick = () => busy(b, () => send({ item_id: Number(b.dataset.id) })); });
  };
  $('#lp-q', m.el).oninput = draw;
  draw();
  const sg = $('#lp-sug-go', m.el);
  if (sg) sg.onclick = e => busy(e.currentTarget, () => send({ item_id: sug.item_id }));
  const ag = $('#lp-already-go', m.el);
  if (ag) ag.onclick = e => busy(e.currentTarget, () => send({ item_id: already.item_id }));
  $('#lp-new', m.el).onclick = e => {
    const name = $('#lp-name', m.el).value.trim();
    if (!name) return toast('Type a name for the new part', true);
    return busy(e.currentTarget, () => send({ new_item: { name, supplier: $('#lp-sup', m.el).value.trim() } }));
  };
  $('#lp-oneoff', m.el).onclick = e => busy(e.currentTarget, async () => {
    const r = await act(() => api('POST', `/api/van-lines/${line.id}/one-off`, { supplier: $('#lp-oo-sup', m.el).value.trim(), by: officeName() }));
    done(`Kept as a one-off part for ${line.chassis || 'this van'} (${r.sku})`);
  });
}

// Special parts to confirm, grouped by van. Returns HTML; wire with wirePlaceholderPanel.
function placeholderPanelHtml(groups, { showVan = true } = {}) {
  if (!groups.length) return '<div class="empty">No special parts left to confirm. 👍</div>';
  return groups.map(g => `<div style="border-top:1px solid var(--line)">
    ${showVan ? `<div class="row" style="padding:10px 16px;background:#fafbfc"><a href="#/vans/${g.van_id}"><strong>${esc(g.chassis)}</strong></a>
      ${dueFlag(g) || (g.eta ? `<span class="small muted">due ${fmtDate(g.eta)}</span>` : '')}<span class="muted small">${g.lines.length} to confirm</span></div>` : ''}
    <div class="table-wrap"><table class="ph-table"><tbody>${g.lines.map(l => `<tr data-ph="${l.id}" class="${l.not_part ? 'ph-notpart' : ''}"><td><strong>${esc(l.plan_column || l.name)}</strong>
      <div class="spec" style="max-width:none">${esc(l.spec || '(no text)')}</div>
      ${l.not_part ? `<div><span class="chip quiet" title="The plan cell only holds the dealer's name. Not ordered and not counted as still to order.">Not a part – ${esc(l.not_part.replace(/, not a part$/, ''))}</span></div>` : ''}
      ${l.parts?.length ? partsHtml(l) : l.suggest ? `<div class="small" style="color:var(--ok)">Suggested: ${esc(l.suggest.name)}</div>` : ''}
      ${l.already ? `<div class="small lp-already-line">${alreadyText(l)}</div>` : ''}
      ${l.clash ? `<div class="small muted">${clashText(l)}</div>` : ''}
      ${l.different ? `<div class="small muted">${differentText(l)}</div>` : ''}
      ${l.same?.length ? `<div class="small muted">Same text on ${l.same.length} other line${l.same.length === 1 ? '' : 's'} (${esc([...new Set(l.same.map(x => x.chassis))].join(', '))})</div>` : ''}
      ${l.duplicate ? `<div><span class="chip check">${esc((LINK_FLAG_TEXT.exec(l.note) || [''])[0])}</span></div>` : ''}</td>
      <td class="num nowrap">${q(l.qty)} ${esc(l.unit)}</td>
      <td class="small nowrap ph-st">${l.not_part ? '<span class="muted">not a part</span>' : l.state === 'customer' ? 'customer supplies' : l.state === 'tbd' ? 'to be decided'
        : l.reserved + l.issued >= l.qty ? 'set aside' : l.on_order > 0 ? 'on order'
        : l.po_ref && !l.state && !l.urgent ? `<span style="color:var(--warn)">check: plan says 'Order ${esc(l.po_ref)}'</span>` : '<span style="color:var(--bad)">not ordered</span>'}</td>
      <td class="right nowrap ph-acts" data-need="office">${l.parts?.some(x => !x.on_van) ? `<button class="btn small primary" data-addparts="${l.id}">Add each part…</button> ` : ''}<button class="btn small ${(l.suggest || l.already) && !l.parts?.length && !l.not_part ? 'primary' : ''}" data-link="${l.id}">${l.already ? 'Same thing?…' : l.suggest ? 'Link…' : 'Link to a real part'}</button>
        <button class="btn small" data-oneoff="${l.id}" title="Custom for this van only (e.g. L&S doors, wheel spats): stops counting as &quot;to confirm&quot; and goes on the order list">One-off</button>
        <div class="touch-hint">One-off = custom for this van only (e.g. L&amp;S doors, wheel spats): goes on the order list.</div></td></tr>`).join('')}</tbody></table></div></div>`).join('');
}
function wirePlaceholderPanel(root, groups, onDone) {
  const all = groups.flatMap(g => g.lines);
  $$('[data-link]', root).forEach(b => { b.onclick = () => linkPartDialog(all.find(l => l.id === Number(b.dataset.link)), onDone); });
  $$('[data-oneoff]', root).forEach(b => { b.onclick = () => oneOffDialog(all.find(l => l.id === Number(b.dataset.oneoff)), onDone); });
  $$('[data-addparts]', root).forEach(b => { b.onclick = () => addPartsDialog(all.find(l => l.id === Number(b.dataset.addparts)), onDone); });
}

// A plan text that names 2+ parts (Small fixes & phone round 1, user-r4-6): "This text names 3 parts:" with
// each part, what it most likely is, and the ones the van already has.
function partsHtml(l) {
  const open = l.parts.filter(x => !x.on_van).length;
  return `<div class="ph-parts small"><strong>This text names ${l.parts.length} parts</strong>${open < l.parts.length ? ` <span class="muted">(${l.parts.length - open} already on this van)</span>` : ''}:
    <ul>${l.parts.map(x => `<li>“${esc(x.text)}” – ${x.on_van ? `<span style="color:var(--ok)">on this van: ${esc(x.on_van.name)}</span>`
      : x.suggest ? `<span style="color:var(--ok)">suggested: ${esc(x.suggest.name)}</span>` : '<span class="muted">no match yet – pick it</span>'}</li>`).join('')}</ul></div>`;
}

// "Add each part…": each part of the text gets its own line on the van (same plan column and text). When every
// part not on the van yet gets one, the plan line itself becomes the first of them; otherwise it stays
// "to confirm" for the rest. Nothing is merged: a part the van already has is refused (use Same thing? / Link).
async function addPartsDialog(line, onDone) {
  if (!line.parts) {
    const g = await api('GET', `/api/placeholders?van=${line.van_id}`).catch(() => []);
    const full = g.flatMap(x => x.lines).find(x => x.id === line.id);
    if (full) line = { ...line, ...full };
  }
  const list = (await items(true)).filter(i => !i.placeholder && i.active && !/^ONEOFF-/.test(i.sku));
  const byName = new Map(list.map(i => [`${i.name} (${i.sku})`, i]));
  const bits = (line.parts || []).map((x, n) => ({ ...x, n }));
  const m = modal('Add each part', `
    <div class="stack">
      <div class="review-item"><div><div class="lbl">${esc(line.chassis || '')} · ${esc(line.plan_column || line.name)}</div><div>${esc(line.spec || '')}</div></div></div>
      <p class="muted small" style="margin:0">This text names ${bits.length} parts. Tick the ones to add: each becomes its own line on ${esc(line.chassis || 'the van')}
        (for: ${esc(line.plan_column || '')}), so it can be ordered and counted like any other part.</p>
      <datalist id="ap-dl">${list.map(i => `<option value="${esc(`${i.name} (${i.sku})`)}">`).join('')}</datalist>
      ${bits.map(x => x.on_van ? `<div class="ap-row done"><div class="grow"><strong>“${esc(x.text)}”</strong>
          <div class="small" style="color:var(--ok)">Already on this van: ${esc(x.on_van.name)}</div></div></div>`
        : `<label class="ap-row" data-n="${x.n}"><input type="checkbox" class="ap-on" ${x.suggest ? 'checked' : ''}>
          <div class="grow"><strong>“${esc(x.text)}”</strong>
            <input type="search" class="ap-pick" list="ap-dl" placeholder="Type to find the part (name or SKU)…" value="${x.suggest ? esc(`${x.suggest.name} (${x.suggest.sku})`) : ''}">
            <div class="small muted">${x.suggest ? `Suggested – ${esc(x.suggest.why || '')}` : 'No match found – type to find it, or leave it unticked.'}</div></div></label>`).join('')}
      <div class="hint">Parts left unticked stay on the plan line as “to confirm”. Not in the list? Use <strong>Link…</strong> on the line to create a new part.</div>
    </div>`, { wide: true, footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ap-go">Add ticked parts</button>' });
  $('[data-close]', m.el).onclick = m.close;
  $$('.ap-pick', m.el).forEach(inp => { inp.oninput = () => { const row = inp.closest('.ap-row'); if (inp.value.trim()) $('.ap-on', row).checked = true; }; });
  $('#ap-go', m.el).onclick = e => {
    const parts = [];
    for (const row of $$('.ap-row[data-n]', m.el)) {
      if (!$('.ap-on', row).checked) continue;
      const x = bits[Number(row.dataset.n)];
      const it = byName.get($('.ap-pick', row).value.trim());
      if (!it) return toast(`Pick a part from the list for “${x.text}”`, true);
      parts.push({ text: x.text, item_id: it.id });
    }
    if (!parts.length) return toast('Tick at least one part', true);
    return busy(e.currentTarget, async () => {
      const r = await act(() => api('POST', `/api/van-lines/${line.id}/add-parts`, { parts, by: officeName() }));
      const n = r.added + r.linked;
      toast(`${n} part${n === 1 ? '' : 's'} added to ${r.chassis}${r.left ? ` · ${r.left} still to confirm on the plan line` : ' · plan line done'}`);
      m.close();
      if (onDone) onDone(); else reload();
    });
  };
}

// "Keep as a one-off special part for this van" straight from the list (asks only for the supplier).
async function oneOffDialog(line, onDone) {
  if (line.supplier_guess === undefined) {
    const g = await api('GET', `/api/placeholders?van=${line.van_id}`).catch(() => []);
    const full = g.flatMap(x => x.lines).find(x => x.id === line.id);
    if (full) line = { ...line, ...full };
  }
  const m = modal('Keep as a one-off special part', `
    <p style="margin-top:0"><strong>${esc(line.chassis || '')} · ${esc(line.plan_column || line.name)}</strong><br>${esc(line.spec || '(no text)')}</p>
    <p class="muted small">It gets its own part, for ${esc(line.chassis || 'this van')} only. It stops counting as "to confirm" and shows on the
      Purchasing order list like any other part. The plan text stays on the line.</p>
    <label class="field">Supplier (who makes it)<input type="text" id="oo-sup" list="oo-sup-dl" value="${esc(line.supplier_guess || '')}"></label>
    <datalist id="oo-sup-dl"></datalist>`, { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="oo-go">Keep as one-off</button>' });
  $('[data-close]', m.el).onclick = m.close;
  api('GET', '/api/suppliers').then(s => { $('#oo-sup-dl', m.el).innerHTML = s.map(x => `<option value="${esc(x.name)}">`).join(''); }).catch(() => {});
  $('#oo-go', m.el).onclick = e => busy(e.currentTarget, async () => {
    const r = await act(() => api('POST', `/api/van-lines/${line.id}/one-off`, { supplier: $('#oo-sup', m.el).value.trim(), by: officeName() }));
    toast(`Kept as a one-off part for ${line.chassis || 'this van'} (${r.sku})`); m.close();
    if (onDone) onDone(); else reload();
  });
}

// ── blind count, one rack at a time ──

async function countRackDialog(scope) {
  const c = await api('GET', '/api/counts/choices');
  const m = modal('Count a rack', `
    <p class="muted" style="margin-top:0">Pick one rack (or area), the parts with no rack yet, or one trade. You'll see the parts but not what the
      system thinks is there — write down what you see. Parts bought for one van (fridges, furniture…) are checked separately.</p>
    <div class="form-grid">
      <label class="field">What to count<select id="cr-scope">
        ${c.racks.map(r => `<option value="area:${r.id}">${esc(r.name)} (${r.items} parts)</option>`).join('')}
        <option value="norack">No rack yet (${c.norack} parts)</option>
        ${c.trades.map(t => `<option value="trade:${esc(t.trade)}">Trade: ${esc(TRADE_NAMES?.[t.trade] || t.trade)} (${t.items} parts)</option>`).join('')}
      </select></label>
      ${nameField()}
    </div>`, { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="cr-open">Start count</button>' });
  $('[data-close]', m.el).onclick = m.close;
  if (typeof scope === 'string' && $(`#cr-scope option[value="${CSS.escape(scope)}"]`, m.el)) $('#cr-scope', m.el).value = scope;
  $('#cr-open', m.el).onclick = e => {
    const by = readName(m.el);
    if (!by) return toast('Type your name first', true);
    return busy(e.currentTarget, async () => {
      const s = await act(() => api('POST', '/api/counts', { scope: $('#cr-scope', m.el).value, by }));
      m.close();
      countSheet(s, by);
    });
  };
}

function countSheet(s, by) {
  const m = modal(`Count: ${s.label}`, `
    <p class="muted" style="margin-top:0">Count what is on the shelf, including parts set aside for vans. Leave a box empty if you didn't count that part.</p>
    <div class="table-wrap" style="max-height:480px;overflow:auto"><table class="cnt-table"><thead><tr><th>Part</th><th>Shelf / bin</th><th class="num">Counted</th></tr></thead><tbody>
      ${s.items.map(i => `<tr data-id="${i.id}"><td><div class="item-cell">${thumbImg(i.photo, 32)}<div><strong>${esc(i.name)}</strong><div class="small faint">${esc(i.sku)}</div></div></div></td>
        <td class="small">${esc(i.location || '')}</td>
        <td class="num nowrap"><input class="qty" type="number" min="0" step="any" inputmode="decimal"> ${esc(i.unit)}</td></tr>`).join('')}
    </tbody></table></div>
    <div id="cnt-check"></div>`,
  { wide: true, footer: '<button class="btn" data-close>Close</button><button class="btn primary" id="cnt-go">Check counts</button>' });
  $('[data-close]', m.el).onclick = () => { if (confirm('Close without saving? The counts typed here are lost.')) m.close(); };
  const typed = () => $$('tr[data-id]', m.el).map(tr => ({ item_id: Number(tr.dataset.id), qty: $('input.qty', tr).value.trim() }))
    .filter(c => c.qty !== '').map(c => ({ ...c, qty: Number(c.qty) }));
  let checked = null;
  const go = $('#cnt-go', m.el);
  go.onclick = () => busy(go, async () => {
    if (!checked) {
      const counts = typed();
      if (!counts.length) return toast('Type at least one count', true);
      const rows = await act(() => api('POST', `/api/counts/${s.id}/check`, { counts }));
      checked = { counts, rows };
      showCheck(rows);
      go.textContent = 'Save counts';
      return;
    }
    // Save: recounts, reasons, "counted before / after?" and "kept elsewhere?" answers.
    const counts = [], timing = {}, elsewhere = {}, elsewhereQty = {};
    for (const r of checked.rows) {
      const tr = $(`#cnt-check tr[data-r="${r.item_id}"]`, m.el);
      const st = rowState(tr, r);
      counts.push({ item_id: r.item_id, qty: st.counted, recounted: st.recounted, reason: $('input.reason', tr)?.value || '' });
      if (st.when) timing[r.item_id] = st.when;
      if (st.shortfall > 1e-9) {
        const ans = $('select.else', tr)?.value || '';
        if (ans) elsewhere[r.item_id] = ans;
        const n = $('input.else-qty', tr)?.value.trim();
        if (ans === 'yes' && n) elsewhereQty[r.item_id] = Number(n);
      }
    }
    try {
      const r = await api('POST', `/api/counts/${s.id}/save`, { counts, timing, elsewhere, elsewhere_qty: elsewhereQty, by });
      toast(`${r.saved} count(s) saved`);
      m.close(); reload();
    } catch (err) { toast(err.message, true); }
  });
  // What a row means right now (recount typed? counted before or after the movements?), worked out the
  // same way as the server: books = counted (after) or counted + what moved since (before).
  const bigDiff = (base, c) => { const d = Math.abs(c - base); return d > 1e-9 && (d > 5 || d > Math.abs(base) * 0.1); };
  function rowState(tr, r) {
    const re = $('input.recount', tr);
    const recount = re && re.value.trim() !== '' && Number.isFinite(Number(re.value)) ? Number(re.value) : null;
    const counted = recount ?? r.counted;
    const when = r.changed ? ($(`input[name="when-${r.item_id}"]:checked`, tr)?.value || '') : '';
    const book = when === 'before' ? counted + r.moved : counted;
    return { counted, recounted: recount != null, when, book, change: book - r.now,
      big: when === 'before' ? bigDiff(r.expected, counted) : bigDiff(r.now, counted), shortfall: Math.max(0, r.locked - book) };
  }
  function refreshRow(tr, r) {
    const st = rowState(tr, r);
    const ch = $('.cnt-change', tr);
    ch.className = `num cnt-change ${st.change < -1e-9 ? 'diff-neg' : st.change > 1e-9 ? 'diff-pos' : ''}`;
    ch.textContent = r.changed && !st.when ? '?' : `${st.change > 0 ? '+' : ''}${q(st.change)}`;
    const open = r.changed && !st.when; // "before or after?" not answered yet
    tr.classList.toggle('cnt-big', st.big && !open);
    $('.cnt-ok', tr).hidden = st.big || open;
    $('.cnt-fix', tr).hidden = open || (!st.big && !st.recounted && !$('input.reason', tr).value.trim());
    const el = $('.cnt-else', tr);
    if (!el) return;
    el.hidden = !(st.shortfall > 1e-9) || open;
    if (!el.hidden) {
      $('.cnt-else-n', tr).textContent = q(st.shortfall);
      const qi = $('input.else-qty', tr);
      qi.max = st.shortfall;
      qi.placeholder = q(st.shortfall);
      $('.cnt-else-qty', tr).hidden = $('select.else', tr).value !== 'yes';
    }
  }
  function showCheck(rows) {
    const anyMoves = rows.some(r => r.changed);
    const lockedText = r => r.lockedVans.map(v => `${esc(v.chassis)} (${q(v.qty)})`).join(', ');
    $('#cnt-check', m.el).innerHTML = `<h3 style="margin-top:16px">Check before saving</h3>
      <p class="small muted" style="margin-top:0">Big differences (more than 10% or 5) need a recount or a reason.
        ${anyMoves ? '<br><strong>Some parts moved while you were counting</strong> — say if you counted that shelf before or after, so nothing is counted twice.' : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Part</th><th class="num">System</th><th class="num">Counted</th><th class="num">Change</th><th>Recount / reason</th></tr></thead><tbody>
      ${rows.map(r => `<tr data-r="${r.item_id}"><td><strong>${esc(r.name)}</strong><div class="small faint">${esc(r.sku)}</div>
          ${r.locked ? `<div class="small muted">${q(r.locked)} kept for ${lockedText(r)}</div>` : ''}</td>
        <td class="num">${q(r.expected)}${r.changed ? `<div class="small muted nowrap">now ${q(r.now)}</div>` : ''}</td><td class="num">${q(r.counted)}</td>
        <td class="num cnt-change"></td>
        <td>
          ${r.changed ? `<div class="small" style="color:var(--warn)">Moved while counting: ${r.moves.map(mv => `${mv.type} ${mv.qty > 0 ? '+' : ''}${q(mv.qty)}${mv.chassis ? ` (${esc(mv.chassis)})` : ''}${mv.worker ? ` by ${esc(mv.worker)}` : ''}`).join('; ') || `${r.moved > 0 ? '+' : ''}${q(r.moved)}`}</div>
            <div class="small" style="margin:4px 0 6px"><strong>Did you count this shelf before or after that?</strong><br>
              <label class="nowrap"><input type="radio" name="when-${r.item_id}" value="before"> Before (books = ${q(r.counted)} ${r.moved < 0 ? '−' : '+'} ${q(Math.abs(r.moved))})</label>
              <label class="nowrap" style="margin-left:10px"><input type="radio" name="when-${r.item_id}" value="after"> After (books = what I counted)</label></div>` : ''}
          <span class="small muted cnt-ok">ok</span>
          <div class="row cnt-fix"><input class="recount qty" type="number" min="0" step="any" placeholder="recount" style="width:80px">
            <input class="reason" type="text" placeholder="or reason (damaged, found…)" style="width:180px"></div>
          ${r.locked ? `<div class="cnt-else" style="margin-top:6px" hidden><div class="small"><strong><span class="cnt-else-n"></span> of the parts kept for ${lockedText(r)} aren't on the shelf. Are they kept somewhere else (in the van, kit area)?</strong></div>
            <div class="row"><select class="else"><option value="">— pick —</option><option value="yes">Yes, elsewhere</option><option value="no">No, they are missing</option></select>
              <label class="small cnt-else-qty nowrap" hidden>How many elsewhere? <input class="else-qty qty" type="number" min="0" step="any" style="width:70px"></label></div>
            <div class="small muted">Any not kept elsewhere go back to "to order" for those vans.</div></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    for (const r of rows) {
      const tr = $(`#cnt-check tr[data-r="${r.item_id}"]`, m.el);
      $$('input, select', tr).forEach(i => { i.addEventListener('input', () => refreshRow(tr, r)); i.addEventListener('change', () => refreshRow(tr, r)); });
      refreshRow(tr, r);
    }
    $$('tr[data-id] input.qty', m.el).forEach(i => { i.disabled = true; });
  }
}

// ── parts bought for one van: check each is really here ──

async function boughtForVanDialog() {
  const groups = await api('GET', '/api/bought-for-van');
  const m = modal('Check parts bought for a van', `
    <p class="muted" style="margin-top:0">These parts arrived for one particular van and aren't fitted yet. Check each one is really here.</p>
    <div class="row" style="margin-bottom:10px">${nameField()}</div>
    ${groups.length ? groups.map(g => `<div class="panel" style="padding:10px 12px;margin-bottom:10px"><strong>${esc(g.chassis)}</strong>
      ${g.lines.map(l => `<div class="row" data-l="${l.id}" style="padding:6px 0;border-top:1px solid var(--line);flex-wrap:nowrap">${thumbImg(l.photo, 32)}
        <div class="grow">Is ${esc(g.chassis)}'s <strong>${esc(l.name)}</strong> here? <span class="small muted">${q(l.reserved)} ${esc(l.unit)}${l.plan_column ? ` · for: ${esc(l.plan_column)}` : ''}${l.spec ? ` · ${esc(l.spec.slice(0, 60))}` : ''}</span>
          ${l.checked_at ? `<span class="small" style="color:var(--ok)"> ✓ checked ${esc(l.checked_at.slice(0, 10))}</span>` : ''}</div>
        <button class="btn small" data-a="here">Yes</button><button class="btn small" data-a="missing">No</button><button class="btn small" data-a="fitted">Already fitted</button></div>`).join('')}</div>`).join('')
      : '<div class="empty">Nothing waiting — no bought-for-van parts are on the shelf.</div>'}`,
    { wide: true, footer: '<button class="btn" data-close>Close</button>' });
  $('[data-close]', m.el).onclick = () => { m.close(); reload(); };
  $$('[data-a]', m.el).forEach(b => { b.onclick = () => {
    const by = readName(m.el);
    if (!by) return toast('Type your name first', true);
    const row = b.closest('[data-l]');
    if (b.dataset.a === 'missing' && !confirm('Not here? It goes back to "to order" for this van, and comes off the shelf figure.')) return;
    return busy($$('button', row), async () => {
      await act(() => api('POST', `/api/van-lines/${row.dataset.l}/check`, { answer: b.dataset.a, by }));
      row.innerHTML = `<span class="small" style="color:var(--ok)">✓ ${b.dataset.a === 'here' ? 'Here' : b.dataset.a === 'missing' ? 'Not here — back to short' : 'Marked fitted'}</span>`;
    });
  }; });
}

// ── clean-up report ──

async function renderCleanup() {
  const r = await api('GET', '/api/tidy/report');
  const total = r.steps.reduce((s, x) => s + x.changes.length, 0);
  const flagged = r.steps.reduce((s, x) => s + x.flagged.length, 0);
  const row = x => `<tr><td class="small nowrap">${esc(x.chassis || '')}</td><td class="small">${esc(x.item_name || '')}<div class="faint">${esc(x.sku || '')}</div></td>
    <td class="small">${esc(x.field)}</td><td class="small">${esc(x.before)}</td><td class="small">${esc(x.after)}</td><td class="small muted">${esc(x.note)}</td></tr>`;
  const table = rows => `<div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Van</th><th>Part</th><th>What</th><th>Before</th><th>After</th><th>Note</th></tr></thead>
    <tbody>${rows.map(row).join('')}</tbody></table></div>`;
  app.innerHTML = `
    <div class="page-head"><h1>Clean-up report</h1>
      <div class="actions">${r.checked ? `<span class="chip ready">Checked by ${esc(r.checked.by)} ${esc(new Date(r.checked.at).toLocaleString('en-AU'))}</span>` : ''}
      <button class="btn primary" id="cu-ok" data-need="office">Checked</button></div></div>
    <div class="panel"><p style="margin-top:0">When this version first started it tidied up the stock records once. Nothing was thrown away:
      every change is listed here with what it was before and after${r.backup ? `, and a full copy of the data from just before is kept in <span class="mono small">${esc(r.backup)}</span>` : ''}.</p>
      <div class="tiles"><div class="tile"><div class="n">${total}</div><div class="l">Changes</div></div>
        <div class="tile ${flagged ? 'warn' : ''}"><div class="n">${flagged}</div><div class="l">Please check</div></div></div></div>
    <div class="panel flush">${r.steps.map(s => `<div class="report-step">
      <div class="row"><strong>${esc(s.label)}</strong><span class="muted small">${s.doneAt ? `${s.changes.length} change(s)${s.flagged.length ? `, ${s.flagged.length} to check` : ''}` : 'not run yet'}</span></div>
      ${s.flagged.length ? `<div style="margin-top:8px"><div class="small" style="color:var(--warn);font-weight:600">Please check</div>${table(s.flagged)}</div>` : ''}
      ${s.changes.length ? `<details style="margin-top:8px" ${s.changes.length <= 12 ? 'open' : ''}><summary class="small muted">Show the ${s.changes.length} change(s)</summary>${table(s.changes)}</details>` : ''}
    </div>`).join('')}</div>`;
  $('#cu-ok').onclick = async () => {
    if (!confirm(`Mark the clean-up report as checked by ${officeName()}?`)) return;
    await act(() => api('POST', '/api/tidy/checked'), 'Marked as checked');
    reload();
  };
}
