// Integration test: `npm run package` end-to-end Windows packaging.
//
// Validates: Requirements 2.5a, 13.1, 13.2
//
// The test exercises the full Windows packaging path:
//
//   1. Run `npm run package` (which chains `npm run build` and
//      `electron-builder --win`). This is heavyweight — minutes of
//      esbuild, vite, electron-builder, and a native-module rebuild —
//      so the test is gated behind `RUN_PACKAGING_INTEGRATION=1` and
//      only runs on a Windows host. Under a normal `npm test` it is
//      skipped so the suite stays fast.
//
//   2. After the build exits 0, assert that
//      `release/Monitor Setup <version>.exe` is present, where
//      `<version>` is read from `package.json`.
//
//   3. Parse `release/builder-effective-config.yaml` and assert the
//      `win:` and `nsis:` blocks match the pinned snapshot below
//      (Requirement 13.1). The pinned snapshot is the value that the
//      checked-in `electron-builder.yml` produces — any future edit
//      to those two blocks needs to be reflected here too.
//
//   4. Walk the unpacked installer (`release/win-unpacked/`) and
//      assert that every `better_sqlite3.node` file is a PE/COFF
//      binary by checking the first two bytes are `4D 5A` ('MZ', the
//      DOS header magic that prefaces every PE binary). This guards
//      Requirement 2.5a — no Mach-O `better_sqlite3.node` ever ends
//      up inside a Windows installer.
//
// Skip predicate:
//   - host platform must be `win32`
//   - environment variable `RUN_PACKAGING_INTEGRATION` must equal `1`
//
// Both conditions must hold; the test is opt-in via the env var so
// CI runs that do not have a fully buildable Node toolchain (or that
// would take 10+ minutes packaging) are unaffected.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

// js-yaml is already used by the static example test; it has no
// bundled types so we declare the slice we need.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (input: string) => unknown };

const REPO_ROOT = resolve(__dirname, '..', '..');
const RELEASE_DIR = join(REPO_ROOT, 'release');

const SHOULD_RUN =
  process.platform === 'win32' &&
  process.env.RUN_PACKAGING_INTEGRATION === '1';

// ---------------------------------------------------------------------------
// Pinned snapshots (Requirement 13.1)
// ---------------------------------------------------------------------------

// These two objects are the expected resolved values for the `win:`
// and `nsis:` blocks in `release/builder-effective-config.yaml` after
// `electron-builder` resolves the checked-in `electron-builder.yml`.
// They are intentionally explicit so a future edit that drops a key
// or changes a value fails this test loudly.
const EXPECTED_WIN_BLOCK = {
  target: 'nsis',
  icon: 'build/icon.ico',
  signAndEditExecutable: false,
} as const;

const EXPECTED_NSIS_BLOCK = {
  oneClick: false,
  allowToChangeInstallationDirectory: true,
  installerIcon: 'build/icon.ico',
  uninstallerIcon: 'build/icon.ico',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
  ) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('package.json#version missing or empty');
  }
  return pkg.version;
}

function loadEffectiveConfig(): Record<string, unknown> {
  const path = join(RELEASE_DIR, 'builder-effective-config.yaml');
  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `builder-effective-config.yaml did not parse as a mapping: ${path}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Recursively collect every file path under `root` whose basename
 * is `better_sqlite3.node`. Used to walk the unpacked installer
 * tree. Returns absolute paths.
 */
function findBetterSqliteBinaries(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && entry === 'better_sqlite3.node') {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * A PE/COFF binary always starts with the 2-byte DOS header magic
 * `4D 5A` (ASCII `MZ`). A Mach-O binary starts with one of
 * `FE ED FA CE`, `FE ED FA CF`, `CE FA ED FE`, or `CF FA ED FE`. We
 * only need the PE check here; the mac integration test handles the
 * Mach-O side.
 */
function isPECoffBinary(path: string): boolean {
  const head = readFileSync(path).subarray(0, 2);
  return head[0] === 0x4d && head[1] === 0x5a;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  'package-win integration (Requirements 2.5a, 13.1, 13.2)',
  () => {
    // electron-builder + npm rebuild + tsc + vite is minutes of work.
    // Give the suite a generous ceiling; the build exit status is the
    // only signal we care about and we do not retry.
    const TEN_MINUTES_MS = 10 * 60 * 1000;

    beforeAll(() => {
      // Use shell: true so `npm` resolves on Windows hosts where the
      // shim is `npm.cmd` rather than a literal `npm` on PATH.
      const result = spawnSync('npm', ['run', 'package'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        shell: true,
        // Cap stdout/stderr capture; electron-builder is chatty and
        // we only need the exit status for the pass/fail decision.
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) {
        throw new Error(
          `npm run package exited ${result.status}\n` +
            `stdout (last 4kB):\n${(result.stdout ?? '').slice(-4096)}\n` +
            `stderr (last 4kB):\n${(result.stderr ?? '').slice(-4096)}`,
        );
      }
    }, TEN_MINUTES_MS);

    it(
      'produces release/Monitor Setup <version>.exe',
      () => {
        const version = readPackageVersion();
        const installer = join(
          RELEASE_DIR,
          `Monitor Setup ${version}.exe`,
        );
        expect(
          existsSync(installer),
          `installer missing at ${installer}`,
        ).toBe(true);
        expect(statSync(installer).size).toBeGreaterThan(0);
      },
      TEN_MINUTES_MS,
    );

    it(
      'effective-config win: block matches the pinned snapshot (Requirement 13.1)',
      () => {
        const cfg = loadEffectiveConfig();
        expect(cfg.win).toEqual(EXPECTED_WIN_BLOCK);
      },
      TEN_MINUTES_MS,
    );

    it(
      'effective-config nsis: block matches the pinned snapshot (Requirement 13.1)',
      () => {
        const cfg = loadEffectiveConfig();
        expect(cfg.nsis).toEqual(EXPECTED_NSIS_BLOCK);
      },
      TEN_MINUTES_MS,
    );

    it(
      'every better_sqlite3.node in the unpacked installer is PE/COFF (Requirement 2.5a)',
      () => {
        const unpacked = join(RELEASE_DIR, 'win-unpacked');
        expect(
          existsSync(unpacked),
          `release/win-unpacked is missing — did electron-builder run?`,
        ).toBe(true);

        const binaries = findBetterSqliteBinaries(unpacked);
        // The asar.unpacked layout always ships exactly one
        // better_sqlite3.node; if zero are found something is wrong
        // with the rebuild pipeline.
        expect(
          binaries.length,
          `expected at least one better_sqlite3.node under ${unpacked}`,
        ).toBeGreaterThan(0);

        for (const bin of binaries) {
          expect(
            isPECoffBinary(bin),
            `${bin} is not PE/COFF (first two bytes != 4D 5A)`,
          ).toBe(true);
        }
      },
      TEN_MINUTES_MS,
    );
  },
);
