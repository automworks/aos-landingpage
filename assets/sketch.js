/*
 * sketch.js — a small "ink on paper" toolkit for three.js
 * ---------------------------------------------------------------------------
 * Everything here exists to make WebGL look like a drafting-table sketch:
 * wobbling ink outlines, pencil hatching, paper-toned fills and hand-drawn
 * figures. No lighting model, no shadows, no gloss. Lines carry the drawing.
 */

import * as THREE from '../vendor/three/three.module.min.js';
import { LineMaterial } from '../vendor/three/lines/LineMaterial.js';
import { LineSegments2 } from '../vendor/three/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/three/lines/LineSegmentsGeometry.js';

export { THREE };

/* ---------------------------------------------------------------- palette */

export const PALETTE = {
  paper:      '#F6F2EA',
  paperRaised:'#FDFBF6',
  ink:        '#181410',
  inkSoft:    '#5C5546',
  inkFaint:   '#8C8472',
  line:       '#E2DACA',
  lineStrong: '#CFC5B0',
  amber:      '#FFCD00',
  amberDeep:  '#C99400',
  layers: ['#4A453D', '#FFCD00', '#17A38B', '#CE3B82', '#181410'],
};

/* ------------------------------------------------------- seeded randomness
 * A drawing should look hand-made but never re-roll itself between frames,
 * so every jitter below comes from a deterministic stream.
 */

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

// Smooth wobble along a path index. Correlated on purpose: white noise reads
// as a ragged star on a 64-segment circle, a low-frequency sine sum reads as
// a wrist.
function wobble(t, seed) {
  return Math.sin(t * 0.37 + seed) * 0.62 +
         Math.sin(t * 0.13 + seed * 2.7) * 0.38;
}

/* ------------------------------------------------------ boiling ink shader
 * Hand-drawn animation "boils": each redrawn frame lands a hair off the last.
 * We reproduce it by nudging every line vertex with value noise that steps a
 * few times a second rather than sliding continuously.
 */

const boilUniforms = {
  uBoilTime: { value: 0 },
  uBoilAmp:  { value: 0.028 },
};

export function setBoil(time, amp) {
  // Stepped, not continuous — continuous drift reads as jelly, steps read as
  // a new pencil pass.
  boilUniforms.uBoilTime.value = Math.floor(time * 7) * 1.37;
  if (amp !== undefined) boilUniforms.uBoilAmp.value = amp;
}

const BOIL_GLSL = /* glsl */`
uniform float uBoilTime;
uniform float uBoilAmp;

float aosHash31(vec3 p){
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}
float aosNoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(aosHash31(i + vec3(0,0,0)), aosHash31(i + vec3(1,0,0)), f.x),
        mix(aosHash31(i + vec3(0,1,0)), aosHash31(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(aosHash31(i + vec3(0,0,1)), aosHash31(i + vec3(1,0,1)), f.x),
        mix(aosHash31(i + vec3(0,1,1)), aosHash31(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
vec3 aosBoil(vec3 p){
  vec3 q = p * 0.62 + uBoilTime;
  return (vec3(
    aosNoise(q),
    aosNoise(q + vec3(31.4, 0.0, 17.2)),
    aosNoise(q + vec3(0.0, 57.1, 91.3))
  ) - 0.5) * uBoilAmp;
}
`;

/**
 * LineMaterial, patched so the line boils.
 *
 * The stock vertex shader reads `instanceStart` / `instanceEnd` attributes in
 * a dozen places. Rather than rewrite each use, we rename the *declarations*
 * and open main() with same-named locals holding the boiled values, so every
 * downstream line picks up the offset untouched.
 */
export function inkMaterial(opts = {}) {
  const mat = new LineMaterial({
    color: new THREE.Color(opts.color || PALETTE.ink),
    linewidth: opts.width || 1.7,
    transparent: true,
    opacity: opts.opacity !== undefined ? opts.opacity : 1,
    dashed: !!opts.dashed,
    dashSize: opts.dashSize || 0.22,
    gapSize: opts.gapSize || 0.16,
    depthTest: opts.depthTest !== false,
    depthWrite: opts.depthWrite === true,
  });
  mat.worldUnits = false;   // linewidth in CSS pixels, so weight stays legible at any zoom
  mat.toneMapped = false;

  if (opts.boil !== false) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBoilTime = boilUniforms.uBoilTime;
      shader.uniforms.uBoilAmp  = boilUniforms.uBoilAmp;
      shader.vertexShader = shader.vertexShader
        .replace('attribute vec3 instanceStart;', 'attribute vec3 aInkStart;')
        .replace('attribute vec3 instanceEnd;',   'attribute vec3 aInkEnd;')
        .replace('void main() {', BOIL_GLSL + `
void main() {
	vec3 instanceStart = aInkStart + aosBoil(aInkStart);
	vec3 instanceEnd   = aInkEnd   + aosBoil(aInkEnd);
`);
    };
    mat.customProgramCacheKey = () => 'aos-ink' + (opts.dashed ? '-dash' : '');
  }
  return mat;
}

/* ------------------------------------------------------------ ink builder
 * Accumulates raw segment endpoints, then bakes one LineSegments2. Batching
 * matters: a tier's whole outline is a single draw call, which is also the
 * unit we fade and tint when a layer goes active.
 */

export class Ink {
  constructor(seed = 7) {
    this.pts = [];
    this.rand = rng(seed);
    this.seed = seed;
    this._jitter = 0.012;
  }

  /** Baked-in hand tremor, on top of the per-frame shader boil. */
  jitter(amount) { this._jitter = amount; return this; }

  _j(p, t) {
    const a = this._jitter;
    if (!a) return p;
    return [
      p[0] + wobble(t, this.seed) * a,
      p[1] + wobble(t + 11.3, this.seed * 1.7) * a,
      p[2] + wobble(t + 23.9, this.seed * 2.9) * a,
    ];
  }

  seg(a, b) {
    this.pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    return this;
  }

  /** Polyline with correlated wobble so it bends like a drawn stroke. */
  poly(points, close = false) {
    const n = points.length;
    if (n < 2) return this;
    const w = points.map((p, i) => this._j(p, i));
    for (let i = 0; i < n - 1; i++) this.seg(w[i], w[i + 1]);
    if (close) this.seg(w[n - 1], w[0]);
    return this;
  }

  /** Horizontal circle (normal +Y) — the tower is built from these. */
  circle(cx, cy, cz, r, segs = 72, arcFrom = 0, arcTo = Math.PI * 2) {
    const pts = [];
    const span = arcTo - arcFrom;
    for (let i = 0; i <= segs; i++) {
      const a = arcFrom + (i / segs) * span;
      pts.push([cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r]);
    }
    return this.poly(pts, false);
  }

  /** Circle standing up, facing the camera-ish (normal +Z). */
  ring(cx, cy, cz, r, segs = 72) {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz]);
    }
    return this.poly(pts);
  }

  /** Axis-aligned box outline. */
  box(cx, cy, cz, w, h, d) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const c = [
      [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],
      [x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1],
    ];
    const e = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [a, b] of e) this.seg(c[a], c[b]);
    return this;
  }

  /** A rectangle drawn on the XY plane at depth z (for panels and screens). */
  rect(cx, cy, cz, w, h) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    return this.poly([[x0,y0,cz],[x1,y0,cz],[x1,y1,cz],[x0,y1,cz]], true);
  }

  /**
   * A tier: two rims and a run of vertical ticks between them. The ticks are
   * what make a cylinder read as a drawn slab instead of a shaded tube.
   */
  disc(cx, cy, cz, r, thickness, ticks = 40) {
    this.circle(cx, cy, cz, r);
    this.circle(cx, cy - thickness, cz, r);
    for (let i = 0; i < ticks; i++) {
      const a = (i / ticks) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      this.seg([x, cy, z], [x, cy - thickness, z]);
    }
    return this;
  }

  count() { return this.pts.length / 6; }

  build(opts = {}) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(this.pts);
    // The boil shader reads these aliases; they share the interleaved buffer
    // the stock attributes already point at, so nothing is uploaded twice.
    geo.setAttribute('aInkStart', geo.getAttribute('instanceStart'));
    geo.setAttribute('aInkEnd',   geo.getAttribute('instanceEnd'));

    const mat = inkMaterial(opts);
    const mesh = new LineSegments2(geo, mat);
    mesh.computeLineDistances();
    mesh.frustumCulled = false;
    mesh.renderOrder = opts.renderOrder !== undefined ? opts.renderOrder : 10;
    return mesh;
  }
}

/* ------------------------------------------------------- canvas texturing */

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, x: c.getContext('2d') };
}

function toTexture(c, { repeat = null } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.needsUpdate = true;
  return t;
}

/** A jittered stroke, drawn twice like a pen going over its own line. */
function roughStroke(x, pts, { passes = 2, amp = 1.4, width = 2, color = PALETTE.ink, seed = 3, close = false } = {}) {
  const r = rng(seed);
  x.strokeStyle = color;
  x.lineWidth = width;
  x.lineCap = 'round';
  x.lineJoin = 'round';
  for (let p = 0; p < passes; p++) {
    x.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const dx = (r() - 0.5) * amp, dy = (r() - 0.5) * amp;
      const px = pts[i][0] + dx, py = pts[i][1] + dy;
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    if (close) x.closePath();
    x.globalAlpha = p === 0 ? 1 : 0.5;
    x.stroke();
  }
  x.globalAlpha = 1;
}

function roughRect(x, rx, ry, rw, rh, opts = {}) {
  roughStroke(x, [[rx,ry],[rx+rw,ry],[rx+rw,ry+rh],[rx,ry+rh]], { close: true, ...opts });
}

/** Diagonal pencil hatching — used on tier undersides and shadowed rims. */
export function hatchTexture({ size = 256, gap = 12, color = PALETTE.inkSoft, alpha = 0.5, seed = 11, bg = null, repeat = [1, 1] } = {}) {
  const { c, x } = canvas2d(size, size);
  x.clearRect(0, 0, size, size);
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, size, size); }
  const r = rng(seed);
  x.strokeStyle = color;
  x.globalAlpha = alpha;
  x.lineWidth = 1.15;
  x.lineCap = 'round';
  for (let i = -size; i < size * 2; i += gap) {
    x.beginPath();
    const j = () => (r() - 0.5) * 3;
    x.moveTo(i + j(), -2 + j());
    x.lineTo(i + size + j(), size + 2 + j());
    x.stroke();
  }
  x.globalAlpha = 1;
  return toTexture(c, { repeat });
}

/* ------------------------------------------------------------- figures
 * The people in the reference drawing are the whole point: an operating model
 * is only real when you can see who is standing in it. Drawn flat and
 * billboarded, which is both cheaper and truer to the illustration than
 * modelled bodies would be.
 */

const POSES = ['stand', 'arms', 'point', 'sit', 'walk', 'laptop'];

function drawFigure(x, w, h, pose, seed, inkColor) {
  const r = rng(seed);
  const cx = w / 2;
  const headR = h * 0.072;
  const headY = h * 0.13;
  const shoulderY = headY + headR * 1.9;
  const hipY = h * 0.545;
  const footY = h * 0.955;
  const sw = h * 0.052;      // half shoulder width
  const lw = Math.max(2, h * 0.017);
  const opt = (s) => ({ width: lw, amp: h * 0.006, seed: seed + s, color: inkColor, passes: 2 });

  // head
  const hp = [];
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    hp.push([cx + Math.cos(a) * headR, headY + Math.sin(a) * headR * 1.08]);
  }
  roughStroke(x, hp, { ...opt(1), close: true });
  x.globalAlpha = 0.14;
  x.fillStyle = inkColor;
  x.beginPath(); x.ellipse(cx, headY, headR, headR * 1.08, 0, 0, Math.PI * 2); x.fill();
  x.globalAlpha = 1;

  // neck
  roughStroke(x, [[cx, headY + headR], [cx, shoulderY]], opt(2));

  if (pose === 'sit') {
    const kneeY = hipY + h * 0.10;
    roughStroke(x, [[cx, shoulderY], [cx + sw * 0.2, hipY]], opt(3));
    roughStroke(x, [[cx - sw, shoulderY + h * 0.01], [cx + sw, shoulderY + h * 0.01]], opt(4));
    roughStroke(x, [[cx + sw * 0.2, hipY], [cx + sw * 1.5, kneeY], [cx + sw * 1.5, footY]], opt(5));
    roughStroke(x, [[cx + sw * 0.2, hipY], [cx + sw * 1.9, kneeY + h * 0.01], [cx + sw * 1.9, footY]], opt(6));
    roughStroke(x, [[cx - sw * 0.7, shoulderY + h * 0.02], [cx + sw * 0.9, hipY - h * 0.01]], opt(7));
    return;
  }

  // torso + shoulders
  roughStroke(x, [[cx, shoulderY], [cx + (r() - 0.5) * sw * 0.3, hipY]], opt(3));
  roughStroke(x, [[cx - sw, shoulderY + h * 0.008], [cx + sw, shoulderY + h * 0.008]], opt(4));

  // legs
  const stride = pose === 'walk' ? sw * 1.5 : sw * 0.75;
  roughStroke(x, [[cx, hipY], [cx - stride, footY]], opt(5));
  roughStroke(x, [[cx, hipY], [cx + stride * (pose === 'walk' ? 0.5 : 1), footY]], opt(6));

  // arms
  const elbowY = shoulderY + (hipY - shoulderY) * 0.55;
  if (pose === 'point') {
    roughStroke(x, [[cx - sw, shoulderY], [cx - sw * 1.3, elbowY], [cx - sw * 0.9, hipY]], opt(7));
    roughStroke(x, [[cx + sw, shoulderY], [cx + sw * 2.1, shoulderY - h * 0.055], [cx + sw * 3.1, shoulderY - h * 0.10]], opt(8));
  } else if (pose === 'arms') {
    roughStroke(x, [[cx - sw, shoulderY], [cx - sw * 1.25, elbowY], [cx + sw * 0.5, elbowY + h * 0.012]], opt(7));
    roughStroke(x, [[cx + sw, shoulderY], [cx + sw * 1.25, elbowY - h * 0.012], [cx - sw * 0.5, elbowY]], opt(8));
  } else if (pose === 'laptop') {
    roughStroke(x, [[cx - sw, shoulderY], [cx - sw * 1.2, elbowY], [cx - sw * 0.2, elbowY + h * 0.02]], opt(7));
    roughStroke(x, [[cx + sw, shoulderY], [cx + sw * 1.2, elbowY], [cx + sw * 0.2, elbowY + h * 0.02]], opt(8));
    roughRect(x, cx - sw * 1.1, elbowY + h * 0.012, sw * 2.2, h * 0.035, { ...opt(9), passes: 1 });
  } else {
    roughStroke(x, [[cx - sw, shoulderY], [cx - sw * 1.35, elbowY], [cx - sw * 1.15, hipY + h * 0.015]], opt(7));
    roughStroke(x, [[cx + sw, shoulderY], [cx + sw * 1.35, elbowY], [cx + sw * 1.15, hipY + h * 0.015]], opt(8));
  }
}

const figureCache = new Map();

/** A billboarded sketch person. `tint` lets a layer colour its own roster. */
export function figureTexture(pose = 'stand', seed = 1, inkColor = PALETTE.ink) {
  const key = `${pose}|${seed}|${inkColor}`;
  if (figureCache.has(key)) return figureCache.get(key);
  const W = 168, H = 384;
  const { c, x } = canvas2d(W, H);
  drawFigure(x, W, H, pose, seed, inkColor);
  const t = toTexture(c);
  figureCache.set(key, t);
  return t;
}

export function makeFigure({ pose, seed, height = 1.0, color = PALETTE.ink, opacity = 1 }) {
  const tex = figureTexture(pose || POSES[seed % POSES.length], seed, color);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(height * (168 / 384), height, 1);
  s.center.set(0.5, 0);       // anchor at the feet so they stand on the tier
  s.renderOrder = 12;
  return s;
}

export const FIGURE_POSES = POSES;

/* --------------------------------------------------- peripheral diagrams
 * The reference drawing is surrounded by half-finished charts and flow
 * fragments — the residue of thinking. These are atmosphere, drawn faint.
 */

const CHART_KINDS = ['bars', 'line', 'flow', 'grid', 'pie', 'dots', 'stack'];

export function chartTexture(kind, seed = 5) {
  const W = 420, H = 300;
  const { c, x } = canvas2d(W, H);
  const r = rng(seed);
  const ink = PALETTE.inkSoft;
  const amber = PALETTE.amber;
  const pad = 34;
  const o = (s, extra = {}) => ({ width: 2.1, amp: 1.6, seed: seed + s, color: ink, ...extra });

  if (kind === 'bars') {
    roughStroke(x, [[pad, pad], [pad, H - pad], [W - pad, H - pad]], o(1));
    const n = 6;
    for (let i = 0; i < n; i++) {
      const bw = (W - pad * 2) / n * 0.6;
      const bx = pad + ((W - pad * 2) / n) * i + bw * 0.28;
      const bh = (0.25 + r() * 0.68) * (H - pad * 2);
      if (i === 3) { x.globalAlpha = 0.85; x.fillStyle = amber; x.fillRect(bx, H - pad - bh, bw, bh); x.globalAlpha = 1; }
      roughRect(x, bx, H - pad - bh, bw, bh, o(10 + i, { passes: 1 }));
    }
  } else if (kind === 'line') {
    roughStroke(x, [[pad, pad], [pad, H - pad], [W - pad, H - pad]], o(1));
    const pts = [];
    let y = H * 0.72;
    for (let i = 0; i <= 8; i++) {
      y = Math.max(pad + 10, Math.min(H - pad - 8, y - r() * 34 + 8));
      pts.push([pad + ((W - pad * 2) / 8) * i, y]);
    }
    roughStroke(x, pts, o(2, { width: 2.8, color: PALETTE.ink }));
    x.fillStyle = amber;
    x.beginPath(); x.arc(pts[8][0], pts[8][1], 7, 0, Math.PI * 2); x.fill();
    roughStroke(x, [[pts[8][0] - 7, pts[8][1]], [pts[8][0] + 7, pts[8][1]]], o(3, { width: 1.5 }));
  } else if (kind === 'flow') {
    const boxes = [[pad, 40], [pad + 150, 40], [pad + 150, 150], [pad + 300, 150]];
    boxes.forEach((b, i) => {
      if (i === 1) { x.globalAlpha = 0.8; x.fillStyle = amber; x.fillRect(b[0], b[1], 92, 58); x.globalAlpha = 1; }
      roughRect(x, b[0], b[1], 92, 58, o(20 + i, { passes: 1 }));
    });
    roughStroke(x, [[pad + 92, 69], [pad + 150, 69]], o(24));
    roughStroke(x, [[pad + 196, 98], [pad + 196, 150]], o(25));
    roughStroke(x, [[pad + 242, 179], [pad + 300, 179]], o(26));
  } else if (kind === 'grid') {
    for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 5; gx++) {
      const bx = pad + gx * 66, by = pad + gy * 56;
      const hot = (gx + gy * 5) % 7 === 3;
      if (hot) { x.globalAlpha = 0.8; x.fillStyle = amber; x.fillRect(bx, by, 46, 38); x.globalAlpha = 1; }
      roughRect(x, bx, by, 46, 38, o(30 + gx + gy * 5, { passes: 1, width: 1.7 }));
    }
  } else if (kind === 'pie') {
    const cx = W / 2, cy = H / 2, rad = 92;
    const cp = [];
    for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; cp.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); }
    x.globalAlpha = 0.85; x.fillStyle = amber;
    x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, rad, -Math.PI / 2, 0.55); x.closePath(); x.fill();
    x.globalAlpha = 1;
    roughStroke(x, cp, o(1, { close: true }));
    roughStroke(x, [[cx, cy], [cx, cy - rad]], o(2));
    roughStroke(x, [[cx, cy], [cx + Math.cos(0.55) * rad, cy + Math.sin(0.55) * rad]], o(3));
  } else if (kind === 'dots') {
    for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 9; gx++) {
      const bx = pad + gx * 40, by = pad + gy * 40;
      const on = r() > 0.55;
      x.fillStyle = on ? (r() > 0.75 ? amber : ink) : 'transparent';
      if (on) { x.beginPath(); x.arc(bx, by, 6.5, 0, Math.PI * 2); x.fill(); }
      else { x.strokeStyle = ink; x.globalAlpha = 0.5; x.lineWidth = 1.4; x.beginPath(); x.arc(bx, by, 6.5, 0, Math.PI * 2); x.stroke(); x.globalAlpha = 1; }
    }
  } else { // stack
    let y = H - pad;
    for (let i = 0; i < 5; i++) {
      const hgt = 30 + r() * 14;
      y -= hgt + 6;
      if (i === 2) { x.globalAlpha = 0.8; x.fillStyle = amber; x.fillRect(pad, y, W - pad * 2, hgt); x.globalAlpha = 1; }
      roughRect(x, pad, y, W - pad * 2, hgt, o(40 + i, { passes: 1 }));
    }
  }
  return toTexture(c);
}

export function makeChart(kind, seed, width = 3) {
  const tex = chartTexture(kind || CHART_KINDS[seed % CHART_KINDS.length], seed);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.55,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, width * (300 / 420)), mat);
  m.renderOrder = 4;
  return m;
}

export const CHART_KINDS_LIST = CHART_KINDS;

/* ---------------------------------------------------------------- fills
 * Flat paper-toned surfaces that sit *behind* the ink. polygonOffset keeps
 * them from fighting the outlines they belong to.
 */

export function fillMaterial(color = PALETTE.paperRaised, opacity = 1, extra = {}) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    polygonOffset: true,
    polygonOffsetFactor: 1.4,
    polygonOffsetUnits: 1.4,
    toneMapped: false,
    ...extra,
  });
}

/** The amber sun behind the tower, with a deliberately imperfect edge. */
export function sunTexture(size = 1024) {
  const { c, x } = canvas2d(size, size);
  const r = rng(21);
  const cx = size / 2, cy = size / 2, rad = size * 0.44;
  x.fillStyle = PALETTE.amber;
  x.beginPath();
  for (let i = 0; i <= 220; i++) {
    const a = (i / 220) * Math.PI * 2;
    const rr = rad * (1 + Math.sin(a * 7 + 1.2) * 0.006 + (r() - 0.5) * 0.012);
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
    if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
  }
  x.closePath();
  x.fill();

  // Crayon-ish grain so the flood does not read as a vector circle.
  x.globalCompositeOperation = 'destination-out';
  x.strokeStyle = 'rgba(0,0,0,0.10)';
  x.lineWidth = 3;
  for (let i = 0; i < 900; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * rad;
    const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
    const len = 8 + r() * 40;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + len, py + len * 0.9); x.stroke();
  }
  x.globalCompositeOperation = 'source-over';
  return toTexture(c);
}
