// Feature: macos-platform-support, Property 13: Stale `better_sqlite3.node` is detected and unlinked iff binary doesn't match target
//
// Validates: Requirement 2.3a
//
// **What this property pins down.**
//
//   For every `(currentTarget, onDiskBinary)` pair, where
//
//     currentTarget ∈ {'darwin/x64', 'darwin/arm64', 'win32/x64'}
//     onDiskBinary  ∈ {'MachO-x64', 'MachO-arm64', 'PE-COFF', 'missing'}
//
//   `cleanStaleSqliteBinary`:
//
//     - Calls `fs.unlinkSync(filePath)` IFF the on-disk binary is
//       present AND its detected format does not equal the expected
//       format for the current target.
//     - Performs no I/O beyond a single `read` (or no I/O at all
//       when the file is absent).
//     - Returns `{ action: 'absent' }` when the file is missing,
//       `{ action: 'kept', ... }` when the binary matches, and
//       `{ action: 'unlinked', ... }` when it does not.
//     - Never throws when the underlying filesystem succeeds; when
//       the underlying read returns ENOENT the call collapses to a
//       no-op (Requirement 2.3a "no-op if the file is absent").
//
// **No real filesystem.** The property test injects a synthetic
// `fsModule` whose `openSync` / `readSync` / `closeSync` /
// `unlinkSync` operate on an in-memory map keyed by file path. No
// real disk access happens in this test, so the test is
// deterministic and platform-independent.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

import {
  cleanStaleSqliteBinary,
  detectBinaryFormat,
  expectedFormatForTarget,
  isStale,
  MACHO_CPU_X86_64,
  MACHO_CPU_ARM64,
} from './prepackage-mac.mjs';

// ---------------------------------------------------------------------------
// Fixture builders — produce magic-byte buffers for each binary
// kind. Mirror the spec's magic-byte mapping in design.md.
// ---------------------------------------------------------------------------

function buildMachOBuffer(cpuType: number): Buffer {
  // Mach-O 64-bit LE header: 4-byte magic + 4-byte cpu type
  // (little-endian). The remaining 24 bytes of a real header are
  // not inspected by `detectBinaryFormat`, so 8 bytes is enough.
  const buf = Buffer.alloc(8);
  buf[0] = 0xcf;
  buf[1] = 0xfa;
  buf[2] = 0xed;
  buf[3] = 0xfe;
  buf.writeUInt32LE(cpuType, 4);
  return buf;
}

function buildPECOFFBuffer(): Buffer {
  // 'MZ' DOS-stub prefix. We pad to 8 bytes so the synthetic fs
  // can serve a full 8-byte read; the additional bytes do not
  // affect detection (PE/COFF only checks the leading two).
  const buf = Buffer.alloc(8);
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  return buf;
}

function buildBufferFor(kind: BinaryKind): Buffer | null {
  switch (kind) {
    case 'MachO-x64':
      return buildMachOBuffer(MACHO_CPU_X86_64);
    case 'MachO-arm64':
      return buildMachOBuffer(MACHO_CPU_ARM64);
    case 'PE-COFF':
      return buildPECOFFBuffer();
    case 'missing':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Synthetic in-memory filesystem.
// ---------------------------------------------------------------------------

type BinaryKind = 'MachO-x64' | 'MachO-arm64' | 'PE-COFF' | 'missing';

interface FakeFs {
  openSync: ReturnType<typeof vi.fn>;
  readSync: ReturnType<typeof vi.fn>;
  closeSync: ReturnType<typeof vi.fn>;
  unlinkSync: ReturnType<typeof vi.fn>;
}

function makeFakeFs(filePath: string, contents: Buffer | null): FakeFs {
  let unlinked = false;
  const openSync = vi.fn((p: string) => {
    if (p !== filePath || contents === null || unlinked) {
      const err = new Error(`ENOENT: no such file, open '${p}'`) as Error & {
        code?: string;
      };
      err.code = 'ENOENT';
      throw err;
    }
    return 42; // arbitrary fd
  });
  const readSync = vi.fn(
    (
      _fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      _position: number | null,
    ) => {
      if (contents === null) {
        return 0;
      }
      const copyLen = Math.min(length, contents.length);
      contents.copy(buffer, offset, 0, copyLen);
      return copyLen;
    },
  );
  const closeSync = vi.fn();
  const unlinkSync = vi.fn((p: string) => {
    if (p !== filePath || contents === null || unlinked) {
      const err = new Error(`ENOENT: no such file, unlink '${p}'`) as Error & {
        code?: string;
      };
      err.code = 'ENOENT';
      throw err;
    }
    unlinked = true;
  });
  return { openSync, readSync, closeSync, unlinkSync };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

interface Target {
  platform: 'darwin' | 'win32';
  arch: 'x64' | 'arm64';
  label: 'darwin/x64' | 'darwin/arm64' | 'win32/x64';
}

const targetArb = fc.constantFrom<Target>(
  { platform: 'darwin', arch: 'x64', label: 'darwin/x64' },
  { platform: 'darwin', arch: 'arm64', label: 'darwin/arm64' },
  { platform: 'win32', arch: 'x64', label: 'win32/x64' },
);

const onDiskArb = fc.constantFrom<BinaryKind>(
  'MachO-x64',
  'MachO-arm64',
  'PE-COFF',
  'missing',
);

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

/**
 * Map a target label to the matching binary kind.
 */
function expectedKindFor(label: Target['label']): BinaryKind {
  switch (label) {
    case 'darwin/x64':
      return 'MachO-x64';
    case 'darwin/arm64':
      return 'MachO-arm64';
    case 'win32/x64':
      return 'PE-COFF';
  }
}

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

describe('Property 13: stale `better_sqlite3.node` is detected and unlinked iff binary does not match target', () => {
  it('unlinks iff mismatch; no-op when absent; correct return action', () => {
    fc.assert(
      fc.property(targetArb, onDiskArb, (target, onDisk) => {
        const filePath = '/fake/node_modules/better-sqlite3/build/Release/better_sqlite3.node';
        const buf = buildBufferFor(onDisk);
        const fakeFs = makeFakeFs(filePath, buf);

        const result = cleanStaleSqliteBinary({
          filePath,
          platform: target.platform,
          arch: target.arch,
          fsModule: fakeFs as unknown as typeof import('node:fs'),
        });

        const expectedKind = expectedKindFor(target.label);

        if (onDisk === 'missing') {
          // No-op when the file is absent.
          expect(result).toEqual({ action: 'absent' });
          expect(fakeFs.unlinkSync).not.toHaveBeenCalled();
          return;
        }

        if (onDisk === expectedKind) {
          // Match: kept, no unlink.
          expect(result.action).toBe('kept');
          expect(fakeFs.unlinkSync).not.toHaveBeenCalled();
        } else {
          // Mismatch: unlinked exactly once with the file path.
          expect(result.action).toBe('unlinked');
          expect(fakeFs.unlinkSync).toHaveBeenCalledTimes(1);
          expect(fakeFs.unlinkSync).toHaveBeenCalledWith(filePath);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('helper purity: detectBinaryFormat is a function of the buffer alone', () => {
    fc.assert(
      fc.property(onDiskArb, (kind) => {
        const buf = buildBufferFor(kind);
        if (buf === null) {
          // 'missing' path: a zero-length buffer should detect as
          // 'unknown'. (Real callers go through the openSync/ENOENT
          // path; we exercise the buffer contract directly here.)
          expect(detectBinaryFormat(Buffer.alloc(0))).toBe('unknown');
          return;
        }
        expect(detectBinaryFormat(buf)).toBe(kind);
      }),
      { numRuns: 100 },
    );
  });

  it('helper purity: expectedFormatForTarget mirrors design.md mapping', () => {
    fc.assert(
      fc.property(targetArb, (target) => {
        const expected = expectedFormatForTarget(target.platform, target.arch);
        expect(expected).toBe(expectedKindFor(target.label));
      }),
      { numRuns: 100 },
    );
  });

  it('helper purity: isStale is a strict-inequality predicate', () => {
    fc.assert(
      fc.property(targetArb, onDiskArb, (target, onDisk) => {
        const expected = expectedFormatForTarget(target.platform, target.arch);
        const detected =
          onDisk === 'missing' ? 'unknown' : onDisk;
        expect(isStale(detected, expected)).toBe(detected !== expected);
      }),
      { numRuns: 100 },
    );
  });
});
