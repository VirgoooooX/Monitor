// prepackage-mac.mjs — prerequisite probes and stale-binary cleanup
// for `npm run package:mac`.
//
// Runs BEFORE electron-builder. If any of the probes fails, this
// script exits non-zero and electron-builder is never invoked
// (Requirement 2.4b).
//
// Probes performed, in order:
//
//   1. `xcode-select -p`         — Requirement 2.4 / 2.4a
//   2. `python3 --version`       — Requirement 2.4 / 2.4a
//   3. Stale `better_sqlite3.node` magic-byte check — Requirement 2.3a
//
// **Why pure helpers?** Requirement 2.3a is the only non-trivial
// branch in the script. Property 13 (PBT in
// `prepackage-mac.stale-binary.pbt.test.ts`) drives the magic-byte
// logic across all `(currentTarget, onDiskBinary)` permutations. To
// keep the property test free of filesystem mocks, the magic-byte
// detection is factored into three pure exported helpers
// (`detectBinaryFormat`, `expectedFormatForTarget`, `isStale`) and
// the side-effecting cleanup is exposed via `cleanStaleSqliteBinary`
// with injected `fsModule`.
//
// **Why `import.meta.url === pathToFileURL(process.argv[1]).href`
// guard?** Vitest imports this file to test the helpers; we MUST
// NOT actually run the probes during a test run. The guard makes
// `runMain()` invoke only when the file is executed directly via
// `node scripts/prepackage-mac.mjs`.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Magic-byte constants — public so tests can build fixture buffers.
// ---------------------------------------------------------------------------

/** Mach-O 64-bit LE magic: `cf fa ed fe`. */
export const MACHO_MAGIC_64_LE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

/** PE/COFF magic ('MZ' DOS-stub prefix): `4d 5a`. */
export const PE_COFF_MAGIC = Buffer.from([0x4d, 0x5a]);

/** Mach-O CPU type for x86_64 = 0x01000007 (little-endian). */
export const MACHO_CPU_X86_64 = 0x01000007;

/** Mach-O CPU type for arm64 = 0x0100000c (little-endian). */
export const MACHO_CPU_ARM64 = 0x0100000c;

// ---------------------------------------------------------------------------
// Pure helpers (exported for property-based testing).
// ---------------------------------------------------------------------------

/**
 * Detect the binary format of a buffer based on its leading magic bytes.
 *
 * Reads up to 8 bytes:
 *   - `cf fa ed fe` followed by CPU type `0x01000007` → `'MachO-x64'`
 *   - `cf fa ed fe` followed by CPU type `0x0100000c` → `'MachO-arm64'`
 *   - `4d 5a` (any subsequent bytes)                  → `'PE-COFF'`
 *   - anything else                                   → `'unknown'`
 *
 * Pure: derives its result solely from the input buffer. Total: never
 * throws, even when `buf` is shorter than 8 bytes or not a Buffer.
 *
 * @param {Buffer} buf
 * @returns {'MachO-x64' | 'MachO-arm64' | 'PE-COFF' | 'unknown'}
 */
export function detectBinaryFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) {
    return 'unknown';
  }

  // PE/COFF: 2-byte 'MZ' DOS-stub prefix is sufficient. We check this
  // first because PE buffers can be arbitrarily short (any length >= 2
  // is enough for detection).
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    return 'PE-COFF';
  }

  // Mach-O 64-bit LE: 4-byte magic + 4-byte cputype = 8 bytes total.
  if (buf.length < 8) {
    return 'unknown';
  }

  if (
    buf[0] === 0xcf &&
    buf[1] === 0xfa &&
    buf[2] === 0xed &&
    buf[3] === 0xfe
  ) {
    const cpuType = buf.readUInt32LE(4);
    if (cpuType === MACHO_CPU_X86_64) return 'MachO-x64';
    if (cpuType === MACHO_CPU_ARM64) return 'MachO-arm64';
    return 'unknown';
  }

  return 'unknown';
}

/**
 * Map a `(platform, arch)` target to the binary format the rebuild
 * step is expected to produce.
 *
 * Pure: derives its result solely from its arguments.
 *
 * @param {string} platform
 * @param {string} arch
 * @returns {'MachO-x64' | 'MachO-arm64' | 'PE-COFF' | 'unknown'}
 */
export function expectedFormatForTarget(platform, arch) {
  if (platform === 'darwin' && arch === 'x64') return 'MachO-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'MachO-arm64';
  if (platform === 'win32' && arch === 'x64') return 'PE-COFF';
  return 'unknown';
}

/**
 * Decide whether a binary is stale relative to the current target.
 *
 * A binary is stale iff `detected !== expected`. An `'unknown'`
 * detected format is treated as stale (it cannot be trusted to
 * match the target ABI).
 *
 * @param {string} detected
 * @param {string} expected
 * @returns {boolean}
 */
export function isStale(detected, expected) {
  return detected !== expected;
}

// ---------------------------------------------------------------------------
// Stale-binary cleanup (side-effecting; uses injected fs module).
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   filePath: string,
 *   platform: string,
 *   arch: string,
 *   fsModule?: typeof import('node:fs'),
 * }} CleanStaleOpts
 */

/**
 * Probe `node_modules/better-sqlite3/build/Release/better_sqlite3.node`
 * (or the supplied path) and unlink it iff its magic bytes do not
 * match the current target. Implements Requirement 2.3a.
 *
 * Returns one of:
 *   - `{ action: 'absent' }`          — file did not exist (no-op)
 *   - `{ action: 'kept', detected, expected }`     — match, kept
 *   - `{ action: 'unlinked', detected, expected }` — mismatch, deleted
 *
 * Throws an `Error` whose `message` contains the file path AND the
 * underlying OS error code if the unlink fails (Requirement 2.3a
 * "surface unlink errors with file path and OS error code").
 *
 * @param {CleanStaleOpts} opts
 */
export function cleanStaleSqliteBinary(opts) {
  const fsModule = opts.fsModule ?? fs;
  const { filePath, platform, arch } = opts;

  let buf;
  try {
    const fd = fsModule.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(8);
      fsModule.readSync(fd, buf, 0, 8, 0);
    } finally {
      fsModule.closeSync(fd);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { action: 'absent' };
    }
    throw err;
  }

  const detected = detectBinaryFormat(buf);
  const expected = expectedFormatForTarget(platform, arch);

  if (!isStale(detected, expected)) {
    return { action: 'kept', detected, expected };
  }

  try {
    fsModule.unlinkSync(filePath);
  } catch (err) {
    const code = (err && err.code) ?? 'UNKNOWN';
    const message = (err && err.message) ?? String(err);
    throw new Error(
      `Failed to unlink stale ${filePath} (${code}): ${message}`,
    );
  }

  return { action: 'unlinked', detected, expected };
}

// ---------------------------------------------------------------------------
// Prerequisite probes.
// ---------------------------------------------------------------------------

/** @typedef {{ ok: true } | { ok: false, error: string }} ProbeResult */

/**
 * Probe `xcode-select -p`. Returns `{ ok: true }` if the command
 * exits 0; otherwise returns the exact remediation string from
 * Requirement 2.4 / 2.4a.
 *
 * Uses `execFileSync` (not `execSync`) to avoid shell-interpolation
 * surprises on a username with spaces.
 *
 * @param {(file: string, args?: string[], opts?: object) => Buffer} execFn
 * @returns {ProbeResult}
 */
export function probeXcodeSelect(execFn) {
  try {
    execFn('xcode-select', ['-p'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Missing Xcode Command Line Tools. Run: xcode-select --install',
    };
  }
}

/**
 * Probe `python3 --version`. Returns `{ ok: true }` if the command
 * exits 0 AND its stdout matches `^Python 3\.`; otherwise returns
 * the remediation string from Requirement 2.4 / 2.4a.
 *
 * @param {(file: string, args?: string[], opts?: object) => Buffer} execFn
 * @returns {ProbeResult}
 */
export function probePython3(execFn) {
  let out;
  try {
    out = execFn('python3', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {
      ok: false,
      error: 'Missing Python 3.x. Run: brew install python@3.11',
    };
  }

  const text = (out instanceof Buffer ? out.toString('utf8') : String(out)).trim();
  if (!/^Python 3\./.test(text)) {
    return {
      ok: false,
      error: 'Missing Python 3.x. Run: brew install python@3.11',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main runner — exposed so tests can drive the orchestration with
// injected dependencies, but ALSO invoked once at module load when
// the file is executed directly via `node scripts/prepackage-mac.mjs`.
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   execFn?: typeof import('node:child_process').execFileSync,
 *   fsModule?: typeof import('node:fs'),
 *   platform?: string,
 *   arch?: string,
 *   sqliteBinaryPath?: string,
 *   stderr?: { write: (s: string) => void },
 *   exit?: (code: number) => void,
 * }} RunOpts
 */

/**
 * Drive the full probe sequence. Invokes `exit(1)` on first failure
 * AND short-circuits subsequent probes (Requirement 2.4b — build
 * steps must not be invoked when probes fail).
 *
 * @param {RunOpts} [opts]
 */
export function runPrepackage(opts = {}) {
  const execFn = opts.execFn ?? execFileSync;
  const fsModule = opts.fsModule ?? fs;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const sqliteBinaryPath =
    opts.sqliteBinaryPath ??
    path.join(
      repoRoot,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    );
  const stderr = opts.stderr ?? process.stderr;
  const exit = opts.exit ?? ((code) => process.exit(code));

  // Probe 1: Xcode Command Line Tools.
  const xcode = probeXcodeSelect(execFn);
  if (!xcode.ok) {
    stderr.write(`${xcode.error}\n`);
    exit(1);
    return;
  }

  // Probe 2: Python 3.
  const python = probePython3(execFn);
  if (!python.ok) {
    stderr.write(`${python.error}\n`);
    exit(1);
    return;
  }

  // Probe 3: stale better_sqlite3.node.
  const result = cleanStaleSqliteBinary({
    filePath: sqliteBinaryPath,
    platform,
    arch,
    fsModule,
  });
  if (result.action === 'unlinked') {
    stderr.write(
      `prepackage-mac: removed stale ${sqliteBinaryPath} ` +
        `(detected=${result.detected}, expected=${result.expected})\n`,
    );
  }
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runPrepackage();
}
