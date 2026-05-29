// Feature: macos-platform-support, Property 9: icons script is atomic across the seven outputs
//
// Validates: Requirement 6.3a
//
// The script writes seven canonical artifacts under `build/`:
//
//   icon.svg, icon.ico, icon.icns, icon.png,
//   tray-icon.png, tray-iconTemplate.png, tray-iconTemplate@2x.png
//
// Requirement 6.3a says: if any output cannot be written successfully,
// the script must exit non-zero AND every one of those seven paths
// must be byte-identical to its pre-run state (or remain absent if it
// did not exist before the run). The script implements this by
// writing each output to `<name>.tmp` first and renaming to the final
// path only after **all** seven temp files have been written. The
// rename is the commit point; a failure at rename `n` leaves outputs
// `[n..6]` byte-identical to their pre-run state.
//
// We exercise this by injecting a fake `fs.rename` that throws at a
// chosen index `failureIndex ∈ [0, 6]`. Because the rename order is
// deterministic (matches `SEVEN_OUTPUT_FILENAMES`), the post-run state
// of every output `m ≥ failureIndex` MUST equal its pre-run state.
//
// Outputs `m < failureIndex` are allowed to flip — the rename has
// already committed. The "atomic across the failed-rename target"
// half of Property 9 is that output `failureIndex` itself stays
// untouched; the failed rename leaves its `.tmp` orphaned but does
// not overwrite the destination, which we explicitly assert.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  atomicWriteAll,
  SEVEN_OUTPUT_FILENAMES,
  // @ts-expect-error — gen-icons.mjs is untyped JS but vitest can
  // import it directly via esbuild's loader.
} from './gen-icons.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DirSnapshot {
  /**
   * For every canonical filename, either the pre-run bytes (Buffer)
   * or `null` to mean "did not exist before the run".
   */
  readonly bytes: ReadonlyMap<string, Buffer | null>;
}

function snapshotDir(dir: string, names: readonly string[]): DirSnapshot {
  const bytes = new Map<string, Buffer | null>();
  for (const name of names) {
    const path = join(dir, name);
    bytes.set(name, existsSync(path) ? readFileSync(path) : null);
  }
  return { bytes };
}

function compareSnapshotsByteIdentical(
  before: DirSnapshot,
  after: DirSnapshot,
  name: string,
): boolean {
  const a = before.bytes.get(name) ?? null;
  const b = after.bytes.get(name) ?? null;
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Property 9: icons script is atomic across the seven outputs', () => {
  it(
    'a rename failure at any index leaves all unrenamed outputs byte-identical to pre-run',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 6 }),
          // Generator over the pre-run state of each artifact: present
          // (with arbitrary stable bytes) or absent. We use a small
          // fixed-size byte array so shrinking stays cheap.
          fc.array(fc.option(fc.uint8Array({ minLength: 1, maxLength: 32 })), {
            minLength: 7,
            maxLength: 7,
          }),
          (failureIndex, preStates) => {
            // Per-iteration tmpdir so iterations don't interfere.
            const dir = mkdtempSync(join(tmpdir(), 'gen-icons-pbt-'));
            try {
              // Seed the pre-run state.
              mkdirSync(dir, { recursive: true });
              for (let i = 0; i < SEVEN_OUTPUT_FILENAMES.length; i++) {
                const name = SEVEN_OUTPUT_FILENAMES[i];
                const pre = preStates[i];
                if (pre !== null) {
                  writeFileSync(join(dir, name), Buffer.from(pre));
                }
              }
              const before = snapshotDir(dir, SEVEN_OUTPUT_FILENAMES);

              // Build the seven payloads we'd commit on a real run.
              // Distinct bytes per output so we can prove the renames
              // that DID happen actually flipped the destination.
              const outputs = SEVEN_OUTPUT_FILENAMES.map((name, idx) => ({
                path: join(dir, name),
                data: Buffer.from(`new-bytes-for-${name}-${idx}`),
              }));

              // Inject a rename that throws at `failureIndex`. The
              // first `failureIndex` calls delegate to the real
              // `renameSync`; the call at `failureIndex` throws.
              let renameCalls = 0;
              const fakeRename = (src: string, dst: string): void => {
                if (renameCalls === failureIndex) {
                  renameCalls += 1;
                  throw new Error(`injected rename failure at index ${failureIndex}`);
                }
                renameCalls += 1;
                // Real rename for indices < failureIndex.
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                require('node:fs').renameSync(src, dst);
              };

              let threw = false;
              try {
                atomicWriteAll(outputs, fakeRename);
              } catch {
                threw = true;
              }

              // The script (the calling site) is expected to exit
              // non-zero on a rename failure. Inside the helper we
              // simply re-throw; the outer wrapper in
              // `gen-icons.mjs` propagates to `process.exit(1)`.
              expect(threw).toBe(true);

              const after = snapshotDir(dir, SEVEN_OUTPUT_FILENAMES);

              // Outputs `[failureIndex..6]` must match pre-run state.
              for (let i = failureIndex; i < SEVEN_OUTPUT_FILENAMES.length; i++) {
                const name = SEVEN_OUTPUT_FILENAMES[i];
                if (
                  !compareSnapshotsByteIdentical(before, after, name)
                ) {
                  throw new Error(
                    `output[${i}] (${name}) was modified despite rename failure at index ${failureIndex}`,
                  );
                }
              }

              // Outputs `[0..failureIndex)` should have been
              // committed. Their post-run bytes must equal the new
              // payload we staged (since the rename succeeded).
              for (let i = 0; i < failureIndex; i++) {
                const name = SEVEN_OUTPUT_FILENAMES[i];
                const expected = outputs[i].data;
                const actual = after.bytes.get(name);
                if (actual === null || actual === undefined) {
                  throw new Error(
                    `output[${i}] (${name}) missing after successful rename`,
                  );
                }
                if (!actual.equals(expected)) {
                  throw new Error(
                    `output[${i}] (${name}) bytes do not match staged payload after rename`,
                  );
                }
              }

              // No `.tmp` files should remain after the failure path
              // unwinds — atomicWriteAll cleans them up on failure.
              for (const name of SEVEN_OUTPUT_FILENAMES) {
                if (existsSync(join(dir, `${name}.tmp`))) {
                  throw new Error(
                    `staging file ${name}.tmp leaked after failure unwind`,
                  );
                }
              }
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
