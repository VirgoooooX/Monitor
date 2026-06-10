// Static configuration check: `package.json` carries the exact
// `package` and `package:mac` script entries required by the
// macos-platform-support feature.
//
// Validates: Requirements 1.3, 1.4
//
// The two assertions are intentionally byte-strict on the script
// command strings:
//
//   - `package` must remain the verbatim Windows packaging command
//     `"npm run build && electron-builder --win"` so the existing
//     Windows release path is preserved unchanged (Requirement 1.4);
//
//   - `package:mac` chains the new `prepackage:mac` probe step with
//     the existing build step and a multi-arch electron-builder
//     invocation, matching the design's literal command string
//     (Requirement 1.3).
//
// We also assert that `prepackage:mac` resolves to the checked-in
// probe script so a future rename of `scripts/prepackage-mac.mjs`
// breaks the lock immediately.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PACKAGE_JSON_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'package.json',
);

interface PackageJson {
  scripts?: Record<string, string>;
}

function loadPackageJson(): PackageJson {
  const raw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('package.json did not parse as a JSON object');
  }
  return parsed as PackageJson;
}

describe('package.json — packaging script entries', () => {
  const pkg = loadPackageJson();
  const scripts = pkg.scripts ?? {};

  it('preserves the Windows `package` script verbatim (Requirement 1.4)', () => {
    expect(scripts['package']).toBe(
      'npm run build && electron-builder --win --publish never',
    );
  });

  it('declares the `package:mac` script with the documented command (Requirement 1.3)', () => {
    expect(scripts['package:mac']).toBe(
      'npm run prepackage:mac && npm run build && electron-builder --mac --x64 --arm64 --publish never',
    );
  });

  it('declares the `prepackage:mac` script pointing at the checked-in probe (Requirement 1.3)', () => {
    expect(scripts['prepackage:mac']).toBe(
      'node scripts/prepackage-mac.mjs',
    );
  });
});
