// Integration test: `npm run package:mac` end-to-end macOS packaging.
//
// Validates: Requirements 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.5, 14.2,
//            14.3, 14.6
//
// The test exercises the full mac packaging path:
//
//   1. Run `npm run package:mac` (which chains `prepackage:mac`,
//      `build`, and `electron-builder --mac --x64 --arm64`). This is
//      heavyweight — minutes of esbuild, vite, electron-builder, and
//      a native-module rebuild for two architectures — so the test
//      is gated behind `RUN_PACKAGING_INTEGRATION=1` and only runs
//      on `darwin`. Under a normal `npm test` it is skipped so the
//      suite stays fast.
//
//   2. After the build exits 0, assert that `release/` contains
//      exactly four mac artefacts and no others:
//        - `Monitor-<version>-arm64.dmg`
//        - `Monitor-<version>-arm64.dmg.blockmap`
//        - `Monitor-<version>-x64.dmg`
//        - `Monitor-<version>-x64.dmg.blockmap`
//      with `<version>` read from `package.json#version`. Disallowed
//      extensions (`.zip`, `.pkg`, `.mas`, universal-arch dmgs) must
//      not appear (Requirements 14.3, 14.6).
//
//   3. Mount each dmg, run `file` on the unpacked
//      `better_sqlite3.node`, and assert the Mach-O CPU type matches
//      the dmg's architecture (Requirements 2.1, 2.2, 2.3, 2.5).
//
//   4. Assert the dmg payload is unsigned: either
//      `<App>.app/Contents/_CodeSignature/CodeResources` is absent,
//      or `codesign --verify` exits non-zero with the substring
//      `not signed at all` in its stderr (Requirements 1.5, 14.2).
//
// Skip predicate:
//   - host platform must be `darwin`
//   - environment variable `RUN_PACKAGING_INTEGRATION` must equal `1`
//
// Both conditions must hold; the test is opt-in via the env var so
// CI runs that do not have a fully buildable Node + Xcode toolchain
// (or that would take 10+ minutes packaging) are unaffected.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
} from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RELEASE_DIR = join(REPO_ROOT, 'release');

const SHOULD_RUN =
  process.platform === 'darwin' &&
  process.env.RUN_PACKAGING_INTEGRATION === '1';

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

interface MountedDmg {
  /** Architecture parsed from the dmg filename: `arm64` or `x64`. */
  arch: 'arm64' | 'x64';
  /** Mountpoint chosen by `hdiutil attach`. */
  mountPoint: string;
  /** Absolute path to the dmg on disk. */
  dmgPath: string;
}

/**
 * Attach a dmg to a fresh mountpoint (`hdiutil attach -nobrowse`)
 * and return the mountpoint. The caller is responsible for
 * detaching when the test is done.
 */
function attachDmg(dmgPath: string): string {
  const mountRoot = mkdtempSync(join(tmpdir(), 'mon-mac-int-'));
  const result = spawnSync(
    'hdiutil',
    ['attach', '-nobrowse', '-readonly', '-mountpoint', mountRoot, dmgPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `hdiutil attach ${dmgPath} exited ${result.status}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return mountRoot;
}

function detachDmg(mountPoint: string): void {
  // `-force` so a stuck handle from a failed test does not leave the
  // dmg attached forever.
  spawnSync('hdiutil', ['detach', '-force', mountPoint], {
    encoding: 'utf8',
  });
}

/**
 * Recursively collect every `better_sqlite3.node` path under `root`.
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
 * Find the `*.app` bundle directory under a mounted dmg root.
 * `electron-builder` ships exactly one app bundle per dmg.
 */
function findAppBundle(mountPoint: string): string {
  const entries = readdirSync(mountPoint);
  for (const entry of entries) {
    if (entry.endsWith('.app')) {
      return join(mountPoint, entry);
    }
  }
  throw new Error(
    `no .app bundle found under ${mountPoint}; got: ${entries.join(', ')}`,
  );
}

interface FileTypeInfo {
  /** `mach-o` if any descriptor reports Mach-O. */
  isMachO: boolean;
  /** `arm64`, `x86_64`, or `unknown`. */
  cpu: 'arm64' | 'x86_64' | 'unknown';
  /** Raw `file(1)` output, kept for diagnostic messages. */
  raw: string;
}

/** Run `file` and parse the Mach-O CPU type out of its output. */
function inspectMachO(path: string): FileTypeInfo {
  const result = spawnSync('file', [path], { encoding: 'utf8' });
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const isMachO = /Mach-O/.test(raw);
  let cpu: FileTypeInfo['cpu'] = 'unknown';
  if (/arm64/.test(raw)) cpu = 'arm64';
  else if (/x86_64/.test(raw)) cpu = 'x86_64';
  return { isMachO, cpu, raw };
}

/**
 * Determine whether the app bundle is unsigned. Two acceptable
 * signals (Requirement 1.5):
 *
 *   - `Contents/_CodeSignature/CodeResources` does not exist; or
 *   - `codesign --verify` exits non-zero with the substring
 *     `not signed at all` in its stderr.
 */
function appIsUnsigned(appPath: string): {
  unsigned: boolean;
  reason: string;
} {
  const cs = join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
  if (!existsSync(cs)) {
    return {
      unsigned: true,
      reason: `_CodeSignature/CodeResources absent`,
    };
  }
  const result = spawnSync(
    'codesign',
    ['--verify', '--verbose=4', appPath],
    { encoding: 'utf8' },
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && /not signed at all/.test(out)) {
    return {
      unsigned: true,
      reason: `codesign --verify exited ${result.status} with "not signed at all"`,
    };
  }
  return {
    unsigned: false,
    reason: `codesign --verify exited ${result.status}: ${out.slice(0, 500)}`,
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  'package-mac integration (Requirements 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.5, 14.2, 14.3, 14.6)',
  () => {
    const TEN_MINUTES_MS = 10 * 60 * 1000;

    // We mount each dmg exactly once for the whole file and detach
    // in afterAll. Mounting is expensive and we read several
    // independent invariants from the same payload.
    const mounted: MountedDmg[] = [];

    beforeAll(() => {
      const result = spawnSync('npm', ['run', 'package:mac'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        shell: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) {
        throw new Error(
          `npm run package:mac exited ${result.status}\n` +
            `stdout (last 4kB):\n${(result.stdout ?? '').slice(-4096)}\n` +
            `stderr (last 4kB):\n${(result.stderr ?? '').slice(-4096)}`,
        );
      }

      // Mount both dmgs once. Failures here surface as test errors
      // rather than `beforeAll` errors so the assertion messages
      // include the dmg paths.
      const version = readPackageVersion();
      for (const arch of ['arm64', 'x64'] as const) {
        const dmgPath = join(
          RELEASE_DIR,
          `Monitor-${version}-${arch}.dmg`,
        );
        if (existsSync(dmgPath)) {
          const mountPoint = attachDmg(dmgPath);
          mounted.push({ arch, mountPoint, dmgPath });
        }
      }
    }, TEN_MINUTES_MS * 2);

    afterAll(() => {
      for (const m of mounted) {
        detachDmg(m.mountPoint);
      }
    });

    it(
      'release/ contains exactly the four expected dmg artefacts (Requirements 14.2, 14.3, 14.6)',
      () => {
        const version = readPackageVersion();
        const expected = new Set([
          `Monitor-${version}-arm64.dmg`,
          `Monitor-${version}-arm64.dmg.blockmap`,
          `Monitor-${version}-x64.dmg`,
          `Monitor-${version}-x64.dmg.blockmap`,
        ]);

        // Filter the release directory for the mac-portion
        // artefacts. We allow electron-builder's own metadata files
        // (e.g. `latest-mac.yml`, `builder-effective-config.yaml`)
        // since they are not user-facing artefacts and are not the
        // subject of Requirement 14.3 — that requirement is about
        // dmg-family files specifically.
        const entries = readdirSync(RELEASE_DIR);
        const dmgFamily = entries.filter(
          (e) =>
            /\.dmg$/.test(e) ||
            /\.dmg\.blockmap$/.test(e) ||
            /\.zip$/.test(e) ||
            /\.pkg$/.test(e) ||
            /\.mas$/.test(e),
        );

        // Every dmg-family file must be in the expected set.
        for (const e of dmgFamily) {
          expect(
            expected.has(e),
            `disallowed mac artefact in release/: ${e}`,
          ).toBe(true);
        }

        // And every expected artefact must be present.
        for (const want of expected) {
          expect(
            dmgFamily.includes(want),
            `expected mac artefact missing from release/: ${want}`,
          ).toBe(true);
        }

        // Universal-arch dmgs are explicitly disallowed (14.3).
        for (const e of entries) {
          expect(
            /universal/.test(e),
            `disallowed universal-arch artefact in release/: ${e}`,
          ).toBe(false);
        }
      },
      TEN_MINUTES_MS,
    );

    it(
      'arm64 dmg ships an arm64 Mach-O better_sqlite3.node (Requirements 2.1, 2.2, 2.5)',
      () => {
        const m = mounted.find((x) => x.arch === 'arm64');
        expect(
          m,
          `arm64 dmg was not mounted; check release/ contents`,
        ).toBeDefined();
        const app = findAppBundle(m!.mountPoint);
        const bins = findBetterSqliteBinaries(app);
        expect(
          bins.length,
          `no better_sqlite3.node found inside ${basename(m!.dmgPath)}`,
        ).toBeGreaterThan(0);
        for (const bin of bins) {
          const info = inspectMachO(bin);
          expect(
            info.isMachO,
            `${bin} is not Mach-O: ${info.raw}`,
          ).toBe(true);
          expect(
            info.cpu,
            `${bin} CPU type mismatch (expected arm64): ${info.raw}`,
          ).toBe('arm64');
        }
      },
      TEN_MINUTES_MS,
    );

    it(
      'x64 dmg ships an x86_64 Mach-O better_sqlite3.node (Requirements 2.1, 2.3, 2.5)',
      () => {
        const m = mounted.find((x) => x.arch === 'x64');
        expect(
          m,
          `x64 dmg was not mounted; check release/ contents`,
        ).toBeDefined();
        const app = findAppBundle(m!.mountPoint);
        const bins = findBetterSqliteBinaries(app);
        expect(
          bins.length,
          `no better_sqlite3.node found inside ${basename(m!.dmgPath)}`,
        ).toBeGreaterThan(0);
        for (const bin of bins) {
          const info = inspectMachO(bin);
          expect(
            info.isMachO,
            `${bin} is not Mach-O: ${info.raw}`,
          ).toBe(true);
          expect(
            info.cpu,
            `${bin} CPU type mismatch (expected x86_64): ${info.raw}`,
          ).toBe('x86_64');
        }
      },
      TEN_MINUTES_MS,
    );

    it(
      'both dmgs ship unsigned .app bundles (Requirements 1.5, 14.2)',
      () => {
        for (const m of mounted) {
          const app = findAppBundle(m.mountPoint);
          const result = appIsUnsigned(app);
          expect(
            result.unsigned,
            `${basename(m.dmgPath)} app is signed: ${result.reason}`,
          ).toBe(true);
        }
      },
      TEN_MINUTES_MS,
    );
  },
);
