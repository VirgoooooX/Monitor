// Generate the project icon (production assets, not placeholders).
//
// Concept: "Pulse" — a centered emerald dot wrapped in two concentric
// pulse rings on a deep slate squircle. The mark reads as a ping / radar
// ripple — the literal motion of a monitoring tool — and reuses the
// widget's StatusHero dot vocabulary so the brand stays cohesive from
// app icon → tray → window content.
//
// Design priorities:
//   - One central element, generous padding (Apple HIG style)
//   - Strong silhouette: at 16 px the icon collapses to a glowing dot,
//     still recognizable; at 256 px the rings fully resolve.
//   - Single hue (emerald) with opacity steps — no muddy gradients.
//
// Outputs:
//   build/icon.svg       — vector source of truth
//   build/icon.ico       — multi-size ICO (16/24/32/48/64/128/256)
//   build/icon.png       — 512x512 marketing PNG
//   build/tray-icon.png  — 32x32 tray icon (simplified for small size)
//
// Run:
//   node scripts/gen-icons.mjs   (or `npm run icons`)

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeflate } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '..', 'build');
mkdirSync(buildDir, { recursive: true });

// ---------------------------------------------------------------------------
// Icon spec — single source of truth shared by the SVG and the rasterizer.
// All coordinates are in a 256x256 design canvas.
// ---------------------------------------------------------------------------

const SIZE = 256;

// ---------------------------------------------------------------------------
// Theme palettes — pick the one you want via the THEME constant below.
//
// All themes use a 3-stop diagonal gradient, white pulse on top. The
// pulse always stays white so contrast is consistent across themes.
// ---------------------------------------------------------------------------

const THEMES = {
  // Gemini-style: cool sky → indigo → warm magenta. The reference for
  // "AI brand" gradients in 2024-2025.
  gemini:  [
    { offset: 0.00, color: '#38bdf8' }, // sky-400
    { offset: 0.55, color: '#6366f1' }, // indigo-500
    { offset: 1.00, color: '#d946ef' }, // fuchsia-500
  ],

  // Aurora — northern lights: cool teal sweeping into warm pink.
  aurora:  [
    { offset: 0.00, color: '#2dd4bf' }, // teal-400
    { offset: 0.50, color: '#8b5cf6' }, // violet-500
    { offset: 1.00, color: '#f472b6' }, // pink-400
  ],

  // Sunset — warm narrative, more "creative tool" energy.
  sunset:  [
    { offset: 0.00, color: '#fbbf24' }, // amber-400
    { offset: 0.50, color: '#f43f5e' }, // rose-500
    { offset: 1.00, color: '#c026d3' }, // fuchsia-600
  ],

  // Cosmic — deep, dramatic: indigo into violet into fuchsia. Stripe-ish.
  cosmic:  [
    { offset: 0.00, color: '#4f46e5' }, // indigo-600
    { offset: 0.50, color: '#7c3aed' }, // violet-600
    { offset: 1.00, color: '#c026d3' }, // fuchsia-600
  ],

  // Ocean — cooler, more "system tool" feel; safer for enterprise.
  ocean:   [
    { offset: 0.00, color: '#22d3ee' }, // cyan-400
    { offset: 0.55, color: '#3b82f6' }, // blue-500
    { offset: 1.00, color: '#4338ca' }, // indigo-700
  ],

  // Mint — the previous emerald → cyan single-family palette, kept as a
  // baseline for comparison.
  mint:    [
    { offset: 0.00, color: '#4ade80' }, // green-400
    { offset: 0.55, color: '#10b981' }, // emerald-500
    { offset: 1.00, color: '#0891b2' }, // cyan-600
  ],
};

// Which theme produces the canonical build/icon.* outputs. The script
// always emits a preview PNG for *every* theme into build/icons-preview/
// so you can compare side-by-side, then change ACTIVE_THEME to pick.
const ACTIVE_THEME = 'mint';

const PALETTE = {
  bgStops: THEMES[ACTIVE_THEME],
  pulse: '#ffffff',
  innerStroke: '#ffffff',
};

// Helper: build a SPEC object for a given theme name. Used by the
// preview-grid generator below.
function specForTheme(themeName, base = SPEC) {
  return {
    ...base,
    bg: { stops: THEMES[themeName], direction: 'diagonal' },
  };
}

// Full-fidelity spec used at 48 px and above.
const SPEC = {
  size: SIZE,
  cornerRadius: 56,                                        // ~22% (Win11/iOS squircle)
  bg: { stops: PALETTE.bgStops, direction: 'diagonal' },   // 'vertical' | 'horizontal' | 'diagonal'
  // Subtle bevel highlight so the squircle feels lifted, not flat.
  innerStroke: { width: 1.5, color: PALETTE.innerStroke, alpha: 0.18 },
  pulse: {
    cx: 128,
    cy: 128,
    color: PALETTE.pulse,
    // Soft white halo behind the dot — adds dimension on the brand ground.
    glow: { radius: 116, alpha: 0.18 },
    dot: { radius: 22, alpha: 1.0 },
    rings: [
      { radius: 60,  strokeWidth: 7, alpha: 0.85 },
      { radius: 100, strokeWidth: 7, alpha: 0.40 },
    ],
  },
};

// Simplified spec for small targets (16-32 px). The outer ring would
// alias to noise below ~40 px, so we drop it and beef up the dot.
const SPEC_TRAY = {
  ...SPEC,
  pulse: {
    cx: 128,
    cy: 128,
    color: PALETTE.pulse,
    glow: { radius: 100, alpha: 0.22 },
    dot: { radius: 36, alpha: 1.0 },
    rings: [
      { radius: 84, strokeWidth: 12, alpha: 0.75 },
    ],
  },
};

// ---------------------------------------------------------------------------
// SVG generator
// ---------------------------------------------------------------------------

function toSvg(spec) {
  const { size, cornerRadius: r, bg, innerStroke, pulse } = spec;

  const ringsSvg = pulse.rings
    .map(
      (ring) =>
        `<circle cx="${pulse.cx}" cy="${pulse.cy}" r="${ring.radius}" fill="none" stroke="${pulse.color}" stroke-width="${ring.strokeWidth}" stroke-opacity="${ring.alpha}"/>`,
    )
    .join('\n  ');

  const glowSvg = pulse.glow
    ? `
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${pulse.color}" stop-opacity="${pulse.glow.alpha}"/>
      <stop offset="100%" stop-color="${pulse.color}" stop-opacity="0"/>
    </radialGradient>`
    : '';
  const glowShape = pulse.glow
    ? `<circle cx="${pulse.cx}" cy="${pulse.cy}" r="${pulse.glow.radius}" fill="url(#glow)"/>`
    : '';

  // Background gradient — single source of truth for SVG; the rasterizer
  // mirrors the same direction logic.
  const dir = bg.direction || 'vertical';
  const gradCoords =
    dir === 'horizontal' ? 'x1="0" y1="0" x2="1" y2="0"' :
    dir === 'diagonal'   ? 'x1="0" y1="0" x2="1" y2="1"' :
                           'x1="0" y1="0" x2="0" y2="1"';
  const bgStops = (bg.stops || [
    { offset: 0, color: bg.from },
    { offset: 1, color: bg.to },
  ])
    .map((s) => `      <stop offset="${(s.offset * 100).toFixed(2)}%" stop-color="${s.color}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" ${gradCoords}>
${bgStops}
    </linearGradient>${glowSvg}
  </defs>

  <!-- Background squircle -->
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#bg)"/>

  <!-- Subtle inner highlight -->
  <rect x="${innerStroke.width / 2}" y="${innerStroke.width / 2}"
        width="${size - innerStroke.width}" height="${size - innerStroke.width}"
        rx="${r - innerStroke.width / 2}" ry="${r - innerStroke.width / 2}"
        fill="none"
        stroke="${innerStroke.color}" stroke-opacity="${innerStroke.alpha}"
        stroke-width="${innerStroke.width}"/>

  <!-- Ambient glow behind the pulse (drawn before rings) -->
  ${glowShape}

  <!-- Pulse rings -->
  ${ringsSvg}

  <!-- Core dot -->
  <circle cx="${pulse.cx}" cy="${pulse.cy}" r="${pulse.dot.radius}" fill="${pulse.color}" fill-opacity="${pulse.dot.alpha}"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Pure-Node rasterizer (supersampled SDF rendering, no native deps)
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Bad hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpRgb(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

// Source-over compositing into a premultiplied float RGBA buffer.
function blend(buf, W, x, y, sr, sg, sb, sa) {
  if (x < 0 || y < 0 || x >= W || y >= W || sa <= 0) return;
  const i = (y * W + x) * 4;
  const k = 1 - sa;
  buf[i + 0] = sr * sa + buf[i + 0] * k;
  buf[i + 1] = sg * sa + buf[i + 1] * k;
  buf[i + 2] = sb * sa + buf[i + 2] * k;
  buf[i + 3] = sa + buf[i + 3] * k;
}

// Iterate pixels in the bounding rectangle of a centered circle.
function forEachPixelInCircle(W, cx, cy, R, fn) {
  const minX = Math.max(0, Math.floor(cx - R - 1));
  const maxX = Math.min(W - 1, Math.ceil(cx + R + 1));
  const minY = Math.max(0, Math.floor(cy - R - 1));
  const maxY = Math.min(W - 1, Math.ceil(cy + R + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) fn(x, y);
  }
}

// Sample a multi-stop gradient at parameter t ∈ [0,1].
// Stops must be sorted by offset and span [0..1].
function sampleStops(stops, t) {
  const u = clamp(t, 0, 1);
  // Linear search is fine for ≤8 stops.
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (u >= a.offset && u <= b.offset) {
      const span = b.offset - a.offset;
      const local = span <= 0 ? 0 : (u - a.offset) / span;
      const [r1, g1, b1] = hexToRgb(a.color);
      const [r2, g2, b2] = hexToRgb(b.color);
      return lerpRgb([r1, g1, b1], [r2, g2, b2], local);
    }
  }
  // Fallback: clamp to nearest endpoint.
  const last = stops[stops.length - 1];
  const [r, g, b] = hexToRgb(u < stops[0].offset ? stops[0].color : last.color);
  return [r, g, b];
}

function rasterize(spec, outSize, ssFactor = 4) {
  const SS = ssFactor;
  const W = outSize * SS;
  const scale = W / spec.size;
  const buf = new Float64Array(W * W * 4);

  // -- 1) Background squircle with multi-stop linear gradient --------------
  {
    const { bg, cornerRadius } = spec;
    const r = cornerRadius * scale;
    // Normalize to a sorted stop array. Supports legacy {from,to} too.
    const stops = bg.stops
      ? [...bg.stops].sort((a, b) => a.offset - b.offset)
      : [
          { offset: 0, color: bg.from },
          { offset: 1, color: bg.to },
        ];
    const dir = bg.direction || 'vertical';
    // Direction unit vector in pixel space, with the gradient parameter
    // t = ((x,y) · d) / |d|² so that t=0 at the start corner and t=1 at
    // the end corner.
    let dx, dy;
    if (dir === 'horizontal')      { dx = W - 1; dy = 0; }
    else if (dir === 'diagonal')   { dx = W - 1; dy = W - 1; }
    else                           { dx = 0;     dy = W - 1; } // vertical
    const denom = dx * dx + dy * dy;

    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const t = denom === 0 ? 0 : (x * dx + y * dy) / denom;
        const [R, G, B] = sampleStops(stops, t);
        const cr = R / 255, cg = G / 255, cb = B / 255;

        // Standard SDF for a centered rounded rectangle:
        //   q   = abs(p) - (b - r)
        //   sdf = length(max(q, 0)) + min(max(q.x, q.y), 0) - r
        // The trailing `- r` is required; without it the corner curves
        // collapse and only the inscribed rectangle gets painted.
        const px = Math.abs(x - W / 2) - (W / 2 - r);
        const py = Math.abs(y - W / 2) - (W / 2 - r);
        const outside = Math.hypot(Math.max(px, 0), Math.max(py, 0));
        const inside = Math.min(0, Math.max(px, py));
        const sdf = outside + inside - r;
        const a = clamp(0.5 - sdf, 0, 1);
        if (a > 0) blend(buf, W, x, y, cr, cg, cb, a);
      }
    }
  }

  // -- 2) Inner highlight stroke ------------------------------------------
  if (spec.innerStroke) {
    const { width, color, alpha } = spec.innerStroke;
    const sw = width * scale;
    const r = (spec.cornerRadius - width / 2) * scale;
    const innerW = (spec.size - width) * scale;
    const cx = W / 2, cy = W / 2;
    const [R, G, B] = hexToRgb(color);
    const cr = R / 255, cg = G / 255, cb = B / 255;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const dx = Math.abs(x - cx) - (innerW / 2 - r);
        const dy = Math.abs(y - cy) - (innerW / 2 - r);
        const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
        const inside = Math.min(0, Math.max(dx, dy));
        // Same correction as the background pass — `- r` is part of the
        // canonical rounded-rect SDF.
        const sdf = outside + inside - r;
        const a = clamp(sw / 2 - Math.abs(sdf) + 0.5, 0, 1) * alpha;
        if (a > 0) blend(buf, W, x, y, cr, cg, cb, a);
      }
    }
  }

  // -- 3) Pulse: ambient glow → rings → core dot --------------------------
  const p = spec.pulse;
  const cxP = p.cx * scale;
  const cyP = p.cy * scale;
  const [pR, pG, pB] = hexToRgb(p.color);
  const cr = pR / 255, cg = pG / 255, cb = pB / 255;

  // 3a) Glow halo — linear falloff matching SVG <radialGradient>:
  // <stop offset=0% opacity=alpha/> → <stop offset=100% opacity=0/>
  // gives `alpha * (1 - d/R)` at distance d.
  if (p.glow) {
    const R = p.glow.radius * scale;
    forEachPixelInCircle(W, cxP, cyP, R, (x, y) => {
      const d = Math.hypot(x - cxP, y - cyP);
      if (d >= R) return;
      const a = p.glow.alpha * (1 - d / R);
      if (a > 0) blend(buf, W, x, y, cr, cg, cb, a);
    });
  }

  // 3b) Concentric rings (stroked circles).
  for (const ring of p.rings) {
    const R = ring.radius * scale;
    const halfSw = (ring.strokeWidth / 2) * scale;
    forEachPixelInCircle(W, cxP, cyP, R + halfSw + 2, (x, y) => {
      const d = Math.hypot(x - cxP, y - cyP);
      const a = clamp(halfSw - Math.abs(d - R) + 0.5, 0, 1) * ring.alpha;
      if (a > 0) blend(buf, W, x, y, cr, cg, cb, a);
    });
  }

  // 3c) Core dot.
  {
    const R = p.dot.radius * scale;
    forEachPixelInCircle(W, cxP, cyP, R + 2, (x, y) => {
      const d = Math.hypot(x - cxP, y - cyP);
      const a = clamp(R - d + 0.5, 0, 1) * p.dot.alpha;
      if (a > 0) blend(buf, W, x, y, cr, cg, cb, a);
    });
  }

  // -- 4) Box-downsample to target, unpremultiply -------------------------
  const out = Buffer.alloc(outSize * outSize * 4);
  const n = SS * SS;
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += buf[i + 0];
          g += buf[i + 1];
          b += buf[i + 2];
          a += buf[i + 3];
        }
      }
      r /= n; g /= n; b /= n; a /= n;
      const o = (y * outSize + x) * 4;
      if (a > 0) {
        out[o + 0] = clamp(Math.round((r / a) * 255), 0, 255);
        out[o + 1] = clamp(Math.round((g / a) * 255), 0, 255);
        out[o + 2] = clamp(Math.round((b / a) * 255), 0, 255);
        out[o + 3] = clamp(Math.round(a * 255), 0, 255);
      } else {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG / ICO encoders
// ---------------------------------------------------------------------------

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function encodePng(rgba, width, height) {
  return new Promise((resolveP) => {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;            // RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const rowSize = 1 + width * 4;
    const raw = Buffer.alloc(height * rowSize);
    for (let y = 0; y < height; y++) {
      raw[y * rowSize] = 0; // filter: None
      rgba.copy(raw, y * rowSize + 1, y * width * 4, (y + 1) * width * 4);
    }

    const deflate = createDeflate({ level: 9 });
    const chunks = [];
    deflate.on('data', (c) => chunks.push(c));
    deflate.on('end', () => {
      const compressed = Buffer.concat(chunks);
      resolveP(Buffer.concat([
        sig,
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', compressed),
        makeChunk('IEND', Buffer.alloc(0)),
      ]));
    });
    deflate.end(raw);
  });
}

// ICO container with multiple PNG-embedded entries (Vista+ format).
function encodeIco(entries) {
  const headerSize = 6 + 16 * entries.length;
  let dataOffset = headerSize;
  const dirEntries = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    let o = 0;
    e.writeUInt8(size >= 256 ? 0 : size, o); o += 1;
    e.writeUInt8(size >= 256 ? 0 : size, o); o += 1;
    e.writeUInt8(0, o); o += 1;             // palette
    e.writeUInt8(0, o); o += 1;             // reserved
    e.writeUInt16LE(1, o); o += 2;          // color planes
    e.writeUInt16LE(32, o); o += 2;         // bits per pixel
    e.writeUInt32LE(png.length, o); o += 4; // PNG byte size
    e.writeUInt32LE(dataOffset, o); o += 4; // PNG offset in file
    dirEntries.push(e);
    dataOffset += png.length;
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);                  // type: ICO
  header.writeUInt16LE(entries.length, 4);

  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.png)]);
}

// ---------------------------------------------------------------------------
// Build & write outputs
// ---------------------------------------------------------------------------

async function main() {
  const activeSpec = specForTheme(ACTIVE_THEME);
  const activeTraySpec = { ...SPEC_TRAY, bg: activeSpec.bg };

  // 1) SVG source of truth (active theme).
  writeFileSync(resolve(buildDir, 'icon.svg'), toSvg(activeSpec));
  console.log(`OK build/icon.svg              [${ACTIVE_THEME}]`);

  // 2) High-res PNG (active theme).
  const png512 = await encodePng(rasterize(activeSpec, 512, 4), 512, 512);
  writeFileSync(resolve(buildDir, 'icon.png'), png512);
  console.log(`OK build/icon.png (512x512)    [${ACTIVE_THEME}]`);

  // 3) Multi-size ICO. Sizes ≤32 use the simplified spec.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const icoEntries = [];
  for (const s of sizes) {
    const spec = s <= 32 ? activeTraySpec : activeSpec;
    const ss = s <= 32 ? 8 : 4;
    const png = await encodePng(rasterize(spec, s, ss), s, s);
    icoEntries.push({ size: s, png });
  }
  writeFileSync(resolve(buildDir, 'icon.ico'), encodeIco(icoEntries));
  console.log(`OK build/icon.ico (${sizes.join(', ')})  [${ACTIVE_THEME}]`);

  // 4) Tray icon (32x32, simplified, active theme).
  const tray = await encodePng(rasterize(activeTraySpec, 32, 8), 32, 32);
  writeFileSync(resolve(buildDir, 'tray-icon.png'), tray);
  console.log(`OK build/tray-icon.png (32x32) [${ACTIVE_THEME}]`);

  // 5) Theme previews — emit one SVG and one 256-PNG per theme so you
  // can compare the same way you'll actually see the icon (SVG = true
  // source; PNG = what ships in the .ico).
  const previewDir = resolve(buildDir, 'icons-preview');
  mkdirSync(previewDir, { recursive: true });

  const themeNames = Object.keys(THEMES);
  const themePngs = {};
  for (const name of themeNames) {
    const spec = specForTheme(name);
    writeFileSync(resolve(previewDir, `${name}.svg`), toSvg(spec));
    const data = rasterize(spec, 256, 4);
    themePngs[name] = data;
    const png = await encodePng(data, 256, 256);
    writeFileSync(resolve(previewDir, `${name}.png`), png);
    console.log(`OK build/icons-preview/${name}.{svg,png}`);
  }

  // 6) Compose a 3x2 grid sheet (with the theme name baked into a
  // simple text-free swatch — order matches THEMES key order).
  const gridCols = 3;
  const gridRows = Math.ceil(themeNames.length / gridCols);
  const cell = 256;
  const gap = 24;
  const padding = 32;
  const gridW = padding * 2 + gridCols * cell + (gridCols - 1) * gap;
  const gridH = padding * 2 + gridRows * cell + (gridRows - 1) * gap;
  const sheet = Buffer.alloc(gridW * gridH * 4);
  // Light neutral background (#f5f5f7) so dark gradients pop.
  for (let i = 0; i < sheet.length; i += 4) {
    sheet[i] = 0xf5; sheet[i + 1] = 0xf5; sheet[i + 2] = 0xf7; sheet[i + 3] = 0xff;
  }
  themeNames.forEach((name, i) => {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    const ox = padding + col * (cell + gap);
    const oy = padding + row * (cell + gap);
    const src = themePngs[name];
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const si = (y * cell + x) * 4;
        const di = ((oy + y) * gridW + (ox + x)) * 4;
        // Alpha-composite the icon over the neutral background.
        const sa = src[si + 3] / 255;
        const k = 1 - sa;
        sheet[di + 0] = Math.round(src[si + 0] * sa + sheet[di + 0] * k);
        sheet[di + 1] = Math.round(src[si + 1] * sa + sheet[di + 1] * k);
        sheet[di + 2] = Math.round(src[si + 2] * sa + sheet[di + 2] * k);
        sheet[di + 3] = 0xff;
      }
    }
  });
  const gridPng = await encodePng(sheet, gridW, gridH);
  writeFileSync(resolve(previewDir, '_compare.png'), gridPng);
  console.log(`OK build/icons-preview/_compare.png (${gridW}x${gridH})`);

  // 7) Index file documenting how to switch.
  const readme =
    `# Icon theme previews\n\n` +
    `Six gradient palettes are rendered here for side-by-side comparison.\n` +
    `See \`_compare.png\` for the grid view.\n\n` +
    `**Active theme**: \`${ACTIVE_THEME}\`\n\n` +
    `## How to switch\n\n` +
    `Open \`scripts/gen-icons.mjs\` and change the \`ACTIVE_THEME\`\n` +
    `constant to one of:\n\n` +
    themeNames.map((n) => `- \`${n}\``).join('\n') +
    `\n\nThen run \`npm run icons\` to rebuild \`build/icon.{svg,ico,png}\`\n` +
    `and \`build/tray-icon.png\` with the new theme.\n`;
  writeFileSync(resolve(previewDir, 'README.md'), readme);
  console.log('OK build/icons-preview/README.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
