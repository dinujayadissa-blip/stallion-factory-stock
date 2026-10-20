// 3D factory view (three.js, served locally from /vendor/three). Same layout data as the 2D map.
//   const view = await mount(container, layout, { onVan(van), onArea(area), cam }); const cam = view.dispose();
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const COLORS = {
  building: 0xd9d6cf, bay: 0xf2c200, yard: 0x9fb48f, gate_in: 0x2e8b4e, gate_out: 0x1f5fa8, office: 0xc9d6e3,
  storage: 0x2f6db5, work: 0xb8955a, wall: 0x6b7380,
};

// Text label as a sprite that always faces the camera.
// onTop: draw over everything (van labels); otherwise hidden behind things in front (area names).
function label(text, { size = 1, color = '#16202b', bg = 'rgba(255,255,255,0.92)', bold = true, onTop = true } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${bold ? 800 : 600} 64px Inter, Segoe UI, system-ui, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  c.width = w; c.height = 96;
  ctx.font = font;
  if (bg) { ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, w, 96, 24); ctx.fill(); }
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 24, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: !onTop, transparent: true }));
  s.scale.set(size * w / 96, size, 1);
  s.renderOrder = onTop ? 10 : 1;
  return s;
}

// Stallion caravan pictures (generated with Runway from the stallioncaravans.com.au photos).
// Side A = door side, A-frame to the right; side B = road side, A-frame to the left.
// Fractions are where the body sits inside each picture.
const PICS = {
  sideA: { url: '/assets/van-side-a.png', aspect: 2.642 },
  sideB: { url: '/assets/van-side-b.png', aspect: 2.617 },
  top: { url: '/assets/van-top.png', body0: 0.04, body1: 0.725 },
  concrete: { url: '/assets/concrete.png' },
};
const SIDE = { body0: 0.02, body1: 0.84, roof: 0.934, bottom: 0.255, toolbox0: 0.84, toolbox1: 0.93 };
const texCache = new Map();
function tex(key) {
  if (!texCache.has(key)) {
    const t = new THREE.TextureLoader().load(PICS[key].url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    texCache.set(key, t);
  }
  return texCache.get(key);
}

// A caravan built like a paper model: real side pictures on both sides (wheels, toolbox and
// A-frame included), the roof picture on top, a dark body box in between. Length along x,
// A-frame towards +x.
function caravan(van, L) {
  const g = new THREE.Group();
  const pct = van.total ? van.done / van.total : 0;
  const H = L / PICS.sideA.aspect;   // picture height in metres (wheels to aircon)
  const Wd = 2.4;                    // body width
  const bx0 = -L / 2 + SIDE.body0 * L, bx1 = -L / 2 + SIDE.body1 * L;
  const by0 = SIDE.bottom * H, by1 = SIDE.roof * H;
  const charcoal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.75 });

  // body box with the roof picture on top (cropped to the body part of the picture)
  const roofTex = tex('top').clone();
  roofTex.needsUpdate = true;
  roofTex.repeat.set(PICS.top.body1 - PICS.top.body0, 1);
  roofTex.offset.set(PICS.top.body0, 0);
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(bx1 - bx0, by1 - by0, Wd),
    [charcoal, charcoal, roofMat, charcoal, charcoal, charcoal]);
  body.position.set((bx0 + bx1) / 2, (by0 + by1) / 2, 0);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // the two side pictures, just outside the box
  const sideMat = key => new THREE.MeshStandardMaterial({ map: tex(key), alphaTest: 0.5, roughness: 0.6 });
  const sideA = new THREE.Mesh(new THREE.PlaneGeometry(L, H), sideMat('sideA'));
  sideA.position.set(0, H / 2, Wd / 2 + 0.02);
  g.add(sideA);
  const sideB = new THREE.Mesh(new THREE.PlaneGeometry(L, H), sideMat('sideB'));
  sideB.position.set(0, H / 2, -(Wd / 2 + 0.02));
  sideB.rotation.y = Math.PI;
  g.add(sideB);

  // toolbox and drawbar so the front has depth from above
  const tbL = (SIDE.toolbox1 - SIDE.toolbox0) * L;
  const toolbox = new THREE.Mesh(new THREE.BoxGeometry(tbL, H * 0.27, Wd * 0.85), charcoal);
  toolbox.position.set(-L / 2 + (SIDE.toolbox0 + SIDE.toolbox1) / 2 * L, H * 0.37, 0);
  toolbox.castShadow = true;
  g.add(toolbox);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(L * 0.08, 0.12, 0.18), charcoal);
  bar.position.set(L / 2 - L * 0.04, H * 0.2, 0);
  g.add(bar);
  // dark underside so you can't see through between the wheels
  const under = new THREE.Mesh(new THREE.BoxGeometry(bx1 - bx0, 0.2, Wd * 0.9), charcoal);
  under.position.set((bx0 + bx1) / 2, by0 - 0.1, 0);
  g.add(under);

  // floating labels
  const top = label(van.chassis, { size: 1.1 });
  top.position.set((bx0 + bx1) / 2, by1 + 1.5, 0);
  g.add(top);
  const extra = [`${Math.round(pct * 100)}% fitted`]; // parts fitted (owner-r3-4)
  if (van.missing) extra.push(`${van.missing} still missing`);
  if (van.due) extra.push('reminder due');
  const sub = label(extra.join(' · '), { size: 0.6, color: van.missing ? '#b42318' : '#1d7a46', bold: false });
  sub.position.set((bx0 + bx1) / 2, by1 + 0.65, 0);
  g.add(sub);
  g.traverse(o => { o.userData.van = van; });
  return g;
}

export async function mount(container, data, opts = {}) {
  container.innerHTML = '';
  const width = container.clientWidth || 800, height = container.clientHeight || 520;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe6ee);
  const xs = data.areas.flatMap(a => [a.x, a.x + a.w]), ys = data.areas.flatMap(a => [a.y, a.y + a.h]);
  const minX = Math.min(0, ...xs), maxX = Math.max(40, ...xs), minY = Math.min(0, ...ys), maxY = Math.max(20, ...ys);
  const cx = (minX + maxX) / 2, cz = (minY + maxY) / 2, span = Math.max(maxX - minX, maxY - minY);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(cx - span * 0.15, span * 0.75, cz + span * 0.8);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(cx, 0, cz);
  if (opts.cam) { camera.position.fromArray(opts.cam.pos); controls.target.fromArray(opts.cam.target); } // keep the view after a refresh
  controls.maxPolarAngle = Math.PI / 2.15;
  controls.enableDamping = true;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4ae, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(cx - span * 0.4, span, cz - span * 0.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 4 });
  sun.target.position.set(cx, 0, cz);
  scene.add(sun, sun.target);

  // ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 4, span * 4), new THREE.MeshStandardMaterial({ color: 0xc9cfc4, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -0.02, cz);
  ground.receiveShadow = true;
  scene.add(ground);

  const clickable = [];
  const at = (a, y = 0) => new THREE.Vector3(a.x + a.w / 2, y, a.y + a.h / 2);
  const flat = (a, color, y, opacity = 1) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(a.w, a.h), new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, roughness: 0.9 }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(at(a, y));
    m.receiveShadow = true;
    return m;
  };
  const outline = (a, color, y) => {
    const pts = [[a.x, a.y], [a.x + a.w, a.y], [a.x + a.w, a.y + a.h], [a.x, a.y + a.h], [a.x, a.y]].map(([x, z]) => new THREE.Vector3(x, y, z));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
  };

  for (const a of data.areas) {
    const col = COLORS[a.kind] ?? 0x999999;
    if (a.kind === 'building') {
      // concrete floor (Runway texture), tiled every 6 m
      const conc = tex('concrete').clone();
      conc.needsUpdate = true;
      conc.wrapS = conc.wrapT = THREE.RepeatWrapping;
      conc.repeat.set(a.w / 6, a.h / 6);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(a.w, a.h), new THREE.MeshStandardMaterial({ map: conc, roughness: 0.85 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.copy(at(a, 0));
      floor.receiveShadow = true;
      scene.add(floor);
      // low walls so you can see in (gates leave gaps visually by colour)
      const wallMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, transparent: true, opacity: 0.55 });
      const h = 1.2, t = 0.2;
      for (const [w, d, x, z] of [[a.w, t, a.x + a.w / 2, a.y], [a.w, t, a.x + a.w / 2, a.y + a.h], [t, a.h, a.x, a.y + a.h / 2], [t, a.h, a.x + a.w, a.y + a.h / 2]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        m.position.set(x, h / 2, z);
        scene.add(m);
      }
      const l = label(a.name || 'Factory', { size: 1.4, bg: null, color: '#3c4652', onTop: false });
      l.position.set(a.x + 3, 2.2, a.y - 1);
      scene.add(l);
    } else if (a.kind === 'bay' || a.kind === 'yard') {
      scene.add(flat(a, a.kind === 'yard' ? 0xb4c4a6 : 0xc4c2bb, 0.01));
      scene.add(outline(a, col, 0.03));
      const l = label(a.name, { size: 0.7, bg: null, color: a.kind === 'bay' ? '#8a6d00' : '#4b6340', onTop: false });
      l.position.set(a.x + 1.4, 0.2, a.y + 0.6);
      scene.add(l);
      const hit = flat(a, col, 0.02, 0.0001);
      hit.userData.area = a;
      clickable.push(hit);
      scene.add(hit);
    } else if (a.kind === 'gate_in' || a.kind === 'gate_out') {
      const m = new THREE.Mesh(new THREE.BoxGeometry(a.w, 0.15, a.h), new THREE.MeshStandardMaterial({ color: col }));
      m.position.copy(at(a, 0.08));
      scene.add(m);
      const l = label(`${a.name} ▶`, { size: 0.9, color: '#fff', bg: a.kind === 'gate_in' ? '#2e8b4e' : '#1f5fa8' });
      l.position.copy(at(a, 3));
      scene.add(l);
    } else {
      const height = a.kind === 'storage' ? 2.4 : a.kind === 'office' ? 3 : a.kind === 'wall' ? (/fence/i.test(a.name) ? 1.8 : 3) : 0.9;
      const m = new THREE.Mesh(new THREE.BoxGeometry(a.w, height, a.h),
        new THREE.MeshStandardMaterial({ color: col, transparent: a.kind === 'storage', opacity: a.kind === 'storage' ? 0.85 : 1, roughness: 0.7 }));
      m.position.copy(at(a, height / 2));
      m.castShadow = true; m.receiveShadow = true;
      m.userData.area = a;
      clickable.push(m);
      scene.add(m);
      if (a.kind !== 'wall') {
        const l = label(a.name, { size: 0.65, bg: 'rgba(255,255,255,0.8)', bold: false, onTop: false });
        l.position.copy(at(a, height + 0.6));
        scene.add(l);
      }
    }
  }

  const byId = new Map(data.areas.map(a => [a.id, a]));
  const angles = window.FactoryMap?.flow(data.areas).angles || new Map();
  for (const v of data.vans) {
    const a = byId.get(v.area_id);
    if (!a || !['bay', 'yard'].includes(a.kind)) continue;
    const horizontal = a.w >= a.h;
    const L = Math.min((horizontal ? a.w : a.h) - 0.3, 9.2);
    const g = caravan(v, L);
    g.position.copy(at(a, 0));
    // face the way the van moves along the line (same as the 2D map)
    g.rotation.y = -((angles.get(a.id) ?? (horizontal ? 0 : 90)) * Math.PI) / 180;
    g.traverse(o => { if (o.isMesh) clickable.push(o); });
    scene.add(g);
  }

  // click → van / area
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // it was a drag (orbit)
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(clickable, false)[0];
    if (hit?.object.userData.van) opts.onVan?.(hit.object.userData.van);
    else if (hit?.object.userData.area) opts.onArea?.(hit.object.userData.area);
  });

  let raf;
  const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();
  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  return {
    // Returns where the camera was, so a rebuilt view can start from the same spot.
    dispose() {
      const cam = { pos: camera.position.toArray(), target: controls.target.toArray() };
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse(o => {
        o.geometry?.dispose();
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        ms.forEach(m => { m.map?.dispose(); m.dispose(); });
      });
      renderer.dispose();
      container.innerHTML = '';
      return cam;
    },
  };
}
