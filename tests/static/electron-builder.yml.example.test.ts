// Static configuration check: `electron-builder.yml` carries the
// macOS build block expected by the macos-platform-support feature.
//
// Validates: Requirements 1.1, 1.6, 1.7, 1.8, 14.1, 14.3, 14.8
//
// The test parses the checked-in YAML and asserts shape — not byte
// equality — so reformatting the file (e.g. changing key order or
// adding harmless comments) does not break the lock-down. The
// invariants we lock are:
//
//   - the `mac` block declares exactly the keys named by Requirement
//     1.1 and 1.8: `category`, `icon`, `hardenedRuntime`,
//     `gatekeeperAssess`, `identity`, `entitlements`,
//     `entitlementsInherit`, `target`, `extendInfo`;
//   - the `extraResources` block contains the five mappings named by
//     Requirements 1.6 and 1.7 (the new `icon.icns`, the two
//     `tray-iconTemplate` PNGs, and the pre-existing Windows
//     `icon.ico` and `tray-icon.png` mappings);
//   - the `extendInfo` block sets `LSUIElement: true` and
//     `LSMinimumSystemVersion: "11.0"` (Requirement 14.1) — the
//     version is asserted as the literal string `"11.0"`, not the
//     number 11, because Apple's `Info.plist` reader is type-strict
//     about that key;
//   - the `mac.target` declaration uses only `dmg` (Requirements 14.3
//     and 14.8: `zip`, `pkg`, `mas`, `dir`, and `universal` are
//     forbidden);
//   - the `entitlements` and `entitlementsInherit` paths point at the
//     checked-in `build/entitlements.mac.plist` (Requirement 1.8).
//
// `js-yaml` is the only YAML parser already present in
// `node_modules/`; it ships no TypeScript types of its own and we
// have not installed `@types/js-yaml`, so we require it through a
// typed require expression that names the single function we use.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// js-yaml has no bundled types; declare the slice of its API we use.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (input: string) => unknown };

const YAML_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'electron-builder.yml',
);

interface ExtraResource {
  from: string;
  to: string;
}

interface MacTarget {
  target: string;
  arch?: ReadonlyArray<string>;
}

interface MacBlock {
  category?: string;
  icon?: string;
  hardenedRuntime?: boolean;
  gatekeeperAssess?: boolean;
  identity?: string | null;
  entitlements?: string;
  entitlementsInherit?: string;
  target?: ReadonlyArray<MacTarget>;
  extendInfo?: Record<string, unknown>;
}

interface BuilderConfig {
  appId?: string;
  extraResources?: ReadonlyArray<ExtraResource>;
  mac?: MacBlock;
  win?: Record<string, unknown>;
  nsis?: Record<string, unknown>;
  npmRebuild?: boolean;
  forceCodeSigning?: boolean;
  afterPack?: string;
}

function loadConfig(): BuilderConfig {
  const raw = fs.readFileSync(YAML_PATH, 'utf-8');
  const parsed = yaml.load(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      'electron-builder.yml did not parse as a YAML mapping',
    );
  }
  return parsed as BuilderConfig;
}

describe('electron-builder.yml — macOS block', () => {
  const config = loadConfig();
  const mac = config.mac;

  it('declares a top-level `mac` block (Requirement 1.1)', () => {
    expect(mac).toBeDefined();
    expect(mac).not.toBeNull();
  });

  it('uses the documented developer-tools category (Requirement 1.1)', () => {
    expect(mac?.category).toBe('public.app-category.developer-tools');
  });

  it('points `icon` at the checked-in icns asset (Requirement 1.1)', () => {
    expect(mac?.icon).toBe('build/icon.icns');
  });

  it('enables Hardened Runtime and disables Gatekeeper assess (Requirement 1.1)', () => {
    expect(mac?.hardenedRuntime).toBe(true);
    expect(mac?.gatekeeperAssess).toBe(false);
  });

  it('declares `identity: null` so the build is unsigned (Requirements 1.1, 1.5)', () => {
    expect(mac?.identity).toBeNull();
  });

  it('points `entitlements` and `entitlementsInherit` at the checked-in plist (Requirement 1.8)', () => {
    expect(mac?.entitlements).toBe('build/entitlements.mac.plist');
    expect(mac?.entitlementsInherit).toBe(
      'build/entitlements.mac.plist',
    );
  });

  it('targets exactly one dmg entry with both x64 and arm64 arches (Requirement 14.3)', () => {
    const targets = mac?.target;
    expect(Array.isArray(targets)).toBe(true);
    expect(targets).toHaveLength(1);
    const [first] = targets ?? [];
    expect(first?.target).toBe('dmg');
    expect(first?.arch).toEqual(['x64', 'arm64']);
  });

  it('forbids zip / pkg / mas / dir / universal mac targets (Requirements 14.3, 14.8)', () => {
    const disallowed = new Set([
      'zip',
      'pkg',
      'mas',
      'dir',
      'universal',
    ]);
    for (const entry of mac?.target ?? []) {
      expect(disallowed.has(entry.target)).toBe(false);
      // Defensive: if a future edit re-introduces `arch: ["universal"]`
      // inside an otherwise-allowed target, reject that too.
      for (const arch of entry.arch ?? []) {
        expect(disallowed.has(arch)).toBe(false);
      }
    }
  });

  it('sets `LSUIElement: true` and `LSMinimumSystemVersion: "11.0"` (Requirement 14.1)', () => {
    const info = mac?.extendInfo;
    expect(info).toBeDefined();
    expect(info?.['LSUIElement']).toBe(true);
    // Apple's Info.plist reader treats LSMinimumSystemVersion as a
    // string. Assert string equality, not numeric, to catch a future
    // edit that drops the quotes around `11.0` (which YAML would
    // otherwise round-trip as the number 11).
    expect(info?.['LSMinimumSystemVersion']).toBe('11.0');
    expect(typeof info?.['LSMinimumSystemVersion']).toBe('string');
  });
});

describe('electron-builder.yml — extraResources mappings', () => {
  const config = loadConfig();
  const mappings = config.extraResources ?? [];

  it('declares all five expected from→to mappings (Requirements 1.6, 1.7)', () => {
    const expected: ReadonlyArray<ExtraResource> = [
      { from: 'build/tray-icon.png', to: 'tray-icon.png' },
      { from: 'build/icon.ico', to: 'icon.ico' },
      { from: 'build/icon.icns', to: 'icon.icns' },
      {
        from: 'build/tray-iconTemplate.png',
        to: 'tray-iconTemplate.png',
      },
      {
        from: 'build/tray-iconTemplate@2x.png',
        to: 'tray-iconTemplate@2x.png',
      },
    ];
    for (const want of expected) {
      const found = mappings.find(
        (m) => m.from === want.from && m.to === want.to,
      );
      if (found === undefined) {
        throw new Error(
          `extraResources is missing mapping ${want.from} → ${want.to}. ` +
            `Got: ${JSON.stringify(mappings, null, 2)}`,
        );
      }
    }
  });

  it('preserves the pre-existing Windows mappings byte-for-byte (Requirement 1.7)', () => {
    expect(mappings).toContainEqual({
      from: 'build/icon.ico',
      to: 'icon.ico',
    });
    expect(mappings).toContainEqual({
      from: 'build/tray-icon.png',
      to: 'tray-icon.png',
    });
  });
});

describe('electron-builder.yml — Windows-side invariants unchanged', () => {
  const config = loadConfig();

  it('keeps appId, npmRebuild, forceCodeSigning, and afterPack unchanged (Requirement 13.1)', () => {
    expect(config.appId).toBe('com.monitor.desktop');
    expect(config.npmRebuild).toBe(true);
    expect(config.forceCodeSigning).toBe(false);
    expect(config.afterPack).toBe('scripts/after-pack-icon.cjs');
  });

  it('keeps the win block unchanged (Requirement 13.1)', () => {
    expect(config.win).toEqual({
      target: 'nsis',
      icon: 'build/icon.ico',
      signAndEditExecutable: false,
    });
  });

  it('keeps the nsis block unchanged (Requirement 13.1)', () => {
    expect(config.nsis).toEqual({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      installerIcon: 'build/icon.ico',
      uninstallerIcon: 'build/icon.ico',
    });
  });
});
