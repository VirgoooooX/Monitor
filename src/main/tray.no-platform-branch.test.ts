// Static source check for `src/main/tray.ts`.
//
// Validates: Requirement 5.6.
//
// Requirement 5.6 reads:
//
//   The `getIconPath` function injected into `createTray` SHALL be
//   the single point of platform branching, and the body of
//   `createTray` SHALL NOT contain any `process.platform` checks or
//   other platform-conditional logic.
//
// We enforce this by reading the source of `tray.ts` and asserting
// that the `createTray` function body — i.e. the slice between
// `function createTray(...)` and the matching closing brace at column
// zero — references `process.platform` only **once**, and that the
// single reference is the `setTemplateImage(true)` branch documented
// in design.md §`src/main/tray.ts`. Any second reference, or a
// reference outside the documented branch, is treated as a
// regression.
//
// The previous behaviour was zero references in the function body
// (the resolver lived elsewhere and the body was platform-agnostic).
// The current behaviour is exactly one reference, on the line that
// flips the AppKit template flag — Requirements 5.4 / 5.5 / 13.4
// allow this single deviation because the flag has no equivalent on
// win32 / linux and so cannot be folded into the path resolver.
//
// We deliberately read the source on disk rather than parsing the
// AST: an AST-based check would need a TypeScript parser dependency
// in test code, and the source-level invariant is straightforward
// enough to enforce with substring checks. If the file is reorganised
// such that this line-based approach no longer captures the intent,
// the test will fail loudly and a maintainer can update the slicing
// logic at that point.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TRAY_SOURCE_PATH = path.join(__dirname, 'tray.ts');

/**
 * Extract the body of the top-level `export function createTray(...)`
 * declaration as a single string. Returns the substring between the
 * opening `{` of the function and the matching closing `}` at column
 * zero. We rely on the project's formatter convention (closing brace
 * at column 0 for top-level declarations) so we can match it without
 * a full brace-depth tracker.
 */
function extractCreateTrayBody(source: string): string {
  // Normalise line endings so a CRLF-checked-in file behaves
  // identically to an LF-checked-in one. The slicing below is
  // line-based; we don't care about preserving the original
  // separator.
  const normalised = source.replace(/\r\n/g, '\n');
  const startMarker = 'export function createTray(';
  const startIdx = normalised.indexOf(startMarker);
  expect(startIdx).toBeGreaterThanOrEqual(0);

  // Find the first `{` after the `):` return-type annotation.
  const openBraceIdx = normalised.indexOf('{', startIdx);
  expect(openBraceIdx).toBeGreaterThanOrEqual(0);

  // Walk forward until we hit a `\n}` followed by a newline (or
  // end-of-file). That is the closing brace of the top-level
  // declaration under the project's formatter conventions.
  let cursor = openBraceIdx + 1;
  while (cursor < normalised.length) {
    const nextClose = normalised.indexOf('\n}', cursor);
    if (nextClose === -1) {
      throw new Error(
        'tray.ts: could not locate the closing brace of `createTray`',
      );
    }
    // The next character after `\n}` must be `\n` (more code
    // follows) or end-of-string.
    const after = normalised.charAt(nextClose + 2);
    if (after === '\n' || after === '') {
      return normalised.slice(openBraceIdx + 1, nextClose);
    }
    cursor = nextClose + 2;
  }
  throw new Error(
    'tray.ts: could not locate the closing brace of `createTray`',
  );
}

describe('tray.ts: createTray body has no platform branching beyond the setTemplateImage flag', () => {
  it('contains exactly one `process.platform` reference, and only on the setTemplateImage branch', () => {
    const source = fs.readFileSync(TRAY_SOURCE_PATH, 'utf-8');
    const body = extractCreateTrayBody(source);

    // Strip block + line comments so commented-out platform branches
    // don't trigger the assertion. We use a conservative regex that
    // keeps the line break in place so subsequent line-based checks
    // still see the same line numbers.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    const matches = code.match(/process\.platform/g) ?? [];

    // Exactly one reference is allowed: the `if (process.platform ===
    // 'darwin')` guard around `image.setTemplateImage(true)`.
    expect(matches.length).toBe(1);

    // The single reference must sit on a line that pairs `process.platform`
    // with the `darwin` literal — i.e. the documented template-flag
    // branch. We use a substring check rather than a full regex so a
    // formatter line break between `process.platform === ` and `'darwin'`
    // would surface as a precise failure rather than silently passing.
    const lines = code.split('\n');
    const platformLine = lines.find((line) => line.includes('process.platform'));
    expect(platformLine).toBeDefined();
    expect(platformLine).toContain("'darwin'");

    // Defence-in-depth: the same line must reference `setTemplateImage`
    // on it or on a subsequent line within a small window. We check
    // the next 3 lines so a reformatted multi-line `if` block still
    // satisfies the invariant. Anything farther away suggests the
    // single allowed reference was repurposed for a different branch.
    const platformLineIdx = lines.findIndex((line) =>
      line.includes('process.platform'),
    );
    const window = lines
      .slice(platformLineIdx, platformLineIdx + 4)
      .join('\n');
    expect(window).toContain('setTemplateImage');
  });
});
