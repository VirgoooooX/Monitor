// OpenCode Go (anomaly.co) provider adapter.
//
// OpenCode Go is the subscription tier of opencode.ai (low-cost
// open-source models, $5–10/mo). Unlike DeepSeek / Xiaomi MiMo it
// does NOT expose a public usage API:
//
//   - The dashboard at `https://opencode.ai/workspace/wrk_<id>/go`
//     server-side renders the rolling / weekly / monthly usage
//     percentages **directly into the HTML**. No fetch / xhr is
//     issued from the client to populate that data.
//   - Authentication is an opaque Iron-encrypted (`Fe26.2**`)
//     session cookie called `auth`, scoped to `opencode.ai`. The
//     adapter cannot decrypt it; it forwards verbatim and treats
//     it like any other bearer token.
//
// The adapter therefore:
//
//   1. GET `<opencodeWorkspaceUrl>` with `Cookie: auth=<...>`.
//   2. Detect a redirect to the OpenAuth login page (302 →
//      `/auth/login`) or a 401/403 response and surface that as
//      `auth_expired` so the renderer prompts the user to re-paste
//      the cookie.
//   3. Scrape the SSR HTML for the three usage rows. The block
//      uses SolidStart's `data-slot` attributes which are stable:
//        <div data-slot="usage-item">
//          <span data-slot="usage-label">滚动用量</span>
//          <span data-slot="usage-value">62%</span>
//          <span data-slot="reset-time">重置于 11 天 21 小时</span>
//        </div>
//   4. Translate each usage-item into a QuotaWindow: `name` is the
//      Chinese label (rendered to a stable display name in
//      `quota-display.ts`), `percentLeft` is `100 - usage%`,
//      `resetAt` is the user-local epoch ms parsed from the
//      duration text, and `windowSeconds` is fixed by the row
//      kind (5h / 7d / 30d).
//
// Privacy:
//   - The auth cookie value is NEVER written to logs or error
//     messages. Errors carry sanitised strings (`'opencode
//     dashboard unauthenticated'`).

import {
  asRecord as _unused,
  okSnapshot,
  ProviderAdapterError,
  requestRaw,
  type RequestRaw,
  unavailableSnapshot,
} from './common';
void _unused;
import type { ProviderAdapter } from './types';
import type { QuotaWindow } from '../../../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HOST = 'https://opencode.ai';

/** Maximum rendered HTML body size we will scan (in bytes). The Go
 *  dashboard is ~50 KB; cap at 1 MiB so a runaway response cannot
 *  exhaust adapter memory. */
const MAX_BODY_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface OpenCodeAdapterDeps {
  readonly requestRaw?: RequestRaw;
}

export function createOpenCodeAdapter(
  deps: OpenCodeAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestRaw ?? requestRaw;

  return {
    provider: 'opencode',
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'OpenCode credentials are missing',
          'quota',
        );
      }

      const authCookie =
        typeof secret.opencodeAuthCookie === 'string'
          ? secret.opencodeAuthCookie.trim()
          : '';
      const workspaceUrl =
        typeof secret.opencodeWorkspaceUrl === 'string'
          ? secret.opencodeWorkspaceUrl.trim()
          : '';

      if (authCookie.length === 0 || workspaceUrl.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'OpenCode requires auth cookie and workspace URL',
          'quota',
        );
      }

      const url = normaliseWorkspaceUrl(workspaceUrl);

      let response: { status: number; body: string };
      try {
        const r = await doRequest({
          url,
          method: 'GET',
          ...(signal !== undefined ? { signal } : {}),
          headers: {
            Cookie: `auth=${authCookie}`,
            'User-Agent': 'Mozilla/5.0',
            Accept: 'text/html,application/xhtml+xml',
          },
        });
        response = { status: r.status, body: r.body };
      } catch (err) {
        const code =
          err instanceof ProviderAdapterError ? err.code : 'network_error';
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'OpenCode dashboard request failed';
        return unavailableSnapshot(account, now, code, message, 'quota');
      }

      // 3xx without a Location header gets returned as-is by
      // requestRaw; treat any 3xx as a redirect to the login page.
      if (response.status >= 300 && response.status < 400) {
        return unavailableSnapshot(
          account,
          now,
          'auth_expired',
          'OpenCode auth cookie expired (redirect to login)',
          'quota',
        );
      }
      if (response.status === 401 || response.status === 403) {
        return unavailableSnapshot(
          account,
          now,
          'auth_expired',
          'OpenCode dashboard rejected auth cookie',
          'quota',
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return unavailableSnapshot(
          account,
          now,
          'upstream_changed',
          `OpenCode dashboard returned HTTP ${response.status}`,
          'quota',
        );
      }
      if (response.body.length > MAX_BODY_BYTES) {
        return unavailableSnapshot(
          account,
          now,
          'upstream_changed',
          'OpenCode dashboard response too large',
          'quota',
        );
      }

      const windows = parseUsageHtml(response.body, now);
      if (windows.length === 0) {
        // The HTML loaded successfully but the data-slot pattern
        // we expect is missing — most likely the dashboard layout
        // changed. Surface as `upstream_changed` so a subsequent
        // refresh after we update the parser recovers cleanly.
        return unavailableSnapshot(
          account,
          now,
          'upstream_changed',
          'OpenCode dashboard usage block not found',
          'quota',
        );
      }

      return okSnapshot(account, now, windows, { kind: 'quota' });
    },
  };
}

export const opencodeAdapter: ProviderAdapter = createOpenCodeAdapter();

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

/**
 * Accept either a full HTTPS URL or a path like
 * `/workspace/wrk_xxx/go`. Returns the canonical full URL pointing
 * at the Go dashboard view. Never throws — invalid input is handed
 * back unchanged so the upstream call surfaces a 4xx that the
 * caller can map to `upstream_changed`.
 */
export function normaliseWorkspaceUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/')) {
    return `${DEFAULT_HOST}${trimmed}`;
  }
  return `${DEFAULT_HOST}/${trimmed}`;
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

/**
 * Walk every `data-slot="usage-item"` block in the HTML and emit a
 * QuotaWindow per match. The parser is structure-tolerant: it
 * looks for the three sentinel attributes inside each item and
 * stops as soon as it has both label + value (reset-time is
 * optional). Order in the source is preserved so the renderer's
 * sort by `quotaWindowPriority` produces a deterministic layout.
 */
export function parseUsageHtml(html: string, now: number): QuotaWindow[] {
  const itemRe = /<div\b[^>]*data-slot=["']usage-item["'][^>]*>([\s\S]*?)<\/div>\s*<!--\/-->/gi;
  const out: QuotaWindow[] = [];
  let match: RegExpExecArray | null;
  // Cap at 16 items defensively to bound the loop.
  let safety = 16;
  while ((match = itemRe.exec(html)) !== null && safety-- > 0) {
    const block = match[1];
    if (block === undefined) continue;
    const window = parseUsageItem(block, now);
    if (window !== null) out.push(window);
  }
  return out;
}

function parseUsageItem(block: string, now: number): QuotaWindow | null {
  const label = extractSlot(block, 'usage-label');
  const valueText = extractSlot(block, 'usage-value');
  const resetText = extractSlot(block, 'reset-time');
  if (label === null || valueText === null) return null;

  const usagePercent = parsePercentage(valueText);
  if (usagePercent === null) return null;
  // The dashboard renders **used** %; we store **remaining** % so
  // it lines up with the existing quota-strip semantics (where 100
  // means "all left" and 0 means "exhausted").
  const percentLeft = Math.max(0, Math.min(100, 100 - usagePercent));

  const windowKind = classifyWindowKind(label);
  const windowSeconds = WINDOW_SECONDS[windowKind];
  const resetAt = resetText !== null
    ? parseResetAt(resetText, now)
    : null;

  return {
    name: windowKind,
    percentLeft,
    resetAt,
    windowSeconds,
  };
}

/**
 * Extract the inner text of the first `<span data-slot="<slot>">…
 * </span>` (or any tag) in `block`. The dashboard wraps text in
 * `<!--$-->…<!--/-->` Solid hydration markers; this strips those
 * along with any nested tags.
 */
function extractSlot(block: string, slot: string): string | null {
  const re = new RegExp(
    `<[^>]+data-slot=["']${escapeRegExp(slot)}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    'i',
  );
  const m = re.exec(block);
  if (m === null) return null;
  const inner = m[1] ?? '';
  // Strip Solid hydration comments and any nested tags, then collapse whitespace.
  const cleaned = inner
    .replace(/<!--[^>]*-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePercentage(text: string): number | null {
  const m = /(-?\d+(?:\.\d+)?)/.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Window kind + reset-at parsing
// ---------------------------------------------------------------------------

/**
 * Map a Chinese row label (or English fallback) to a stable window
 * name slot. The names match `quotaWindowDisplayName`'s recognised
 * patterns — `5h` is reused from Codex, `7d` / `30d` are added in
 * the renderer's normaliser to render as「每周用量」/「每月用量」.
 */
function classifyWindowKind(label: string): 'opencode-5h' | 'opencode-7d' | 'opencode-30d' | 'opencode-unknown' {
  if (label.includes('滚动') || /rolling/i.test(label)) return 'opencode-5h';
  if (label.includes('每周') || /weekly/i.test(label)) return 'opencode-7d';
  if (label.includes('每月') || /monthly/i.test(label)) return 'opencode-30d';
  return 'opencode-unknown';
}

const WINDOW_SECONDS: Record<
  'opencode-5h' | 'opencode-7d' | 'opencode-30d' | 'opencode-unknown',
  number | null
> = {
  'opencode-5h': 5 * 60 * 60,
  'opencode-7d': 7 * 24 * 60 * 60,
  'opencode-30d': 30 * 24 * 60 * 60,
  'opencode-unknown': null,
};

/**
 * Parse a Chinese duration string ("5 小时 0 分钟" / "4 天 18 小时" /
 * "11 天 21 小时") into an absolute epoch timestamp by adding it to
 * `now`. English fallback ("5 hours 0 minutes" / "4 days 18 hours")
 * is also accepted defensively.
 *
 * The dashboard doesn't surface seconds; missing units default to 0.
 */
export function parseResetAt(text: string, now: number): number | null {
  const days = matchUnit(text, /(\d+)\s*(?:天|days?)/i);
  const hours = matchUnit(text, /(\d+)\s*(?:小时|hours?|hrs?)/i);
  const minutes = matchUnit(text, /(\d+)\s*(?:分钟|分|minutes?|mins?)/i);
  if (days === null && hours === null && minutes === null) return null;

  const totalMs =
    (days ?? 0) * 86_400_000 +
    (hours ?? 0) * 3_600_000 +
    (minutes ?? 0) * 60_000;
  if (totalMs <= 0) return now;
  return now + totalMs;
}

function matchUnit(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
