// Placeholder substitution for the i18n-multilingual-support feature.
//
// `applyParams` resolves `{name}` placeholders inside a template string
// using values from the supplied `params` object. The grammar of a
// placeholder is the regex `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g` (per
// design.md §Components and Interfaces → format.ts and Requirement 9.4):
//
//   - The first character of the name MUST be ASCII letter or underscore.
//   - Subsequent characters MUST be ASCII letter, digit, or underscore.
//
// Any substring matching that grammar but whose `name` is NOT an own
// enumerable property of `params` is left verbatim (Requirement 9.4).
//
// Substitution uses `String(value)` so primitives, `null`, `undefined`,
// objects, arrays, and functions all round-trip safely (Requirement
// 9.5, 9.6). Symbols are the documented edge case: per the design, the
// `String()` coercion is wrapped in try/catch so the function never
// throws, even when a caller leaks a `symbol` past the declared
// `Record<string, string | number | boolean | null | undefined>` type.
// On catch, the placeholder is left verbatim so the surrounding string
// is still renderable.
//
// Contract: this function MUST NEVER throw — it is invoked from
// Translation_Function (`t`) which itself MUST NOT throw under
// Requirement 9.3.

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function applyParams(
  template: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      // Requirement 9.4 — placeholder whose key is not present is left verbatim.
      return whole;
    }
    try {
      // Requirement 9.5, 9.6 — `String(value)` for primitives and non-primitives alike.
      return String((params as Record<string, unknown>)[name]);
    } catch {
      // Symbol values throw on `String()` coercion in some engines; the
      // function MUST NOT propagate. Fall back to the verbatim placeholder.
      return whole;
    }
  });
}
