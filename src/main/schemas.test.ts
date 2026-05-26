// Feature: network-quick-actions, Property 11
//
// Property 11: AppSettings schema accepts every default and rejects every invalid form.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.6
//   - 13.1 New AppSettings fields (configSwitchVerifyWindowMs, managementInterface.url,
//          managementInterface.kind) are validated.
//   - 13.2 No `configSwitchConfirmation` field is accepted by the schema.
//   - 13.3 Out-of-range / malformed values cause `appSettingsSchema.safeParse` to fail.
//   - 13.6 Management URLs with embedded userinfo, query, or fragment are rejected.
//
// Strategy: build a known-valid `AppSettings` base, then mutate one field at a time
// using fast-check arbitraries. Run >=100 cases per property.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { appSettingsSchema } from './schemas';
import type { AppSettings } from './types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NUM_RUNS = 100;

/**
 * A valid baseline `AppSettings`. Every field passes the current schema; tests
 * mutate one field at a time so failures localize to the field under test.
 *
 * The `managementInterface.url` is set to a real http(s) origin (rather than
 * the seeded empty string in `buildDefaultAppSettings`) because the schema's
 * `managementUrlSchema` enforces `min(1)`; the empty seed is a "not yet
 * configured" sentinel that lives outside the validated range.
 */
function validBase(): AppSettings {
  return {
    controllerUrl: 'http://192.168.31.100:9090',
    primaryGroups: ['🚀 节点选择'],
    probeUrls: ['https://www.google.com/generate_204'],
    routerHealth: { host: '192.168.31.100', port: 22 },
    switchVerifyDelayMs: 1000,
    switchConfirmation: false,
    refreshIntervals: {
      networkMs: 3_000,
      openclashMs: 3_000,
      currentNodeMs: 10_000,
      nodeScanMs: 60_000,
      usageMs: 60_000,
      retentionMs: 60 * 60 * 1_000,
    },
    collectors: {
      codex: { enabled: true },
    },
    autostart: false,
    configSwitchVerifyWindowMs: 8_000,
    managementInterface: {
      kind: 'openclash-luci',
      url: 'http://192.168.31.100',
      requestTimeoutMs: 10_000,
      configFileWhitelist: [],
    },
    cliproxy: {
      enabled: false,
      managementUrl: '',
      authDir: '',
      usageQueueBatchSize: 25,
    },
    appearance: {
      colorMode: 'dark',
      compactTheme: 'mint-monitor',
      fontScale: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Integers in the closed interval [1000, 30000] — the spec's valid range. */
const validVerifyWindowMs = fc.integer({ min: 1_000, max: 30_000 });
const validRequestTimeoutMs = fc.integer({ min: 1_000, max: 30_000 });

/** Out-of-range integers (below 1000 or above 30000). */
const outOfRangeWindowMs = fc.oneof(
  fc.integer({ min: -1_000_000, max: 999 }),
  fc.integer({ min: 30_001, max: 1_000_000 }),
);

/** Non-integer numbers in a plausible range; integers are filtered out. */
const nonIntegerWindowMs = fc
  .double({ min: 1_000, max: 30_000, noNaN: true, noDefaultInfinity: true })
  .filter((n) => !Number.isInteger(n));

/** Build a known-valid http(s) origin URL with no query/fragment/userinfo. */
const validHostArb = fc.constantFrom(
  '192.168.1.1',
  'router.lan',
  '10.0.0.1',
  'openwrt.local',
);

const validManagementUrl = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    validHostArb,
    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
  )
  .map(([scheme, host, port]) =>
    port === undefined ? `${scheme}://${host}` : `${scheme}://${host}:${port}`,
  );

/** http(s):// URL with embedded userinfo (e.g. http://user:pass@host). */
const urlWithUserinfo = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc
      .string({ minLength: 1, maxLength: 8 })
      .filter((s) => /^[A-Za-z0-9]+$/.test(s)),
    fc
      .string({ minLength: 1, maxLength: 8 })
      .filter((s) => /^[A-Za-z0-9]+$/.test(s)),
    validHostArb,
  )
  .map(([scheme, user, pass, host]) => `${scheme}://${user}:${pass}@${host}`);

/** http(s):// URL with a query string (e.g. http://host?token=abc). */
const urlWithQuery = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    validHostArb,
    fc
      .string({ minLength: 1, maxLength: 8 })
      .filter((s) => /^[A-Za-z0-9]+$/.test(s)),
  )
  .map(([scheme, host, token]) => `${scheme}://${host}?token=${token}`);

/** http(s):// URL with a fragment (e.g. http://host#password=abc). */
const urlWithFragment = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    validHostArb,
    fc
      .string({ minLength: 1, maxLength: 8 })
      .filter((s) => /^[A-Za-z0-9]+$/.test(s)),
  )
  .map(([scheme, host, frag]) => `${scheme}://${host}#${frag}`);

/** Non-http(s) scheme URLs (file://, ftp://, ws://, javascript:). */
const nonHttpUrl = fc
  .tuple(
    fc.constantFrom('file', 'ftp', 'ws', 'wss', 'gopher'),
    validHostArb,
  )
  .map(([scheme, host]) => `${scheme}://${host}`);

const invalidManagementUrl = fc.oneof(
  urlWithUserinfo,
  urlWithQuery,
  urlWithFragment,
  nonHttpUrl,
);

/**
 * Arbitrary unknown keys. We deliberately seed `'configSwitchConfirmation'`
 * because Requirement 13.2 specifically forbids that key. Otherwise generate
 * short identifiers that don't collide with known top-level keys.
 */
const knownKeys = new Set<string>([
  'controllerUrl',
  'primaryGroups',
  'probeUrls',
  'routerHealth',
  'switchVerifyDelayMs',
  'switchConfirmation',
  'refreshIntervals',
  'collectors',
  'autostart',
  'configSwitchVerifyWindowMs',
  'managementInterface',
]);

const unknownKey = fc.oneof(
  fc.constant('configSwitchConfirmation'),
  fc
    .string({ minLength: 1, maxLength: 24 })
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !knownKeys.has(s)),
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('appSettingsSchema (Property 11)', () => {
  it('accepts the known-valid baseline (sanity)', () => {
    const result = appSettingsSchema.safeParse(validBase());
    expect(result.success).toBe(true);
  });

  // 1. configSwitchVerifyWindowMs in [1000, 30000] is accepted.
  it('accepts every valid configSwitchVerifyWindowMs', () => {
    fc.assert(
      fc.property(validVerifyWindowMs, (windowMs) => {
        const settings: AppSettings = {
          ...validBase(),
          configSwitchVerifyWindowMs: windowMs,
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 2. Out-of-range, non-integer, and NaN configSwitchVerifyWindowMs are rejected.
  it('rejects out-of-range configSwitchVerifyWindowMs', () => {
    fc.assert(
      fc.property(outOfRangeWindowMs, (windowMs) => {
        const settings = {
          ...validBase(),
          configSwitchVerifyWindowMs: windowMs,
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects non-integer configSwitchVerifyWindowMs', () => {
    fc.assert(
      fc.property(nonIntegerWindowMs, (windowMs) => {
        const settings = {
          ...validBase(),
          configSwitchVerifyWindowMs: windowMs,
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects NaN configSwitchVerifyWindowMs', () => {
    const settings = {
      ...validBase(),
      configSwitchVerifyWindowMs: Number.NaN,
    };
    const result = appSettingsSchema.safeParse(settings);
    expect(result.success).toBe(false);
  });

  // 3. Invalid management URLs (userinfo, query, fragment, non-http) are rejected.
  it('rejects management URLs with userinfo / query / fragment / non-http(s)', () => {
    fc.assert(
      fc.property(invalidManagementUrl, (badUrl) => {
        const base = validBase();
        const settings = {
          ...base,
          managementInterface: {
            ...base.managementInterface,
            url: badUrl,
          },
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts plain http(s):// management URLs without userinfo, query, or fragment', () => {
    fc.assert(
      fc.property(validManagementUrl, (goodUrl) => {
        const base = validBase();
        const settings: AppSettings = {
          ...base,
          managementInterface: {
            ...base.managementInterface,
            url: goodUrl,
          },
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 4. Unknown extra keys are rejected (notably `configSwitchConfirmation`).
  it('rejects any unknown extra top-level key, including configSwitchConfirmation', () => {
    fc.assert(
      fc.property(unknownKey, fc.anything(), (key, value) => {
        const settings = {
          ...validBase(),
          [key]: value,
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('explicitly rejects configSwitchConfirmation (Requirement 13.2)', () => {
    const settings = {
      ...validBase(),
      configSwitchConfirmation: true,
    };
    const result = appSettingsSchema.safeParse(settings);
    expect(result.success).toBe(false);
  });

  // 5. requestTimeoutMs in [1000, 30000] is accepted.
  it('accepts every valid managementInterface.requestTimeoutMs', () => {
    fc.assert(
      fc.property(validRequestTimeoutMs, (timeoutMs) => {
        const base = validBase();
        const settings: AppSettings = {
          ...base,
          managementInterface: {
            ...base.managementInterface,
            requestTimeoutMs: timeoutMs,
          },
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects out-of-range managementInterface.requestTimeoutMs', () => {
    fc.assert(
      fc.property(outOfRangeWindowMs, (timeoutMs) => {
        const base = validBase();
        const settings = {
          ...base,
          managementInterface: {
            ...base.managementInterface,
            requestTimeoutMs: timeoutMs,
          },
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Appearance / theme schema (theme system feature)
// ---------------------------------------------------------------------------
//
// The theme system adds an `appearance` block to `AppSettings` with a
// closed-set `colorMode` (dark | light), `compactTheme` (one of six
// presets), and bounded `fontScale`. The schema must:
//   - accept every default colorMode / compactTheme combination
//   - reject any unknown literal in either field
//   - reject extra keys (the appearance schema is `.strict()`)
//   - accept partial patches via `appSettingsPatchSchema`

describe('appSettingsSchema appearance (theme system)', () => {
  const VALID_COLOR_MODES = ['dark', 'light'] as const;
  const VALID_COMPACT_THEMES = [
    // v2 design-language presets
    'liquid-glass',
    'material-you',
    'soft-neumorph',
    'paper-dashboard',
    'mint-monitor',
    'device-oled',
    // v1 legacy presets retained as additional options
    'obsidian-glass',
    'aurora-ring',
    'holo-grid',
    'liquid-metal',
    'signal-pulse',
  ] as const;

  it('accepts every valid (colorMode, compactTheme) pair', () => {
    for (const colorMode of VALID_COLOR_MODES) {
      for (const compactTheme of VALID_COMPACT_THEMES) {
        const base = validBase();
        const settings: AppSettings = {
          ...base,
          appearance: { colorMode, compactTheme, fontScale: 1 },
        };
        const result = appSettingsSchema.safeParse(settings);
        expect(result.success).toBe(true);
      }
    }
  });

  it('rejects unknown colorMode', () => {
    const base = validBase();
    const settings = {
      ...base,
      appearance: {
        colorMode: 'sepia',
        compactTheme: 'mint-monitor',
        fontScale: 1,
      },
    };
    const result = appSettingsSchema.safeParse(settings);
    expect(result.success).toBe(false);
  });

  it('rejects unknown compactTheme', () => {
    const base = validBase();
    const settings = {
      ...base,
      appearance: {
        colorMode: 'dark',
        compactTheme: 'rainbow-explosion',
        fontScale: 1,
      },
    };
    const result = appSettingsSchema.safeParse(settings);
    expect(result.success).toBe(false);
  });

  it('rejects extra keys inside appearance', () => {
    const base = validBase();
    const settings = {
      ...base,
      appearance: {
        colorMode: 'dark',
        compactTheme: 'mint-monitor',
        fontScale: 1,
        accent: '#ff0000',
      },
    };
    const result = appSettingsSchema.safeParse(settings);
    expect(result.success).toBe(false);
  });

  it('accepts the bounded font scale range', () => {
    for (const fontScale of [0.9, 1, 1.2]) {
      const settings: AppSettings = {
        ...validBase(),
        appearance: {
          colorMode: 'dark',
          compactTheme: 'mint-monitor',
          fontScale,
        },
      };
      expect(appSettingsSchema.safeParse(settings).success).toBe(true);
    }
  });

  it('rejects font scale outside the supported range', () => {
    for (const fontScale of [0.89, 1.21]) {
      const settings: AppSettings = {
        ...validBase(),
        appearance: {
          colorMode: 'dark',
          compactTheme: 'mint-monitor',
          fontScale,
        },
      };
      expect(appSettingsSchema.safeParse(settings).success).toBe(false);
    }
  });
});
