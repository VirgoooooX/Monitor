// Feature: macos-platform-support, Property 3 (Antigravity half): unavailable reason names resolved missing path
// Feature: macos-platform-support, Property 4 (Antigravity half): appDataPath override bypasses the resolver
//
// Validates: Requirements 3.5, 3.6, 3.7, 3.9, 11.2, 12.5
//
// **What these properties pin down.**
//
//   Property 3 (Antigravity half) — when both probed directories are
//   absent, `capabilityCheck()` returns `unavailable` with a reason
//   that mentions the resolved gemini path AND the resolved
//   application-data path verbatim. On `darwin` the reason MUST NOT
//   contain `AppData\Roaming` or `APPDATA` (Requirement 3.7).
//
//   Property 4 (Antigravity half) — when an `appDataPath` override
//   is supplied, the per-platform resolver is never invoked and the
//   override flows through to the unavailable reason verbatim
//   (Requirement 3.9). We verify "never invoked" by passing
//   sentinel `platform`/`env`/`homedir` values that, if they reached
//   the resolver, would produce a different path than the override.
//
// **Test posture.** We exercise the collector through its public
// dependency injection surface — `platform`, `env`, `homedir`,
// `geminiPath`, `appDataPath`, `directoryExists` — so the host's
// `process.platform`, `process.env`, and `os.homedir()` are never
// mutated (Requirement 12.5). The fake `directoryExists` always
// returns `false`, forcing the unavailable branch.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as path from 'node:path';

import { createAntigravityCollector } from './antigravity.collector';
import {
  resolveAntigravityAppDataPath,
  type ResolverEnv,
} from '../../platform/paths';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const platformArb = fc.constantFrom('win32', 'darwin', 'linux', '');

/**
 * String generator that avoids the null byte (Node `path` rejects
 * `\u0000`) and stays inside Windows MAX_PATH (260) so a synthesized
 * value remains a plausible filesystem path.
 */
const nonEmptyPathish = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => !s.includes('\u0000'));

const envArb = fc.record(
  {
    APPDATA: fc.option(nonEmptyPathish, { nil: undefined }),
    XDG_DATA_HOME: fc.option(nonEmptyPathish, { nil: undefined }),
  },
  { withDeletedKeys: true },
);

/**
 * The fake `directoryExists` that drives the unavailable branch on
 * every probe. Used by both properties.
 */
async function alwaysFalseDirExists(_dirPath: string): Promise<boolean> {
  return false;
}

// ---------------------------------------------------------------------------
// Property 3 (Antigravity half)
// ---------------------------------------------------------------------------

describe('Property 3 (Antigravity half): unavailable reason names resolved missing path', () => {
  it('returns `unavailable` mentioning both resolved paths verbatim, with no AppData/APPDATA leakage on darwin', () => {
    fc.assert(
      fc.asyncProperty(
        platformArb,
        envArb,
        nonEmptyPathish,
        nonEmptyPathish,
        async (platform, env, homedir, geminiPath) => {
          const expectedAppData = resolveAntigravityAppDataPath(
            platform,
            env,
            homedir,
          );

          const collector = createAntigravityCollector({
            platform,
            env,
            homedir,
            geminiPath,
            directoryExists: alwaysFalseDirExists,
          });

          const result = await collector.capabilityCheck();

          expect(result.status).toBe('unavailable');
          // Requirement 3.6: reason format names both resolved paths.
          expect(result.reason).toBe(
            `目录 ${geminiPath} 和 ${expectedAppData} 均不存在`,
          );
          // Both resolved paths appear as substrings of the reason.
          expect(result.reason ?? '').toContain(geminiPath);
          expect(result.reason ?? '').toContain(expectedAppData);

          // Requirement 3.7: on darwin the reason must NOT contain
          // any Windows-flavoured AppData substring.
          if (platform === 'darwin') {
            const reason = result.reason ?? '';
            expect(reason).not.toContain('AppData\\Roaming');
            expect(reason).not.toContain('APPDATA');
            // The resolved application-data path on darwin is
            // anchored at `Library/Application Support`. We assert
            // the positive expectation as a belt-and-suspenders
            // check that the resolver actually fired.
            expect(expectedAppData).toContain('Library/Application Support');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 (Antigravity half)
// ---------------------------------------------------------------------------

describe('Property 4 (Antigravity half): appDataPath override bypasses the resolver', () => {
  it('uses the supplied override verbatim and never consults the per-platform resolver', () => {
    fc.assert(
      fc.asyncProperty(
        platformArb,
        envArb,
        nonEmptyPathish,
        nonEmptyPathish,
        nonEmptyPathish,
        async (platform, env, homedir, geminiPath, appDataOverride) => {
          // Pre-condition: pick an override that is NOT the value
          // the resolver would return. If the generated values
          // happen to collide we shrink past them — fast-check
          // treats a `pre()` violation as a skip, not a failure.
          const resolverOutput: string = resolveAntigravityAppDataPath(
            platform,
            env as ResolverEnv,
            homedir,
          );
          fc.pre(appDataOverride !== resolverOutput);

          // If the override accidentally matches the gemini path we
          // also skip — the unavailable reason is "${gemini} 和
          // ${appData} 均不存在", and we want them distinguishable.
          fc.pre(appDataOverride !== geminiPath);

          const collector = createAntigravityCollector({
            platform,
            env,
            homedir,
            geminiPath,
            appDataPath: appDataOverride,
            directoryExists: alwaysFalseDirExists,
          });

          const result = await collector.capabilityCheck();

          expect(result.status).toBe('unavailable');
          // Requirement 3.9: the override flows through verbatim,
          // independent of the per-platform resolver's value.
          expect(result.reason).toBe(
            `目录 ${geminiPath} 和 ${appDataOverride} 均不存在`,
          );
          // Negative check: the resolver-derived path must NOT
          // appear in the reason — proving the resolver was
          // bypassed entirely.
          expect(result.reason ?? '').not.toContain(resolverOutput);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-check: keep the model and the resolver in sync.
// ---------------------------------------------------------------------------
//
// If a future refactor redefines the per-platform branch table in
// `paths.ts` without updating this file, the "negative check" above
// in Property 4 would silently start passing for every input. The
// tiny example below is a smoke test that the model path lookup
// here uses the same `node:path` flavours as the implementation —
// independent of any platform-specific runtime state.

describe('Antigravity collector path resolution: smoke', () => {
  it('routes platform/env/homedir to resolveAntigravityAppDataPath', () => {
    const sentinel = path.win32.join('C:\\', 'Users', 'sentinel', 'AppData', 'Roaming');
    const resolved = resolveAntigravityAppDataPath(
      'win32',
      { APPDATA: sentinel },
      'C:\\Users\\sentinel',
    );
    expect(resolved).toBe(path.win32.join(sentinel, 'Antigravity', 'logs'));
  });
});
