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
}

/** SVG intrinsic dimensions (matches design spec: 60×16). */
const WIDTH = 60;
const HEIGHT = 16;

/**
 * Build the SVG `points` attribute value. Each sample maps to one
 * x-pixel; y is normalized linearly so that the minimum value sits
 * at the bottom and maximum at the top (with a 1 px pad so the
 * stroke doesn't clip at the edges).
 */
function buildPoints(data: number[]): string {
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
  const usableHeight = HEIGHT - pad * 2;

  const points: string[] = [];
  const xStep = data.length > 1 ? (WIDTH - 1) / (data.length - 1) : 0;

  for (let i = 0; i < data.length; i++) {
    const x = i * xStep;
    // Invert y: SVG y=0 is top, we want high values at the top.
    const y = pad + usableHeight - ((data[i]! - min) / range) * usableHeight;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  return points.join(' ');
}

export function Sparkline({ data }: SparklineProps): JSX.Element {
  const points = buildPoints(data);

  return (
    <svg
      className="sparkline"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      data-testid="sparkline"
    >
      {points && (
        <polyline
          points={points}
          fill="none"
          stroke="rgba(245, 245, 247, 0.6)"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
