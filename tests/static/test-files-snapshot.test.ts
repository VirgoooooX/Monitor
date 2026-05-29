// Static lock: the four pre-feature collector test files MUST NOT be
// modified by the macos-platform-support feature work.
//
// Validates: Requirement 12.7
//
// Requirement 12.7 reads:
//
//   THE existing Codex, Gemini, Claude, and Kiro collector test files
//   SHALL remain byte-identical to their pre-feature contents (no
//   additions, deletions, or modifications) after this feature is
//   merged.
//
// Operationalisation. We pin the canonical content hash of each file
// against a constant and fail loudly if a hash drifts. The hash is
// SHA-256 over the file's bytes after a single normalisation pass —
// every `\r\n` is collapsed to `\n` — so the assertion is invariant
// across:
//
//   - a Windows checkout where the working tree has CRLF endings,
//   - a macOS / Linux checkout where the working tree has LF
//     endings,
//   - a CI runner that overrides `core.autocrlf` to either `true` or
//     `input`.
//
// The repo has no `.gitattributes`, so git's storage layer is LF
// (`text=auto` default with `eol` unset) and CRLF only appears on
// Windows checkouts. Hashing the LF-normalised bytes mirrors git's
// stored content exactly.
//
// One file in the spec list — `gemini.collector.test.ts` — does not
// exist in the repo at the time this lock is written. "No additions"
// is part of the byte-identity contract, so we lock its absence
// instead of its content. If a later commit adds the file, the
// `expect(fs.existsSync(...)).toBe(false)` branch fires and points
// the maintainer at this lock.
//
// Re-pinning protocol. If a hash drift is intentional (e.g. a
// follow-up feature explicitly amends one of these files), the
// failing assertion prints both the pinned hash and the freshly
// computed hash. Replace the pinned constant with the new hash in
// the same commit that performs the intentional change. Do NOT
// loosen the lock by removing the file from `LOCKED_FILES`.

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COLLECTORS_DIR = path.join(
  REPO_ROOT,
  'src',
  'main',
  'collectors',
  'usage',
);

interface LockedFile {
  /** Repo-relative POSIX path used in error messages. */
  readonly relPath: string;
  /** Absolute path on disk. */
  readonly absPath: string;
  /**
   * SHA-256 of the file's bytes after normalising line endings to
   * LF. Lower-case hex, 64 characters.
   */
  readonly sha256Lf: string;
}

const LOCKED_FILES: ReadonlyArray<LockedFile> = [
  {
    relPath: 'src/main/collectors/usage/codex.collector.test.ts',
    absPath: path.join(COLLECTORS_DIR, 'codex.collector.test.ts'),
    sha256Lf:
      '255737b180679f536fddeb3dc933ac10a905986643f60cb51614ab85a6d0a2df',
  },
  {
    relPath: 'src/main/collectors/usage/claudeCode.collector.test.ts',
    absPath: path.join(
      COLLECTORS_DIR,
      'claudeCode.collector.test.ts',
    ),
    sha256Lf:
      '97c2746f8c43e984473ee46804e9a5f72637335e5fe38f57307810c531e68ddc',
  },
  {
    relPath: 'src/main/collectors/usage/kiro.collector.test.ts',
    absPath: path.join(COLLECTORS_DIR, 'kiro.collector.test.ts'),
    sha256Lf:
      'bd69a25f1db7315d1d978176b9edba767a7c4df828540a7edc3d8ea917c36841',
  },
];

/**
 * Path of the gemini collector test file named by Requirement 12.7
 * but which does not exist in the repo at the time of the pin. Its
 * absent state is part of the lock — see file header.
 */
const GEMINI_TEST_PATH = path.join(
  COLLECTORS_DIR,
  'gemini.collector.test.ts',
);

/**
 * Hash the file's content with `\r\n` collapsed to `\n` so the same
 * commit-time bytes produce the same hash on both Windows (working
 * tree typically CRLF) and POSIX checkouts.
 */
function sha256OfLfNormalised(absPath: string): string {
  const raw = fs.readFileSync(absPath);
  // Walk byte-by-byte and drop any 0x0d that immediately precedes a
  // 0x0a. We do not strip lone 0x0d (those would be a real content
  // change worth surfacing), only the CR half of a CRLF pair.
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const byte = raw[i] as number;
    if (
      byte === 0x0d &&
      i + 1 < raw.length &&
      raw[i + 1] === 0x0a
    ) {
      continue;
    }
    out.push(byte);
  }
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(out));
  return hash.digest('hex');
}

describe('collector test files are byte-identical to their pre-feature contents (Requirement 12.7)', () => {
  for (const locked of LOCKED_FILES) {
    it(`${locked.relPath} matches its pinned SHA-256`, () => {
      // Sanity: the file exists. If a later commit deletes it, fail
      // here with a precise message rather than letting `readFileSync`
      // throw an opaque ENOENT.
      expect(
        fs.existsSync(locked.absPath),
        `${locked.relPath} is missing — Requirement 12.7 forbids deletion of the existing collector test files. ` +
          'If the deletion is intentional, update the lock in tests/static/test-files-snapshot.test.ts.',
      ).toBe(true);

      const actual = sha256OfLfNormalised(locked.absPath);
      if (actual !== locked.sha256Lf) {
        // Build a maintainer-friendly diagnostic. The new hash is
        // emitted verbatim so a maintainer who intentionally changed
        // the file can copy it directly into LOCKED_FILES.
        throw new Error(
          [
            `Hash drift detected for ${locked.relPath}.`,
            '',
            'Requirement 12.7 forbids modifications to the existing collector test files.',
            '',
            `  pinned (LF-normalised SHA-256):   ${locked.sha256Lf}`,
            `  computed (LF-normalised SHA-256): ${actual}`,
            '',
            'If this change is intentional, replace the `sha256Lf` value for this entry',
            'in tests/static/test-files-snapshot.test.ts with the computed hash above',
            'in the SAME commit that performs the file change.',
            '',
            'Do NOT remove the file from LOCKED_FILES — Requirement 12.7 requires the lock',
            'to remain in place.',
          ].join('\n'),
        );
      }
      expect(actual).toBe(locked.sha256Lf);
    });
  }

  it('gemini.collector.test.ts remains absent (Requirement 12.7 — "no additions")', () => {
    // Requirement 12.7 names a `gemini.collector.test.ts` file. No
    // such file exists in the repo at the time this lock was written;
    // gemini-collector behaviour is exercised only through the
    // shared `usage.test.ts`. The "no additions" half of "no
    // additions, deletions, or modifications" therefore translates
    // to: this exact path must continue to be absent. If a future
    // commit deliberately introduces the file, replace this assertion
    // with a hash-pin entry under LOCKED_FILES in the SAME commit.
    if (fs.existsSync(GEMINI_TEST_PATH)) {
      const newHash = sha256OfLfNormalised(GEMINI_TEST_PATH);
      throw new Error(
        [
          `Unexpected new file: src/main/collectors/usage/gemini.collector.test.ts.`,
          '',
          'Requirement 12.7 forbids additions to the existing collector test files.',
          '',
          `  computed (LF-normalised SHA-256): ${newHash}`,
          '',
          'If this addition is intentional, add a LOCKED_FILES entry for the new file',
          'in tests/static/test-files-snapshot.test.ts using the hash above, in the SAME',
          'commit that introduces the file.',
        ].join('\n'),
      );
    }
    expect(fs.existsSync(GEMINI_TEST_PATH)).toBe(false);
  });
});
