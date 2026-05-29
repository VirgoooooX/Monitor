// OpenCode collector unit tests.
//
// Validates: Requirements 4.1, 4.5, 4.6, 13.3
//
// These cases exercise the deps-injection surface added by the
// macos-platform-support feature and pin the regression-locked
// Windows path format. The property-based tests in
// `opencode.collector.pbt.test.ts` cover the per-platform
// resolver across 100 generated inputs; this file adds
// example-based assertions that are quicker to read and that
// pin specific message formats (e.g. the `OpenCode 目录未找到`
// prefix) which would be tedious to express as a property.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createOpenCodeCollector } from './opencode.collector';

describe('createOpenCodeCollector — deps injection', () => {
  it('uses the supplied platform / env / homedir to compute the default opencode path on darwin', async () => {
    const collector = createOpenCodeCollector({
      platform: 'darwin',
      env: {},
      homedir: '/Users/alice',
    });

    // The directory does not exist in the host filesystem, so the
    // capability check returns `unavailable` with the resolved
    // path embedded verbatim. We assert that path matches the
    // darwin shape (`Library/Application Support/opencode`).
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toContain(
      '/Users/alice/Library/Application Support/opencode',
    );
    // Does not contain win32-only crumbs.
    expect(result.reason).not.toContain('AppData\\Roaming');
    expect(result.reason).not.toContain('APPDATA');
  });

  it('uses the supplied platform / env / homedir to compute the default opencode path on linux (XDG fallback)', async () => {
    const collector = createOpenCodeCollector({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/home/alice/.share-custom' },
      homedir: '/home/alice',
    });
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toContain('/home/alice/.share-custom/opencode');
  });

  it('uses the supplied platform / env / homedir to compute the default opencode path on linux (no XDG)', async () => {
    const collector = createOpenCodeCollector({
      platform: 'linux',
      env: {},
      homedir: '/home/alice',
    });
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toContain('/home/alice/.local/share/opencode');
  });

  it('regression-locked Windows path: APPDATA-rooted opencode directory', async () => {
    const collector = createOpenCodeCollector({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      homedir: 'C:\\Users\\test',
    });
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe(
      'OpenCode 目录未找到: C:\\Users\\test\\AppData\\Roaming\\opencode',
    );
  });

  it('regression-locked Windows path: falls back to <homedir>\\AppData\\Roaming when APPDATA is absent', async () => {
    const collector = createOpenCodeCollector({
      platform: 'win32',
      env: {},
      homedir: 'C:\\Users\\test',
    });
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe(
      'OpenCode 目录未找到: C:\\Users\\test\\AppData\\Roaming\\opencode',
    );
  });

  it('opencodePath override flows through to capability check verbatim', async () => {
    const overridePath = path.join(os.tmpdir(), 'opencode-override-does-not-exist');
    const collector = createOpenCodeCollector({ opencodePath: overridePath });
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe(`OpenCode 目录未找到: ${overridePath}`);
  });

  it('empty-string opencodePath falls through to the per-platform resolver', async () => {
    // Empty string is treated as "no override", per the
    // refactor's `length > 0` guard. The resolver branch then
    // fires and produces a darwin-style path.
    const collector = createOpenCodeCollector({
      opencodePath: '',
      platform: 'darwin',
      env: {},
      homedir: '/Users/bob',
    });
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toContain(
      '/Users/bob/Library/Application Support/opencode',
    );
  });
});

describe('createOpenCodeCollector — capability ok happy path', () => {
  // A short integration-style test that gives the collector a real
  // tmp directory containing a structured log so the
  // `findLogFiles` → `hasTokenFields` path is exercised end-to-end.
  // This pins that the deps-injection refactor did not break the
  // existing scan logic.
  it('returns ok when a top-level .jsonl file with token fields exists', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'opencode-test-'),
    );
    try {
      const log = path.join(root, 'session-1.jsonl');
      await fs.promises.writeFile(
        log,
        JSON.stringify({
          timestamp: '2026-05-08T15:53:34.149Z',
          model: 'opencode-v1',
          input_tokens: 100,
          output_tokens: 50,
          cache_tokens: 10,
        }) + '\n',
        'utf-8',
      );

      const collector = createOpenCodeCollector({ opencodePath: root });
      const result = await collector.capabilityCheck();
      expect(result.status).toBe('ok');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
