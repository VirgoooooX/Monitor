// Sparkline — a minimal 60×16 SVG polyline for latency history.
//
// Renders the last ≤60 latency samples from the in-memory ring buffer
// as a simple line chart. The y-axis is auto-scaled to the min/max of
// the current data window so the line always fills the available
// vertical space.
//
// References:
//   • design.md §Window Strategy (60×16 SVG polyline)
//   • design.md §Performance Considerations (in-memory ring buffer)
//   • PLAN.md §UI Implementation Guide

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
 * Build the SVG `points` attribute value. Each sample maps to one
 * x-pixel; y is normalized linearly so that the minimum value sits
 * at the bottom and maximum at the top (with a 1 px pad so the
 * stroke doesn't clip at the edges).
 */
function buildPoints(data: number[], width: number, height: number): string {
  if (data.length === 0) return '';

  let min = data[0]!;
  let max = data[0]!;
  for (let i = 1; i < data.length; i++) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const range = max - min || 1; // avoid division by zero when all values equal
  const pad = 1;
  const usableHeight = height - pad * 2;

  const points: string[] = [];
  const xStep = data.length > 1 ? (width - 1) / (data.length - 1) : 0;

  for (let i = 0; i < data.length; i++) {
    const x = i * xStep;
    // Invert y: SVG y=0 is top, we want high values at the top.
    const y = pad + usableHeight - ((data[i]! - min) / range) * usableHeight;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  return points.join(' ');
}

export function Sparkline({
  data,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  strokeWidth = 1.2,
  fill = false,
}: SparklineProps): JSX.Element {
  const points = buildPoints(data, width, height);
  // For the area fill we close the polyline back to the bottom corners.
  const areaPoints = points
    ? `0,${height} ${points} ${width},${height}`
    : '';
  const gradId = `sparkline-grad-${width}x${height}`;

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
      {fill && points && (
        <>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(165, 180, 252, 0.45)" />
              <stop offset="100%" stopColor="rgba(165, 180, 252, 0)" />
            </linearGradient>
          </defs>
          <polygon points={areaPoints} fill={`url(#${gradId})`} />
        </>
      )}
      {points && (
        <polyline
          points={points}
          fill="none"
          stroke="rgba(245, 245, 247, 0.7)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
