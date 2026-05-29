// Static source check: no direct DPAPI usage anywhere in `src/`.
//
// Validates: Requirement 13.6
//
// Requirement 13.6 reads:
//
//   THE Secrets_Store SHALL use platform-native encryption via
//   Electron `safeStorage` on every platform, delegating to DPAPI on
//   Windows and Keychain Services on macOS; AND WHILE running on
//   `process.platform === 'win32'`, THE Secrets_Store SHALL NOT
//   invoke any non-Electron encryption API.
//
// Operationalising the "no non-Electron encryption API" clause: the
// project SHALL NOT import or reference the Win32 DPAPI (`Crypt32.dll`
// `CryptProtectData` / `CryptUnprotectData`) directly — any such
// reference would be a regression of the cross-platform secrets
// posture. The single source of truth for encryption is
// `safeStorage`, which delegates internally to DPAPI / Keychain /
// libsecret.
//
// We grep the entire `src/` tree (recursively) for the offending
// symbols. Test files are excluded — `secrets.management.pbt.test.ts`
// and a few comments mention "DPAPI" in prose to describe the
// platform binding, but never as a code reference, and excluding
// `*.test.ts` keeps the assertion focused on shipping source.
//
// We deliberately read the disk rather than parsing the AST: a
// substring match is sufficient because no legitimate identifier in
// our code base spells `CryptProtectData` / `CryptUnprotectData`,
// and a future direct DPAPI import would necessarily reference one
// of those names.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');

/** File extensions we consider "source" for the purposes of this check. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
]);

/**
 * Test files are excluded — they describe the OS-level encryption
 * binding in prose ("DPAPI on Windows", "Keychain on macOS") without
 * actually invoking it.
 */
function isTestFile(relPath: string): boolean {
  return (
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.test.tsx') ||
    relPath.endsWith('.spec.ts') ||
    relPath.endsWith('.spec.tsx')
  );
}

/**
 * Forbidden symbols. These are the canonical names of the Win32
 * DPAPI entry points; any direct binding (via `node-ffi-napi`,
 * `koffi`, `node-addon-api`, or a hand-rolled native module) would
 * have to spell one of them.
 */
const FORBIDDEN = ['CryptProtectData', 'CryptUnprotectData'];

interface Hit {
  relPath: string;
  line: number;
  needle: string;
  excerpt: string;
}

function walk(dir: string, hits: Hit[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, hits);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) {
      continue;
    }
    const relPath = path
      .relative(SRC_ROOT, abs)
      .split(path.sep)
      .join('/');
    if (isTestFile(relPath)) {
      continue;
    }

    const content = fs.readFileSync(abs, 'utf-8');
    if (!FORBIDDEN.some((needle) => content.includes(needle))) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      for (const needle of FORBIDDEN) {
        if (line.includes(needle)) {
          hits.push({
            relPath,
            line: i + 1,
            needle,
            excerpt: line.trim().slice(0, 200),
          });
        }
      }
    }
  }
}

describe('no direct DPAPI references in shipping source (Requirement 13.6)', () => {
  it('grep src/ finds zero matches for CryptProtectData / CryptUnprotectData outside test files', () => {
    // Sanity: `src/` exists. If it does not, our walk would silently
    // pass — fail loudly instead so a future repo restructure can't
    // accidentally turn this assertion into a no-op.
    expect(fs.existsSync(SRC_ROOT)).toBe(true);
    expect(fs.statSync(SRC_ROOT).isDirectory()).toBe(true);

    const hits: Hit[] = [];
    walk(SRC_ROOT, hits);

    if (hits.length > 0) {
      const summary = hits
        .map(
          (h) =>
            `  ${h.relPath}:${h.line}  [${h.needle}]  ${h.excerpt}`,
        )
        .join('\n');
      throw new Error(
        `Found ${hits.length} direct DPAPI reference(s) in src/. ` +
          'All encryption MUST go through Electron `safeStorage`.\n' +
          summary,
      );
    }

    expect(hits).toEqual([]);
  });
});
