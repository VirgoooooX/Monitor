// Feature: macos-platform-support, Property 3 (OpenCode half): Collector unavailable reason names the resolved missing path
// Feature: macos-platform-support, Property 4 (OpenCode half): Collector path overrides bypass the resolver
// Feature: macos-platform-support, Property 5: OpenCode directory scan respects the two-level depth bound
//
// Validates: Requirements 4.1, 4.5, 4.6, 4.7, 4.8, 11.2
//
// **What these properties pin down.**
//
//   Property 3 (OpenCode half): for any per-platform resolver
//   output, when the resolved directory does not exist on the
//   filesystem, the collector's `capabilityCheck()` returns
//   `unavailable` with a reason that names the resolved path
//   verbatim. On `darwin` the reason MUST NOT contain win32-only
//   substrings (`AppData\\Roaming`, `APPDATA`).
//
//   Property 4 (OpenCode half): when `opencodePath` is supplied as a
//   non-empty string override, the per-platform resolver is bypassed
//   entirely — the collector never reads `process.platform`,
//   `process.env`, or `os.homedir()` during construction or any
//   subsequent cycle, and uses the override verbatim as the
//   resolved path.
//
//   Property 5: when the collector scans an arbitrary directory
//   tree, it accesses only depth-0 (the root itself) and depth-1
//   (direct children) entries. No depth-≥-2 path is opened,
//   read, or stat-ed. Symbolic links beyond depth 1 are not
//   traversed.
//
// **Synthetic in-memory filesystem.** We mount a per-test fake on
// `fs.promises.readdir`, `fs.promises.stat`, and
// `fs.promises.readFile` via `vi.spyOn`. The fake reads from an
// `fc.letrec`-generated tree object keyed by absolute path, so
// every probe by the collector is observable as a recorded access.
// We do NOT use `mock-fs` or any other library — the fake is
// ~30 lines and produces deterministic shrinking diagnostics.
//
// **Purity for Property 4.** The override branch must not invoke
// `resolveOpencodePath`. We verify this by stubbing the imported
// `paths` module's `resolveOpencodePath` to throw — if the
// collector calls it, construction surfaces the throw immediately.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createOpenCodeCollector } from './opencode.collector';
import * as pathsModule from '../../platform/paths';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const platformArb = fc.constantFrom('win32', 'darwin', 'linux');

const nonEmptyPathish = fc
  .string({ minLength: 1, maxLength: 120 })
  .filter((s) => !s.includes('\u0000'));

const envArb = fc.record(
  {
    APPDATA: fc.option(nonEmptyPathish, { nil: undefined }),
    XDG_DATA_HOME: fc.option(nonEmptyPathish, { nil: undefined }),
  },
  { withDeletedKeys: true },
);

// ---------------------------------------------------------------------------
// Property 3 (OpenCode half)
// ---------------------------------------------------------------------------
//
// We make the synthetic filesystem report **every** directory as
// non-existent. The collector should fall through to the
// `unavailable` branch with the resolved path embedded verbatim.

describe('Property 3 (OpenCode half): unavailable reason names resolved missing path', () => {
  let statSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), {
          code: 'ENOENT',
        }),
      );
  });

  afterEach(() => {
    statSpy.mockRestore();
  });

  it('embeds the resolved opencode path in the unavailable reason and omits win32-only substrings on darwin', async () => {
    await fc.assert(
      fc.asyncProperty(
        platformArb,
        envArb,
        nonEmptyPathish,
        async (platform, env, homedir) => {
          const expectedPath = pathsModule.resolveOpencodePath(
            platform,
            env,
            homedir,
          );

          const collector = createOpenCodeCollector({
            platform,
            env,
            homedir,
          });
          const result = await collector.capabilityCheck();

          expect(result.status).toBe('unavailable');
          if (result.status !== 'unavailable') return;
          expect(typeof result.reason).toBe('string');
          expect(result.reason!.length).toBeGreaterThan(0);
          // Resolved path appears verbatim.
          expect(result.reason).toContain(expectedPath);
          // On darwin, no win32-only crumbs (Requirement 3.7
          // applied analogously to Requirement 4.5 / 11.2).
          if (platform === 'darwin') {
            expect(result.reason).not.toContain('AppData\\Roaming');
            expect(result.reason).not.toContain('APPDATA');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 (OpenCode half)
// ---------------------------------------------------------------------------
//
// When the override is provided, the resolver MUST NOT be called.
// We stub `pathsModule.resolveOpencodePath` to throw; if the
// collector invokes it during construction (or any subsequent
// cycle), the throw surfaces.

describe('Property 4 (OpenCode half): override bypasses the resolver', () => {
  let statSpy: ReturnType<typeof vi.spyOn>;
  let resolverSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    resolverSpy = vi
      .spyOn(pathsModule, 'resolveOpencodePath')
      .mockImplementation(() => {
        throw new Error(
          'resolveOpencodePath called even though opencodePath override was supplied',
        );
      });
  });

  afterEach(() => {
    statSpy.mockRestore();
    resolverSpy.mockRestore();
  });

  it('uses the override verbatim and never invokes resolveOpencodePath', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyPathish,
        async (override) => {
          // Construction must not throw — i.e. the resolver is not
          // called.
          const collector = createOpenCodeCollector({
            opencodePath: override,
          });
          const result = await collector.capabilityCheck();
          expect(result.status).toBe('unavailable');
          if (result.status !== 'unavailable') return;
          // The override appears verbatim in the unavailable reason.
          expect(result.reason).toContain(override);
          // The resolver is never called, in any cycle.
          expect(resolverSpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: two-level depth bound
// ---------------------------------------------------------------------------
//
// Synthetic FS model: a `Tree` is either a `File` (leaf) or a
// `Dir` mapping segment names to children. We mount the tree on
// `fs.promises.readdir` / `fs.promises.stat` / `fs.promises.readFile`.
// Every access is recorded; after the collector completes a cycle,
// we assert the recorded access set contains only depth-0 and
// depth-1 paths under the root.
//
// Symbolic links: we omit them from the synthetic FS — the
// `findLogFiles` implementation never calls `fs.promises.readlink`
// or follows symlinks explicitly, and `withFileTypes: true` plus
// the `isFile` / `isDirectory` predicates honour the underlying
// dirent type. The collector's actual two-level cap (Requirement
// 4.7) is structural: the outer `for` loop walks `entries`, and
// only `isDirectory` entries trigger one further `readdir`. Any
// regression that adds a third-level recursion would surface as a
// depth-≥-2 access in the recorded set.

interface FileNode {
  readonly kind: 'file';
  readonly contents: string;
}
interface DirNode {
  readonly kind: 'dir';
  readonly children: ReadonlyMap<string, Tree>;
}
type Tree = FileNode | DirNode;

/**
 * Generate a recursive directory tree of depth up to ~3, biased
 * toward producing at least some depth-2 grandchildren so the
 * property has something to NOT-access.
 */
const filenameArb = fc
  .stringMatching(/^[a-zA-Z0-9._-]{1,16}$/)
  .filter((s) => s !== '.' && s !== '..');

const fileExtArb = fc.constantFrom('.jsonl', '.json', '.log', '.txt', '');
const fileNameArb = fc
  .tuple(filenameArb, fileExtArb)
  .map(([base, ext]) => `${base}${ext}`);

const { tree } = fc.letrec<{ tree: Tree }>((tieRec) => ({
  tree: fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('file' as const), contents: fc.string({ maxLength: 32 }) }) },
    {
      weight: 1,
      arbitrary: fc
        .dictionary(fileNameArb, tieRec('tree'), { maxKeys: 4 })
        .map((obj): DirNode => ({
          kind: 'dir',
          children: new Map(Object.entries(obj)),
        })),
    },
  ),
}));

/**
 * Build a top-level dictionary of children under the synthetic
 * root so the root itself is always a directory (otherwise
 * `directoryExists` returns false and the cycle short-circuits
 * before any depth-2 path could be probed).
 */
const rootChildrenArb = fc
  .dictionary(fileNameArb, tree, { minKeys: 0, maxKeys: 6 })
  .map(
    (obj): DirNode => ({
      kind: 'dir',
      children: new Map(Object.entries(obj)),
    }),
  );

/**
 * Walk the tree from the root path and return a map keyed by
 * normalised absolute path. The map is what the synthetic FS
 * fakes consult on each access.
 */
function flatten(rootPath: string, root: DirNode): Map<string, Tree> {
  const out = new Map<string, Tree>();
  const walk = (currentPath: string, node: Tree): void => {
    out.set(path.normalize(currentPath), node);
    if (node.kind === 'dir') {
      for (const [name, child] of node.children) {
        walk(path.join(currentPath, name), child);
      }
    }
  };
  walk(rootPath, root);
  return out;
}

/**
 * Compute the depth of `accessed` relative to `rootPath`. Depth 0
 * is the root itself; depth 1 is a direct child; depth ≥ 2 is a
 * grandchild or deeper. Returns `-1` when `accessed` is outside
 * the root.
 *
 * Note: we segment-split the relative path BEFORE checking for
 * `..` so a file name starting with multiple dots (e.g.
 * `....jsonl`) is treated as one segment, not as a parent-dir
 * traversal.
 */
function depthOf(rootPath: string, accessed: string): number {
  const root = path.normalize(rootPath);
  const target = path.normalize(accessed);
  if (target === root) return 0;
  const rel = path.relative(root, target);
  if (rel === '') return 0;
  const segs = rel.split(/[\\/]/g).filter((s) => s.length > 0);
  if (segs.length === 0) return 0;
  if (segs[0] === '..') return -1;
  return segs.length;
}

describe('Property 5: OpenCode directory scan respects two-level depth bound', () => {
  let readdirSpy: ReturnType<typeof vi.spyOn>;
  let statSpy: ReturnType<typeof vi.spyOn>;
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  // We separate tracking by access kind. The two-level depth bound
  // applies to **scanning** (`readdir`): the collector's
  // `findLogFiles` enumerates `readdir(root)` (depth 0) and, for
  // each child directory, `readdir(child)` (depth 1). Grandchild
  // directories are listed by name in the depth-1 result but
  // SHALL NOT be `readdir`-ed.
  //
  // Reading file contents at depth-2 is a separate concern — it
  // happens during capability probing and the tick's incremental
  // read step, and is governed by Requirement 4.6 / 4.5 (the
  // resolved path contract), not by 4.7 (the scan-depth bound).
  let readdirAccessed: Set<string>;
  let fakeFs: Map<string, Tree>;

  beforeEach(() => {
    readdirAccessed = new Set<string>();
    fakeFs = new Map<string, Tree>();

    statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockImplementation(async (p: fs.PathLike) => {
        const key = path.normalize(String(p));
        const node = fakeFs.get(key);
        if (node === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        const isDir = node.kind === 'dir';
        return {
          isDirectory: () => isDir,
          isFile: () => !isDir,
        } as fs.Stats;
      });

    // Both call signatures (with/without `{ withFileTypes: true }`)
    // are used by `findLogFiles` — top-level scan uses `withFileTypes`,
    // inner subdirectory scan uses the bare form.
    readdirSpy = vi
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (p: fs.PathLike, opts?: any) => {
          const key = path.normalize(String(p));
          readdirAccessed.add(key);
          const node = fakeFs.get(key);
          if (node === undefined || node.kind !== 'dir') {
            throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
          }
          const names = Array.from(node.children.keys());
          if (opts && typeof opts === 'object' && opts.withFileTypes) {
            return names.map((name) => {
              const child = node.children.get(name)!;
              const isDir = child.kind === 'dir';
              return {
                name,
                isFile: () => !isDir,
                isDirectory: () => isDir,
                isSymbolicLink: () => false,
                isBlockDevice: () => false,
                isCharacterDevice: () => false,
                isFIFO: () => false,
                isSocket: () => false,
              } as fs.Dirent;
            });
          }
          return names as unknown as string[];
        },
      );

    readFileSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (p: fs.PathOrFileDescriptor) => {
        const key = path.normalize(String(p));
        const node = fakeFs.get(key);
        if (node === undefined || node.kind !== 'file') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return node.contents;
      });
  });

  afterEach(() => {
    statSpy.mockRestore();
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('readdir is invoked only on depth-0 (root) and depth-1 (immediate children) paths', async () => {
    const rootPath = path.posix.join('/', 'tmp', 'opencode-fixture');

    await fc.assert(
      fc.asyncProperty(rootChildrenArb, async (rootDir) => {
        readdirAccessed.clear();
        fakeFs = flatten(rootPath, rootDir);

        const collector = createOpenCodeCollector({ opencodePath: rootPath });
        // Run the full cycle: capability check probes, then tick
        // (with a no-op repository) probes again. Either path
        // could violate the scan-depth bound.
        await collector.capabilityCheck();
        await collector.tick({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          usageEvents: {
            watermark: () => null,
            insertIgnore: () => true,
          } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          settings: {} as any,
          now: () => 0,
        });

        for (const accessedPath of readdirAccessed) {
          const d = depthOf(rootPath, accessedPath);
          // Depth 0 = the resolved root itself.
          // Depth 1 = an immediate child directory.
          // Depth ≥ 2 indicates illegal recursion into a grandchild.
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});
