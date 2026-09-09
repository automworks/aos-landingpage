/*
 * aos-scene.js — the Adaptive OS tower
 * ---------------------------------------------------------------------------
 * A five-tier drawn structure standing in front of an amber sun. Each tier is
 * one layer of the operating system; the staircases between them are the loop.
 * Scroll walks the camera around and up the tower, one layer per section.
 */

import {
  THREE, PALETTE, Ink, inkMaterial, hatchTexture, makeFigure,
  makeChart, fillMaterial, sunTexture, setBoil, rng, FIGURE_POSES, CHART_KINDS_LIST,
} from './sketch.js';

/* ------------------------------------------------------------ the layers */

export const LAYERS = [
  { id: 'L1', name: 'Strategy & Outcomes', r: 3.1, y:  9.2, ox:  0.0, oz:  0.0, color: '#4A453D', people: 4, stairAngle: -0.55 },
  { id: 'L2', name: 'People & Agents',     r: 4.4, y:  6.1, ox:  0.35, oz: -0.25, color: '#FFCD00', people: 7, stairAngle: 1.35 },
  { id: 'L3', name: 'Process & Workflows', r: 5.6, y:  3.0, ox: -0.45, oz:  0.3, color: '#17A38B', people: 6, stairAngle: 2.85 },
  { id: 'L4', name: 'Platforms & Tools',   r: 6.8, y: -0.1, ox:  1.05, oz:  0.45, color: '#CE3B82', people: 5, stairAngle: 4.35 },
  { id: 'L5', name: 'Data & Context',      r: 8.1, y: -3.2, ox:  0.0, oz:  0.0, color: '#181410', people: 5, stairAngle: 0 },
];

const TIER_T = 0.44;         // slab thickness
const CORE_R = 1.65;
const GROUND_Y = -5.6;

/* --------------------------------------------------------- camera shots
 * One shot per page section. Azimuth climbs monotonically so scrolling reads
 * as walking around the building rather than snapping between viewpoints.
 */

const SHOTS = [
  { az: -0.60, el: 0.26, dist: 50, tx: 0.0,  ty:  2.6, tz: 0.0 },  // 0 hero
  { az:  0.30, el: 0.20, dist: 18, tx: 0.0,  ty:  9.4, tz: 0.0 },  // 1 L1
  { az:  1.10, el: 0.17, dist: 22, tx: 0.35, ty:  6.4, tz: -0.25 },// 2 L2
  { az:  1.92, el: 0.15, dist: 26, tx: -0.45,ty:  3.4, tz: 0.3 },  // 3 L3
  { az:  2.74, el: 0.14, dist: 29, tx: 1.05, ty:  0.3, tz: 0.45 }, // 4 L4
  { az:  3.56, el: 0.17, dist: 32, tx: 0.0,  ty: -2.8, tz: 0.0 },  // 5 L5
  { az:  4.55, el: 0.33, dist: 56, tx: 0.0,  ty:  2.6, tz: 0.0 },  // 6 the loop
  { az:  5.70, el: 0.22, dist: 46, tx: 0.0,  ty:  2.2, tz: 0.0 },  // 7 cta
];

/** Which layer (0-4) a section spotlights, or -1 for the wide shots. */
const SECTION_LAYER = [-1, 0, 1, 2, 3, 4, -1, -1];

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------------------------------------------------------- build */

export function createScene(canvas, opts = {}) {
  const reduced = !!opts.reduced;

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
  });
  renderer.setClearColor(new THREE.Color(PALETTE.paper), 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.5, 400);

  // Every LineMaterial needs the viewport size to compute pixel widths.
  const inkMats = [];
  const track = (mesh) => { inkMats.push(mesh.material); return mesh; };

  /* ---- the sun, parked behind the tower from wherever you're standing --- */

  const sunGroup = new THREE.Group();
  scene.add(sunGroup);

  // The sun rides on the camera target and scales with distance, so it stays a
  // constant backdrop behind whatever the shot is looking at.
  const SUN_AT = [1.5, 4.8, -26];
  const SUN_REF_DIST = 50;

  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshBasicMaterial({ map: sunTexture(), transparent: true, opacity: 0.82, depthWrite: false, toneMapped: false })
  );
  sun.position.set(...SUN_AT);
  sun.renderOrder = 0;
  sunGroup.add(sun);

  {
    // Drafting arcs radiating off the sun — the compass marks left in a sketch.
    const g = new Ink(31).jitter(0.02);
    const [sx, sy, sz] = [SUN_AT[0], SUN_AT[1], SUN_AT[2] + 0.5];
    for (const rad of [11.6, 12.6, 14.2]) g.ring(sx, sy, sz, rad, 120);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + 0.2;
      const r0 = 12.9, r1 = 15.6 + (i % 3) * 0.9;
      g.seg([sx + Math.cos(a) * r0, sy + Math.sin(a) * r0, sz],
            [sx + Math.cos(a) * r1, sy + Math.sin(a) * r1, sz]);
    }
    const m = track(g.build({ color: PALETTE.inkFaint, width: 1.05, opacity: 0.34, renderOrder: 2 }));
    sunGroup.add(m);
  }

  /* ------------------------------------------- ground: grid, base, people */

  const staticGroup = new THREE.Group();
  scene.add(staticGroup);

  {
    const g = new Ink(5).jitter(0.03);
    // A faint blueprint grid, fading out toward the edges of the sheet.
    for (let i = -7; i <= 7; i++) {
      g.seg([i * 3, GROUND_Y, -21], [i * 3, GROUND_Y, 21]);
      g.seg([-21, GROUND_Y, i * 3], [21, GROUND_Y, i * 3]);
    }
    const grid = track(g.build({ color: PALETTE.lineStrong, width: 1, opacity: 0.4, depthTest: false, renderOrder: 1 }));
    staticGroup.add(grid);

    // Base plinth the whole structure sits on.
    const b = new Ink(6).jitter(0.02);
    b.disc(0, GROUND_Y + 0.5, 0, 9.6, 0.5, 56);
    b.circle(0, GROUND_Y + 0.5, 0, 9.0, 72);
    staticGroup.add(track(b.build({ color: PALETTE.inkSoft, width: 1.5, opacity: 0.75 })));

    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(9.6, 9.6, 0.5, 64),
      fillMaterial(PALETTE.paperRaised, 1)
    );
    plinth.position.set(0, GROUND_Y + 0.25, 0);
    plinth.renderOrder = 3;
    staticGroup.add(plinth);
  }

  // Construction guides: the centre axis and the dimension ticks beside it.
  {
    const g = new Ink(9).jitter(0.01);
    g.seg([0, GROUND_Y, 0], [0, 15.5, 0]);
    for (const L of LAYERS) {
      g.seg([-13.5, L.y, 0], [-11.6, L.y, 0]);
      g.seg([-12.55, L.y, -0.35], [-12.55, L.y, 0.35]);
    }
    g.seg([-12.55, LAYERS[4].y, 0], [-12.55, LAYERS[0].y, 0]);
    const m = track(g.build({
      color: PALETTE.inkFaint, width: 1.05, opacity: 0.42,
      dashed: true, dashSize: 0.34, gapSize: 0.26, depthTest: false, renderOrder: 2,
    }));
    staticGroup.add(m);
  }

  /* ----------------------------------------------------------- the core */

  {
    const top = LAYERS[0].y + 0.9, bot = LAYERS[4].y - TIER_T;
    const coreFill = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_R, CORE_R, top - bot, 40, 1, true),
      fillMaterial(PALETTE.paperRaised, 1, { side: THREE.DoubleSide })
    );
    coreFill.position.set(0, (top + bot) / 2, 0);
    coreFill.renderOrder = 3;
    staticGroup.add(coreFill);

    const g = new Ink(13).jitter(0.015);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      g.seg([Math.cos(a) * CORE_R, bot, Math.sin(a) * CORE_R], [Math.cos(a) * CORE_R, top, Math.sin(a) * CORE_R]);
    }
    g.circle(0, top, 0, CORE_R, 48);
    staticGroup.add(track(g.build({ color: PALETTE.inkSoft, width: 1.4, opacity: 0.8 })));
  }

  /* ------------------------------------------------------ tiers + stairs */

  const tiers = LAYERS.map((L, idx) => buildTier(L, idx));
  tiers.forEach((t) => scene.add(t.group));

  function buildTier(L, idx) {
    const group = new THREE.Group();
    const rand = rng(100 + idx * 37);
    const surfaceY = L.y;

    /* solid slab ------------------------------------------------------- */
    const sideTex = hatchTexture({ gap: 9, alpha: 0.42, bg: PALETTE.paperRaised, seed: 40 + idx, repeat: [Math.round(L.r * 2.4), 1] });
    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(L.r, L.r, TIER_T, 64),
      [
        new THREE.MeshBasicMaterial({ map: sideTex, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 1.4, polygonOffsetUnits: 1.4 }),
        fillMaterial(PALETTE.paperRaised, 1),
        fillMaterial('#EFE9DC', 1),
      ]
    );
    slab.position.set(L.ox, surfaceY - TIER_T / 2, L.oz);
    slab.renderOrder = 3;
    group.add(slab);

    /* the amber wash that marks the layer you're reading ---------------- */
    const wash = new THREE.Mesh(
      new THREE.CircleGeometry(L.r * 0.995, 64),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE.amber), transparent: true, opacity: 0,
        depthWrite: false, toneMapped: false,
      })
    );
    wash.rotation.x = -Math.PI / 2;
    wash.position.set(L.ox, surfaceY + 0.012, L.oz);
    wash.renderOrder = 5;
    group.add(wash);

    /* ink outline ------------------------------------------------------- */
    const g = new Ink(200 + idx).jitter(0.022);
    g.disc(L.ox, surfaceY, L.oz, L.r, TIER_T, Math.round(L.r * 7));
    // an inset rim line, the way a draughtsman marks a floor edge
    g.circle(L.ox, surfaceY + 0.01, L.oz, L.r - 0.42, 64);

    if (idx < LAYERS.length - 1) addStair(g, L, LAYERS[idx + 1]);
    const outline = track(g.build({ color: PALETTE.ink, width: 2.1, renderOrder: 10 }));
    group.add(outline);

    /* people on this floor --------------------------------------------- */
    const figs = [];
    for (let i = 0; i < L.people; i++) {
      const a = (i / L.people) * Math.PI * 2 + rand() * 0.7;
      const rr = lerp(CORE_R + 0.75, L.r - 0.7, 0.25 + rand() * 0.7);
      const pose = FIGURE_POSES[Math.floor(rand() * FIGURE_POSES.length)];
      const f = makeFigure({ pose, seed: idx * 17 + i * 3 + 1, height: 1.22, color: PALETTE.ink });
      f.position.set(L.ox + Math.cos(a) * rr, surfaceY + 0.01, L.oz + Math.sin(a) * rr);
      group.add(f);
      figs.push(f);
    }

    /* a screen or board mounted on the core, per floor ------------------ */
    let board = null;
    if (idx < 4) {
      const a = L.stairAngle + 2.2;
      board = makeChart(CHART_KINDS_LIST[idx % CHART_KINDS_LIST.length], 300 + idx, 2.5);
      board.position.set(Math.cos(a) * (CORE_R + 0.06), surfaceY + 1.05, Math.sin(a) * (CORE_R + 0.06));
      board.rotation.y = -a + Math.PI / 2;
      board.material.opacity = 0.7;
      group.add(board);

      const bg = new Ink(320 + idx).jitter(0.012);
      bg.rect(0, 0, 0, 2.5, 2.5 * (300 / 420));
      const frame = track(bg.build({ color: PALETTE.ink, width: 1.5, opacity: 0.85 }));
      frame.position.copy(board.position);
      frame.rotation.copy(board.rotation);
      group.add(frame);
    }

    return {
      group, outline, wash, figs, slab, board,
      layer: L, idx,
      anchor: new THREE.Vector3(L.ox, surfaceY + 0.5, L.oz),
      baseColor: new THREE.Color(PALETTE.ink),
      accent: new THREE.Color(L.color),
      state: { hi: 0, acc: 0 },
    };
  }

  /**
   * A drawn staircase from the lower (wider) tier up to the one above it.
   * Two zig-zag profiles plus tread edges: reads as stairs without solids.
   */
  function addStair(g, upper, lower) {
    const a = lower.stairAngle;
    const dx = Math.cos(a), dz = Math.sin(a);
    const rTop = upper.r * 0.94, rBot = lower.r * 0.80;
    const from = [lower.ox + dx * rBot, lower.y, lower.oz + dz * rBot];
    const to   = [upper.ox + dx * rTop, upper.y, upper.oz + dz * rTop];

    const steps = 9;
    const w = 0.62;
    const px = -dz * w, pz = dx * w;             // perpendicular, for the two sides

    for (const s of [1, -1]) {
      const prof = [[from[0] + px * s, from[1], from[2] + pz * s]];
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps, t1 = (i + 1) / steps;
        const y1 = lerp(from[1], to[1], t1);
        const x0 = lerp(from[0], to[0], t0), z0 = lerp(from[2], to[2], t0);
        const x1 = lerp(from[0], to[0], t1), z1 = lerp(from[2], to[2], t1);
        prof.push([x0 + px * s, y1, z0 + pz * s]);   // riser
        prof.push([x1 + px * s, y1, z1 + pz * s]);   // tread
      }
      g.poly(prof);
    }
    // tread nosings, tying the two profiles together
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const y = lerp(from[1], to[1], t);
      const x = lerp(from[0], to[0], t), z = lerp(from[2], to[2], t);
      g.seg([x + px, y, z + pz], [x - px, y, z - pz]);
    }
  }

  /* -------------------------------------------------- peripheral thinking */

  const charts = [];
  {
    const r = rng(77);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.4;
      const rad = 13.5 + r() * 5;
      const c = makeChart(CHART_KINDS_LIST[i % CHART_KINDS_LIST.length], 500 + i * 13, 3.2 + r() * 1.6);
      c.position.set(Math.cos(a) * rad, lerp(-3, 12, r()), Math.sin(a) * rad);
      c.material.opacity = 0.4;
      scene.add(c);
      charts.push(c);
    }
  }

  /* --------------------------------------------------- ground-floor crowd */

  const crowd = [];
  {
    const r = rng(404);
    for (let i = 0; i < 12; i++) {
      const a = r() * Math.PI * 2;
      const rad = 10.5 + r() * 6.5;
      const f = makeFigure({
        pose: FIGURE_POSES[Math.floor(r() * FIGURE_POSES.length)],
        seed: 900 + i * 7, height: 1.1, color: PALETTE.inkSoft, opacity: 0.75,
      });
      f.position.set(Math.cos(a) * rad, GROUND_Y, Math.sin(a) * rad);
      scene.add(f);
      crowd.push(f);
    }
  }

  /* ------------------------------------------------------------ the loop
   * Intent falls down the outside of the core, signal climbs back up. Two
   * particle ribbons; the only thing in the drawing that never stops moving.
   */

  function dotTexture(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, color);
    grd.addColorStop(0.55, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = grd;
    x.beginPath(); x.arc(32, 32, 32, 0, Math.PI * 2); x.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function makeFlow(count, color, size) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const mat = new THREE.PointsMaterial({
      map: dotTexture(color), size, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = 14;
    scene.add(p);
    return p;
  }

  const FLOW_N = reduced ? 0 : 72;
  const flowDown = makeFlow(FLOW_N, PALETTE.ink, 0.5);
  const flowUp = makeFlow(FLOW_N, PALETTE.amberDeep, 0.58);

  const yTop = LAYERS[0].y + 0.6, yBot = LAYERS[4].y - 0.2;

  /** Radius of the structure's silhouette at a given height. */
  function radiusAtY(y) {
    if (y >= LAYERS[0].y) return LAYERS[0].r;
    for (let i = 0; i < LAYERS.length - 1; i++) {
      const a = LAYERS[i], b = LAYERS[i + 1];
      if (y <= a.y && y >= b.y) return lerp(a.r, b.r, (a.y - y) / (a.y - b.y));
    }
    return LAYERS[LAYERS.length - 1].r;
  }

  function updateFlows(time) {
    if (!FLOW_N) return;
    const dpos = flowDown.geometry.attributes.position.array;
    const upos = flowUp.geometry.attributes.position.array;
    for (let i = 0; i < FLOW_N; i++) {
      const off = i / FLOW_N;

      let t = (off + time * 0.11) % 1;                    // intent: top -> bottom
      let y = lerp(yTop, yBot, t);
      let a = off * Math.PI * 2 * 3 + t * 2.4;
      let rr = radiusAtY(y) + 0.55;                       // spills down the outside
      dpos[i * 3] = Math.cos(a) * rr; dpos[i * 3 + 1] = y; dpos[i * 3 + 2] = Math.sin(a) * rr;

      t = (off + time * 0.09) % 1;                        // signal: bottom -> top
      y = lerp(yBot, yTop, t);
      a = -off * Math.PI * 2 * 3 - t * 2.4 + 1.0;
      rr = CORE_R + 0.55;                                 // climbs the spine
      upos[i * 3] = Math.cos(a) * rr; upos[i * 3 + 1] = y; upos[i * 3 + 2] = Math.sin(a) * rr;
    }
    flowDown.geometry.attributes.position.needsUpdate = true;
    flowUp.geometry.attributes.position.needsUpdate = true;
  }

  /* ------------------------------------------------------ camera + input */

  const cam = { az: SHOTS[0].az, el: SHOTS[0].el, dist: SHOTS[0].dist, target: new THREE.Vector3(0, 3, 0) };
  const userAz = { v: 0, target: 0 };
  const userEl = { v: 0, target: 0 };
  let progress = 0;          // continuous section index
  let activeLayer = -1;
  let hovered = -1;
  let dragging = false, lastX = 0, lastY = 0, moved = 0;
  let crowdFade = 1;

  function shotAt(p) {
    const i = clamp(Math.floor(p), 0, SHOTS.length - 1);
    const j = clamp(i + 1, 0, SHOTS.length - 1);
    const t = smooth(clamp(p - i, 0, 1));
    const A = SHOTS[i], B = SHOTS[j];
    return {
      az: lerp(A.az, B.az, t), el: lerp(A.el, B.el, t), dist: lerp(A.dist, B.dist, t),
      tx: lerp(A.tx, B.tx, t), ty: lerp(A.ty, B.ty, t), tz: lerp(A.tz, B.tz, t),
    };
  }

  /* ---- picking: invisible cylinders so the whole floor is clickable ---- */

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-2, -2);
  let hoverDirty = false;

  const picks = LAYERS.map((L, i) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(L.r, L.r, TIER_T + 1.4, 24),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    m.position.set(L.ox, L.y - TIER_T / 2 + 0.5, L.oz);
    m.userData.layer = i;
    scene.add(m);
    return m;
  });

  /** Which floor is under these client coordinates, or -1. */
  function pickAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    pointer.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(picks, false)[0];
    return hit ? hit.object.userData.layer : -1;
  }

  function setHover(next) {
    if (next === hovered) return;
    hovered = next;
    if (!dragging) canvas.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    if (opts.onHover) opts.onHover(hovered);
  }

  function updateHover() {
    hoverDirty = false;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(picks, false)[0];
    setHover(hit ? hit.object.userData.layer : -1);
  }

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      userAz.target = clamp(userAz.target - dx * 0.005, -1.1, 1.1);
      userEl.target = clamp(userEl.target + dy * 0.003, -0.22, 0.42);
    } else {
      const r = canvas.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      hoverDirty = true;
    }
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    // Raycast here rather than trusting the cached hover: a quick click, and
    // every touch tap, lands before the next frame has run updateHover().
    let hit = -1;
    if (moved < 6 && e && e.clientX !== undefined) {
      hit = pickAt(e.clientX, e.clientY);
      setHover(hit);
    }
    canvas.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    if (hit >= 0 && opts.onPick) opts.onPick(hit);
    if (e && e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.style.cursor = 'grab';

  /* ---------------------------------------------------------- the frame */

  const tmp = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const sunInv = new THREE.Quaternion();
  const clock = new THREE.Clock();
  let raf = 0, running = true;
  let width = 1, height = 1;

  function resize() {
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Narrow viewports need a wider lens or the tower will not fit the frame.
    camera.fov = width < 760 ? 46 : 34;
    camera.updateProjectionMatrix();

    // Lens shift rather than a moved target: on desktop the copy occupies the
    // left third, so slide the whole image right without swinging the camera.
    // On phones the copy sits underneath, so lift the tower instead.
    // NDC is offset by -m, hence the negative signs.
    const narrow = width < 900;
    camera.projectionMatrix.elements[8] = narrow ? 0 : -0.34;
    camera.projectionMatrix.elements[9] = narrow ? -0.26 : 0;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    for (const m of inkMats) m.resolution.set(width, height);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!running) return;

    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    if (!reduced) setBoil(time);

    // ease user drag toward its target so flicks feel weighted
    userAz.v += (userAz.target - userAz.v) * Math.min(1, dt * 7);
    userEl.v += (userEl.target - userEl.v) * Math.min(1, dt * 7);

    const s = shotAt(progress);
    // Idle drift, hero only — the drawing breathes when nobody is scrolling.
    const drift = reduced ? 0 : Math.sin(time * 0.14) * 0.06 * clamp(1 - progress, 0, 1);

    cam.az += (s.az + userAz.v + drift - cam.az) * Math.min(1, dt * 3.2);
    cam.el += (clamp(s.el + userEl.v, -0.2, 0.75) - cam.el) * Math.min(1, dt * 3.2);
    cam.dist += (s.dist - cam.dist) * Math.min(1, dt * 3.2);
    cam.target.lerp(tmp.set(s.tx, s.ty, s.tz), Math.min(1, dt * 3.2));

    const ce = Math.cos(cam.el), se = Math.sin(cam.el);
    camera.position.set(
      cam.target.x + Math.sin(cam.az) * ce * cam.dist,
      cam.target.y + se * cam.dist,
      cam.target.z + Math.cos(cam.az) * ce * cam.dist
    );
    camera.lookAt(cam.target);

    // Keep the sun directly behind the subject from wherever the camera stands,
    // then cancel the group's yaw back out so the disc still faces us square.
    // Scaling with distance holds its size in frame across every shot.
    sunGroup.position.copy(cam.target);
    sunGroup.rotation.y = cam.az;
    sunGroup.scale.setScalar(cam.dist / SUN_REF_DIST);
    sunInv.copy(sunGroup.quaternion).invert();
    sun.quaternion.copy(camera.quaternion).premultiply(sunInv);

    for (const c of charts) c.quaternion.copy(camera.quaternion);

    // Layer emphasis. Presence (how strongly a floor is inked) and accent (its
    // layer colour) are tracked apart: in the wide shots every floor is drawn
    // at full strength but the whole tower stays in plain ink, which is how the
    // reference reads — black line, amber signal, colour only where it means
    // something.
    const k = Math.min(1, dt * 4);
    for (const t of tiers) {
      const isActive = t.idx === activeLayer;
      const isHover = hovered === t.idx;
      const wantHi = Math.max(activeLayer === -1 ? 0.62 : (isActive ? 1 : 0), isHover ? 0.85 : 0);
      const wantAcc = (isActive || isHover) ? 1 : 0;
      t.state.hi += (wantHi - t.state.hi) * k;
      t.state.acc += (wantAcc - t.state.acc) * k;
      const hi = t.state.hi, acc = t.state.acc;

      t.outline.material.opacity = lerp(0.26, 1, hi);
      t.outline.material.color.copy(t.baseColor).lerp(t.accent, acc * 0.7);
      t.outline.material.linewidth = lerp(1.5, 2.6, hi);
      t.wash.material.opacity = acc * 0.3;
      for (const f of t.figs) f.material.opacity = lerp(0.22, 1, hi);
      if (t.board) t.board.material.opacity = lerp(0.18, 0.8, hi);
    }

    // the loop only runs when you are looking at the loop
    const loopStrength = clamp(1 - Math.abs(progress - 6) * 0.85, 0, 1);
    flowDown.material.opacity = loopStrength * 0.9;
    flowUp.material.opacity = loopStrength;
    if (loopStrength > 0.01) updateFlows(time);

    crowdFade += ((activeLayer === -1 ? 1 : 0) - crowdFade) * k;
    for (const c of crowd) c.material.opacity = lerp(0.16, 0.8, crowdFade);

    if (hoverDirty) updateHover();

    renderer.render(scene, camera);
    if (opts.onFrame) opts.onFrame(projectAnchors());
  }

  /** Screen-space anchors so crisp HTML labels can ride on the 3D tiers. */
  function projectAnchors() {
    const out = [];
    // Ride the right-hand rim of each floor rather than its centre, so the name
    // sits beside the structure instead of on top of it.
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    for (const t of tiers) {
      tmp.copy(t.anchor)
        .addScaledVector(camRight, t.layer.r * 0.94)
        .addScaledVector(camUp, 0.35)
        .project(camera);
      out.push({
        idx: t.idx,
        x: (tmp.x * 0.5 + 0.5) * width,
        y: (-tmp.y * 0.5 + 0.5) * height,
        visible: tmp.z < 1 && tmp.x > -1.05 && tmp.x < 1.05 && tmp.y > -1.05 && tmp.y < 1.05,
        emphasis: t.state.hi,
      });
    }
    return out;
  }

  resize();
  window.addEventListener('resize', resize);
  // Start on the next frame, not synchronously: the caller is still wiring up
  // its own state when createScene() returns, and onFrame must not beat it.
  raf = requestAnimationFrame(frame);

  return {
    resize,
    setProgress(p) { progress = clamp(p, 0, SHOTS.length - 1); },
    setActiveLayer(i) { activeLayer = i; },
    sectionLayer: (i) => SECTION_LAYER[clamp(i, 0, SECTION_LAYER.length - 1)],
    sectionCount: SHOTS.length,
    resetView() { userAz.target = 0; userEl.target = 0; },
    pause() { running = false; },
    resume() { if (!running) { running = true; clock.getDelta(); } },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}
