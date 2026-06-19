/**
 * Design-token (theme) awareness — the in-source answer to "is this color on-theme?". A DOM/a11y
 * tool sees a color rendered; it does not know the app's INTENDED palette. Iris reads the design
 * tokens the app declares as `:root` CSS custom properties and reports, per element, whether its
 * color/background maps to a token or is an off-palette hardcoded value. That is a theme-compliance
 * signal no outside-the-page tool has without re-deriving the palette itself.
 *
 * Conservative by design: only a SET, opaque color with no matching token is flagged off-theme, and
 * the matched token name is returned when there is one — so the agent can judge, not just trust a flag.
 */

interface ThemePalette {
  /** canonical "rgb(r, g, b)" → token name (e.g. "--accent"). */
  byColor: Map<string, string>;
}

let cached: ThemePalette | null = null;

/** Resolve any CSS color string to canonical computed `rgb(...)`/`rgba(...)`, or null if not a color. */
function toRgb(value: string): string | null {
  if (value.length === 0) return null;
  const probe = document.createElement('span');
  probe.style.color = '';
  probe.style.color = value; // invalid colors leave it empty (the setter rejects them)
  if (probe.style.color === '') return null;
  probe.style.position = 'absolute';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}

/** Collect `--token: value` declarations from every :root/html rule across the app's stylesheets. */
function collectTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules; // cross-origin sheets throw — skip them
    } catch {
      continue;
    }
    if (rules === null) continue;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!/(^|,)\s*(:root|html)\b/.test(rule.selectorText)) continue;
      for (const prop of Array.from(rule.style)) {
        if (prop.startsWith('--')) out[prop] = rule.style.getPropertyValue(prop).trim();
      }
    }
  }
  return out;
}

/** The app's palette (color tokens → rgb), built once and cached (theme rarely changes at runtime). */
function palette(): ThemePalette {
  if (cached !== null) return cached;
  const byColor = new Map<string, string>();
  for (const [name, value] of Object.entries(collectTokens())) {
    const rgb = toRgb(value);
    if (rgb !== null && !byColor.has(rgb)) byColor.set(rgb, name);
  }
  cached = { byColor };
  return cached;
}

/** True for a color that carries no visual weight (fully transparent) — never flagged off-theme. */
function isTransparent(rgb: string): boolean {
  return rgb === 'rgba(0, 0, 0, 0)' || rgb === 'transparent';
}

export interface ThemeReport {
  /** Matched design-token name for the text color, or null when the color is off-palette. */
  colorToken: string | null;
  /** Matched design-token name for the background color, or null. */
  backgroundToken: string | null;
  /** True when a set, opaque color uses no design token — a theme violation worth surfacing. */
  offTheme: boolean;
  /** How many color tokens the app declared (0 ⇒ no palette found, so offTheme is never asserted). */
  tokenCount: number;
}

/** Report an element's theme compliance from its computed style. */
export function themeReport(cs: CSSStyleDeclaration): ThemeReport {
  const p = palette();
  const colorToken = p.byColor.get(cs.color) ?? null;
  const backgroundToken = p.byColor.get(cs.backgroundColor) ?? null;
  const colorOff = !isTransparent(cs.color) && colorToken === null;
  const bgOff = !isTransparent(cs.backgroundColor) && backgroundToken === null;
  return {
    colorToken,
    backgroundToken,
    // Only meaningful when a palette exists; an app with no tokens can't violate one.
    offTheme: p.byColor.size > 0 && (colorOff || bgOff),
    tokenCount: p.byColor.size,
  };
}

/** Drop the cached palette (call if the app swaps themes at runtime). */
export function resetThemeCache(): void {
  cached = null;
}
