// Quota window display helpers.
//
// Antigravity model display rules (per user request):
//   Show only two model groups, filter everything else:
//     1. Claude   — Anthropic / Claude variants
//     2. Gemini   — every Gemini variant (Pro, Flash, Lite…) except
//                   Image. Antigravity shares one quota pool across
//                   most Gemini chat models, so a single row is the
//                   most honest representation.
//   OpenAI / GPT, Image-only models, placeholders, and unknown enums
//   are filtered (the helper returns `null`).
//
// Gemini CLI rules:
//   Google CPA exposes a per-modelId daily bucket and ships new
//   variants frequently (gemini-2.5-pro, gemini-3.1-pro,
//   gemini-3-pro-preview, gemini-3.1-flash-lite-preview, …). To keep
//   the strip readable as new variants ship we collapse them into
//   two rows:
//     1. Gemini Pro     — any modelId containing "pro"
//     2. Gemini Flash   — any modelId containing "flash" (incl. Lite + previews)
//   Within each row the merge averages percentLeft (consistent with
//   Antigravity), so the bar reflects the group as a whole.

const ANTIGRAVITY_ORDER: readonly string[] = [
  'Claude',
  'Gemini',
];

const GEMINI_CLI_ORDER: readonly string[] = [
  'Gemini Pro',
  'Gemini Flash',
];

export function quotaWindowDisplayName(name: string, provider = ''): string | null {
  const normalised = normaliseProviderWindowName(name, provider);
  if (normalised !== undefined) return normalised;

  if (name.startsWith('code_review:')) {
    const inner = quotaWindowDisplayName(name.slice('code_review:'.length), provider);
    return inner === null ? null : `Code Review · ${inner}`;
  }
  if (name.startsWith('credits:')) {
    return name.slice('credits:'.length) || '额度积分';
  }

  switch (name) {
    case '5h': return '5 小时限额';
    case 'weekly': return '周限额';
    case 'monthly': return '月限额';
    case 'daily': return '日限额';
    default: return name;
  }
}

export function quotaWindowCompactLabel(name: string, provider = ''): string | null {
  const displayName = quotaWindowDisplayName(name, provider);
  if (displayName === null) return null;

  switch (displayName) {
    case '5 小时限额': return '5h';
    case '周限额': return '周';
    case '月限额': return '月';
    case '日限额': return '日';
    case 'Claude': return 'Claude';
    case 'Gemini': return 'Gemini';
    case 'Gemini Pro': return 'Pro';
    case 'Gemini Flash': return 'Flash';
    case 'Claude/GPT': return 'GPT';
    default: return displayName;
  }
}

export function quotaWindowPriority(name: string, provider = ''): number {
  const displayName = quotaWindowDisplayName(name, provider);
  if (displayName === null) return 999;

  switch (displayName) {
    case '5 小时限额': return 0;
    case '日限额': return 1;
    case '周限额': return 2;
    case '月限额': return 3;
    // OpenCode Go: 滚动 → 每周 → 每月 (top to bottom).
    case '滚动用量': return 0;
    case '每周用量': return 2;
    case '每月用量': return 3;
  }

  const order = provider === 'antigravity' ? ANTIGRAVITY_ORDER : GEMINI_CLI_ORDER;
  const index = order.indexOf(displayName);
  return index === -1 ? 100 : index;
}

function normaliseProviderWindowName(name: string, provider: string): string | null | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const base = trimmed.split(':')[0]?.trim() ?? trimmed;
  const upper = base.toUpperCase();
  const lower = base.toLowerCase();

  // OpenCode Go produces fixed window names so the display labels
  // match the platform dashboard's vocabulary verbatim.
  if (provider === 'opencode') {
    switch (trimmed) {
      case 'opencode-5h': return '滚动用量';
      case 'opencode-7d': return '每周用量';
      case 'opencode-30d': return '每月用量';
      case 'opencode-unknown': return null;
    }
  }

  if (/^MODEL_PLACEHOLDER_M\d+$/.test(upper)) return null;
  if (/^MODEL_CHAT_\d+$/.test(upper)) return normaliseKnownChatModel(upper, provider);
  if (/^MODEL_[A-Z0-9_]+$/.test(upper)) return normaliseEnumModel(upper, provider);
  if (/^response:\d+$/.test(trimmed) || /^\d+$/.test(trimmed)) return null;

  if (provider === 'antigravity') {
    if (lower.includes('claude') || lower.includes('anthropic')) return 'Claude';
    if (lower.includes('gpt') || lower.includes('openai')) return null;
    if (lower.includes('image')) return null;
    if (lower.includes('gemini') || lower.includes('google')) return 'Gemini';
    return null;
  }

  // Gemini CLI: collapse all Gemini variants into Pro / Flash so the
  // strip stays readable as Google ships new model previews.
  if (lower.includes('gemini') || lower.includes('google')) {
    if (lower.includes('image')) return null;
    if (lower.includes('pro')) return 'Gemini Pro';
    if (lower.includes('flash')) return 'Gemini Flash';
  }

  return undefined;
}

function normaliseKnownChatModel(name: string, provider: string): string | null {
  if (provider === 'antigravity') {
    // MODEL_CHAT_23310 is Gemini 3.1 Flash Image — filtered out (separate pool, rarely used).
    if (name === 'MODEL_CHAT_23310') return null;
    // Other MODEL_CHAT_* are Gemini variants → fold into the Gemini bucket.
    return 'Gemini';
  }
  // Gemini CLI: only `MODEL_CHAT_20706` (Gemini 3 Flash) is known to
  // appear; fold it into the Flash bucket alongside other Flash variants.
  switch (name) {
    case 'MODEL_CHAT_20706': return 'Gemini Flash';
    case 'MODEL_CHAT_23310': return null; // Image is filtered.
    default: return null;
  }
}

function normaliseEnumModel(name: string, provider: string): string | null {
  if (provider === 'antigravity') {
    if (name.includes('CLAUDE') || name.includes('ANTHROPIC')) return 'Claude';
    if (name.includes('OPENAI') || name.includes('GPT')) return null;
    if (name.includes('IMAGE')) return null;
    if (name.includes('GEMINI') || name.includes('GOOGLE')) return 'Gemini';
    return null;
  }

  if (
    name.includes('OPENAI') ||
    name.includes('GPT') ||
    name.includes('ANTHROPIC') ||
    name.includes('CLAUDE')
  ) {
    return 'Claude/GPT';
  }
  if (name.includes('IMAGE')) return null;
  if (name.includes('GEMINI') || name.includes('GOOGLE')) {
    if (name.includes('PRO')) return 'Gemini Pro';
    if (name.includes('FLASH')) return 'Gemini Flash';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display-time grouping
// ---------------------------------------------------------------------------

interface QuotaWindowLike {
  readonly name: string;
  readonly percentLeft: number | null;
  readonly resetAt: number | null;
  readonly windowSeconds: number | null;
}

interface GroupedQuotaWindow<W extends QuotaWindowLike> {
  /** The synthetic window with name = display label and merged metrics. */
  readonly window: W;
  /** Display label this group renders under. */
  readonly displayName: string;
  /** Original raw window names that contributed to this group. */
  readonly sourceNames: readonly string[];
}

/**
 * Filter out windows that have no display name and group remaining
 * windows by display label. Within a group, percentLeft is averaged
 * (so e.g. multiple raw Gemini buckets that share one quota pool
 * collapse into a single "Gemini" row) and resetAt is taken as the
 * earliest reset across the group.
 *
 * The output is sorted by `quotaWindowPriority`, so Antigravity rows
 * appear in the user-defined order and gemini-cli rows keep their
 * existing order.
 */
export function groupQuotaWindowsByDisplay<W extends QuotaWindowLike>(
  windows: readonly W[],
  provider = '',
): GroupedQuotaWindow<W>[] {
  type Aggregator = {
    displayName: string;
    sample: W;
    percentSum: number;
    percentCount: number;
    resetAt: number | null;
    windowSeconds: number | null;
    sourceNames: string[];
  };
  const byName = new Map<string, Aggregator>();

  for (const window of windows) {
    const displayName = quotaWindowDisplayName(window.name, provider);
    if (displayName === null) continue;

    const existing = byName.get(displayName);
    if (existing === undefined) {
      byName.set(displayName, {
        displayName,
        sample: window,
        percentSum: window.percentLeft ?? 0,
        percentCount: window.percentLeft === null ? 0 : 1,
        resetAt: window.resetAt,
        windowSeconds: window.windowSeconds,
        sourceNames: [window.name],
      });
      continue;
    }

    if (window.percentLeft !== null) {
      existing.percentSum += window.percentLeft;
      existing.percentCount += 1;
    }
    if (window.resetAt !== null) {
      existing.resetAt = existing.resetAt === null
        ? window.resetAt
        : Math.min(existing.resetAt, window.resetAt);
    }
    existing.windowSeconds = existing.windowSeconds ?? window.windowSeconds;
    existing.sourceNames.push(window.name);
  }

  const groups: GroupedQuotaWindow<W>[] = [];
  byName.forEach((agg) => {
    const percentLeft = agg.percentCount === 0 ? null : agg.percentSum / agg.percentCount;
    // Preserve the *raw* sample name on the synthesised window so callers
    // that need to inspect the original (e.g. credits-row detection in
    // QuotaStrip) keep working. Display-label resolution is idempotent
    // — `quotaWindowDisplayName(rawName, provider)` re-derives the same
    // label downstream.
    const merged: W = {
      ...agg.sample,
      percentLeft,
      resetAt: agg.resetAt,
      windowSeconds: agg.windowSeconds,
    };
    groups.push({
      window: merged,
      displayName: agg.displayName,
      sourceNames: agg.sourceNames,
    });
  });

  groups.sort(
    (a, b) =>
      quotaWindowPriority(a.displayName, provider) -
      quotaWindowPriority(b.displayName, provider),
  );

  return groups;
}

// ---------------------------------------------------------------------------
// Credits window parsing
// ---------------------------------------------------------------------------

export interface ParsedCreditsWindow {
  /** ISO-style currency code (e.g. "CNY", "USD"). */
  readonly currency: string;
  /** Primary balance (typically `total_balance`). `null` if not present. */
  readonly total: string | null;
  /** Granted / promotional balance. `null` if not present. */
  readonly granted: string | null;
  /** Topped-up balance. `null` if not present. */
  readonly toppedUp: string | null;
}

/**
 * Parse a window name produced by a credits adapter (e.g. DeepSeek).
 *
 * Recognised format (matches `deepseek.adapter.ts` output):
 *   credits:<currency> 总额 <n> / 赠金 <n> / 充值 <n>
 *
 * Returns `null` for windows that are not credits or do not match the
 * expected shape. Callers should fall back to the generic quota row
 * rendering in that case.
 */
export function parseCreditsWindow(name: string): ParsedCreditsWindow | null {
  if (!name.startsWith('credits:')) return null;
  const body = name.slice('credits:'.length).trim();
  if (body.length === 0) return null;

  // Split off the leading currency token. Everything after the first
  // space is the breakdown ("总额 X / 赠金 Y / 充值 Z").
  const firstSpace = body.indexOf(' ');
  const currency = (firstSpace === -1 ? body : body.slice(0, firstSpace)).trim();
  const breakdown = firstSpace === -1 ? '' : body.slice(firstSpace + 1);

  const segments = breakdown.split('/').map((s) => s.trim()).filter(Boolean);
  let total: string | null = null;
  let granted: string | null = null;
  let toppedUp: string | null = null;

  for (const segment of segments) {
    const match = /^(总额|赠金|充值)\s+(\S+)$/u.exec(segment);
    if (match === null) continue;
    const value = match[2] ?? null;
    if (match[1] === '总额') total = value;
    else if (match[1] === '赠金') granted = value;
    else if (match[1] === '充值') toppedUp = value;
  }

  return { currency, total, granted, toppedUp };
}

/** ISO 4217 → display symbol for the few currencies we render. */
export function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY': case 'RMB': return '¥';
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'JPY': return '¥';
    default: return '';
  }
}
