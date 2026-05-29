// Integration test: `npm run icons` end-to-end output verification
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.5
//
// The script is the single producer of the seven canonical icon
// artifacts that ship through `electron-builder.yml#extraResources`.
// This integration test runs `npm run icons` in a clean tmp project
// (a copy of `scripts/gen-icons.mjs` is invoked against a tmp build/
// directory) and asserts:
//
//   - all seven outputs exist with size > 0
//   - the ICNS file's TOC contains all ten chunk types from Req 6.1
//   - 16/32/256 RGBA bitmaps are byte-identical between .icns and .ico
//   - icons-preview/ is populated and untouched
//
// We deliberately invoke the real script rather than re-implementing
// the build to catch regressions in the script itself (a refactor
// that breaks the chunk type list, for instance).

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Run the icon generation once for the whole test file. The script
// is deterministic so a single run amortises across every test case.
let workDir: string;
let buildDir: string;

beforeAll(() => {
  // Create a workspace mirroring the repo layout the script needs.
  // The script computes `buildDir` as `<scriptDir>/../build`, so we
  // mirror `scripts/gen-icons.mjs` into a tmp directory and let it
  // resolve the build dir there.
  workDir = mkdtempSync(join(tmpdir(), 'icons-output-int-'));
  mkdirSync(join(workDir, 'scripts'), { recursive: true });
  cpSync(
    join(REPO_ROOT, 'scripts', 'gen-icons.mjs'),
    join(workDir, 'scripts', 'gen-icons.mjs'),
  );
  buildDir = join(workDir, 'build');

  const result = spawnSync(
    process.execPath,
    [join(workDir, 'scripts', 'gen-icons.mjs')],
    { encoding: 'utf8', cwd: workDir },
  );
  if (result.status !== 0) {
    throw new Error(
      `gen-icons.mjs exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Helpers (PNG decode, ICO parse, ICNS parse)
// ---------------------------------------------------------------------------

function decodePng(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  let p = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('ascii');
    const payload = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
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
        case 0: v = row[x]; break;
        case 1: v = (row[x] + left) & 0xff; break;
        case 2: v = (row[x] + up) & 0xff; break;
        case 3: v = (row[x] + Math.floor((left + up) / 2)) & 0xff; break;
        case 4: {
          const pV = left + up - upLeft;
          const pa = Math.abs(pV - left);
          const pb = Math.abs(pV - up);
          const pc = Math.abs(pV - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          v = (row[x] + predictor) & 0xff;
          break;
        }
        default: throw new Error(`unsupported filter ${filter}`);
      }
      dec[x] = v;
    }
    dec.copy(out, y * stride);
    prev = dec;
  }
  return { width, height, rgba: out };
}

function pngsFromIco(buf: Buffer): Buffer[] {
  const count = buf.readUInt16LE(4);
  const out: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const sz = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    out.push(buf.subarray(off, off + sz));
  }
  return out;
}

function parseIcnsChunks(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (buf.subarray(0, 4).toString('ascii') !== 'icns') {
    throw new Error('not an icns file');
  }
  let p = 8;
  while (p < buf.length) {
    const t = buf.subarray(p, p + 4).toString('ascii');
    const l = buf.readUInt32BE(p + 4);
    out.set(t, buf.subarray(p + 8, p + l));
    p += l;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SEVEN_OUTPUTS = [
  'icon.svg',
  'icon.ico',
  'icon.icns',
  'icon.png',
  'tray-icon.png',
  'tray-iconTemplate.png',
  'tray-iconTemplate@2x.png',
];

const TEN_ICNS_TYPES = [
  'ic04', 'ic05', 'ic07', 'ic08', 'ic09',
  'ic10', 'ic11', 'ic12', 'ic13', 'ic14',
];

describe('icons output integration (Requirements 6.1, 6.2, 6.3, 6.5)', () => {
  it('all seven outputs exist with size > 0', () => {
    for (const name of SEVEN_OUTPUTS) {
      const path = join(buildDir, name);
      expect(existsSync(path), `${name} missing`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
  });

  it('icons-preview/ is populated with expected files', () => {
    const previewDir = join(buildDir, 'icons-preview');
    expect(existsSync(previewDir)).toBe(true);
    // The script writes one .svg and one .png per theme plus
    // _compare.png and README.md. Six themes × 2 = 12 + 2 = 14 files.
    const expectedNames = [
      'gemini.svg', 'gemini.png',
      'aurora.svg', 'aurora.png',
      'sunset.svg', 'sunset.png',
      'cosmic.svg', 'cosmic.png',
      'ocean.svg', 'ocean.png',
      'mint.svg', 'mint.png',
      '_compare.png', 'README.md',
    ];
    for (const name of expectedNames) {
      const p = join(previewDir, name);
      expect(existsSync(p), `preview ${name} missing`).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
    }
  });

  it('icon.icns contains all ten required chunk types with non-empty payloads', () => {
    const icns = parseIcnsChunks(readFileSync(join(buildDir, 'icon.icns')));
    for (const t of TEN_ICNS_TYPES) {
      expect(icns.has(t), `chunk ${t} missing`).toBe(true);
      expect((icns.get(t) as Buffer).length).toBeGreaterThan(0);
    }
  });

  it('icon.icns chunk dimensions match Requirement 6.1', () => {
    const icns = parseIcnsChunks(readFileSync(join(buildDir, 'icon.icns')));
    const expected: Record<string, number> = {
      ic04: 16,
      ic11: 32,
      ic05: 32,
      ic12: 64,
      ic07: 128,
      ic13: 256,
      ic08: 256,
      ic14: 512,
      ic09: 512,
      ic10: 1024,
    };
    for (const [type, size] of Object.entries(expected)) {
      const png = icns.get(type) as Buffer;
      const decoded = decodePng(png);
      expect(decoded.width).toBe(size);
      expect(decoded.height).toBe(size);
    }
  });

  it('16/32/256 RGBA bitmaps are byte-identical between .icns and .ico', () => {
    const ico = pngsFromIco(readFileSync(join(buildDir, 'icon.ico')));
    const icns = parseIcnsChunks(readFileSync(join(buildDir, 'icon.icns')));

    function findIcoBySize(sz: number): Buffer {
      for (const png of ico) {
        const d = decodePng(png);
        if (d.width === sz && d.height === sz) return png;
      }
      throw new Error(`ICO has no entry of size ${sz}`);
    }

    // Per Requirement 6.1's chunk-to-size map, 16 → ic04, 32 → ic11
    // (or ic05; both are 32×32 — we use ic11 because it shares the
    // same source bitmap as the 32×32 ICO entry), 256 → ic13.
    const sizeToIcnsType: Record<number, string> = {
      16: 'ic04',
      32: 'ic11',
      256: 'ic13',
    };

    for (const sz of [16, 32, 256]) {
      const fromIco = decodePng(findIcoBySize(sz));
      const fromIcns = decodePng(icns.get(sizeToIcnsType[sz]) as Buffer);
      expect(fromIco.width).toBe(sz);
      expect(fromIcns.width).toBe(sz);
      expect(
        fromIco.rgba.equals(fromIcns.rgba),
        `RGBA mismatch at size ${sz}`,
      ).toBe(true);
    }
  });
});
