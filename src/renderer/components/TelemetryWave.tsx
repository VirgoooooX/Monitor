// TelemetryWave — instrument-grade latency waveform for the expanded
// network strip.
//
// Builds on top of the same data shape as `Sparkline` (a `number[]`
// of latency samples) but draws a richer visual:
//
//   • Stacked vertical sample bars under the curve, fading from the
//     trailing edge backward — gives the chart a sense of "history
//     decaying into the past" without the busy noise of full bars.
//   • Smooth gradient stroke with a horizontal sweep gradient
//     (faint → bright) so the eye is pulled toward the latest value.
//   • A 2x glowing trailing dot with concentric halo rings; on
//     non-flat datasets the dot pulses (when motion is allowed).
//   • Three ghost grid lines at 25 / 50 / 75% of the y-range to
//     anchor the eye in space without the chart turning into graph
//     paper.
//   • A hairline "now" tick at the right edge, which together with
//     the trailing dot reads as "you are here".
//
// The component owns no animation state — pulsing is a CSS animation
// keyed off `data-pulse="true"` so `prefers-reduced-motion` users
// get a static dot via the standard CSS gate.
//
// Visual tokens: the entire chart inherits `currentColor` from the
// CSS scope, exactly like `Sparkline`. Set `color` on the parent to
// retint (emerald in light mode, indigo in dark, red on degraded).
//
// Why a separate component? `Sparkline` is reused in the 60×16
// compact widget where every byte of paint matters; loading a glow
// filter + 18 vertical bars there would burn cycles. `TelemetryWave`
// is the "network strip is in focus" variant — bigger canvas, richer
// paint, single-window cost.

import { useId, useMemo } from 'react';

export interface TelemetryWaveProps {
  /** Up to 60 latency samples (ms) from the ring buffer. */
  readonly data: number[];
  /** Optional intrinsic width override (default 520). */
  readonly width?: number;
  /** Optional intrinsic height override (default 56). */
  readonly height?: number;
  /** Optional stroke width (default 1.75). */
  readonly strokeWidth?: number;
  /**
   * When true (default), enable the trailing pulse animation if the
   * user hasn't requested reduced motion. Set to false to force
   * static rendering (e.g. screenshots, tests).
   */
  readonly pulse?: boolean;
}

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 56;

interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
  /** Raw value, kept so callers can render value-driven decoration. */
  readonly v: number;
}

interface ProjectionResult {
  readonly points: ProjectedPoint[];
  readonly min: number;
  readonly max: number;
  readonly range: number;
}

/**
 * Project samples into screen-space `[x, y]` pairs. The y axis is
 * inverted (SVG y=0 is the top) and padded by 2 px on top/bottom so
 * the stroke + glow do not clip at the edges of the viewBox.
 */
function projectPoints(
  data: number[],
  width: number,
  height: number,
): ProjectionResult {
  if (data.length === 0) {
    return { points: [], min: 0, max: 0, range: 1 };
  }

  let min = data[0]!;
  let max = data[0]!;
  for (let i = 1; i < data.length; i += 1) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const range = max - min || 1;
  const pad = 4;
  const usableHeight = height - pad * 2;
  const xStep = data.length > 1 ? (width - 1) / (data.length - 1) : 0;

  const points: ProjectedPoint[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i]!;
    const x = i * xStep;
    const y = pad + usableHeight - ((v - min) / range) * usableHeight;
    points.push({ x, y, v });
  }
  return { points, min, max, range };
}

/**
 * Build a smooth `path d` attribute from projected points using
 * Catmull-Rom-to-cubic-Bézier conversion. Mirrors the helper in
 * `Sparkline` but operates on `ProjectedPoint`.
 */
function buildSmoothPath(points: ProjectedPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const { x, y } = points[0]!;
    return `M ${x.toFixed(2)} ${y.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  const k = 0.18;
  const out: string[] = [];
  const first = points[0]!;
  out.push(`M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`);

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;

    const cp1x = p1.x + (p2.x - p0.x) * k;
    const cp1y = p1.y + (p2.y - p0.y) * k;
    const cp2x = p2.x - (p3.x - p1.x) * k;
    const cp2y = p2.y - (p3.y - p1.y) * k;

    out.push(
      `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ` +
        `${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ` +
        `${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    );
  }

  return out.join(' ');
}

function isFlat(data: number[]): boolean {
  if (data.length < 2) return true;
  const first = data[0]!;
  for (let i = 1; i < data.length; i += 1) {
    if (data[i] !== first) return false;
  }
  return true;
}

export function TelemetryWave({
  data,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  strokeWidth = 1.75,
  pulse = true,
}: TelemetryWaveProps): JSX.Element {
  const uid = useId().replace(/:/g, '');
  const lineGradId = `tw-line-${uid}`;
  const fillGradId = `tw-fill-${uid}`;
  const barGradId = `tw-bar-${uid}`;
  const glowId = `tw-glow-${uid}`;

  const projection = useMemo(
    () => projectPoints(data, width, height),
    [data, width, height],
  );
  const { points } = projection;
  const path = useMemo(() => buildSmoothPath(points), [points]);
  const flat = isFlat(data);

  // Build the closed area polygon for the gradient fill.
  const areaPath = useMemo(() => {
    if (!path || points.length === 0) return '';
    const first = points[0]!;
    const last = points[points.length - 1]!;
    return `${path} L ${last.x.toFixed(2)} ${height} L ${first.x.toFixed(2)} ${height} Z`;
  }, [path, points, height]);

  // Sample bar pitch — denser than the data points so the bars look
  // like a busy oscilloscope feed even when the data buffer is small.
  // We render one bar per data point but sized to a max of 64 bars
  // so the chart stays readable on shorter buffers.
  const lastPoint = points[points.length - 1];
  const dotRadius = 3;
  const haloRadius = 8;

  // Vertical sample bars under the curve. Each bar runs from the
  // baseline (height - 2) up to the curve's y at that sample. The
  // opacity decays with distance from the trailing edge so the
  // history fades into the past rather than competing with the
  // active edge.
  const bars = useMemo(() => {
    if (points.length === 0) return [];
    const bottomY = height - 2;
    const result: { x: number; y: number; height: number; opacity: number }[] = [];
    const total = points.length;
    for (let i = 0; i < total; i += 1) {
      const p = points[i]!;
      const decay = (i + 1) / total; // 0 → 1 left-to-right
      // Bias the alpha curve so the latest 1/3 reads brightest.
      const alpha = Math.max(0.04, Math.pow(decay, 2.2) * 0.55);
      const barH = bottomY - p.y;
      if (barH <= 0) continue;
      result.push({ x: p.x, y: p.y, height: barH, opacity: alpha });
    }
    return result;
  }, [points, height]);

  // Three reference lines at 25/50/75% of the y-range.
  const gridLines = useMemo(() => {
    const pad = 4;
    const usable = height - pad * 2;
    return [0.25, 0.5, 0.75].map((t) => pad + usable * t);
  }, [height]);

  // Bar width: aim for 1.5–3 px depending on density. Computed from
  // the x-step between consecutive points.
  const xStep =
    points.length > 1 ? (points[1]!.x - points[0]!.x) : 0;
  const barWidth = Math.max(1, Math.min(3, xStep * 0.45));

  return (
    <svg
      className="telemetry-wave"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="telemetry-wave"
      data-pulse={pulse && !flat ? 'true' : 'false'}
    >
      <defs>
        {/* Horizontal stroke gradient — head of the curve glows
            brightest; tail recedes. */}
        <linearGradient id={lineGradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
          <stop offset="55%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>

        {/* Area fill under the curve. */}
        <linearGradient id={fillGradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.04" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>

        {/* Bar gradient — vertical, with strong alpha at the top
            (curve edge) softening down to nothing at the baseline. */}
        <linearGradient id={barGradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.6" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>

        {/* Soft glow filter for the curve + trailing dot. */}
        <filter
          id={glowId}
          x="-5%"
          y="-30%"
          width="110%"
          height="160%"
          filterUnits="userSpaceOnUse"
        >
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Reference grid lines — quiet horizontal anchors. */}
      {!flat && gridLines.map((y, idx) => (
        <line
          key={`grid-${idx}`}
          x1={0}
          x2={width}
          y1={y}
          y2={y}
          stroke="currentColor"
          strokeOpacity={idx === 1 ? 0.14 : 0.07}
          strokeWidth={1}
          strokeDasharray={idx === 1 ? '0' : '2 5'}
        />
      ))}

      {/* Vertical sample bars, drawn before the area so they sit
          underneath the smooth gradient wash. */}
      {!flat && bars.map((b, idx) => (
        <line
          key={`bar-${idx}`}
          x1={b.x}
          x2={b.x}
          y1={b.y}
          y2={height - 2}
          stroke={`url(#${barGradId})`}
          strokeWidth={barWidth}
          strokeLinecap="round"
          opacity={b.opacity}
        />
      ))}

      {/* Soft area wash. */}
      {areaPath && !flat && (
        <path d={areaPath} fill={`url(#${fillGradId})`} stroke="none" />
      )}

      {/* Glowing curve. */}
      {path && (
        <path
          d={path}
          fill="none"
          stroke={`url(#${lineGradId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#${glowId})`}
        />
      )}

      {/* Vertical hairline at the trailing edge — "now" marker. */}
      {!flat && lastPoint && (
        <line
          x1={lastPoint.x}
          x2={lastPoint.x}
          y1={2}
          y2={height - 2}
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={1}
          strokeDasharray="1 3"
        />
      )}

      {/* Concentric halo + dot at the trailing edge. */}
      {!flat && lastPoint && (
        <>
          <circle
            className="telemetry-wave__halo"
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={haloRadius}
            fill="currentColor"
            opacity={0.16}
          />
          <circle
            className="telemetry-wave__pulse"
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={dotRadius * 1.6}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.55}
          />
          <circle
            className="telemetry-wave__dot"
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={dotRadius}
            fill="currentColor"
          />
        </>
      )}
    </svg>
  );
}
