// Static documentation check: `README.md` contains the macOS-support
// sections required by Requirements 14.4 and 14.5.
//
// Validates: Requirements 14.4, 14.5
//
// Requirement 14.4 reads (verbatim):
//
//   THE App's `README.md` SHALL contain a section titled exactly
//   "macOS Installation" whose body includes the verbatim first-run
//   instruction "首次运行：右键（Ctrl+click）.app → 打开 → 在弹出的
//   Gatekeeper 对话框中确认打开" or its English equivalent, AND
//   SHALL state that the macOS distribution is unsigned.
//
// Requirement 14.5 reads (verbatim):
//
//   THE App's `README.md` SHALL contain a section titled exactly
//   "Supported Platforms" listing macOS 11+ on arm64 and x64, AND
//   Windows 10+ on x64.
//
// We assert:
//
//   - `## Supported Platforms` is present as a top-level heading
//     and its body mentions macOS 11+, arm64, x64, and Windows 10+;
//   - `## macOS Installation` is present as a top-level heading;
//   - the verbatim Chinese Gatekeeper string appears somewhere in
//     the README; we anchor on the Chinese form (the "or its English
//     equivalent" allowance in 14.4 is covered by also documenting
//     it in English elsewhere in the section, but the verbatim
//     Chinese instruction is the canonical anchor we lock here);
//   - the README states the macOS distribution is unsigned.
//
// We deliberately match against the raw README bytes rather than a
// markdown AST: the requirements language is byte-precise about the
// Gatekeeper instruction, and an AST round-trip could normalise
// whitespace or punctuation in subtle ways.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const README_PATH = path.resolve(__dirname, '..', '..', 'README.md');

const GATEKEEPER_VERBATIM =
  '首次运行：右键（Ctrl+click）.app → 打开 → 在弹出的 Gatekeeper 对话框中确认打开';

function loadReadme(): string {
  return fs.readFileSync(README_PATH, 'utf-8');
}

/**
 * Extract the body of a `## <title>` section. The body runs from
 * immediately after the heading line up to (but not including) the
 * next `## ` heading or end-of-file. Returns `null` if the section
 * is absent.
 */
function extractSection(readme: string, title: string): string | null {
  // We anchor on `\n## <title>\n` (or BOF + the heading) and consume
  // up to the next `\n## ` heading or EOF. The trailing `m` flag
  // makes `^` / `$` line-anchored.
  const lines = readme.split(/\r?\n/);
  const headingPrefix = `## ${title}`;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === headingPrefix) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    return null;
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx + 1, endIdx).join('\n');
}

describe('README.md — macOS support sections', () => {
  it('exists at the project root', () => {
    expect(fs.existsSync(README_PATH)).toBe(true);
    expect(fs.statSync(README_PATH).isFile()).toBe(true);
  });

  describe('## Supported Platforms (Requirement 14.5)', () => {
    const readme = loadReadme();
    const body = extractSection(readme, 'Supported Platforms');

    it('is present as a top-level heading with the exact title', () => {
      expect(body).not.toBeNull();
    });

    it('mentions macOS 11+ on arm64 and x64', () => {
      expect(body).not.toBeNull();
      // Use a tolerant match: the requirement only mandates the
      // version + arch tokens be present, not their exact ordering.
      expect(body).toMatch(/macOS\s*11/i);
      expect(body).toMatch(/arm64/i);
      expect(body).toMatch(/x64/i);
    });

    it('mentions Windows 10+ on x64', () => {
      expect(body).not.toBeNull();
      expect(body).toMatch(/Windows\s*10/i);
      // The same `x64` token covers both bullets; we already asserted
      // its presence above.
    });
  });

  describe('## macOS Installation (Requirement 14.4)', () => {
    const readme = loadReadme();
    const body = extractSection(readme, 'macOS Installation');

    it('is present as a top-level heading with the exact title', () => {
      expect(body).not.toBeNull();
    });

    it('contains the verbatim Gatekeeper first-run instruction', () => {
      expect(body).not.toBeNull();
      // Byte-precise containment — the Chinese string MUST appear
      // exactly as Requirement 14.4 spells it.
      expect(body).toContain(GATEKEEPER_VERBATIM);
    });

    it('states that the macOS distribution is unsigned', () => {
      expect(body).not.toBeNull();
      // The section MUST mention "unsigned"; we accept any casing
      // (e.g. "Unsigned" at the start of a sentence) and any prose
      // form ("the dmg is unsigned", "ships unsigned", etc.).
      expect(body).toMatch(/unsigned/i);
    });
  });
});
