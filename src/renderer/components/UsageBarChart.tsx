// UsageBarChart — stacked, range-uniform token consumption chart.
//
// Visual design ("Editorial Telemetry"):
//   • Constant canvas. Plot area is always the same height regardless of
//     range. Y-axis is a fixed left column; the bar rail is a flex
//     container so 7 / 24 / 30 columns produce uniform-feeling rhythm.
//   • Bars are HTML buttons (not SVG <rect>). This keeps tap-targets
//     consistent (≥44px tall on mobile, comfortable on desktop) and
//     gives us real keyboard navigation across columns.
//   • SVG only carries the y-axis + gridlines + an animated peak
//     "crown" mark — the layers that genuinely benefit from vector
//     rendering. The bars themselves are CSS so they layer cleanly
//     with focus rings, hover highlights, and reduced-motion fades.
//   • One signature detail: the tallest column gets a small inverted
//     chevron "crown" above its top. Quick read of "this is the peak
//     in the window" without forcing the user to scan all the labels.
//
// Provider stacking order: tallest provider in the bottom of every
// column (sorted by total tokens across the visible range), so users
// can compare "is Claude or Codex driving today?" with their eyes
// anchored on the column base — the stack-order convention used by
// ccusage and tokscale.
//
// References:
//   - phuryn/claude-usage      (per-day Chart.js stacked bars)
//   - junhoyeo/tokscale        (TUI contribution graph + stacked rows)
//   - ccusage `daily` command  (one row per local day, models stacked)

import { useMemo, useId, useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { UsageTimeseriesBucket } from '../lib/types';
import type { TranslationKey } from '../../i18n';
import { formatTokens, formatCurrencyAmount } from '../lib/format';
import { useT } from '../lib/i18n';

// ---------------------------------------------------------------------------
// Provider color palette
// ---------------------------------------------------------------------------

/**
 * Token kinds shown inside each provider segment, ordered visually
 * from bottom of the bar to top:
 *
 *   output  →  input  →  cache
 *
 * Output (生成) sits at the bottom because it represents "real
 * work the model produced" and is what the user feels they're
 * paying for. Input (上下文) is the middle band — it's the
 * conversation history + prompt that drove the output. Cache
 * (复用上下文) sits at the top because it's the cheapest tier
 * and the most "free" — putting it at the top makes the cost-
 * intensive bands settle at the bar base.
 */
type TokenKind = 'output' | 'input' | 'cache';

const KIND_ORDER: ReadonlyArray<TokenKind> = ['output', 'input', 'cache'];

const KIND_LABEL_KEY: Record<TokenKind, TranslationKey> = {
  output: 'usage.kind.output',
  input: 'usage.kind.input',
  cache: 'usage.kind.cache',
};

/**
 * Stable per-provider base hue (in HSL). Each provider segment is
 * split into three same-hue tones at different lightness levels
 * (output = darkest / most saturated → cache = lightest / most
 * desaturated) so the user can read both "which provider" (hue)
 * and "which token kind" (tone) on the same bar without needing
 * to memorise a separate colour grid.
 *
 * Falls back to a hash-derived hue for unknown providers so newly
 * added collectors still get a deterministic colour without a code
 * change here.
 */
interface ProviderHue {
  hue: number;
  /** Saturation — keeps brand-y providers feeling vibrant. */
  sat: number;
}

const PROVIDER_HUES: Record<string, ProviderHue> = {
  'codex':             { hue: 158, sat: 64 }, // emerald — OpenAI green
  'claude-code':       { hue:  24, sat: 92 }, // orange — Anthropic warm
  'gemini-cli':        { hue: 215, sat: 88 }, // sky blue — Google blue
  'gemini-api':        { hue: 210, sat: 78 }, // lighter sky — sibling
  'antigravity':       { hue: 262, sat: 82 }, // violet
  'kiro-ide':          { hue: 188, sat: 86 }, // cyan — Kiro brand
  'opencode':          { hue: 168, sat: 70 }, // teal
  'deepseek':          { hue: 330, sat: 78 }, // pink
  'xiaomi':            { hue:  35, sat: 92 }, // amber — Xiaomi vibe
  'openai-compatible': { hue: 220, sat: 14 }, // slate
};

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function providerHueFor(provider: string): ProviderHue {
  return (
    PROVIDER_HUES[provider] ?? {
      hue: hashHue(provider),
      sat: 64,
    }
  );
}

/**
 * Per-token-kind tone of a provider's hue. Output is the darkest
 * shade so the most "owned by the model" band sits dark at the
 * column base; cache is the lightest so the cheapest tier reads
 * as a pale crown on top of the band.
 *
 * We use HSL so the same family stays visually coherent — the
 * eye reads "this is one provider" via hue, and "which kind" via
 * lightness step.
 */
function kindColor(provider: string, kind: TokenKind): string {
  const { hue, sat } = providerHueFor(provider);
  switch (kind) {
    case 'output': return `hsl(${hue} ${sat}% 48%)`;
    case 'input':  return `hsl(${hue} ${Math.max(sat - 8, 30)}% 62%)`;
    case 'cache':  return `hsl(${hue} ${Math.max(sat - 22, 22)}% 78%)`;
  }
}

/** Provider swatch in the legend uses the "input" mid-tone. */
function providerColor(provider: string): string {
  return kindColor(provider, 'input');
}

// ---------------------------------------------------------------------------
// Tick formatting
// ---------------------------------------------------------------------------

function formatXTick(key: string, granularity: 'hour' | 'day'): string {
  if (granularity === 'hour') {
    // 'YYYY-MM-DD HH:00' → 'HH'
    const m = /\s(\d{2}):/.exec(key);
    return m?.[1] ?? key;
  }
  // 'YYYY-MM-DD' → 'DD' (the M/D would be too dense at 30 columns;
  // the leading "MM" appears once per month transition below).
  const m = /-(\d{2})-(\d{2})$/.exec(key);
  return m?.[2] ?? key;
}

function formatBucketTitle(key: string, granularity: 'hour' | 'day'): string {
  if (granularity === 'hour') {
    const m = /^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):/.exec(key);
    if (!m) return key;
    const next = (Number(m[4]) + 1) % 24;
    return `${m[2]}/${m[3]} · ${m[4]}:00–${pad2(next)}:00`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : key;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface UsageBarChartProps {
  buckets: UsageTimeseriesBucket[];
  granularity: 'hour' | 'day';
  valueMode?: 'tokens' | 'cost';
  /** Display labels for providers (Chinese / branded names). */
  providerLabel: (provider: string) => string;
}

export function UsageBarChart({
  buckets,
  granularity,
  valueMode = 'tokens',
  providerLabel,
}: UsageBarChartProps): JSX.Element {
  const t = useT();
  const uid = useId().replace(/:/g, '');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Pre-compute per-bucket totals + the global max for y-axis scaling.
  // `providersInOrder` is the legend order; we sort by total descending
  // so the largest stack lives at the bottom of every column.
  const layout = useMemo(() => {
    const providerTotals = new Map<string, number>();
    for (const b of buckets) {
      for (const p of b.perProvider) {
        const tokens = p.inputTokens + p.outputTokens + p.cacheTokens;
        const value = valueMode === 'cost' ? (p.costUsd ?? 0) : tokens;
        providerTotals.set(
          p.provider,
          (providerTotals.get(p.provider) ?? 0) + value,
        );
      }
    }
    const providersInOrder = Array.from(providerTotals.entries())
      .filter(([, total]) => total > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([provider]) => provider);

    let maxTotal = 0;
    let maxEvents = 0;
    let peakIdx = -1;
    let primaryCurrency: string | null = null;

    const columns = buckets.map((b, idx) => {
      const stack: Array<{
        provider: string;
        tokens: number;
        cost: number | null;
        costEstimated: boolean;
        eventCount: number;
        /**
         * Per-kind breakdown rendered as nested same-hue bands inside
         * the provider segment. Order matches `KIND_ORDER` (output →
         * input → cache, bottom → top).
         */
        kinds: ReadonlyArray<{ kind: TokenKind; tokens: number }>;
      }> = [];
      let total = 0;
      let totalCost = 0;
      let totalCurrency: string | null = null;
      let totalEvents = 0;
      // Per-kind totals across the whole hovered column. Used by the
      // detail panel below so users can read a clean
      // "input X · output Y · cache Z" line without needing to add
      // up provider segments themselves.
      const kindTotals: Record<TokenKind, number> = {
        output: 0,
        input: 0,
        cache: 0,
      };
      for (const provider of providersInOrder) {
        const row = b.perProvider.find((p) => p.provider === provider);
        if (!row) continue;
        const tokens = row.inputTokens + row.outputTokens + row.cacheTokens;
        const value = valueMode === 'cost' ? (row.costUsd ?? 0) : tokens;
        if (value === 0) continue;
        const kinds: Array<{ kind: TokenKind; tokens: number }> = [
          { kind: 'output', tokens: row.outputTokens },
          { kind: 'input',  tokens: row.inputTokens },
          { kind: 'cache',  tokens: row.cacheTokens },
        ];
        kindTotals.output += row.outputTokens;
        kindTotals.input  += row.inputTokens;
        kindTotals.cache  += row.cacheTokens;
        stack.push({
          provider,
          tokens: value,
          cost: row.costUsd,
          costEstimated: row.costEstimated === true,
          eventCount: row.eventCount,
          kinds: valueMode === 'cost'
            ? [{ kind: 'input', tokens: value }]
            : kinds,
        });
        total += value;
        if (row.costUsd !== null) {
          totalCost += row.costUsd;
          if (row.currency && !totalCurrency) totalCurrency = row.currency;
          if (row.currency && !primaryCurrency) primaryCurrency = row.currency;
        }
        totalEvents += row.eventCount;
      }
      if (total > maxTotal) {
        maxTotal = total;
        peakIdx = idx;
      }
      if (totalEvents > maxEvents) {
        maxEvents = totalEvents;
      }
      return {
        key: b.key,
        startTs: b.startTs,
        total,
        kindTotals,
        totalCost,
        totalCurrency,
        totalCostEstimated: stack.some((seg) => seg.costEstimated),
        totalEvents,
        stack,
      };
    });

    return { providersInOrder, columns, maxTotal, maxEvents, peakIdx, primaryCurrency };
  }, [buckets, valueMode]);

  // Empty state — render an empty grid so the user sees the chart
  // exists, just no data yet. This is friendlier than a "暂无数据"
  // text block and also keeps the page height stable across data
  // ticks.
  const emptyData = layout.maxTotal === 0 || layout.columns.length === 0;

  // Y scale: round the max up to a "nice" tick so the reference line
  // labels are readable (1.2M instead of 1.21M).
  const yMax = niceCeiling(layout.maxTotal || 1);
  const valueUnit = valueMode === 'cost' ? '' : 'tok';
  const metricName = valueMode === 'cost' ? 'API 金额' : 'Token 消耗';
  const emptyLabel = valueMode === 'cost'
    ? '尚无 API 金额数据'
    : '尚无 Token 用量数据';
  const formatValue = (value: number, currency: string | null = null): string =>
    valueMode === 'cost'
      ? formatCurrencyAmount(value, currency ?? layout.primaryCurrency ?? null)
      : formatTokens(value);
  const formatPrimaryValue = (
    value: number,
    currency: string | null = null,
    estimated = false,
  ): string => {
    const formatted = formatValue(value, currency);
    return valueMode === 'cost' && estimated ? `估算 ${formatted}` : formatted;
  };

  // Right-axis scale for the events line. Capped at 1 so the polyline
  // sits on the baseline when there are no events recorded yet
  // (rather than going wild trying to scale to zero). The `nice`
  // helper handles small integer counts cleanly: 3→3, 7→7.5, 12→15.
  const eMax = niceCeiling(layout.maxEvents || 1);
  const hasEvents = layout.maxEvents > 0;

  // The number of columns drives x-axis label density only — the
  // visual width of every column is determined by flexbox, so the
  // chart's overall rhythm stays uniform across 7 / 24 / 30 columns.
  const columnCount = Math.max(layout.columns.length, 1);
  const tickStep = pickXTickStep(columnCount, granularity);

  // "Today" indicator: highlight the column whose `startTs` matches
  // the current local day (or hour). Used as a subtle ring.
  const nowMarker = useMemo(() => {
    const now = Date.now();
    if (granularity === 'hour') {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      return d.getTime();
    }
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, [granularity, layout.columns.length]);

  // Reset hover when the buckets change (e.g. user switched ranges)
  // so a stale hoverIdx doesn't cling to a different column.
  useEffect(() => {
    setHoverIdx(null);
  }, [granularity, columnCount]);

  const hovered = hoverIdx !== null ? layout.columns[hoverIdx] ?? null : null;

  return (
    <div
      className="usage-chart"
      role="figure"
      aria-label={
        emptyData
          ? emptyLabel
          : `${metricName} · ${granularity === 'hour' ? '小时' : '天'}级 · 峰值 ${formatValue(layout.maxTotal)}`
      }
    >
      {/* Header: peak summary + window subtitle. Lives above the
          plot frame so the chart canvas itself stays visually pure. */}
      <header className="usage-chart__header">
        <div className="usage-chart__heading">
          <span className="usage-chart__eyebrow">
            {granularity === 'hour' ? 'PER HOUR' : 'PER DAY'}
          </span>
          <span className="usage-chart__rule" aria-hidden />
          <span className="usage-chart__columns-meta">
            {emptyData ? '—' : `${columnCount} 个时段`}
          </span>
        </div>

        <dl className="usage-chart__stats">
          <div className="usage-chart__stat">
            <dt>峰值</dt>
            <dd>
              {emptyData ? '—' : formatValue(layout.maxTotal)}
              {valueUnit !== '' && (
                <span className="usage-chart__stat-unit">{valueUnit}</span>
              )}
            </dd>
          </div>
          <div className="usage-chart__stat">
            <dt>区间合计</dt>
            <dd>
              {formatValue(
                layout.columns.reduce((s, c) => s + c.total, 0),
              )}
              {valueUnit !== '' && (
                <span className="usage-chart__stat-unit">{valueUnit}</span>
              )}
            </dd>
          </div>
        </dl>
      </header>

      <div
        className={`usage-chart__plot${emptyData ? ' usage-chart__plot--empty' : ''}`}
        data-granularity={granularity}
        data-column-count={columnCount}
      >
        {/* Y-axis: SVG so we can render the gridlines crisp and
            respect the same coordinate space as the bars.
            Coordinate system mirrors the rail's exact vertical
            range (12px from the canvas top, 22px reserved for the
            x-axis at the bottom) so labels sit exactly on the
            matching gridline AND on the bar baseline. The "0" label
            in particular has to land on canvas-y = 198 to match the
            rail bottom; mismatch here produces the "bars floating in
            mid-air" bug. */}
        <svg
          className="usage-chart__yaxis"
          viewBox="0 0 44 220"
          preserveAspectRatio="none"
          aria-hidden
        >
          {[1, 0.75, 0.5, 0.25, 0].map((frac) => {
            // Rail vertical range: top = 12px, bottom = 198px,
            // inner height = 186px. Labels share the same scale.
            const y = 12 + (1 - frac) * 186;
            return (
              <text
                key={frac}
                x={40}
                y={y + 3}
                textAnchor="end"
                className="usage-chart__yaxis-label"
              >
                {frac === 0 ? '0' : formatValue(yMax * frac)}
              </text>
            );
          })}
        </svg>

        {/* Plot canvas: gridlines (SVG, absolute) + bar rail (HTML
            flex). The two layers share the same height tokens via
            CSS variables defined on `.usage-chart__plot`.

            `--rail-max-width` is the horizontal budget the three
            coordinate-sensitive layers (rail / events / xaxis)
            share. Without it the rail's bars clamp at
            `--col-max-w` (28px) leaving slack on the right for
            low column counts (今日 24h, 本周 7d), while the
            events SVG uses `preserveAspectRatio="none"` and
            stretches edge-to-edge — so the curve drifts off the
            bar centres. Capping every layer to the same computed
            width and centering them keeps the polyline
            x-coordinates aligned with bar centres regardless of
            how many columns the current range is showing. */}
        <div
          className="usage-chart__canvas"
          style={
            {
              '--rail-max-width': `calc(${columnCount} * var(--col-max-w) + ${Math.max(columnCount - 1, 0)} * var(--col-gap))`,
            } as CSSProperties
          }
        >
          {/*
            Kind-tone key — floats in the top-right corner of the
            plot canvas. Anchored to the chart itself (not header /
            footer) so it reads as inline data-key reference; using
            a neutral grey scale signals "this is the lightness
            scale inside every bar", not a fourth provider.
            Hidden when there's no data so the empty-state has
            uncluttered breathing room.
          */}
          {!emptyData && valueMode === 'tokens' && layout.providersInOrder.length > 0 && (
            <span
              className="usage-chart__kind-key"
              aria-label={t('usage.kind.legendAria')}
            >
              {KIND_ORDER.map((kind) => (
                <span key={kind} className="usage-chart__kind-key-item">
                  <span
                    className="usage-chart__kind-key-swatch"
                    data-kind={kind}
                  />
                  <span className="usage-chart__kind-key-label">
                    {t(KIND_LABEL_KEY[kind])}
                  </span>
                </span>
              ))}
            </span>
          )}

          {/* Gridline backdrop. Drawn as an SVG so the dashed strokes
              stay crisp at any width. Uses a 0..100 normalized
              coordinate space; the rail and y-axis use 12..198 px in
              their own canvas, so a frac of 1 → y=12 and frac of 0
              → y=198 (the baseline that bars stand on). Mismatch
              here is the "bars floating in mid-air" bug. */}
          <svg
            className="usage-chart__grid"
            viewBox="0 0 100 220"
            preserveAspectRatio="none"
            aria-hidden
          >
            {[1, 0.75, 0.5, 0.25].map((frac, i) => {
              const y = 12 + (1 - frac) * 186;
              return (
                <line
                  key={frac}
                  x1={0}
                  x2={100}
                  y1={y}
                  y2={y}
                  className={`usage-chart__gridline${i === 0 ? ' usage-chart__gridline--top' : ''}`}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {/* Baseline — sits at the rail's bottom edge so bars
                appear to grow out of it. */}
            <line
              x1={0}
              x2={100}
              y1={198}
              y2={198}
              className="usage-chart__gridline usage-chart__gridline--baseline"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Bar rail. Each column is a button so it's reachable by
              keyboard and properly sized for touch. The bars
              themselves are absolutely-positioned divs stacked
              vertically; their height is a percentage of the
              column's `--col-h` so the y-scale lines up with the
              gridlines drawn behind. */}
          <div
            className="usage-chart__rail"
            role="list"
            onMouseLeave={() => setHoverIdx(null)}
          >
            {emptyData
              ? // One placeholder column to keep layout height stable
                Array.from({ length: 12 }).map((_, i) => (
                  <div
                    key={i}
                    className="usage-chart__col usage-chart__col--placeholder"
                    aria-hidden
                  />
                ))
              : layout.columns.map((col, idx) => {
                  const heightPct =
                    yMax > 0 ? (col.total / yMax) * 100 : 0;
                  const isHover = hoverIdx === idx;
                  const isPeak =
                    idx === layout.peakIdx && col.total > 0;
                  const isNow = col.startTs === nowMarker;
                  return (
                    <button
                      type="button"
                      key={col.key}
                      role="listitem"
                      className={`usage-chart__col${isHover ? ' usage-chart__col--hover' : ''}${isPeak ? ' usage-chart__col--peak' : ''}${isNow ? ' usage-chart__col--now' : ''}`}
                      onMouseEnter={() => setHoverIdx(idx)}
                      onFocus={() => setHoverIdx(idx)}
                      onBlur={() => setHoverIdx(null)}
                      aria-label={`${formatBucketTitle(col.key, granularity)}：${formatPrimaryValue(col.total, col.totalCurrency, col.totalCostEstimated)}${valueMode === 'tokens' ? ' tokens' : ''}${col.totalEvents > 0 ? `，${col.totalEvents} 次请求` : ''}`}
                      style={{
                        // Stagger the entrance — feels like data
                        // is being printed in. Capped at 600ms
                        // total even at 30 columns so the chart
                        // never feels laggy.
                        animationDelay: `${Math.min(idx * 18, 600)}ms`,
                      }}
                    >
                      {/* Inner clip — the stack can't paint
                          outside the column box, which keeps the
                          gradient sheen contained on hover. */}
                      <span className="usage-chart__col-track" aria-hidden>
                        <span
                          className="usage-chart__stack"
                          style={{ height: `${heightPct}%` }}
                        >
                          {col.stack.map((seg) => {
                            const segPct =
                              col.total > 0
                                ? (seg.tokens / col.total) * 100
                                : 0;
                            return (
                              <span
                                key={seg.provider}
                                className="usage-chart__seg"
                                style={{ flexBasis: `${segPct}%` }}
                                data-provider={seg.provider}
                              >
                                {/*
                                  Each provider segment is split into
                                  three same-hue bands (output / input
                                  / cache) using `flex-direction:
                                  column-reverse` so output pins to the
                                  bottom and cache crowns the top — the
                                  cost-heavy bands stay at the column
                                  base where the eye lands first.
                                */}
                                {seg.kinds.map(({ kind, tokens }) => {
                                  if (tokens === 0) return null;
                                  const kindPct =
                                    seg.tokens > 0
                                      ? (tokens / seg.tokens) * 100
                                      : 0;
                                  return (
                                    <span
                                      key={kind}
                                      className="usage-chart__kind"
                                      style={{
                                        flexBasis: `${kindPct}%`,
                                        background: kindColor(
                                          seg.provider,
                                          kind,
                                        ),
                                      }}
                                      data-kind={kind}
                                    />
                                  );
                                })}
                              </span>
                            );
                          })}
                        </span>
                        {isPeak && (
                          <span
                            className="usage-chart__crown"
                            style={{ bottom: `calc(${heightPct}% + 4px)` }}
                            aria-hidden
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
          </div>

          {/* Events polyline overlay — renders on top of the bar rail
              so the request-count trend is visible across the whole
              window. Shares the rail's vertical coordinate space
              (12..198) so its 0 lines up with the bar baseline.
              Hidden when no events have been recorded yet — empty
              data already shows the placeholder skeleton. */}
          {!emptyData && hasEvents && (
            <svg
              className="usage-chart__events"
              viewBox={`0 0 ${Math.max(columnCount, 1)} 220`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {(() => {
                // Build a smooth Catmull-Rom-derived cubic-bezier
                // path through every column's event count. X is the
                // centre of the column slot in the viewBox's local
                // x-units (0..columnCount); CSS's
                // `preserveAspectRatio="none"` then stretches the
                // entire SVG to fit the rail's exact width, so the
                // points align with the column centres regardless
                // of the rail's actual pixel width.
                //
                // We feed every column into the smoother (including
                // zero-event ones) so the curve flows naturally
                // through valleys instead of forming sharp
                // triangles between sparse peaks.
                //
                // Y range is 12..194 (NOT 12..198). The bar
                // baseline lives at canvas-y = 198 — drawing the
                // zero-events curve there too would make the line
                // and the baseline overlap pixel-for-pixel, which
                // (combined with the bars chopping through it)
                // read as the curve "going dashed" along sparse
                // ranges. Lifting the floor by 4px gives the line
                // its own lane just above the baseline so it
                // always reads as a continuous stroke regardless
                // of how many adjacent buckets are zero.
                const points: Array<[number, number, number, number]> =
                  layout.columns.map((col, idx) => {
                    const x = idx + 0.5;
                    const frac = eMax > 0 ? col.totalEvents / eMax : 0;
                    const y = 12 + (1 - frac) * 182;
                    return [x, y, idx, col.totalEvents];
                  });

                const linePath = buildSmoothEventsPath(
                  points.map(([x, y]) => [x, y]),
                );

                return (
                  <>
                    <path
                      className="usage-chart__events-line"
                      d={linePath}
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                );
              })()}
            </svg>
          )}

          {/*
            Hover dot — rendered as a screen-space HTML element so it
            is NOT affected by the events SVG's `preserveAspectRatio
            ="none"` (which would stretch a viewBox-space circle into
            a wide horizontal smear, especially at high column
            counts). Position is computed in % of canvas width × px
            of the same vertical coordinate space the bars use.
          */}
          {!emptyData && hasEvents && hoverIdx !== null && (() => {
            const col = layout.columns[hoverIdx];
            if (!col || col.totalEvents === 0) return null;
            const xPct = ((hoverIdx + 0.5) / columnCount) * 100;
            // Same y-scale as the polyline (12..194 — see the
            // curve build above for the rationale on the 4px
            // offset from the bar baseline at canvas-y = 198).
            const yPx = 12 + (1 - col.totalEvents / eMax) * 182;
            return (
              <span
                className="usage-chart__events-dot"
                style={{
                  left: `calc(${xPct.toFixed(3)}% )`,
                  top: `${yPx.toFixed(2)}px`,
                }}
                aria-hidden
              />
            );
          })()}

          {/* X-axis labels under the rail. We render one <span> per
              column even when we don't show a label so the spacing
              stays in lockstep with the bars (no extra positioning
              math). */}
          {!emptyData && (
            <div className="usage-chart__xaxis" aria-hidden>
              {layout.columns.map((col, idx) => {
                const showLabel =
                  idx % tickStep === 0 ||
                  idx === layout.columns.length - 1;
                return (
                  <span
                    key={col.key}
                    className={`usage-chart__xaxis-tick${showLabel ? '' : ' usage-chart__xaxis-tick--blank'}`}
                  >
                    {showLabel ? formatXTick(col.key, granularity) : ''}
                  </span>
                );
              })}
            </div>
          )}

          {emptyData && (
            <div className="usage-chart__empty" role="status">
              <span className="usage-chart__empty-glyph" aria-hidden />
              {/* `usage-chart__empty-title` ("尚未采集到 Token 用量") is
                  a chart-frame headline outside the task-14.4 scope
                  (time-range labels, quota window names, snapshot
                  status badges, source labels, kind labels, empty-
                  state sentences). It is left for the broader
                  empty-state pass in task 14.5. */}
              <p className="usage-chart__empty-title">{emptyLabel}</p>
              <p className="usage-chart__empty-desc">
                {granularity === 'hour'
                  ? t('usage.empty.todayPlaceholder')
                  : t('usage.empty.rangePlaceholder')}
              </p>
            </div>
          )}
        </div>

        {/* Right y-axis: events-per-bucket. Same vertical coordinate
            space as the left axis (12..198) so 0 lines up with the
            bar baseline. Hidden when no events have been recorded
            so the right gutter doesn't carry a misleading scale. */}
        <svg
          className="usage-chart__yaxis usage-chart__yaxis--right"
          viewBox="0 0 44 220"
          preserveAspectRatio="none"
          aria-hidden
          data-active={hasEvents ? 'true' : 'false'}
        >
          {hasEvents &&
            [1, 0.75, 0.5, 0.25, 0].map((frac) => {
              // Match the polyline's compressed range (12..194) so
              // each tick label sits exactly on the curve's value
              // for that fraction. See the curve build above.
              const y = 12 + (1 - frac) * 182;
              return (
                <text
                  key={frac}
                  x={4}
                  y={y + 3}
                  textAnchor="start"
                  className="usage-chart__yaxis-label usage-chart__yaxis-label--right"
                >
                  {frac === 0
                    ? '0'
                    : Math.round(eMax * frac).toString()}
                </text>
              );
            })}
        </svg>
      </div>

      {/* Legend + tooltip live below the plot so they don't compete
          with the data. The tooltip slides in from the right of the
          legend strip — keeps the user's eyes on the same line. */}
      <footer className="usage-chart__footer">
        <div className="usage-chart__legend" aria-hidden>
          {layout.providersInOrder.length === 0 && (
            <span className="usage-chart__legend-empty">
              {emptyData ? '\u00a0' : t('usage.empty.allRanges')}
            </span>
          )}
          {layout.providersInOrder.map((provider) => {
            const isDimmed =
              hovered &&
              !hovered.stack.some((s) => s.provider === provider) &&
              hovered.total > 0;
            return (
              <span
                key={provider}
                className={`usage-chart__legend-item${isDimmed ? ' usage-chart__legend-item--dim' : ''}`}
              >
                {/*
                  Provider swatch is a 3-tone gradient strip mirroring
                  the same hue family used inside the bar — output
                  (dark) → input (mid) → cache (light). Reading the
                  chart and the legend with the same colour grammar
                  removes the need for a separate kind legend.
                */}
                <span
                  className="usage-chart__legend-swatch"
                  style={{
                    background: `linear-gradient(to right, ${kindColor(
                      provider,
                      'output',
                    )} 0% 33%, ${kindColor(
                      provider,
                      'input',
                    )} 33% 66%, ${kindColor(provider, 'cache')} 66% 100%)`,
                  }}
                />
                <span className="usage-chart__legend-label">
                  {providerLabel(provider)}
                </span>
              </span>
            );
          })}
          {/*
            Events series legend item — added when there are events
            in the window so the orange polyline is identifiable.
            Marker is a short stroke + dot so it reads as a "line"
            not a "block".
          */}
          {hasEvents && (
            <span className="usage-chart__legend-item usage-chart__legend-item--events">
              <svg
                className="usage-chart__legend-line"
                viewBox="0 0 14 8"
                aria-hidden
              >
                <line
                  x1={0}
                  x2={14}
                  y1={4}
                  y2={4}
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                />
                <circle cx={7} cy={4} r={2} fill="currentColor" />
              </svg>
              <span className="usage-chart__legend-label">请求次数</span>
            </span>
          )}
        </div>

        {/* Hover detail panel. Always rendered, just dimmed when no
            column is hovered — keeps the row height stable so the
            page doesn't reflow on hover (UX rule §3 layout-shift). */}
        <div
          className={`usage-chart__detail${hovered && hovered.total > 0 ? ' usage-chart__detail--active' : ''}`}
          role="status"
          aria-live="polite"
        >
          {hovered && hovered.total > 0 ? (
            <>
              <span className="usage-chart__detail-label">
                {formatBucketTitle(hovered.key, granularity)}
              </span>
              <span className="usage-chart__detail-sep" aria-hidden>·</span>
              <span className="usage-chart__detail-value">
                {formatPrimaryValue(hovered.total, hovered.totalCurrency, hovered.totalCostEstimated)}
                {valueUnit !== '' ? ` ${valueUnit}` : ''}
              </span>
              {/*
                Per-kind totals across all visible providers in the
                hovered bucket. Hides individual zero-tier counts so
                a "no cache hits today" doesn't push noise onto the
                pill.
              */}
              {valueMode === 'tokens' && KIND_ORDER.map((kind) => {
                const value = hovered.kindTotals[kind];
                if (value === 0) return null;
                return (
                  <span
                    key={kind}
                    className="usage-chart__detail-kind"
                    data-kind={kind}
                  >
                    <span
                      className="usage-chart__detail-kind-dot"
                      data-kind={kind}
                      aria-hidden
                    />
                    <span className="usage-chart__detail-kind-label">
                      {t(KIND_LABEL_KEY[kind])}
                    </span>
                    <span className="usage-chart__detail-kind-value">
                      {formatTokens(value)}
                    </span>
                  </span>
                );
              })}
              {hovered.totalEvents > 0 && (
                <>
                  <span className="usage-chart__detail-sep" aria-hidden>·</span>
                  <span className="usage-chart__detail-value">
                    {hovered.totalEvents} 次
                  </span>
                </>
              )}
              {valueMode === 'tokens' && hovered.totalCost > 0 && (
                <>
                  <span className="usage-chart__detail-sep" aria-hidden>·</span>
                  <span className="usage-chart__detail-value">
                    {formatCurrencyAmount(hovered.totalCost, hovered.totalCurrency ?? null)}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="usage-chart__detail-hint">
              {emptyData ? '\u00a0' : t('usage.empty.hoverHint')}
            </span>
          )}
        </div>
      </footer>

      {/* Render `uid` so each chart instance has a unique CSS scope
          if we ever want to namespace it. Currently unused but keeps
          the hook signature stable for future per-instance gradients. */}
      <span hidden data-uid={uid} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Round `n` up to a "nice" tick value so the y-axis labels are
 * readable. e.g. 1_213_456 → 1_500_000, 6_400 → 7_000, 80 → 100.
 */
function niceCeiling(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const norm = n / base; // in [1, 10)
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 1.5) nice = 1.5;
  else if (norm <= 2) nice = 2;
  else if (norm <= 3) nice = 3;
  else if (norm <= 5) nice = 5;
  else if (norm <= 7.5) nice = 7.5;
  else nice = 10;
  return nice * base;
}

/**
 * Pick how often to render an x-axis tick label so they don't
 * overlap. The rail is flex-driven so this is purely about label
 * legibility, not bar layout.
 */
function pickXTickStep(
  columnCount: number,
  granularity: 'hour' | 'day',
): number {
  if (granularity === 'hour') {
    if (columnCount <= 12) return 2;
    if (columnCount <= 24) return 3;
    return Math.ceil(columnCount / 8);
  }
  if (columnCount <= 7) return 1;
  if (columnCount <= 14) return 2;
  if (columnCount <= 31) return 4;
  return Math.ceil(columnCount / 6);
}

/**
 * Build a smooth `path d` attribute through `points` using monotone
 * cubic Hermite interpolation (Fritsch-Carlson). Unlike a generic
 * Catmull-Rom-to-Bezier smoother, this algorithm is **shape-
 * preserving**: the curve is guaranteed never to overshoot a data
 * point's local extremum, and it stays exactly flat through any
 * run of equal y-values.
 *
 * That property is exactly what we need for the events trend:
 *   - "0 → peak → 0" segments don't develop control-point wings
 *     above the peak that get clipped into horizontal artefacts;
 *   - long runs of zeros stay glued to y=baseline instead of
 *     dipping below into the x-axis lane.
 *
 * Reference: Fritsch & Carlson 1980, "Monotone Piecewise Cubic
 * Interpolation". Implementation follows the SIAM J. Numer. Anal.
 * pseudocode with the Hyman boundary fixes for the first/last
 * tangents.
 */
function buildSmoothEventsPath(points: Array<[number, number]>): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) {
    const [x, y] = points[0]!;
    return `M ${x.toFixed(3)} ${y.toFixed(2)} L ${x.toFixed(3)} ${y.toFixed(2)}`;
  }

  // Step 1 — slope of each segment.
  const dx: number[] = [];
  const dy: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dxi = points[i + 1]![0] - points[i]![0];
    const dyi = points[i + 1]![1] - points[i]![1];
    dx.push(dxi);
    dy.push(dyi);
    slopes.push(dxi === 0 ? 0 : dyi / dxi);
  }

  // Step 2 — initial tangents at each point. Endpoints use one-sided
  // estimates; interior points use the average of adjacent slopes.
  const m: number[] = new Array(n).fill(0);
  m[0] = slopes[0]!;
  m[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    m[i] = (slopes[i - 1]! + slopes[i]!) / 2;
  }

  // Step 3 — Fritsch-Carlson correction. If two consecutive slopes
  // have opposite signs (a local extremum) zero out the tangent;
  // otherwise scale tangents down to keep the curve monotone within
  // each segment.
  for (let i = 0; i < n - 1; i += 1) {
    const sk = slopes[i]!;
    if (sk === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / sk;
    const b = m[i + 1]! / sk;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * sk;
      m[i + 1] = t * b * sk;
    }
  }

  // Step 4 — emit each Hermite segment as a cubic Bezier. The
  // mapping is the standard one:
  //   B(t) =   (1-t)^3 P0
  //          + 3(1-t)^2 t  C1
  //          + 3(1-t) t^2  C2
  //          +     t^3      P1
  // with C1 = P0 + (m0 * dx)/3, C2 = P1 - (m1 * dx)/3.
  const out: string[] = [];
  out.push(`M ${points[0]![0].toFixed(3)} ${points[0]![1].toFixed(2)}`);
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const c1x = x0 + dx[i]! / 3;
    const c1y = y0 + (m[i]! * dx[i]!) / 3;
    const c2x = x1 - dx[i]! / 3;
    const c2y = y1 - (m[i + 1]! * dx[i]!) / 3;
    out.push(
      `C ${c1x.toFixed(3)} ${c1y.toFixed(2)}, ` +
        `${c2x.toFixed(3)} ${c2y.toFixed(2)}, ` +
        `${x1.toFixed(3)} ${y1.toFixed(2)}`,
    );
  }
  return out.join(' ');
}
