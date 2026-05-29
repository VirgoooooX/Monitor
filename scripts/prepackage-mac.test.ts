// prepackage-mac unit tests.
//
// Validates Requirements 2.4, 2.4a, 2.4b from macos-platform-support spec:
//   - 2.4 / 2.4a: probes for `xcode-select -p` and `python3 --version`
//                 with exact remediation strings.
//   - 2.4b:       on probe failure, the build pipeline does not
//                 invoke the rebuild step or any subsequent build
//                 step. Modeled here as: `runPrepackage` exits with
//                 code 1 BEFORE invoking the stale-binary cleanup,
//                 and never returns a successful path.
//
// The probes are exercised through a mocked `execFileSync` that
// either returns a buffer or throws based on per-call configuration.
// The orchestration is exercised through `runPrepackage` with
// injected `execFn` / `fsModule` / `stderr` / `exit`.

import { describe, it, expect, vi } from 'vitest';

import {
  probeXcodeSelect,
  probePython3,
  runPrepackage,
} from './prepackage-mac.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExecCall {
  file: string;
  args?: string[];
}

/**
 * Build a fake `execFileSync` that records calls and serves results
 * according to a per-command lookup. Each entry returns either the
 * stdout buffer for a successful call or an Error to throw.
 */
function makeExecFn(behaviours: Record<string, Buffer | Error>) {
  const calls: ExecCall[] = [];
  const fn = vi.fn((file: string, args?: string[]) => {
    calls.push({ file, args });
    const outcome = behaviours[file];
    if (outcome instanceof Error) {
      throw outcome;
    }
    if (outcome === undefined) {
      // Default: empty stdout, success.
      return Buffer.alloc(0);
    }
    return outcome;
  });
  return { fn, calls };
}

function makeStderrCapture() {
  const writes: string[] = [];
  return {
    capture: writes,
    sink: {
      write: (s: string) => {
        writes.push(s);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// probeXcodeSelect
// ---------------------------------------------------------------------------

describe('probeXcodeSelect', () => {
  it('returns ok when execFn exits 0', () => {
    const { fn } = makeExecFn({
      'xcode-select': Buffer.from('/Library/Developer/CommandLineTools\n'),
    });

    const result = probeXcodeSelect(fn as never);

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledWith(
      'xcode-select',
      ['-p'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('returns the verbatim remediation string when execFn throws', () => {
    const { fn } = makeExecFn({
      'xcode-select': new Error('command not found'),
    });

    const result = probeXcodeSelect(fn as never);

    expect(result).toEqual({
      ok: false,
      error: 'Missing Xcode Command Line Tools. Run: xcode-select --install',
    });
  });
});

// ---------------------------------------------------------------------------
// probePython3
// ---------------------------------------------------------------------------

describe('probePython3', () => {
  it('returns ok when stdout reports Python 3.x', () => {
    const { fn } = makeExecFn({
      python3: Buffer.from('Python 3.11.4\n'),
    });

    const result = probePython3(fn as never);

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledWith(
      'python3',
      ['--version'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('returns the remediation string when execFn throws', () => {
    const { fn } = makeExecFn({
      python3: new Error('command not found'),
    });

    const result = probePython3(fn as never);

    expect(result).toEqual({
      ok: false,
      error: 'Missing Python 3.x. Run: brew install python@3.11',
    });
  });

  it('returns the remediation string when stdout reports Python 2', () => {
    const { fn } = makeExecFn({
      python3: Buffer.from('Python 2.7.18\n'),
    });

    const result = probePython3(fn as never);

    expect(result).toEqual({
      ok: false,
      error: 'Missing Python 3.x. Run: brew install python@3.11',
    });
  });
});

// ---------------------------------------------------------------------------
// runPrepackage — orchestration
// ---------------------------------------------------------------------------

describe('runPrepackage', () => {
  it('runs probes in order: xcode-select then python3', () => {
    const { fn, calls } = makeExecFn({
      'xcode-select': Buffer.from('/Library/Developer/CommandLineTools\n'),
      python3: Buffer.from('Python 3.11.4\n'),
    });
    const stderr = makeStderrCapture();
    const exit = vi.fn();
    // Use a fake fs that reports the file as absent so the third
    // probe is a clean no-op.
    const fakeFs = {
      openSync: vi.fn(() => {
        const err = new Error('ENOENT') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }),
      readSync: vi.fn(),
      closeSync: vi.fn(),
      unlinkSync: vi.fn(),
    };

    runPrepackage({
      execFn: fn as never,
      fsModule: fakeFs as never,
      platform: 'darwin',
      arch: 'arm64',
      sqliteBinaryPath: '/fake/better_sqlite3.node',
      stderr: stderr.sink,
      exit: exit as never,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(calls.map((c) => c.file)).toEqual(['xcode-select', 'python3']);
  });

  it('exits 1 with the xcode remediation message when xcode-select probe fails', () => {
    const { fn, calls } = makeExecFn({
      'xcode-select': new Error('command not found'),
    });
    const stderr = makeStderrCapture();
    const exit = vi.fn();
    const fakeFs = {
      openSync: vi.fn(),
      readSync: vi.fn(),
      closeSync: vi.fn(),
      unlinkSync: vi.fn(),
    };

    runPrepackage({
      execFn: fn as never,
      fsModule: fakeFs as never,
      platform: 'darwin',
      arch: 'arm64',
      sqliteBinaryPath: '/fake/better_sqlite3.node',
      stderr: stderr.sink,
      exit: exit as never,
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.capture.join('')).toContain(
      'Missing Xcode Command Line Tools. Run: xcode-select --install',
    );
    // Subsequent probes (python3) MUST NOT have been invoked.
    expect(calls.map((c) => c.file)).toEqual(['xcode-select']);
    // Stale-binary cleanup MUST NOT have run.
    expect(fakeFs.openSync).not.toHaveBeenCalled();
    expect(fakeFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('exits 1 with the python remediation message when python3 probe fails', () => {
    const { fn, calls } = makeExecFn({
      'xcode-select': Buffer.from('/Library/Developer/CommandLineTools\n'),
      python3: new Error('command not found'),
    });
    const stderr = makeStderrCapture();
    const exit = vi.fn();
    const fakeFs = {
      openSync: vi.fn(),
      readSync: vi.fn(),
      closeSync: vi.fn(),
      unlinkSync: vi.fn(),
    };

    runPrepackage({
      execFn: fn as never,
      fsModule: fakeFs as never,
      platform: 'darwin',
      arch: 'arm64',
      sqliteBinaryPath: '/fake/better_sqlite3.node',
      stderr: stderr.sink,
      exit: exit as never,
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.capture.join('')).toContain(
      'Missing Python 3.x. Run: brew install python@3.11',
    );
    // Both probes ran, but cleanup did not.
    expect(calls.map((c) => c.file)).toEqual(['xcode-select', 'python3']);
    expect(fakeFs.openSync).not.toHaveBeenCalled();
    expect(fakeFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('skips stale-binary cleanup when the python3 stdout is malformed', () => {
    const { fn } = makeExecFn({
      'xcode-select': Buffer.from('/Library/Developer/CommandLineTools\n'),
      python3: Buffer.from('Python 2.7.18\n'),
    });
    const stderr = makeStderrCapture();
    const exit = vi.fn();
    const fakeFs = {
      openSync: vi.fn(),
      readSync: vi.fn(),
      closeSync: vi.fn(),
      unlinkSync: vi.fn(),
    };

    runPrepackage({
      execFn: fn as never,
      fsModule: fakeFs as never,
      platform: 'darwin',
      arch: 'arm64',
      sqliteBinaryPath: '/fake/better_sqlite3.node',
      stderr: stderr.sink,
      exit: exit as never,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(fakeFs.openSync).not.toHaveBeenCalled();
  });

  it('runs stale-binary cleanup after both probes succeed', () => {
    const { fn } = makeExecFn({
      'xcode-select': Buffer.from('/Library/Developer/CommandLineTools\n'),
      python3: Buffer.from('Python 3.11.4\n'),
    });
    const stderr = makeStderrCapture();
    const exit = vi.fn();

    // Pre-load a stale Mach-O x64 binary while targeting arm64.
    let unlinked = false;
    const filePath = '/fake/better_sqlite3.node';
    const machoX64 = Buffer.alloc(8);
    machoX64[0] = 0xcf;
    machoX64[1] = 0xfa;
    machoX64[2] = 0xed;
    machoX64[3] = 0xfe;
    machoX64.writeUInt32LE(0x01000007, 4);
    const fakeFs = {
      openSync: vi.fn((p: string) => {
        if (unlinked || p !== filePath) {
          const err = new Error('ENOENT') as Error & { code?: string };
          err.code = 'ENOENT';
          throw err;
        }
        return 7;
      }),
      readSync: vi.fn(
        (
          _fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
        ) => {
          machoX64.copy(buffer, offset, 0, Math.min(length, machoX64.length));
          return Math.min(length, machoX64.length);
        },
      ),
      closeSync: vi.fn(),
      unlinkSync: vi.fn(() => {
        unlinked = true;
      }),
    };

    runPrepackage({
      execFn: fn as never,
      fsModule: fakeFs as never,
      platform: 'darwin',
      arch: 'arm64',
      sqliteBinaryPath: filePath,
      stderr: stderr.sink,
      exit: exit as never,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(fakeFs.openSync).toHaveBeenCalledTimes(1);
    expect(fakeFs.unlinkSync).toHaveBeenCalledTimes(1);
    expect(fakeFs.unlinkSync).toHaveBeenCalledWith(filePath);
    expect(stderr.capture.join('')).toContain('removed stale');
  });
});
