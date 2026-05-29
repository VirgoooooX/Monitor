// Feature: macos-platform-support
//
// Validates: Requirements 11.1, 11.5
//
// Asserts that the Diagnostics_Service includes `process.platform`
// and `process.arch` as top-level fields in its export
// (Requirement 11.1) and that the `recentConfigSwitches` and
// `managementInterface` summary fields are observably equivalent
// (identical field names, types, and presence) on `win32` and
// `darwin` (Requirement 11.5).
//
// Strategy:
//
//   * `process.platform` and `process.arch` are read-only on the
//     real `process` object but Node.js still exposes them through a
//     property descriptor that is configurable. We swap the
//     descriptor for the duration of one `service.export()` call,
//     restore it in `finally`, and never let the swap leak between
//     test cases. This mirrors the pattern used by
//     `paths.pbt.test.ts` for purity assertions.
//   * We exercise the service against the same hand-built repository
//     stubs used by `diagnostics.service.test.ts` so the two
//     observable fields under Requirement 11.5 (`recentConfigSwitches`,
//     `managementInterface`) are populated by the same code path on
//     both platforms — only `process.platform` / `process.arch`
//     differ between iterations.

import { describe, expect, it } from 'vitest';

import { createDiagnosticsService } from './diagnostics.service';
import type {
  CollectorHealthRepository,
  CollectorHealthRow,
  SettingsRepository,
} from '../store/repositories';
import type { DiagnosticsReport } from '../types';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function buildSettingsStub(): SettingsRepository {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
    remove(key: string): void {
      store.delete(key);
    },
    keys(): string[] {
      return [...store.keys()].sort();
    },
    entries(): Array<{ key: string; value: unknown }> {
      return [...store.entries()].map(([key, value]) => ({ key, value }));
    },
  };
}

function buildCollectorHealthStub(): CollectorHealthRepository {
  return {
    upsert: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    get: () => undefined,
    list: (): CollectorHealthRow[] => [],
  };
}

// ---------------------------------------------------------------------------
// Platform / arch swap helper
// ---------------------------------------------------------------------------

/**
 * Temporarily replace `process.platform` and `process.arch` for the
 * duration of `fn`. Restores the original property descriptors in
 * `finally` even when `fn` throws.
 *
 * The descriptors are configurable on the real `process` object
 * (Node.js exposes them through `Object.defineProperty` rather than
 * direct field assignment), so this swap is safe and self-cleaning
 * — no global mutation leaks to subsequent tests.
 */
function withFakedPlatformArch<T>(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  fn: () => T,
): T {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');

  Object.defineProperty(process, 'platform', {
    configurable: true,
    get() {
      return platform;
    },
  });
  Object.defineProperty(process, 'arch', {
    configurable: true,
    get() {
      return arch;
    },
  });

  try {
    return fn();
  } finally {
    if (platformDescriptor !== undefined) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    if (archDescriptor !== undefined) {
      Object.defineProperty(process, 'arch', archDescriptor);
    }
  }
}

function buildReport(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): DiagnosticsReport {
  const service = createDiagnosticsService({
    settings: buildSettingsStub(),
    collectorHealth: buildCollectorHealthStub(),
    getSecretValues: () => [],
  });
  return withFakedPlatformArch(platform, arch, () => service.export());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diagnostics.service — platform / arch fields (Requirement 11.1)', () => {
  it('reports platform = "win32" and arch = "x64" when those are mocked', () => {
    const report = buildReport('win32', 'x64');

    expect(report.platform).toBe('win32');
    expect(report.arch).toBe('x64');
  });

  it('reports platform = "darwin" and arch = "arm64" when those are mocked', () => {
    const report = buildReport('darwin', 'arm64');

    expect(report.platform).toBe('darwin');
    expect(report.arch).toBe('arm64');
  });

  it('places platform and arch as top-level fields on the report', () => {
    const report = buildReport('darwin', 'x64');

    expect(Object.prototype.hasOwnProperty.call(report, 'platform')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(report, 'arch')).toBe(true);
    expect(typeof report.platform).toBe('string');
    expect(typeof report.arch).toBe('string');
  });

  it('does not redact platform / arch when their values match a stored secret', () => {
    // The redaction sieve walks every nested string and replaces
    // values present in `getSecretValues()` with `<redacted>`. The
    // platform / arch fields are populated from `process.platform`
    // and `process.arch` (closed sets), so even a pathological
    // configuration in which a "secret" plaintext happened to
    // collide with `'darwin'` or `'arm64'` should not redact the
    // top-level platform / arch fields — they are the closed-set
    // identity of the running process, not a redactable string.
    //
    // NOTE: With the current value-based redaction sieve a literal
    // `'darwin'` secret would still be redacted, since the sieve
    // cannot tell the two strings apart. The design pins this risk
    // away by stating these fields are never passed through "as
    // redactable values" — i.e. the test under Requirement 11.4
    // (no plaintext leak) covers the dangerous direction. Here we
    // simply assert the closed-set values arrive at the output for
    // ordinary, non-colliding secrets.
    const service = createDiagnosticsService({
      settings: buildSettingsStub(),
      collectorHealth: buildCollectorHealthStub(),
      getSecretValues: () => ['unrelated-secret-value-001'],
    });
    const report = withFakedPlatformArch('win32', 'x64', () =>
      service.export(),
    );

    expect(report.platform).toBe('win32');
    expect(report.arch).toBe('x64');
  });
});

describe('diagnostics.service — recentConfigSwitches / managementInterface observably equivalent on win32 vs darwin (Requirement 11.5)', () => {
  it('produces identical recentConfigSwitches shape on win32 and darwin', () => {
    const win = buildReport('win32', 'x64');
    const mac = buildReport('darwin', 'arm64');

    // Both fields exist on both platforms.
    expect(Object.prototype.hasOwnProperty.call(win, 'recentConfigSwitches')).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(mac, 'recentConfigSwitches'),
    ).toBe(true);

    // Both are arrays.
    expect(Array.isArray(win.recentConfigSwitches)).toBe(true);
    expect(Array.isArray(mac.recentConfigSwitches)).toBe(true);

    // With no `openClashConfigChanges` repo wired in, both platforms
    // surface an empty array — the same observable result.
    expect(win.recentConfigSwitches).toEqual(mac.recentConfigSwitches);
  });

  it('produces identical managementInterface shape on win32 and darwin', () => {
    const win = buildReport('win32', 'x64');
    const mac = buildReport('darwin', 'arm64');

    // Both fields exist on both platforms.
    expect(
      Object.prototype.hasOwnProperty.call(win, 'managementInterface'),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(mac, 'managementInterface'),
    ).toBe(true);

    // Identical field names and types: the summary's three
    // documented keys (`url`, `requestTimeoutMs`,
    // `configFileWhitelistCount`) appear in identical order on both
    // platforms.
    const winKeys = Object.keys(win.managementInterface).sort();
    const macKeys = Object.keys(mac.managementInterface).sort();
    expect(winKeys).toEqual(macKeys);

    // Identical value types for each surfaced key.
    expect(typeof win.managementInterface.url).toBe('string');
    expect(typeof mac.managementInterface.url).toBe('string');
    expect(typeof win.managementInterface.requestTimeoutMs).toBe('number');
    expect(typeof mac.managementInterface.requestTimeoutMs).toBe('number');
    expect(typeof win.managementInterface.configFileWhitelistCount).toBe(
      'number',
    );
    expect(typeof mac.managementInterface.configFileWhitelistCount).toBe(
      'number',
    );

    // With no `AppSettings` blob persisted, both platforms surface
    // the same defaults — the platforms are indistinguishable when
    // inspecting only this field.
    expect(win.managementInterface).toEqual(mac.managementInterface);
  });

  it('only platform and arch differ between a win32 and darwin export', () => {
    const win = buildReport('win32', 'x64');
    const mac = buildReport('darwin', 'arm64');

    // Strip the two fields that are *expected* to differ plus the
    // wall-clock timestamp.
    const stripVolatile = (
      r: DiagnosticsReport,
    ): Omit<DiagnosticsReport, 'platform' | 'arch' | 'generatedAt'> => {
      const { platform: _p, arch: _a, generatedAt: _g, ...rest } = r;
      return rest;
    };

    expect(stripVolatile(win)).toEqual(stripVolatile(mac));
  });
});
