// Provider icon registry — official colored brand SVGs.
//
// Sources the `*-color.svg` variants from `@lobehub/icons-static-svg`
// (a real, hand-tuned brand asset library). Falls back to the
// monochrome `*.svg` for providers that don't ship a color version.
//
// Imported via Vite's `?raw` query so we get the SVG markup as a
// string and can render it inline via `dangerouslySetInnerHTML`.
// Each SVG is sized using its native `width="1em"` / `height="1em"`
// attributes — set `font-size` on the wrapper to control the size.
//
// Provider keys are normalized to lowercase to match the values
// emitted by usage / quota collectors (see `KNOWN_PROVIDERS` in
// `src/main/services/usage.service.ts`).

import codexColor from '@lobehub/icons-static-svg/icons/codex-color.svg?raw';
import geminiColor from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import claudeColor from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import deepseekColor from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import antigravityColor from '@lobehub/icons-static-svg/icons/antigravity-color.svg?raw';
import copilotColor from '@lobehub/icons-static-svg/icons/copilot-color.svg?raw';
import kimiColor from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw';
import mistralColor from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';

// No color variant available — fall back to the brand-mono mark.
import opencodeMono from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import openaiMono from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import cursorMono from '@lobehub/icons-static-svg/icons/cursor.svg?raw';
import groqMono from '@lobehub/icons-static-svg/icons/groq.svg?raw';
import openrouterMono from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Per-provider SVG markup. Look up by lowercase provider key.
 *
 * Aliases (e.g. `copilot` ↔ `githubcopilot`) point at the same string
 * so all spelling variants resolve to the same icon.
 */
export const PROVIDER_ICON_SVG: Record<string, string> = {
  codex: codexColor,
  gemini: geminiColor,
  claude: claudeColor,
  anthropic: claudeColor,
  deepseek: deepseekColor,
  antigravity: antigravityColor,
  copilot: copilotColor,
  githubcopilot: copilotColor,
  'github-copilot': copilotColor,
  kimi: kimiColor,
  mistral: mistralColor,

  opencode: opencodeMono,
  openai: openaiMono,
  cursor: cursorMono,
  groq: groqMono,
  openrouter: openrouterMono,
};

/**
 * Returns the SVG markup for the given provider, or `null` if no icon
 * is registered. Caller is responsible for embedding the markup safely
 * (these strings come from a trusted package, not user input).
 */
export function getProviderIconSvg(provider: string): string | null {
  const key = provider.trim().toLowerCase();
  return PROVIDER_ICON_SVG[key] ?? null;
}
