// Per-platform path resolvers shared by the Antigravity and OpenCode
// usage collectors.
//
// References:
//   - design.md §`src/main/platform/paths.ts` (new)
//   - design.md §Property 1, §Property 2
//   - requirements.md Requirements 3.2, 3.3, 3.4, 4.2, 4.3, 4.4, 4.8,
//                                   12.1, 12.2, 12.3, 12.4
//
// This module is the single source of truth for the
// (platform, env, homedir) → string mapping that both collectors
// previously inlined as `process.env.APPDATA ?? ...`. Centralising it
// here:
//
//   1. Removes the win32-only assumption from `antigravity.collector.ts`
//      and `opencode.collector.ts` (`process.platform === 'darwin'` →
//      `<homedir>/Library/Application Support/...`,
//      everything else → XDG fallback).
//   2. Lets a property-based test exercise every supported platform
//      branch by passing literal strings, without monkey-patching the
//      global `process.platform`, `process.env`, or `os.homedir` state.
//
// **Purity contract.** Both exported functions are pure: they derive
// their result solely from their arguments. They MUST NOT call
// `process.platform`, `process.env`, or `os.homedir()` — Requirement
// 12.1 / 12.2. The Property 1 / Property 2 PBT test stubs those
// globals to throw before invoking the resolvers, so any future
// regression that re-introduces a global read fails CI immediately.
//
// **Path-flavour selection.** For the `win32` branch we deliberately
// use `path.win32.join` so a unit test running on Linux still gets
// backslash-separated output for win32 inputs (Requirement 13.3
// regression lock). For `darwin` and the XDG fallback we use
// `path.posix.join` so the same test running on Windows still gets
// forward-slash output for those branches. The current host's
// `path.join` is intentionally not used.

import * as path from 'node:path';

/**
 * Per-platform environment slice consumed by the resolvers.
 *
 * We name only the variables we actually read so a test can pass an
 * empty object (`{}`) without committing to `process.env`'s full
 * surface. Both fields are optional — the resolvers fall back to
 * `<homedir>/AppData/Roaming` (win32) or `<homedir>/.local/share`
 * (XDG) when the corresponding variable is absent.
 */
export interface ResolverEnv {
  readonly APPDATA?: string;
  readonly XDG_DATA_HOME?: string;
}

/**
 * Resolve the Antigravity application-data log directory.
 *
 * Branch table:
 *
 * - `platform === 'win32'`
 *     → `${env.APPDATA ?? <homedir>/AppData/Roaming}/Antigravity/logs`
 *     (win32-flavoured separators)
 * - `platform === 'darwin'`
 *     → `<homedir>/Library/Application Support/Antigravity/logs`
 *     (POSIX-flavoured separators)
 * - everything else (including `''`, unknown strings)
 *     → `${env.XDG_DATA_HOME ?? <homedir>/.local/share}/Antigravity/logs`
 *     (POSIX-flavoured separators)
 *
 * Total: never throws. Pure: reads only its arguments. See
 * Requirements 3.2 / 3.3 / 3.4 / 4.8 / 12.1 / 12.3 / 12.5 / 13.3.
 */
export function resolveAntigravityAppDataPath(
  platform: string,
  env: ResolverEnv,
  homedir: string,
): string {
  if (platform === 'win32') {
    const appData =
      env.APPDATA ?? path.win32.join(homedir, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Antigravity', 'logs');
  }
  if (platform === 'darwin') {
    return path.posix.join(
      homedir,
      'Library',
      'Application Support',
      'Antigravity',
      'logs',
    );
  }
  // Linux + every unrecognised platform string falls through to XDG
  // per Requirement 4.8 / 3.4. The empty-string platform tested by
  // Property 1 lands here.
  const xdg =
    env.XDG_DATA_HOME ?? path.posix.join(homedir, '.local', 'share');
  return path.posix.join(xdg, 'Antigravity', 'logs');
}

/**
 * Resolve the OpenCode log directory.
 *
 * Branch table:
 *
 * - `platform === 'win32'`
 *     → `${env.APPDATA ?? <homedir>/AppData/Roaming}/opencode`
 *     (win32-flavoured separators)
 * - `platform === 'darwin'`
 *     → `<homedir>/Library/Application Support/opencode`
 *     (POSIX-flavoured separators)
 * - everything else (including `''`, unknown strings)
 *     → `${env.XDG_DATA_HOME ?? <homedir>/.local/share}/opencode`
 *     (POSIX-flavoured separators)
 *
 * Total: never throws. Pure: reads only its arguments. See
 * Requirements 4.2 / 4.3 / 4.4 / 4.8 / 12.2 / 12.4 / 12.5 / 13.3.
 */
export function resolveOpencodePath(
  platform: string,
  env: ResolverEnv,
  homedir: string,
): string {
  if (platform === 'win32') {
    const appData =
      env.APPDATA ?? path.win32.join(homedir, 'AppData', 'Roaming');
    return path.win32.join(appData, 'opencode');
  }
  if (platform === 'darwin') {
    return path.posix.join(
      homedir,
      'Library',
      'Application Support',
      'opencode',
    );
  }
  const xdg =
    env.XDG_DATA_HOME ?? path.posix.join(homedir, '.local', 'share');
  return path.posix.join(xdg, 'opencode');
}
