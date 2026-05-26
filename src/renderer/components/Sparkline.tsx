// Sparkline — smoothed SVG line for latency history.
//
// Renders the last ≤60 latency samples from the in-memory ring buffer
// as a smoothed line chart. The y-axis is auto-scaled to the min/max
// of the current data window so the line always fills the available
// vertical space.
//
// Visual treatment:
//   • A soft area fill (top-down gradient) under the curve adds depth.
//   • The stroke uses a horizontal colour gradient so the trend tilts
//     between the accent colour and a complementary highlight.
//   • An outer glow (`<filter>` blur) gives the line a halo against
//     the card backdrop without bleeding outside the SVG box.
//   • The latest sample carries a small dot + halo so the user can
//     read "where we are right now" at a glance.
//   • A 1 px baseline dashed at min(data) provides a visual anchor;
//     hidden when the curve is flat (range === 0).
//
// The curve itself is built with cubic Bézier control points
// (Catmull-Rom-derived), which keeps the line smooth without
// introducing oscillation between samples — a plain `polyline`
// produces sharp peaks that read as noise on a 920 × 72 canvas.
//
// References:
//   • design.md §Window Strategy (60×16 SVG polyline)
//   • design.md §Performance Considerations (in-memory ring buffer)
//   • PLAN.md §UI Implementation Guide

import { useId } from 'react';

interface SparklineProps {
  /** Up to 60 latency samples (ms) from the ring buffer. */
  readonly data: number[];
  /** Optional intrinsic width override (default 60). */
  readonly width?: number;
  /** Optional intrinsic height override (default 16). */
  readonly height?: number;
  /** Optional stroke width (default 1.2). */
  readonly strokeWidth?: number;
  /** Render a soft gradient fill under the line (default false). */
  readonly fill?: boolean;
}

/** Default SVG intrinsic dimensions (matches design spec: 60×16). */
const DEFAULT_WIDTH = 60;
const DEFAULT_HEIGHT = 16;

/**
 * Project samples into screen-space `[x, y]` pairs. The y axis is
 * inverted (SVG y=0 is the top) and padded by 1 px on top/bottom so
 * the stroke does not clip at the edges of the viewBox.
 */
function projectPoints(
  data: number[],
  width: number,
  height: number,
): Array<[number, number]> {
  if (data.length === 0) return [];

  let min = data[0]!;
  let max = data[0]!;
  for (let i = 1; i < data.length; i += 1) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const range = max - min || 1; // avoid division by zero
  const pad = 1;
  const usableHeight = height - pad * 2;
  const xStep = data.length > 1 ? (width - 1) / (data.length - 1) : 0;

  const out: Array<[number, number]> = [];
  for (let i = 0; i < data.length; i += 1) {
    const x = i * xStep;
    const y = pad + usableHeight - ((data[i]! - min) / range) * usableHeight;
    out.push([x, y]);
  }
  return out;
}

/**
 * Build a smooth `path d` attribute from projected points using
 * Catmull-Rom-to-cubic-Bézier conversion. The smoothing factor `k`
 * controls how aggressively the tangents pull — 0.18 is gentle
 * enough that local peaks are still legible.
 */
function buildSmoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const [x, y] = points[0]!;
    // Single-sample fallback: a tiny dot represented as a zero-length
    // line so SVG still renders the cap.
    return `M ${x.toFixed(2)} ${y.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  const k = 0.18;
  const out: string[] = [];
  const [x0, y0] = points[0]!;
  out.push(`M ${x0.toFixed(2)} ${y0.toFixed(2)}`);

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;

    const cp1x = p1[0] + (p2[0] - p0[0]) * k;
    const cp1y = p1[1] + (p2[1] - p0[1]) * k;
    const cp2x = p2[0] - (p3[0] - p1[0]) * k;
    const cp2y = p2[1] - (p3[1] - p1[1]) * k;

    out.push(
      `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ` +
        `${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ` +
        `${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`,
    );
  }

  return out.join(' ');
}

/**
 * Detect if the dataset is "flat" (range === 0). When every sample is
 * the same value we suppress the area fill and the baseline dash so
 * the user does not see a misleading horizontal slab.
 */
function isFlat(data: number[]): boolean {
  if (data.length < 2) return true;
  const first = data[0]!;
  for (let i = 1; i < data.length; i += 1) {
    if (data[i] !== first) return false;
  }
  return true;
}

export function Sparkline({
  data,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  strokeWidth = 1.2,
  fill = false,
}: SparklineProps): JSX.Element {
  // Stable per-instance id so multiple sparklines on the same page
  // don't collide on `<linearGradient id>`. `useId` is React 18+.
  const uid = useId().replace(/:/g, '');
  const lineGradId = `sl-line-${uid}`;
  const fillGradId = `sl-fill-${uid}`;
  const glowId = `sl-glow-${uid}`;

  const points = projectPoints(data, width, height);
  const path = buildSmoothPath(points);
  const flat = isFlat(data);

  // Treat strokes thicker than 1.5 px as "large canvas" — used to
  // scale the trailing-dot radius and the glow blur radius so the
  // small 60×16 widget keeps its tight look while the 920×72
  // network card gets a richer, softer visual.
  const isLarge = strokeWidth >= 1.5;
  const lastPoint = points[points.length - 1];
  const dotRadius = isLarge ? 2.4 : 1.4;
  const haloRadius = dotRadius * 2.4;
  const glowStdDev = isLarge ? 1.4 : 0.6;

  // For the area fill we close the polyline back to the bottom corners.
  // Use the path's first/last x so the polygon hugs the curve cleanly.
  const areaPath = path
    ? `${path} L ${(points[points.length - 1]?.[0] ?? width).toFixed(2)} ${height} ` +
      `L ${(points[0]?.[0] ?? 0).toFixed(2)} ${height} Z`
    : '';

  // Baseline dash sits at min(data). Only drawn on large canvases —
  // it would just be noise on the 60×16 widget.
  const showBaseline = isLarge && !flat && points.length > 1;
  const baselineY = showBaseline ? height - 1 : 0;

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="sparkline"
    >
      <defs>
        {/* Stroke gradient — horizontal so the line tilts from the
            accent colour into a paler highlight as it travels right. */}
        <linearGradient id={lineGradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>

        {/* Area fill — vertical fade so the curve "drops" into the
            backdrop instead of sitting on it. */}
        <linearGradient id={fillGradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
          <stop offset="65%" stopColor="currentColor" stopOpacity="0.06" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>

        {/* Soft glow — keeps `userSpaceOnUse` so the blur radius is in
            screen pixels regardless of the viewBox aspect. */}
        <filter
          id={glowId}
          x="-10%"
          y="-30%"
          width="120%"
          height="160%"
          filterUnits="userSpaceOnUse"
        >
          <feGaussianBlur stdDeviation={glowStdDev} result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Baseline dash — anchors the eye on large canvases. */}
      {showBaseline && (
        <line
          x1={0}
          x2={width}
          y1={baselineY}
          y2={baselineY}
          stroke="currentColor"
          strokeOpacity={0.12}
          strokeWidth={1}
          strokeDasharray="2 4"
        />
      )}

      {fill && path && !flat && (
        <path d={areaPath} fill={`url(#${fillGradId})`} stroke="none" />
      )}

      {path && (
        <path
          d={path}
          fill="none"
          stroke={`url(#${lineGradId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={isLarge ? `url(#${glowId})` : undefined}
        />
      )}

      {/* Trailing-edge dot + halo for "you are here". Skip on flat
          datasets — there's no movement to highlight. */}
      {isLarge && lastPoint && !flat && (
        <>
          <circle
            cx={lastPoint[0]}
            cy={lastPoint[1]}
            r={haloRadius}
            fill="currentColor"
            opacity={0.18}
          />
          <circle
            cx={lastPoint[0]}
            cy={lastPoint[1]}
            r={dotRadius}
            fill="currentColor"
          />
        </>
      )}
    </svg>
  );
}
