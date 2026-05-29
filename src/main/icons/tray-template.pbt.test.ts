// Feature: macos-platform-support, Property 7: tray template assets are monochrome black-on-transparent
//
// Validates: Requirements 5.1, 5.2, 5.7
//
// Build/tray-iconTemplate.png and build/tray-iconTemplate@2x.png ship
// in the macOS package's `Resources/` directory. AppKit treats them
// as Template_Image — it ignores the RGB channels and recolours via
// the alpha mask — but Apple's own template assets are always pure
// black on a transparent background, so we hold the same standard.
//
// The property: every pixel `(r, g, b, a)` satisfies
//   `a === 0  OR  (a === 255 AND r === 0 AND g === 0 AND b === 0)`.
// And dimensions are exactly 24×24 (1x) and 48×48 (@2x).
//
// We do not generate inputs — the property quantifies over every
// pixel of two on-disk assets — but `fast-check` is still useful
// because its random shrinking helps narrow failures to a single
// offending coordinate when the build accidentally introduces a
// non-monochrome pixel.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TEMPLATE_1X = resolve(REPO_ROOT, 'build', 'tray-iconTemplate.png');
const TEMPLATE_2X = resolve(REPO_ROOT, 'build', 'tray-iconTemplate@2x.png');

// ---------------------------------------------------------------------------
// Minimal pure-Node PNG decoder
// ---------------------------------------------------------------------------
//
// The repo's `gen-icons.mjs` emits truecolour-with-alpha (color type 6,
// bit depth 8), one IDAT chunk, no interlacing. The decoder below
// supports exactly that shape — the tests fail loudly on anything
// else, which is the desired regression signal if the encoder ever
// changes format.
function decodePng(buf: Buffer): {
  width: number;
  height: number;
  rgba: Buffer;
} {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) {
      throw new Error('not a PNG signature');
    }
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('ascii');
    const payload = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      bitDepth = payload[8];
      colorType = payload[9];
      const interlace = payload[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(payload);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const dec = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? dec[x - 4] : 0;
      const up = prev[x];
      const upLeft = x >= 4 ? prev[x - 4] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = row[x];
          break;
        case 1:
          v = (row[x] + left) & 0xff;
          break;
        case 2:
          v = (row[x] + up) & 0xff;
          break;
        case 3:
          v = (row[x] + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4: {
          // Paeth predictor.
          const pV = left + up - upLeft;
          const pa = Math.abs(pV - left);
          const pb = Math.abs(pV - up);
          const pc = Math.abs(pV - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          v = (row[x] + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      dec[x] = v;
    }
    dec.copy(out, y * stride);
    prev = dec;
  }
  return { width, height, rgba: out };
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

const ASSETS: ReadonlyArray<{ path: string; expected: number }> = [
  { path: TEMPLATE_1X, expected: 24 },
  { path: TEMPLATE_2X, expected: 48 },
];

describe('Property 7: tray template assets are monochrome black-on-transparent', () => {
  // Both files must be present. If either is missing the build is
  // broken and the rest of the property is moot.
  it('both template assets exist on disk', () => {
    for (const { path } of ASSETS) {
      expect(existsSync(path), `${path} not found — run npm run icons`).toBe(true);
    }
  });

  for (const { path, expected } of ASSETS) {
    it(`${path.split(/[\\/]/).pop()} is exactly ${expected}x${expected}`, () => {
      const decoded = decodePng(readFileSync(path));
      expect(decoded.width).toBe(expected);
      expect(decoded.height).toBe(expected);
    });

    it(`every pixel of ${path.split(/[\\/]/).pop()} is transparent or pure black`, () => {
      const decoded = decodePng(readFileSync(path));
      // Generate (x, y) coordinates; fast-check shrinks toward the
      // simplest offending coordinate on failure.
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: decoded.width - 1 }),
          fc.integer({ min: 0, max: decoded.height - 1 }),
          (x, y) => {
            const i = (y * decoded.width + x) * 4;
            const r = decoded.rgba[i];
            const g = decoded.rgba[i + 1];
            const b = decoded.rgba[i + 2];
            const a = decoded.rgba[i + 3];
            const ok =
              a === 0 || (a === 255 && r === 0 && g === 0 && b === 0);
            if (!ok) {
              throw new Error(
                `pixel (${r},${g},${b},${a}) at (${x},${y}) violates monochrome constraint`,
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  }
});
