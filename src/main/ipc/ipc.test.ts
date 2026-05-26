// IPC handler registry tests — security & schema validation.
//
// Covers:
//   - updateSettings rejects unknown fields (strict schema)
//   - updateSecret only accepts allowlisted keys
//   - Schema validation prevents malformed payloads
//   - switchOpenClashConfig payload schema (network-quick-actions
//     task 10.4 — static-shape validation only; live-whitelist
//     membership and orchestrator behaviour are covered by task 10.6
//     property tests).

import { describe, it, expect } from 'vitest';
import {
  appSettingsPatchSchema,
  switchOpenClashConfigInputSchema,
  updateSecretInputSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Schema-level tests (no Electron dependency)
// ---------------------------------------------------------------------------

describe('appSettingsPatchSchema', () => {
  it('rejects unknown fields', () => {
    const result = appSettingsPatchSchema.safeParse({
      controllerUrl: 'http://192.168.31.100:9090',
      _secret: 'should-be-rejected',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown nested fields', () => {
    const result = appSettingsPatchSchema.safeParse({
      unknownField: 'should-be-rejected',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid partial patch', () => {
    const result = appSettingsPatchSchema.safeParse({
      controllerUrl: 'http://192.168.1.1:9090',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (no changes)', () => {
    const result = appSettingsPatchSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects invalid controllerUrl', () => {
    const result = appSettingsPatchSchema.safeParse({
      controllerUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects interval below minimum', () => {
    const result = appSettingsPatchSchema.safeParse({
      refreshIntervals: {
        networkMs: 500, // below 1000 minimum
        openclashMs: 3000,
        currentNodeMs: 10000,
        nodeScanMs: 60000,
        usageMs: 60000,
        retentionMs: 3600000,
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an appearance-only patch (theme system)', () => {
    const result = appSettingsPatchSchema.safeParse({
      appearance: {
        colorMode: 'light',
        compactTheme: 'aurora-ring',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an appearance patch with unknown compactTheme', () => {
    const result = appSettingsPatchSchema.safeParse({
      appearance: {
        colorMode: 'dark',
        compactTheme: 'not-a-real-theme',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('updateSecretInputSchema', () => {
  it('accepts valid key+value', () => {
    const result = updateSecretInputSchema.safeParse({
      key: 'openclash.controllerSecret',
      value: 'mySecret123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty key', () => {
    const result = updateSecretInputSchema.safeParse({
      key: '',
      value: 'value',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty value', () => {
    const result = updateSecretInputSchema.safeParse({
      key: 'openclash.controllerSecret',
      value: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    const result = updateSecretInputSchema.safeParse({
      key: 'openclash.controllerSecret',
      value: 'secret',
      extra: 'bad',
    });
    expect(result.success).toBe(false);
  });
});

describe('switchOpenClashConfigInputSchema', () => {
  it('accepts a non-empty trimmed targetPath', () => {
    const result = switchOpenClashConfigInputSchema.safeParse({
      targetPath: '/etc/openclash/config/profile-a.yaml',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing targetPath field', () => {
    const result = switchOpenClashConfigInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects an empty targetPath', () => {
    const result = switchOpenClashConfigInputSchema.safeParse({
      targetPath: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only targetPath', () => {
    const result = switchOpenClashConfigInputSchema.safeParse({
      targetPath: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-string targetPath', () => {
    const result = switchOpenClashConfigInputSchema.safeParse({
      targetPath: 42,
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields under strict mode', () => {
    const result = switchOpenClashConfigInputSchema.safeParse({
      targetPath: '/etc/openclash/config/profile-a.yaml',
      extra: 'should-be-rejected',
    });
    expect(result.success).toBe(false);
  });
});
