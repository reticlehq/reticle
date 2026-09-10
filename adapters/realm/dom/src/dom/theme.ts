/**
 * Design-token (theme) awareness — the in-source answer to "is this color on-theme?". A DOM/a11y
 * tool sees a color rendered; it does not know the app's INTENDED palette. Reticle reads the design
 * tokens the app declares as CSS custom properties, resolves them AS THE PAGE CURRENTLY RENDERS
 * THEM, and reports, per element, which tokens its color/background map to or whether the value is
 * an off-palette hardcoded one. That is a theme-compliance signal no outside-the-page tool has
 * without re-deriving the palette itself.
 *
 * Conservative by design: only a SET, opaque color with no matching token is flagged off-theme, and
 * every matching token name is returned — so the agent can judge, not just trust a flag.
 *
 * Two defects made this field untrustworthy in BOTH directions before it was rewritten:
 *   - the reverse map was color → ONE name, first writer wins, so a button styled with a brand token
 *     was told its background was a focus-border token because the two resolve to the same hex. The
 *     name is the part an agent reasons about, and it was arbitrary among the candidates.
 *   - the palette was built from the RAW `:root` declaration text and cached for the page lifetime,
 *     on the reasoning that a theme rarely changes at runtime. A human toggling the theme between
 *     two inspect calls left every lookup keyed on the previous theme's colors, so a `<summary>` that
 *     had just been changed to a text token reported a surface token. The reporter read that as their
 *     edit not applying and went hunting for a theme-scope bug that did not exist.
 * Hence: no cache, values resolved through `getComputedStyle` so the active theme wins, and the
 * scope that was active at capture time reported alongside, so two results minutes apart are
 * comparable at all.
 */

/** Attribute an app flips to switch themes, reported as part of the scope so results are comparable. */
const THEME_ATTRIBUTE = 'data-theme';

/** Collect every custom-property NAME the app declares, in any rule. */
function tokenNames(): Set<string> {
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules; // cross-origin sheets throw — skip them
    } catch {
      continue;
    }
    if (null === rules) continue;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      // Deliberately NOT filtered to `:root`/`html`: a theme block is usually `.dark` or
      // `[data-theme="dark"]`, and an app that declares its palette only there had no palette at all
      // under the old filter. Names are cheap; a name that is not in scope resolves to nothing below
      // and is dropped, so widening collection cannot invent a token.
      for (const prop of Array.from(rule.style)) {
        if (prop.startsWith('--')) names.add(prop);
      }
    }
  }
  return names;
}

/**
 * The palette as the page renders it right now: canonical `rgb(...)` → every token with that color.
 *
 * Resolved against `document.body` rather than the raw declaration text, because custom properties
 * inherit: this picks up a theme scoped to `<html>` or to `<body>`, and picks up the value the
 * ACTIVE theme block won with rather than whichever block the stylesheet happened to list first.
 */
function palette(): Map<string, string[]> {
  const byColor = new Map<string, string[]>();
  const root = document.body ?? document.documentElement;
  if (null === root) return byColor;
  const rootStyle = getComputedStyle(root);
  // One shared probe for the whole build. There is no cache any more, so this runs per inspect, and
  // a span per token would be a few hundred appends on a real design system.
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);
  try {
    for (const name of tokenNames()) {
      const rgb = toRgb(probe, rootStyle.getPropertyValue(name).trim());
      if (null === rgb) continue;
      const named = byColor.get(rgb);
      if (named === undefined) byColor.set(rgb, [name]);
      else named.push(name);
    }
  } finally {
    probe.remove();
  }
  // Sorted so the reported order is a property of the app's tokens, not of stylesheet iteration
  // order — the same collision must read the same way on two consecutive inspects.
  for (const named of byColor.values()) named.sort();
  return byColor;
}

/** Resolve any CSS color string to canonical computed `rgb...)`/`rgba...)`, or null if not a color. */
function toRgb(probe: HTMLElement, value: string): string | null {
  if (0 === value.length) return null;
  probe.style.color = '';
  probe.style.color = value; // invalid colors leave it empty (the setter rejects them)
  if ('' === probe.style.color) return null;
  return getComputedStyle(probe).color;
}

/** True for a color that carries no visual weight (fully transparent) — never flagged off-theme. */
function isTransparent(rgb: string): boolean {
  return 'rgba(0, 0, 0, 0)' === rgb || 'transparent' === rgb;
}

/**
 * The theme scope in force at capture time, as a selector-shaped string (`.dark[data-theme="dark"]`),
 * or null when the root carries no theme marker at all.
 */
function themeScope(): string | null {
  const el = document.documentElement;
  if (null === el) return null;
  const classes = Array.from(el.classList)
    .map((c) => `.${c}`)
    .join('');
  const attr = el.getAttribute(THEME_ATTRIBUTE);
  const scope = `${classes}${null === attr ? '' : `[${THEME_ATTRIBUTE}="${attr}"]`}`;
  return 0 === scope.length ? null : scope;
}

interface ThemeReport {
  /**
   * The ONE design token matching the text color, or null. Null both when nothing matches and when
   * several tokens share the color: the previous behaviour picked an arbitrary winner and the caller
   * could not tell, which is the whole defect. Read `colorTokens` for the full answer; this field
   * stays for callers that only ever wanted the unambiguous case.
   */
  colorToken: string | null;
  /** Every design token whose resolved value is the text color. Empty when the color is off-palette. */
  colorTokens: string[];
  /** The one design token matching the background color, or null (same abstain-on-tie rule). */
  backgroundToken: string | null;
  /** Every design token whose resolved value is the background color. */
  backgroundTokens: string[];
  /** True when a set, opaque color matches NO design token — a theme violation worth surfacing. */
  offTheme: boolean;
  /** How many color tokens resolved under the active theme (0 ⇒ offTheme is never asserted). */
  tokenCount: number;
  /** Theme scope active at capture time, e.g. `.dark`, so two results taken apart are comparable. */
  themeScope: string | null;
}

/** The unambiguous match, or null when the palette cannot tell the candidates apart. */
function sole(names: string[]): string | null {
  return 1 === names.length ? (names[0] ?? null) : null;
}

/** Report an element's theme compliance from its computed style. */
export function themeReport(cs: CSSStyleDeclaration): ThemeReport {
  const byColor = palette();
  const colorTokens = byColor.get(cs.color) ?? [];
  const backgroundTokens = byColor.get(cs.backgroundColor) ?? [];
  const colorOff = !isTransparent(cs.color) && 0 === colorTokens.length;
  const bgOff = !isTransparent(cs.backgroundColor) && 0 === backgroundTokens.length;
  let tokenCount = 0;
  for (const named of byColor.values()) tokenCount += named.length;
  return {
    colorToken: sole(colorTokens),
    colorTokens,
    backgroundToken: sole(backgroundTokens),
    backgroundTokens,
    // Only meaningful when a palette exists; an app with no tokens can't violate one.
    offTheme: tokenCount > 0 && (colorOff || bgOff),
    tokenCount,
    themeScope: themeScope(),
  };
}
