'use strict';
// Top-down 2D factory map (SVG), shared by the office and worker screens. Units are metres.
//   FactoryMap.render(container, layout, {
//     mode: 'view' | 'edit' | 'pick',  // view: click + drag vans; edit: move/resize areas; pick: tap only
//     selected: {type:'van'|'area', id}, highlightArea: id,
//     onVan(van), onArea(area), onDropVan(vanId, areaId), onAreaChange(area), onBackground(),
  //     bigTags, minTap, pinchZoom   // the worker's phone map (worker-r3-6): bigger tags, 44px+ taps, pinch zoom
//   })
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const STYLE = {
    building: { fill: 'url(#fm-concrete)', stroke: '#5b6470', sw: 0.25 },
    bay: { fill: 'rgba(255,214,0,0.07)', stroke: '#d9a900', sw: 0.18, dash: '0.6 0.35' },
    yard: { fill: '#e7eee2', stroke: '#7d9a6c', sw: 0.15, dash: '0.6 0.35' },
    gate_in: { fill: '#2e8b4e', stroke: '#1d6336', sw: 0.1, text: '#fff' },
    gate_out: { fill: '#1f5fa8', stroke: '#164a85', sw: 0.1, text: '#fff' },
    office: { fill: '#f1ebe1', stroke: '#512b1a', sw: 0.15, text: '#512b1a' },
    storage: { fill: '#d4e4f7', stroke: '#2f6db5', sw: 0.12 },
    work: { fill: '#ecdcc0', stroke: '#9a7a45', sw: 0.12 },
    wall: { fill: '#6b7380', stroke: '#4c535d', sw: 0.08 },
  };
  const PARK = new Set(['bay', 'yard']);
  const center = a => ({ x: a.x + a.w / 2, y: a.y + a.h / 2 });

  // The production flow: chassis-in gate → Bay 1 → Bay 2 … → van-out gate. Each bay's angle
  // points along the flow (snapped to the bay's long side), so vans face the way they move.
  function flow(areas) {
    const num = a => Number((/\d+/.exec(a.name) || [])[0] ?? 9999);
    const bays = areas.filter(a => a.kind === 'bay').sort((a, b) => num(a) - num(b) || a.id - b.id);
    const gin = areas.find(a => a.kind === 'gate_in'), gout = areas.find(a => a.kind === 'gate_out');
    const path = [gin, ...bays, gout].filter(Boolean).map(center);
    const angles = new Map();
    bays.forEach((b, i) => {
      const c = center(b), next = i + 1 < bays.length ? center(bays[i + 1]) : gout ? center(gout) : null;
      const prev = i > 0 ? center(bays[i - 1]) : gin ? center(gin) : null;
      const dx = next ? next.x - c.x : prev ? c.x - prev.x : 1, dy = next ? next.y - c.y : prev ? c.y - prev.y : 0;
      angles.set(b.id, b.w >= b.h ? (dx >= 0 ? 0 : 180) : (dy >= 0 ? 90 : -90));
    });
    for (const a of areas) if (!angles.has(a.id)) angles.set(a.id, a.w >= a.h ? 0 : 90);
    return { path, angles };
  }
  const SNAP = 0.25;
  const snap = v => Math.round(v / SNAP) * SNAP;
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };

  function bounds(areas) {
    if (!areas.length) return { x: 0, y: 0, w: 40, h: 20 };
    const xs = areas.flatMap(a => [a.x, a.x + a.w]), ys = areas.flatMap(a => [a.y, a.y + a.h]);
    const x = Math.min(...xs) - 1.5, y = Math.min(...ys) - 1.5;
    return { x, y, w: Math.max(...xs) - x + 1.5, h: Math.max(...ys) - y + 1.5 };
  }

  // Top-down picture of a Stallion caravan (generated with Runway from the stallioncaravans.com.au
  // photos). Body runs from 4% to 72.5% of the image width; the A-frame points right (+x).
  const VAN_TOP = { href: '/assets/van-top.png', aspect: 4.204, body0: 0.04, body1: 0.725 };

  // Van drawn from above: the real roof picture pointing the way it moves, an upright chassis
  // label, progress bar, badges.
  // `big` (follow-up round 1, worker-r3-6): the worker's phone map, fitted to the screen — the chassis tag is
  // 1.6× bigger, the small "% fitted" line is left off, and the badges sit on the tag's top-right corner (so a
  // tag never runs into the next yard spot's). Returns the van's group and the box its tag + spot cover.
  function drawVan(g, van, area, selected, angle, big = false) {
    const horizontal = area.w >= area.h;
    const span = (horizontal ? area.w : area.h) - 0.3, depth = (horizontal ? area.h : area.w) - 0.7;
    let L = Math.min(span, 9.2), W = L / VAN_TOP.aspect;
    if (W > depth) { W = depth; L = W * VAN_TOP.aspect; }
    const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
    const vg = el('g', { class: 'fm-van', 'data-van': van.id, transform: `translate(${cx} ${cy})`, style: 'cursor:pointer' }, g);
    const body = el('g', { transform: `rotate(${angle})` }, vg);
    const bodyX0 = -L / 2 + VAN_TOP.body0 * L, bodyL = (VAN_TOP.body1 - VAN_TOP.body0) * L, bodyMid = bodyX0 + bodyL / 2;
    if (selected) el('rect', { x: -L / 2 - 0.18, y: -W / 2 - 0.18, width: L + 0.36, height: W + 0.36, rx: 0.3, fill: 'rgba(232,89,12,0.12)', stroke: '#e8590c', 'stroke-width': 0.22 }, body);
    el('image', { href: VAN_TOP.href, x: -L / 2, y: -W / 2, width: L, height: W, preserveAspectRatio: 'none' }, body);
    const pct = van.total ? van.done / van.total : 0;
    // progress bar along the side of the van
    el('rect', { x: bodyX0, y: W / 2 + 0.1, width: bodyL, height: 0.24, rx: 0.12, fill: 'rgba(0,0,0,0.18)' }, body);
    if (pct > 0) el('rect', { x: bodyX0, y: W / 2 + 0.1, width: bodyL * pct, height: 0.24, rx: 0.12, fill: '#2f9e5b' }, body);
    // upright chassis label over the middle of the body
    const r = angle * Math.PI / 180, mx = bodyMid * Math.cos(r), my = bodyMid * Math.sin(r);
    const k = big ? 1.6 : 1;
    const pillW = Math.max(3, van.chassis.length * 0.6 + 0.9) * k, pillH = 1.44 * k;
    el('rect', { x: mx - pillW / 2, y: my - pillH / 2, width: pillW, height: pillH, rx: 0.5 * k, fill: 'rgba(255,255,255,0.93)', stroke: '#2b3440', 'stroke-width': 0.05 * k }, vg);
    const t = el('text', { x: mx, y: big ? my + 0.3 * k : my + 0.02, 'text-anchor': 'middle', 'font-size': 0.82 * k, 'font-weight': 800, fill: '#16202b' }, vg);
    t.textContent = van.chassis;
    if (!big) {
      const s = el('text', { x: mx, y: my + 0.55, 'text-anchor': 'middle', 'font-size': 0.42, fill: '#5b6673' }, vg);
      s.textContent = `${Math.round(pct * 100)}% fitted`; // parts fitted, not the whole van (owner-r3-4)
    }
    // Badges, upright, just right of the label (big: on the tag's top-right corner, side by side leftwards)
    let bx = big ? mx + pillW / 2 - 0.2 : mx + pillW / 2 + 0.2, by = big ? my - pillH / 2 - 0.2 * k : my - 0.72;
    const badge = (fill, label) => {
      const b = el('g', { transform: `translate(${bx} ${by})` }, vg);
      el('circle', { r: 0.55 * k, fill, stroke: '#fff', 'stroke-width': 0.1 * k }, b);
      const bt = el('text', { 'text-anchor': 'middle', y: (label.length > 2 ? 0.15 : 0.2) * k, 'font-size': (label.length > 2 ? 0.42 : 0.6) * k, 'font-weight': 800, fill: '#fff' }, b);
      bt.textContent = label;
      if (big) bx -= 1.2 * k; else by += 1.2;
    };
    if (van.missing) badge('#d92d20', van.missing > 99 ? '99+' : String(van.missing));
    if (van.due) badge('#e8890c', '!');
    else if (van.reminders) badge('#8a94a3', String(van.reminders));
    const title = el('title', {}, vg);
    title.textContent = `${van.chassis} — ${van.length} ${van.model}\n${van.done}/${van.total} parts fitted · ${van.still ? van.still.missing : van.missing} ${van.still ? 'still missing' : 'left to fit'}${van.reminders ? ` · ${van.reminders} reminder(s)` : ''}`;
    // What a tap on this van may cover: its parking spot and its tag (worker-r3-6, see `minTap` in render)
    vg.fmHit = { van, x0: Math.min(area.x, cx + mx - pillW / 2), y0: Math.min(area.y, cy + my - pillH / 2),
      x1: Math.max(area.x + area.w, cx + mx + pillW / 2), y1: Math.max(area.y + area.h, cy + my + pillH / 2) };
    return vg;
  }

  function render(container, data, opts = {}) {
    const mode = opts.mode || 'view';
    container.innerHTML = '';
    const b = bounds(data.areas);
    // Pick mode (phones) only taps, so a finger swipe on the map still scrolls the page / the map box.
    // `pinchZoom` (worker-r3-6): two fingers zoom the page in on the fitted phone map.
    const touch = mode === 'pick' ? (opts.pinchZoom ? 'pan-x pan-y pinch-zoom' : 'pan-x pan-y') : 'none';
    const svg = el('svg', { viewBox: `${b.x} ${b.y} ${b.w} ${b.h}`, width: '100%', class: 'fm-svg', style: `display:block;touch-action:${touch};user-select:none;font-family:Inter,Segoe UI,system-ui,sans-serif` }, container);
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: '#ece6dc' }, svg);
    // Concrete floor texture for the building (generated with Runway), 6 m tiles.
    const defs = el('defs', {}, svg);
    const conc = el('pattern', { id: 'fm-concrete', width: 6, height: 6, patternUnits: 'userSpaceOnUse' }, defs);
    el('image', { href: '/assets/concrete.png', width: 6, height: 6, preserveAspectRatio: 'none' }, conc);
    // 1 m grid in edit mode
    if (mode === 'edit') {
      const pat = el('pattern', { id: 'fm-grid', width: 1, height: 1, patternUnits: 'userSpaceOnUse' }, svg.querySelector('defs') || el('defs', {}, svg));
      el('path', { d: 'M 1 0 L 0 0 0 1', fill: 'none', stroke: '#cdd3da', 'stroke-width': 0.03 }, pat);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'url(#fm-grid)' }, svg);
    }
    const order = ['building', 'yard', 'bay', 'office', 'work', 'storage', 'wall', 'gate_in', 'gate_out'];
    const areas = [...data.areas].sort((a, c) => order.indexOf(a.kind) - order.indexOf(c.kind));
    const areaEls = new Map();
    for (const a of areas) {
      const st = STYLE[a.kind] || STYLE.work;
      const g = el('g', { class: 'fm-area', 'data-area': a.id, style: mode === 'edit' || a.kind === 'storage' || PARK.has(a.kind) ? 'cursor:pointer' : '' }, svg);
      const hl = opts.highlightArea === a.id;
      const sel = opts.selected?.type === 'area' && opts.selected.id === a.id;
      el('rect', { x: a.x, y: a.y, width: a.w, height: a.h, rx: a.kind === 'building' ? 0.2 : 0.15, fill: hl ? '#ffe066' : st.fill,
        stroke: sel ? '#e8590c' : hl ? '#e8590c' : st.stroke, 'stroke-width': sel || hl ? 0.3 : st.sw, 'stroke-dasharray': st.dash }, g);
      if (a.kind !== 'building' && a.kind !== 'wall') {
        const park = PARK.has(a.kind);
        const vertical = !park && a.h > a.w * 1.6;
        // Bay / yard names sit just above the spot so a parked van doesn't hide them.
        const tx = vertical ? a.x + a.w / 2 : a.x + 0.3, ty = vertical ? a.y + a.h / 2 : park ? a.y - 0.18 : a.y + 0.75;
        const fs = park ? 0.6 : Math.min(0.75, Math.max(0.35, Math.min(a.w, a.h) * 0.33));
        const label = el('text', { x: tx, y: ty, 'font-size': fs, 'font-weight': 600, fill: st.text || '#3c4652',
          'text-anchor': vertical ? 'middle' : 'start', transform: vertical ? `rotate(-90 ${tx} ${ty})` : null, 'pointer-events': 'none' }, g);
        label.textContent = (a.kind === 'gate_in' || a.kind === 'gate_out') ? `${a.name} ▶` : a.name;
        if (a.kind === 'storage' && data.itemCounts?.[a.id]) {
          const n = el('text', { x: vertical ? tx + fs * 1.2 : tx, y: vertical ? ty : ty + fs * 1.1, 'font-size': fs * 0.75, fill: '#2f6db5',
            'text-anchor': vertical ? 'middle' : 'start', transform: vertical ? `rotate(-90 ${tx + fs * 1.2} ${ty})` : null, 'pointer-events': 'none' }, g);
          n.textContent = `${data.itemCounts[a.id]} items`;
        }
      } else if (a.kind === 'building' && a.name) {
        const label = el('text', { x: a.x + 0.4, y: a.y - 0.35, 'font-size': 0.8, 'font-weight': 700, fill: '#5b6470' }, g);
        label.textContent = a.name;
      }
      if (mode === 'edit' && sel) {
        el('rect', { class: 'fm-resize', x: a.x + a.w - 0.45, y: a.y + a.h - 0.45, width: 0.9, height: 0.9, fill: '#e8590c', style: 'cursor:nwse-resize' }, g);
      }
      areaEls.set(a.id, g);
    }
    const byId = new Map(data.areas.map(a => [a.id, a]));
    const fl = flow(data.areas);
    // Flow arrows: in the left door, round the bays, out the right door.
    if (mode !== 'edit' && fl.path.length > 1) {
      const defs = svg.querySelector('defs');
      const mk = el('marker', { id: 'fm-arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto' }, defs);
      el('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: '#e8890c' }, mk);
      const pts = [];
      fl.path.forEach((p, i) => {
        if (i) { const q = fl.path[i - 1]; pts.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }); }
        pts.push(p);
      });
      el('polyline', { points: pts.map(p => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: '#e8890c', 'stroke-width': 0.18,
        'stroke-dasharray': '0.7 0.45', 'stroke-linejoin': 'round', opacity: 0.85, 'marker-mid': 'url(#fm-arrow)', 'pointer-events': 'none' }, svg);
    }
    const vanLayer = el('g', {}, svg);
    const vanHits = [];
    if (mode !== 'edit') {
      for (const v of data.vans) {
        const a = byId.get(v.area_id);
        if (a && PARK.has(a.kind)) vanHits.push(drawVan(vanLayer, v, a, opts.selected?.type === 'van' && opts.selected.id === v.id, fl.angles.get(a.id), !!opts.bigTags).fmHit);
      }
    }
    // Follow-up round 1 (worker-r3-6): `minTap` (screen px, pick mode with onVan) — a tap anywhere on a van's spot or
    // tag opens it, and each van's tap area is at least minTap × minTap on screen, however small the fitted map is
    // (an invisible box; where two overlap, the nearer van wins).
    const vanNear = p => {
      if (!opts.minTap || !vanHits.length) return null;
      const ctm = svg.getScreenCTM();
      const unit = ctm ? Math.hypot(ctm.a, ctm.b) : 0; // screen px per metre
      if (!unit) return null;
      const min = opts.minTap / unit;
      let best = null, bestD = Infinity;
      for (const h of vanHits) {
        const mx = (h.x0 + h.x1) / 2, my = (h.y0 + h.y1) / 2;
        const hw = Math.max(h.x1 - h.x0, min) / 2, hh = Math.max(h.y1 - h.y0, min) / 2;
        if (Math.abs(p.x - mx) > hw || Math.abs(p.y - my) > hh) continue;
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < bestD) { bestD = d; best = h.van; }
      }
      return best;
    };

    // ── interaction ──
    const pt = e => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
    const areaAt = (p, kinds) => [...data.areas].reverse().find(a => (!kinds || kinds.has(a.kind)) && p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h);
    let drag = null;

    svg.addEventListener('pointerdown', e => {
      const vanG = e.target.closest('.fm-van');
      const areaG = e.target.closest('.fm-area');
      const p = pt(e);
      if (mode === 'view' && vanG) {
        drag = { type: 'van', id: Number(vanG.dataset.van), g: vanG, start: p, moved: false, base: vanG.getAttribute('transform') };
      } else if (mode === 'edit' && areaG) {
        const a = byId.get(Number(areaG.dataset.area));
        drag = { type: e.target.classList.contains('fm-resize') ? 'resize' : 'area', area: a, start: p, orig: { ...a }, g: areaG, moved: false };
      } else drag = { type: 'none', start: p, moved: false, areaG, vanG };
      drag.cx = e.clientX; drag.cy = e.clientY;
      if (drag.type !== 'none') svg.setPointerCapture(e.pointerId); // only when something can be dragged
    });
    svg.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = pt(e);
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      // Phones: a tap may wobble a few pixels (gloves), so allow ~12 screen px before it counts as a move.
      const still = mode === 'pick' ? Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < 12 : Math.hypot(dx, dy) < 0.4;
      if (!drag.moved && still) return;
      drag.moved = true;
      if (drag.type === 'van') {
        drag.g.setAttribute('transform', `translate(${dx} ${dy}) ${drag.base}`);
        drag.g.style.opacity = 0.75;
        areaEls.forEach(g => g.firstChild.style.filter = '');
        const over = areaAt(p, PARK);
        if (over) areaEls.get(over.id).firstChild.style.filter = 'drop-shadow(0 0 0.3px #e8590c) brightness(0.92)';
      } else if (drag.type === 'area' || drag.type === 'resize') {
        const a = drag.area, o = drag.orig;
        if (drag.type === 'area') { a.x = snap(o.x + dx); a.y = snap(o.y + dy); }
        else { a.w = Math.max(0.5, snap(o.w + dx)); a.h = Math.max(0.5, snap(o.h + dy)); }
        const r = drag.g.firstChild;
        r.setAttribute('x', a.x); r.setAttribute('y', a.y); r.setAttribute('width', a.w); r.setAttribute('height', a.h);
        [...drag.g.children].slice(1).forEach(c => { c.style.visibility = 'hidden'; });
      }
    });
    svg.addEventListener('pointerup', e => {
      const d = drag;
      drag = null;
      if (!d) return;
      const p = pt(e);
      if (d.type === 'van') {
        if (d.moved) {
          const over = areaAt(p, PARK);
          if (over && opts.onDropVan) opts.onDropVan(d.id, over.id);
          else { d.g.setAttribute('transform', d.base); d.g.style.opacity = 1; areaEls.forEach(g => g.firstChild.style.filter = ''); }
        } else opts.onVan?.(data.vans.find(v => v.id === d.id));
        return;
      }
      if (d.type === 'area' || d.type === 'resize') {
        if (d.moved) opts.onAreaChange?.(d.area);
        else opts.onArea?.(d.area);
        return;
      }
      if (!d.moved) {
        if (d.vanG) return opts.onVan?.(data.vans.find(v => v.id === Number(d.vanG.dataset.van)));
        const near = mode === 'pick' && opts.onVan ? vanNear(p) : null;
        if (near) return opts.onVan(near);
        const hit = areaAt(p, mode === 'edit' ? null : new Set(['storage', 'bay', 'yard']));
        if (hit && hit.kind !== 'building') opts.onArea?.(hit);
        else opts.onBackground?.(p);
      }
    });
    // The browser took the touch over (page scroll): forget the tap / put a dragged van back.
    svg.addEventListener('pointercancel', () => {
      if (drag?.type === 'van' && drag.moved) { drag.g.setAttribute('transform', drag.base); drag.g.style.opacity = 1; areaEls.forEach(g => g.firstChild.style.filter = ''); }
      drag = null;
    });
    // Vans dragged in from the "not on the floor" list (HTML drag and drop).
    svg.addEventListener('dragover', e => { if (mode === 'view') e.preventDefault(); });
    svg.addEventListener('drop', e => {
      const vanId = Number(e.dataTransfer.getData('text/van'));
      const over = areaAt(pt(e), PARK);
      if (vanId && over) { e.preventDefault(); opts.onDropVan?.(vanId, over.id); }
    });
    return { svg, point: pt };
  }

  window.FactoryMap = { render, flow, STYLE, PARK };
})();
