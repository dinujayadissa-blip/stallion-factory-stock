'use strict';
// Office "Factory floor" page: 2D map / 3D view / layout editor, van panel with what's missing,
// notes and reminders. Uses helpers from app.js (api, esc, modal, toast, act, …) at runtime.

let factoryView3d = null;     // the live 3D view, disposed when leaving the page
// Trades on the floor (same keys as src/trades.js).
const TRADE_NAMES = { electrician: '⚡ Electrician', builder: '🔨 Builder', cladding: '🧱 Aluminium & cladding', plumber: '🚿 Plumber', finisher: '✨ Finisher' };
let factoryState = { selected: null };

async function renderFactory() {
  const cam = factoryView3d?.dispose(); factoryView3d = null;
  if (cam) factoryState.cam = cam; // 3D camera, kept so a refresh doesn't spin the view back
  // Phone round 1 (C12): on a phone only the 2D map (3D view and Edit layout are hidden — three.js is heavy
  // for a cheap phone); on a touch screen a tap shows the van, and dragging vans is off until "Move vans".
  const phone = isPhone();
  const coarse = matchMedia('(pointer: coarse)').matches;
  let mode = sessionStorage.getItem('factoryMode') || '2d';
  if (phone && mode !== '2d') mode = '2d';
  if (mode === 'edit' && !can('layout')) mode = '2d'; // only the office edits the layout (logins and job roles)
  const moving = coarse && mode === '2d' && sessionStorage.getItem('factoryMove') === '1';
  // Moving vans: owner, office and leading hands; stores see the floor read-only.
  const canDrag = can('floor') && mode === '2d' && (!coarse || moving);
  const data = await api('GET', '/api/layout');
  const placed = new Set(data.areas.filter(a => FactoryMap.PARK.has(a.kind)).map(a => a.id));
  const unplaced = data.vans.filter(v => !placed.has(v.area_id));
  const parkCount = placed.size;
  // Phones: the bays as a list above the map, and a warning for vans in production that are not in a bay.
  const pctDone = v => v.total ? Math.round(v.done / v.total * 100) : 0;
  const bayNo = a => Number((/\d+/.exec(a.name) || [])[0] ?? 9999);
  const bays = data.areas.filter(a => a.kind === 'bay').sort((a, b) => bayNo(a) - bayNo(b) || a.name.localeCompare(b.name));
  const bayIds = new Set(bays.map(a => a.id));
  const notInBay = data.vans.filter(v => v.status === 'in_production' && !bayIds.has(v.area_id));
  const stillN = v => (v.still ? v.still.missing : v.missing) || 0;
  // Follow-up round 1 (owner-r3-4): each bay line and each van in the warning says how late it is ("31 days late",
  // red) or when it is due ("due in 12 days"); a planned van with a passed date says "date to check".
  const whenHtml = v => { const late = vanLateDays(v);
    if (late) return `<span class="late">${lateDaysText(late)}</span>`;
    if (dateToCheck(v)) return '<span class="dueflag">date to check</span>';
    if (!v.eta) return '<span class="muted">no due date</span>';
    const d = daysUntil(v.eta);
    return d === 0 ? '<span class="late">due today</span>' : `<span class="muted">due in ${d} day${d === 1 ? '' : 's'}</span>`; };
  const advBtn = '<button class="btn primary" id="advance" data-need="floor" title="Last bay goes out to the yard, every van moves one bay along, next chassis into Bay 1">Move the line along ▶</button>';

  app.innerHTML = `
    <div class="page-head"><h1>Factory floor</h1>
      <div class="seg" id="fmode">
        <button data-m="2d">2D map</button><button data-m="3d" class="no-phone">3D view</button><button data-m="edit" class="no-phone" data-need="layout">Edit layout</button></div>
      ${coarse && mode === '2d' ? `<button class="btn ${moving ? 'primary' : ''}" id="fmove" data-need="floor" aria-pressed="${moving}">${moving ? '✓ Done moving' : 'Move vans'}</button>` : ''}
      <div class="actions"><span class="small muted">${data.vans.length - unplaced.length} of ${parkCount} spots used</span>
        ${mode === 'edit' ? '' : phone ? `<details class="more-acts" data-need="floor"><summary class="btn">More actions ▾</summary><div class="more-acts-body">${advBtn}
          <div class="small muted">Shows what will move first — nothing changes until you confirm.</div></div></details>` : advBtn}</div></div>
    ${phone ? `<div class="panel bays-list"><h2>Bays</h2>
      ${notInBay.length ? `<div class="bays-warn">⚠ In production but not in a bay: ${notInBay.map(v => `<a href="#/vans/${v.id}" class="bw-van"><b>${esc(v.chassis)}</b> <span class="small">${whenHtml(v)}</span></a>`).join('')}</div>` : ''}
      ${bays.map(a => { const v = data.vans.find(x => x.area_id === a.id); return v
        ? `<a class="bay-row" href="#/vans/${v.id}"><span class="bay-n">${esc(a.name)}</span><span class="grow"><b>${esc(v.chassis)}</b>
            <span class="small"> · <span class="${stillN(v) ? 'still-n' : 'ok-text'}">${stillN(v)} still missing</span> · ${whenHtml(v)} · ${pctDone(v)}% fitted</span></span><span class="go-arrow" aria-hidden="true">›</span></a>`
        : `<div class="bay-row"><span class="bay-n">${esc(a.name)}</span><span class="grow muted small">empty</span></div>`; }).join('')}</div>` : ''}
    <div class="factory">
      <div class="panel flush fmap-wrap"><div id="fmap" class="fmap ${mode === '3d' ? 'is3d' : ''}"></div>
        ${mode === '2d' ? `<div class="fm-legend small muted"><span><i style="background:#d92d20"></i>parts not in factory</span>
          <span><i style="background:#e8890c"></i>reminder due</span><span><i style="background:#3aa66a"></i>progress</span>
          <span>${coarse ? (moving ? 'Drag a van onto a bay or yard space to move it' : 'Tap a van for details') : canDrag ? 'Drag a van to move it · click it for details' : 'Click a van for details'}</span></div>` : ''}
        ${mode === '3d' ? '<div class="fm-legend small muted"><span>Drag to spin · scroll / pinch to zoom · right-drag to pan · click a van for details</span></div>' : ''}
      </div>
      <div class="fside" id="fside"></div>
    </div>`;
  $$('#fmode button').forEach(b => {
    b.classList.toggle('on', b.dataset.m === mode);
    b.onclick = () => { sessionStorage.setItem('factoryMode', b.dataset.m); factoryState.selected = null; factoryView3d?.dispose(); factoryView3d = null; factoryState.cam = null; renderFactory(); };
  });

  const adv = $('#advance');
  if (adv) adv.onclick = () => advanceDialog(unplaced);
  const fmove = $('#fmove');
  if (fmove) fmove.onclick = () => { sessionStorage.setItem('factoryMove', moving ? '0' : '1'); refreshFactory(); };

  const highlight = Number(sessionStorage.getItem('factoryHighlight')) || null;
  sessionStorage.removeItem('factoryHighlight');
  const mapEl = $('#fmap');
  // On narrow screens the side panel sits under the map, off-screen: bring it into view after a click
  // (once the panel has loaded, so the page is tall enough to scroll to it).
  const showSide = () => { if (matchMedia('(max-width:1100px)').matches) $('#fside')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const handlers = {
    onVan: v => { factoryState.selected = { type: 'van', id: v.id }; redraw(); vanPanel(v.id).then(showSide); },
    onArea: a => { factoryState.selected = { type: 'area', id: a.id }; redraw(); Promise.resolve(mode === 'edit' ? editPanel(a) : areaPanel(a, data)).then(showSide); },
    onBackground: () => { factoryState.selected = null; redraw(); defaultPanel(); },
    onDropVan: async (vanId, areaId) => {
      try { await moveVanWithUndo(data, vanId, areaId); } catch (e) { toast(e.message, true); }
      factoryState.selected = { type: 'van', id: vanId };
      renderFactory();
    },
    onAreaChange: async a => {
      try { await api('PUT', `/api/layout/areas/${a.id}`, { x: a.x, y: a.y, w: a.w, h: a.h }); } catch (e) { toast(e.message, true); }
      factoryState.selected = { type: 'area', id: a.id };
      renderFactory();
    },
  };
  const redraw = () => {
    if (mode === '3d') return;
    FactoryMap.render(mapEl, data, { mode: mode === 'edit' ? 'edit' : canDrag ? 'view' : 'pick', selected: factoryState.selected, highlightArea: highlight, ...handlers });
  };

  if (mode === '3d') {
    try {
      const { mount } = await import('/floor3d.js');
      factoryView3d = await mount(mapEl, data, { ...handlers, cam: factoryState.cam });
    } catch (e) {
      mapEl.innerHTML = `<div class="empty">3D view couldn't start on this computer (${esc(e.message)}). Use the 2D map.</div>`;
    }
  } else redraw();

  // side panel
  function defaultPanel() {
    const side = $('#fside');
    if (mode === 'edit') {
      side.innerHTML = `<div class="panel"><h2>Edit layout</h2>
        <p class="muted small" style="margin-top:0">Drag things to move them. Click one, then drag its orange corner to resize. Sizes are in metres — a caravan bay is about 9 × 3.2.</p>
        <div class="row"><select id="newkind">${Object.entries(data.kinds).filter(([k]) => k !== 'building' || !data.areas.some(a => a.kind === 'building'))
          .map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select><button class="btn primary" id="addarea">Add</button></div></div>`;
      $('#addarea').onclick = e => busy(e.currentTarget, async () => {
        const kind = $('#newkind').value;
        const size = { bay: [9, 3.2], yard: [9, 3.2], office: [10, 6], storage: [1.6, 5], work: [6, 2.5], wall: [6, 0.3], gate_in: [1.2, 6], gate_out: [1.2, 6], building: [44, 22] }[kind];
        const bld = data.areas.find(a => a.kind === 'building') || { x: 0, y: 0, w: 40, h: 20 };
        const r = await act(() => api('POST', '/api/layout/areas', { kind, x: bld.x + bld.w / 2 - size[0] / 2, y: bld.y + bld.h / 2 - size[1] / 2, w: size[0], h: size[1] }));
        factoryState.selected = { type: 'area', id: r.id };
        await refreshFactory();
      });
      return;
    }
    const due = data.vans.filter(v => v.due);
    side.innerHTML = `
      <div class="panel"><h2>Not on the floor yet (${unplaced.length})</h2>
        <p class="muted small" style="margin-top:0">In build order (#1 first). ${!can('floor') ? 'Click a van to see it.' : coarse ? 'Tap a van to place it.' : mode === '2d' ? 'Drag a van onto a bay or yard space, or click it.' : 'Click a van to place it.'}</p>
        <div class="unplaced">${unplaced.map(v => `<div class="uvan" draggable="${!coarse && canDrag}" data-id="${v.id}">${v.build_pos ? `<span class="small muted" title="Place in the build order">#${v.build_pos}</span> ` : ''}<b>${esc(v.chassis)}</b>
          <span class="small muted">${esc(v.length)} ${esc(v.model)}${v.eta ? ` · due ${fmtDate(v.eta)}` : ''}</span>${dueFlag(v) ? ` ${dueFlag(v)}` : ''}</div>`).join('') || '<div class="muted small">Every van is placed.</div>'}</div></div>
      ${due.length ? `<div class="panel"><h2>Reminders due</h2>${due.map(v => `<div class="uvan" data-id="${v.id}"><b>${esc(v.chassis)}</b><span class="small" style="color:var(--warn)">${v.due} due</span></div>`).join('')}</div>` : ''}`;
    $$('.uvan', side).forEach(d => {
      d.ondragstart = e => { e.dataTransfer.setData('text/van', d.dataset.id); e.dataTransfer.effectAllowed = 'move'; };
      d.onclick = () => handlers.onVan(data.vans.find(v => v.id === Number(d.dataset.id)));
    });
  }

  async function vanPanel(vanId) {
    const side = $('#fside');
    side.innerHTML = '<div class="panel empty">Loading…</div>';
    const f = await api('GET', `/api/vans/${vanId}/floor`);
    const v = f.van;
    const pct = f.total ? Math.round(f.done / f.total * 100) : 0;
    const spots = data.areas.filter(a => FactoryMap.PARK.has(a.kind));
    const occupant = id => data.vans.find(x => x.area_id === id && x.id !== v.id);
    const today = localToday();
    // Round 2 phone batch 1 (owner-r1-2): the card leads with the badge's number and how late the van is.
    const miss = v.still ? v.still.missing : 0;
    const lateDays = vanLateDays(v); // a planned van with a passed date is a "date to check", not late (owner-r3-1)
    // owner-r1-3: on a touch screen "Move" sits under More actions and asks first (a stray tap on the
    // drop-down used to swap two vans at once); with a mouse it stays where it was. Both show Undo after.
    const touch = phone || coarse;
    const moveSel = `<select id="vmove" class="grow"><option value="">${v.area_name ? `Move from ${esc(v.area_name)} to…` : 'Place on the floor…'}</option>
            ${spots.map(a => { const o = occupant(a.id); return `<option value="${a.id}" ${a.id === v.area_id ? 'disabled' : ''}>${esc(a.name)}${o ? ` (swap with ${esc(o.chassis)})` : ''}</option>`; }).join('')}
            ${v.area_id ? '<option value="off">Take off the map</option>' : ''}</select>`;
    side.innerHTML = `
      <div class="panel">
        <div class="row"><h2 style="margin:0"><a href="#/vans/${v.id}">${esc(v.chassis)}</a></h2>${chip(v.status)}<span class="grow"></span>
          <button class="btn small link" id="vclose">Close</button></div>
        <div class="muted small" style="margin:4px 0 8px">${esc(v.length)} ${esc(v.model)}${v.customer ? ` · ${esc(v.customer)}` : ''}${v.eta ? ` · due ${fmtDate(v.eta)}` : ''}</div>
        <div class="fv-still ${miss ? 'still-n' : 'ok-text'}">${miss ? `${miss} still missing` : 'Nothing missing'}${lateDays ? ` · ${lateDaysText(lateDays)}` : ''}${dateToCheck(v) ? ` · ${dueFlag(v)}` : ''}</div>
        <div class="small muted fv-fit-l">Fitted so far</div>
        <div class="bar" style="height:10px"><i class="g" style="width:${pct}%"></i></div>
        <div class="small muted" style="margin-top:4px">${f.done} of ${f.total} parts fitted (${pct}%)${f.reminderLines
          ? ` · not counting ${f.reminderLines} customer supplies / to be decided` : ''}</div>
        ${touch ? '' : `<div class="row" style="margin-top:12px" data-need="floor">${moveSel}</div>`}
        ${touch ? `<div class="row" style="margin-top:10px"><a class="btn small" href="#/vans/${v.id}">Full parts list</a></div>
          <details class="more-acts" style="margin-top:8px" data-need="floor"><summary class="btn small">More actions ▾</summary><div class="more-acts-body">
            <label class="field small">Move this van${moveSel}</label>
            <button class="btn small" id="vleave">Gone out the gate (finished)</button>
            <button class="btn small" id="vfitted" data-need="office">Already fitted…</button></div></details>`
          : `<div class="row" style="margin-top:8px"><button class="btn small" id="vleave" data-need="floor">Gone out the gate (finished)</button>
          <a class="btn small" href="#/vans/${v.id}">Full parts list</a>
          <button class="btn small" id="vfitted" data-need="office" title="Tick parts that were put in before the system was used">Already fitted…</button></div>`}
      </div>
      <div class="panel"><h3>Reminders</h3>
        <div id="rlist">${f.reminders.map(r => `<div class="rem fv-rem ${r.done ? 'done' : ''}" data-id="${r.id}">
          <label class="rem-tick"><input type="checkbox" ${r.done ? 'checked' : ''} aria-label="Done"></label>
          <div class="grow"><div class="rem-text" title="Tap to see it all">${esc(r.text)}</div><div class="small ${!r.done && r.due && r.due <= today ? 'overdue' : 'muted'}">${r.due ? fmtDate(r.due) : 'no date'}${r.worker ? ` · ${esc(r.worker)}` : ''}
            · ${r.trade && TRADE_NAMES[r.trade] ? esc(TRADE_NAMES[r.trade]) : 'Everyone'}</div></div>
          <button type="button" class="rem-del" data-del data-need="floor" title="Delete this reminder" aria-label="Delete this reminder">×</button></div>`).join('') || '<div class="muted small">No reminders.</div>'}</div>
        <form id="radd" class="row" style="margin-top:8px" data-need="floor"><input type="text" name="text" class="grow" placeholder="e.g. Chase cladding from Probond">
          <input type="date" name="due" value="">
          <select name="trade" title="Who sees it on the worker screen"><option value="">Everyone</option>
            ${Object.entries(TRADE_NAMES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
          <button class="btn small primary">Add</button></form></div>
      <div class="panel"><h3>Notes</h3>
        <form id="nadd"><textarea name="text" rows="2" placeholder="Write a note for this van…"></textarea>
          <div class="row" style="margin-top:6px"><span class="grow"></span><button class="btn small primary">Add note</button></div></form>
        <div id="nlist">${f.notes.map(n => `<div class="note-item" data-id="${n.id}"><div>${esc(n.text).replace(/\n/g, '<br>')}</div>
          <div class="small muted">${esc(n.created_at.slice(0, 16))}${n.worker ? ` · ${esc(n.worker)}` : ''} <button class="btn small link" data-del data-need="floor">delete</button></div></div>`).join('') || '<div class="muted small">No notes yet.</div>'}</div></div>
      <div class="panel"><h3>Not in the factory yet (${f.notInFactory.length})</h3>
        ${f.notInFactory.length ? `<div class="miss">${f.notInFactory.map(l => `<div class="mi">${thumbImg(l.photo, 32)}<div class="grow"><div>${esc(l.name)}</div>
          <div class="small muted">${q(l.qty - l.reserved - l.issued)} ${esc(l.unit)} needed${l.on_order ? ' · <span style="color:var(--info)">on order</span>' : ' · <span style="color:var(--bad)">not ordered</span>'}</div></div></div>`).join('')}</div>` : '<div class="muted small">Everything is here. 👍</div>'}
        <details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">In stock, waiting to be fitted (${f.readyToFit.length})</summary>
          <div class="miss" style="margin-top:6px">${f.readyToFit.map(l => `<div class="mi">${thumbImg(l.photo, 32)}<div class="grow"><div>${esc(l.name)}</div>
            <div class="small muted">${q(l.qty - l.issued)} ${esc(l.unit)}${l.area_name ? ` · ${esc(l.area_name)}` : l.location ? ` · ${esc(l.location)}` : ''}</div></div></div>`).join('')}</div></details>
      </div>`;
    // Re-render the page; the selection brings this panel back.
    const refresh = () => { factoryState.selected = { type: 'van', id: vanId }; return refreshFactory(); };
    $('#vclose').onclick = () => handlers.onBackground();
    $('#vfitted').onclick = () => alreadyFittedDialog(v.id, refresh);
    $('#vmove').onchange = async e => {
      const val = e.target.value;
      if (!val) return;
      const to = val === 'off' ? null : Number(val);
      if (touch && !confirm(moveQuestion(data, v, to))) { e.target.value = ''; return; }
      try { await moveVanWithUndo(data, v.id, to); } catch (err) { toast(err.message, true); }
      refresh();
    };
    $('#vleave').onclick = e => {
      if (!confirm(`${v.chassis} has left the factory? It's marked finished, taken off the map, and parts still set aside for it are counted as used.`)) return;
      return busy(e.currentTarget, async () => {
        await act(() => api('POST', `/api/vans/${v.id}/leave`), `${v.chassis} finished`);
        factoryState.selected = null;
        await refreshFactory();
      });
    };
    $('#radd').onsubmit = e => {
      e.preventDefault();
      const fd = formData(e.target);
      if (!fd.text.trim()) return;
      return busy($('button', e.target), async () => {
        await act(() => api('POST', '/api/reminders', { van_id: v.id, text: fd.text, due: fd.due, trade: fd.trade }), 'Reminder added');
        await refresh();
      });
    };
    $$('#rlist .rem').forEach(r => {
      $('.rem-text', r).onclick = e => e.currentTarget.classList.toggle('open'); // long reminders: 2 lines until tapped (owner-r3-6)
      $('input', r).onchange = async e => { await act(() => api('PUT', `/api/reminders/${r.dataset.id}`, { done: e.target.checked })); refresh(); };
      $('[data-del]', r).onclick = async () => { if (!confirm('Delete this reminder?')) return; await act(() => api('DELETE', `/api/reminders/${r.dataset.id}`)); refresh(); };
    });
    $('#nadd').onsubmit = e => {
      e.preventDefault();
      const text = e.target.text.value;
      if (!text.trim()) return;
      return busy($('button', e.target), async () => {
        await act(() => api('POST', `/api/vans/${v.id}/notes`, { text }), 'Note added'); // saved under the login's name
        await refresh();
      });
    };
    $$('#nlist .note-item').forEach(n => {
      $('[data-del]', n).onclick = async () => { if (!confirm('Delete this note?')) return; await act(() => api('DELETE', `/api/notes/${n.dataset.id}`)); refresh(); };
    });
  }

  async function areaPanel(a) {
    const side = $('#fside');
    if (FactoryMap.PARK.has(a.kind)) {
      const v = data.vans.find(x => x.area_id === a.id);
      if (v) return vanPanel(v.id);
      side.innerHTML = `<div class="panel"><div class="row"><h2 style="margin:0">${esc(a.name)}</h2><span class="grow"></span><button class="btn small link" id="aclose">Close</button></div>
        <p class="muted">Empty.<span data-need="floor"> Put a van here:</span></p>
        <select id="aput" style="width:100%" data-need="floor"><option value="">Choose a van…</option>${data.vans.map(x => `<option value="${x.id}">${esc(x.chassis)} — ${esc(x.model)}${x.area_id ? ' (moves it)' : ''}</option>`).join('')}</select></div>`;
      $('#aclose').onclick = () => handlers.onBackground();
      $('#aput').onchange = e => {
        if (!e.target.value) return;
        const mv = data.vans.find(x => x.id === Number(e.target.value));
        // a van already on the floor moves away from its spot: ask first on a touch screen (owner-r1-3)
        if (coarse && mv?.area_id && !confirm(moveQuestion(data, mv, a.id))) { e.target.value = ''; return; }
        handlers.onDropVan(Number(e.target.value), a.id);
      };
      return;
    }
    side.innerHTML = '<div class="panel empty">Loading…</div>';
    const r = await api('GET', `/api/layout/areas/${a.id}/items`);
    side.innerHTML = `<div class="panel"><div class="row"><h2 style="margin:0">${esc(a.name)}</h2><span class="grow"></span><button class="btn small link" id="aclose">Close</button></div>
      <p class="muted small">${r.items.length} item(s) stored here.</p>
      <div class="miss">${r.items.map(i => `<div class="mi" data-id="${i.id}">${thumbImg(i.photo, 32)}<div class="grow"><div>${esc(i.name)}</div>
        <div class="small muted">${q(i.on_hand)} ${esc(i.unit)} on hand${i.location ? ` · ${esc(i.location)}` : ''}</div></div>
        <button class="btn small link" data-rm data-need="stock" title="Not stored here">×</button></div>`).join('')}</div>
      <div style="margin-top:10px" data-need="stock"><label class="field">Add items stored here${itemPicker('additem')}</label>
        <div class="row" style="margin-top:6px"><input type="text" id="addloc" placeholder="Shelf / bin (optional), e.g. Shelf 3" class="grow"><button class="btn small primary" id="addbtn">Add</button></div></div></div>`;
    await items(); fillItemDatalist();
    $('#aclose').onclick = () => handlers.onBackground();
    $('#addbtn').onclick = async () => {
      const id = pickedItemId($('[name=additem]'));
      if (!id) return toast('Pick an item from the list', true);
      const body = { area_id: a.id };
      if ($('#addloc').value.trim()) body.location = $('#addloc').value.trim();
      await act(() => api('PUT', `/api/items/${id}`, body), 'Item located');
      itemsCache = null;
      data.itemCounts[a.id] = (data.itemCounts[a.id] || 0) + 1;
      const y = window.scrollY;
      redraw(); await areaPanel(a);
      window.scrollTo(0, y);
    };
    $$('[data-rm]', side).forEach(b => b.onclick = async () => {
      await act(() => api('PUT', `/api/items/${b.closest('.mi').dataset.id}`, { area_id: null }));
      itemsCache = null; refreshFactory();
    });
  }

  function editPanel(a) {
    const side = $('#fside');
    side.innerHTML = `<div class="panel"><div class="row"><h2 style="margin:0">Edit ${esc(a.name)}</h2><span class="grow"></span><button class="btn small link" id="eclose">Close</button></div>
      <form id="aform" class="form-grid" style="margin-top:10px">
        <label class="field" style="grid-column:1/-1">Name<input type="text" name="name" value="${esc(a.name)}"></label>
        <label class="field" style="grid-column:1/-1">Type<select name="kind">${Object.entries(data.kinds).map(([k, l]) => `<option value="${k}" ${k === a.kind ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="field">From left (m)<input type="number" step="0.25" name="x" value="${a.x}"></label>
        <label class="field">From top (m)<input type="number" step="0.25" name="y" value="${a.y}"></label>
        <label class="field">Width (m)<input type="number" step="0.25" min="0.3" name="w" value="${a.w}"></label>
        <label class="field">Depth (m)<input type="number" step="0.25" min="0.3" name="h" value="${a.h}"></label>
      </form>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="asave">Save</button><button class="btn" id="arot">Turn 90°</button>
        <span class="grow"></span><button class="btn danger" id="adel">Delete</button></div></div>`;
    $('#eclose').onclick = () => handlers.onBackground();
    const btns = () => [$('#asave'), $('#arot'), $('#adel')];
    const save = body => busy(btns(), async () => { await act(() => api('PUT', `/api/layout/areas/${a.id}`, body), 'Saved'); await refreshFactory(); });
    $('#asave').onclick = () => save(formData($('#aform')));
    $('#arot').onclick = () => save({ x: a.x + (a.w - a.h) / 2, y: a.y + (a.h - a.w) / 2, w: a.h, h: a.w });
    $('#adel').onclick = () => {
      if (!confirm(`Delete ${a.name}? Vans parked here go back to "not on the floor"; items stored here lose their location.`)) return;
      return busy(btns(), async () => {
        await act(() => api('DELETE', `/api/layout/areas/${a.id}`), 'Deleted');
        factoryState.selected = null; await refreshFactory();
      });
    };
  }

  // restore selection after a redraw (waited for, so a refresh can put the scroll back once the panel is full height)
  const sel = factoryState.selected;
  try {
    if (sel?.type === 'van' && data.vans.some(v => v.id === sel.id)) await vanPanel(sel.id);
    else if (sel?.type === 'area') { const a = data.areas.find(x => x.id === sel.id); await (a ? (mode === 'edit' ? editPanel(a) : areaPanel(a)) : defaultPanel()); }
    else if (highlight) { const a = data.areas.find(x => x.id === highlight); await (a ? areaPanel(a) : defaultPanel()); }
    else defaultPanel();
  } catch (e) {
    // Keep the map on screen if only the side panel failed to load.
    const side = $('#fside');
    if (side) side.innerHTML = `<div class="panel empty">Couldn't load this: ${esc(e.message)}</div>`;
  }
}

// Re-render the floor page but keep the scroll where it was. On a tablet the side panel sits under
// the map, and a plain re-render briefly shortens the page so the browser jumps back up.
// Round 2 phone batch 1 (owner-r1-3): "Swap ST0367 (Bay 3) with ST0386 (Bay 4)?" before a move on a touch
// screen, and every move from the van card / drag / "put a van here" shows an Undo message afterwards.
function moveQuestion(data, v, toId) {
  const name = id => data.areas.find(a => a.id === id)?.name || 'off the map';
  const from = v.area_id ? name(v.area_id) : '';
  if (toId == null) return `Take ${v.chassis}${from ? ` (${from})` : ''} off the map?`;
  const other = data.vans.find(x => x.area_id === toId && x.id !== v.id);
  if (other) return from ? `Swap ${v.chassis} (${from}) with ${other.chassis} (${name(toId)})?`
    : `Put ${v.chassis} in ${name(toId)}? ${other.chassis} comes off the map.`;
  return from ? `Move ${v.chassis} from ${from} to ${name(toId)}?` : `Put ${v.chassis} in ${name(toId)}?`;
}
async function moveVanWithUndo(data, vanId, toId) {
  const v = data.vans.find(x => x.id === vanId) || { id: vanId, chassis: 'Van', area_id: null };
  const from = v.area_id ?? null;
  const other = toId != null ? data.vans.find(x => x.area_id === toId && x.id !== vanId) : null;
  const toArea = data.areas.find(a => a.id === toId);
  const r = await api('POST', `/api/vans/${vanId}/move`, { area_id: toId });
  const msg = toId == null ? `${v.chassis} taken off the map` : `${v.chassis} → ${toArea?.name || 'moved'}${r.swapped ? ` (swapped with ${r.swapped})` : ''}`;
  toastUndo(msg, async () => {
    // back to its old spot (a swap swaps back); a van that came off the map for it goes back too
    await api('POST', `/api/vans/${vanId}/move`, { area_id: from });
    if (other && from == null) await api('POST', `/api/vans/${other.id}/move`, { area_id: toId });
    // a planned van put in a bay was marked "in production" by the move
    if (v.status === 'planned' && toArea?.kind === 'bay') await api('PUT', `/api/vans/${vanId}`, { status: 'planned' });
    factoryState.selected = { type: 'van', id: vanId };
    if (location.hash === '#/factory') await refreshFactory();
  });
  return r;
}

async function refreshFactory() {
  const y = window.scrollY;
  await renderFactory();
  window.scrollTo(0, y);
}

// "Move the line along": show exactly what will move, pick the next chassis for Bay 1, confirm.
async function advanceDialog(unplaced) {
  // In build order (owner-r3-1): the server lists the vans that way, so a planned van whose date has passed
  // ("Date passed – check") is no longer offered first just because of its old date.
  const waiting = [...unplaced];
  const m = modal('Move the line along', `
    <p class="muted" style="margin-top:0">The van in the last bay goes out to the yard and every van moves forward one bay.</p>
    <label class="field">Next chassis into the first bay<select id="adv-next">
      <option value="">— leave the first bay empty —</option>
      ${waiting.map((v, i) => `<option value="${v.id}" ${i === 0 ? 'selected' : ''}>${v.build_pos ? `#${v.build_pos} ` : ''}${esc(v.chassis)} — ${esc(v.length)} ${esc(v.model)}${v.eta ? ` (due ${fmtDate(v.eta)}${dateToCheck(v) ? ' – date to check' : ''})` : ''}</option>`).join('')}</select></label>
    <div id="adv-moves" style="margin-top:14px"></div>`,
    { footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="adv-go">Move them</button>' });
  $('[data-close]', m.el).onclick = m.close;
  let expected = null; // the moves shown, so the server can refuse if the line has moved since
  const preview = async () => {
    const next = $('#adv-next', m.el).value;
    expected = null;
    try {
      const p = await api('GET', `/api/layout/advance${next ? `?next=${next}` : ''}`);
      expected = p.moves;
      $('#adv-moves', m.el).innerHTML = p.moves.length
        ? `<table><tbody>${p.moves.map(x => `<tr><td><b>${esc(x.chassis)}</b></td><td class="muted">${esc(x.from || 'not on the floor')}</td><td>→</td><td><b>${esc(x.to)}</b></td></tr>`).join('')}</tbody></table>`
        : '<div class="muted">Nothing to move.</div>';
      $('#adv-go', m.el).disabled = !p.moves.length;
    } catch (e) {
      $('#adv-moves', m.el).innerHTML = `<div class="banner" style="margin:0">${esc(e.message)}</div>`;
      $('#adv-go', m.el).disabled = true;
    }
  };
  $('#adv-next', m.el).onchange = preview;
  await preview();
  $('#adv-go', m.el).onclick = () => busy([$('#adv-go', m.el), $('#adv-next', m.el)], async () => {
    const next = $('#adv-next', m.el).value;
    await act(() => api('POST', '/api/layout/advance', { next_van_id: next || null, expect: expected }), 'Line moved along');
    m.close();
    factoryState.selected = null;
    renderFactory();
  });
}

// Leaving the page: stop the 3D renderer.
window.addEventListener('hashchange', () => { if (location.hash !== '#/factory') { factoryView3d?.dispose(); factoryView3d = null; factoryState.cam = null; } });
