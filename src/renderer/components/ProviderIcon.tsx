// ProviderIcon — colored AI provider brand marks.
//
// Renders the official brand SVGs shipped in `@lobehub/icons-static-svg`
// (color variants where available) instead of hand-extracted mono paths.
// Inline embedding via `dangerouslySetInnerHTML` keeps gradients, masks,
// and filters intact, so the icons look identical to upstream.
//
// The wrapper sets `font-size: ${size}px` and the inner SVG uses
// `width=1em`/`height=1em`, so a single prop controls both the box
// and the glyph dimensions.

import { getProviderIconSvg } from '../lib/provider-icons';

interface ProviderIconProps {
  provider: string;
  /** Pixel size of the rendered glyph. Defaults to 18px. */
  size?: number;
}

export function ProviderIcon({ provider, size = 18 }: ProviderIconProps): JSX.Element {
  const svg = getProviderIconSvg(provider);
  const dataProvider = provider.trim().toLowerCase();

  // Fallback: a generic AI dot in `currentColor` if the provider is unknown.
  if (svg === null) {
    return (
      <span
        className="provider-icon provider-icon--fallback"
        style={{ fontSize: `${size}px`, width: `${size}px`, height: `${size}px` }}
        aria-label={provider}
        data-provider={dataProvider}
        role="img"
      >
        <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="4" />
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
        </svg>
      </span>
    );
  }

  return (
    <span
      className="provider-icon"
      style={{ fontSize: `${size}px`, width: `${size}px`, height: `${size}px` }}
      aria-label={provider}
      data-provider={dataProvider}
      role="img"
      // The SVG markup ships with the package and is not user-supplied.
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
