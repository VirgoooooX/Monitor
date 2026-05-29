// Feature: macos-platform-support, Property 1: Antigravity path resolver — total, per-platform correct, pure
// Feature: macos-platform-support, Property 2: OpenCode path resolver — total, per-platform correct, pure
//
// Validates: Requirements 3.2, 3.3, 3.4, 4.2, 4.3, 4.4, 4.8, 12.1, 12.2, 12.3, 12.4, 12.5, 12.8
//
// **What these properties pin down.**
//
//   For any `platform ∈ {'win32', 'darwin', 'linux', ''}`, any `env`
//   slice that independently has each field present or absent, and
//   any non-empty `homedir` of length 1 to 260, both
//   `resolveAntigravityAppDataPath` and `resolveOpencodePath` MUST
//
//     1. Return a non-empty string.
//     2. Never throw.
//     3. Place the brand segment (`Antigravity` or `opencode`) in
//        the right anchor position — penultimate for Antigravity
//        (because of the trailing `logs` segment) and final for
//        OpenCode.
//     4. Equal the model-computed expected path — i.e. the same
//        `path.{win32,posix}.join` invocation that the implementation
//        uses. Asserting against the model rather than against
//        substring predicates avoids false positives when the
//        platform-specific `path.join` flavour normalises its input
//        (e.g. `path.win32.join('/foo', 'bar')` → `\foo\bar`,
//        `path.posix.join('./foo', 'bar')` → `foo/bar`). The
//        normalised result no longer literally `startsWith` the raw
//        input, but the property of "this is what the resolver should
//        compute" still holds when both sides flow through the same
//        join function.
//     5. Be **pure** — derive their result solely from their
//        arguments. Verified by stubbing `process.platform`,
//        `process.env`, and `os.homedir` to throw before each
//        invocation; if either resolver touched any of those, the
//        property would surface a thrown exception (Requirement
//        12.1 / 12.2).
//
// **Purity check, with a precondition.** `fast-check` itself reads
// `process.env` and other globals during shrink reporting, so we
// cannot leave the throwing stubs in place across the full property
// run. Instead, each property body re-installs the stubs *just before*
// invoking the resolver and tears them down *immediately after*. The
// resolver's whole job is to compute its return value synchronously
// from its arguments, so this scope is sufficient to detect any
// global-state read.
//
// We use `path.win32` / `path.posix` joins in the model rather than
// the host's `path.join`, because this test must give identical
// verdicts on a Windows runner and a macOS runner — Requirement 12.8
// demands `npm test` pass on both.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as path from 'node:path';

import {
  resolveAntigravityAppDataPath,
  resolveOpencodePath,
} from './paths';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Platforms we exercise. We deliberately include the empty string so
 * the unknown-platform branch (Requirement 4.8) is covered: an empty
 * `process.platform` must fall through to the XDG branch without
 * throwing.
 */
const platformArb = fc.constantFrom('win32', 'darwin', 'linux', '');

/**
 * String generator constrained to the [1, 260] character window. 260
 * is the historical Windows MAX_PATH; we keep within it so
 * `path.win32.join` produces a value short enough to be a plausible
 * real-world path.
 *
 * We strip null bytes (`\u0000`) because Node's `path` module rejects
 * them with `TypeError [ERR_INVALID_ARG_VALUE]`. The resolvers don't
 * defend against that themselves — and they aren't required to —
 * but the generator must avoid them so the property body runs
 * without false positives.
 */
const nonEmptyPathish = fc
  .string({ minLength: 1, maxLength: 260 })
  .filter((s) => !s.includes('\u0000'));

const envArb = fc.record(
  {
    APPDATA: fc.option(nonEmptyPathish, { nil: undefined }),
    XDG_DATA_HOME: fc.option(nonEmptyPathish, { nil: undefined }),
  },
  { withDeletedKeys: true },
);

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

/**
 * Independent, fully-spelled-out reference implementation of the spec.
 * If a future refactor changes the implementation in `paths.ts` (e.g.
 * by collapsing branches), this model still mirrors the spec branches
 * one-for-one, so the property failure pinpoints the divergence.
 */
function modelAntigravityPath(
  platform: string,
  env: { APPDATA?: string; XDG_DATA_HOME?: string },
  homedir: string,
): string {
  if (platform === 'win32') {
    const base =
      env.APPDATA ?? path.win32.join(homedir, 'AppData', 'Roaming');
    return path.win32.join(base, 'Antigravity', 'logs');
  }
  if (platform === 'darwin') {
    return path.posix.join(
      homedir,
      'Library',
      'Application Support',
      'Antigravity',
      'logs',
    );
  }
  const xdg =
    env.XDG_DATA_HOME ?? path.posix.join(homedir, '.local', 'share');
  return path.posix.join(xdg, 'Antigravity', 'logs');
}

function modelOpencodePath(
  platform: string,
  env: { APPDATA?: string; XDG_DATA_HOME?: string },
  homedir: string,
): string {
  if (platform === 'win32') {
    const base =
      env.APPDATA ?? path.win32.join(homedir, 'AppData', 'Roaming');
    return path.win32.join(base, 'opencode');
  }
  if (platform === 'darwin') {
    return path.posix.join(
      homedir,
      'Library',
      'Application Support',
      'opencode',
    );
  }
  const xdg =
    env.XDG_DATA_HOME ?? path.posix.join(homedir, '.local', 'share');
  return path.posix.join(xdg, 'opencode');
}

// ---------------------------------------------------------------------------
// Purity stubs
// ---------------------------------------------------------------------------

/**
 * Install throwing stubs on `process.platform`, `process.env`, and
 * `os.homedir`. Any read or write attempted by the resolver body
 * raises immediately, surfacing as a property failure with a
 * meaningful counter-example.
 *
 * Returns a teardown that restores the original descriptors. We do
 * NOT use `vi.spyOn` because Vitest's spy implementation re-reads
 * the target object during teardown, which would itself trip the
 * traps if the order is wrong. Plain `Object.defineProperty`
 * snapshots avoid that footgun.
 */
function installPurityTraps(): () => void {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  const envDescriptor = Object.getOwnPropertyDescriptor(process, 'env');

  // Lazy require so we capture the same `os` module object the
  // resolver would (mis)use. The static `import` isn't usable here
  // because we need to overwrite its `homedir` slot transiently.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osModule = require('node:os') as typeof import('node:os');
  const originalHomedir = osModule.homedir;

  Object.defineProperty(process, 'platform', {
    configurable: true,
    get() {
      throw new Error(
        'paths resolver attempted to read process.platform — purity violation',
      );
    },
  });
  Object.defineProperty(process, 'env', {
    configurable: true,
    get() {
      throw new Error(
        'paths resolver attempted to read process.env — purity violation',
      );
    },
  });
  osModule.homedir = (() => {
    throw new Error(
      'paths resolver attempted to call os.homedir() — purity violation',
    );
  }) as typeof osModule.homedir;

  return () => {
    if (platformDescriptor !== undefined) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    if (envDescriptor !== undefined) {
      Object.defineProperty(process, 'env', envDescriptor);
    }
    osModule.homedir = originalHomedir;
  };
}

/**
 * Run `fn` with the purity traps installed, guaranteeing teardown
 * even when `fn` throws (the property body itself should be
 * synchronous and non-throwing — exceptions surface to fast-check).
 */
function withPurityTraps<T>(fn: () => T): T {
  const teardown = installPurityTraps();
  try {
    return fn();
  } finally {
    teardown();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Split a path with a known segment separator. We split using BOTH
 * the win32 and posix separators so a result mixing them (e.g. a
 * win32 result ending in `Antigravity\logs` versus a darwin result
 * ending in `Antigravity/logs`) is handled uniformly.
 */
function segmentsOf(p: string): string[] {
  return p.split(/[\\/]/g).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Property 1: Antigravity path resolver
// ---------------------------------------------------------------------------

describe('Property 1: resolveAntigravityAppDataPath — total, per-platform correct, pure', () => {
  it('returns a non-empty path with `Antigravity/logs` as the trailing two segments and matches the spec model, without reading globals', () => {
    fc.assert(
      fc.property(
        platformArb,
        envArb,
        nonEmptyPathish,
        (platform, env, homedir) => {
          const result = withPurityTraps(() =>
            resolveAntigravityAppDataPath(platform, env, homedir),
          );

          // (1) non-empty string
          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(0);

          // (3) final segment `logs`, penultimate `Antigravity`
          const segs = segmentsOf(result);
          expect(segs.length).toBeGreaterThanOrEqual(2);
          expect(segs[segs.length - 1]).toBe('logs');
          expect(segs[segs.length - 2]).toBe('Antigravity');

          // (4) per-spec model equality. We compare against
          // `modelAntigravityPath`, which mirrors the spec's branch
          // table. This subsumes "starts with APPDATA" /
          // "contains Library/Application Support" /
          // "contains .local/share" — any deviation surfaces here.
          expect(result).toBe(modelAntigravityPath(platform, env, homedir));
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: OpenCode path resolver
// ---------------------------------------------------------------------------

describe('Property 2: resolveOpencodePath — total, per-platform correct, pure', () => {
  it('returns a non-empty path whose final segment is `opencode` and matches the spec model, without reading globals', () => {
    fc.assert(
      fc.property(
        platformArb,
        envArb,
        nonEmptyPathish,
        (platform, env, homedir) => {
          const result = withPurityTraps(() =>
            resolveOpencodePath(platform, env, homedir),
          );

          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(0);

          // Final segment `opencode`.
          const segs = segmentsOf(result);
          expect(segs.length).toBeGreaterThanOrEqual(1);
          expect(segs[segs.length - 1]).toBe('opencode');

          expect(result).toBe(modelOpencodePath(platform, env, homedir));
        },
      ),
      { numRuns: 100 },
    );
  });
});
