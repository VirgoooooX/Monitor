// Antigravity collector — deps-injection example tests.
//
// Validates: Requirement 3.10 (deps-injection without monkey-patching
// globals); also reinforces Requirements 3.5 / 3.6 / 3.9.
//
// **Posture.** All cases below drive the collector through its
// public dependency injection surface. We never mutate
// `process.platform`, `process.env`, or `os.homedir()` — the
// `platform`, `env`, and `homedir` deps replace those reads inside
// the resolver, and `directoryExists` is stubbed to drive specific
// branches deterministically without touching the host filesystem.

import { describe, it, expect } from 'vitest';

import { createAntigravityCollector } from './antigravity.collector';

const alwaysFalse = async (): Promise<boolean> => false;

describe('antigravity collector — deps-injection (Requirement 3.10)', () => {
  it('routes platform=darwin through the resolver to a Library/Application Support path', async () => {
    const collector = createAntigravityCollector({
      platform: 'darwin',
      env: {},
      homedir: '/Users/test',
      geminiPath: '/Users/test/.gemini/antigravity',
      directoryExists: alwaysFalse,
    });

    const result = await collector.capabilityCheck();

    expect(result.status).toBe('unavailable');
    // The resolver-derived application-data path on darwin contains
    // the canonical macOS data anchor (forward slashes — the
    // resolver uses `path.posix.join` for darwin).
    expect(result.reason).toContain('Library/Application Support');
    expect(result.reason).toContain('Antigravity/logs');
    // Negative check: no Windows-flavoured AppData substring leaks
    // through on darwin (Requirement 3.7).
    expect(result.reason).not.toContain('AppData\\Roaming');
    expect(result.reason).not.toContain('APPDATA');
  });

  it('routes platform=darwin without env to <homedir>/Library/Application Support/Antigravity/logs verbatim', async () => {
    const collector = createAntigravityCollector({
      platform: 'darwin',
      env: {},
      homedir: '/Users/example',
      geminiPath: '/Users/example/.gemini/antigravity',
      directoryExists: alwaysFalse,
    });

    const result = await collector.capabilityCheck();

    expect(result.reason).toBe(
      '目录 /Users/example/.gemini/antigravity 和 /Users/example/Library/Application Support/Antigravity/logs 均不存在',
    );
  });

  it('uses the appDataPath override verbatim and bypasses the per-platform resolver (Requirement 3.9)', async () => {
    // Even though we declare `platform: 'darwin'` and a homedir that
    // would otherwise resolve under `/Users/test/Library/...`, the
    // explicit `appDataPath` override must flow through unchanged.
    const collector = createAntigravityCollector({
      platform: 'darwin',
      env: {},
      homedir: '/Users/test',
      geminiPath: '/tmp/no-such/.gemini/antigravity',
      appDataPath: '/tmp/custom/antigravity-data',
      directoryExists: alwaysFalse,
    });

    const result = await collector.capabilityCheck();

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(
      '目录 /tmp/no-such/.gemini/antigravity 和 /tmp/custom/antigravity-data 均不存在',
    );
    // Resolver-derived path absent, proving the override won.
    expect(result.reason).not.toContain('Library/Application Support');
  });
});
