import type { ElementQuery } from '@reticlehq/core';
import { parentAcrossShadowBoundary } from './shadow-registry.js';
import { stalledFade } from './visibility.js';

/**
 * Match user-visible prose the way the public query API has always promised: trim and collapse
 * whitespace, compare canonically equivalent Unicode in NFC, and keep fuzzy text queries
 * case-insensitive. Attribute identifiers such as testid stay exact and do not pass through here.
 */
export function normaliseVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().normalize('NFC');
}

/** Typographic quotes and dashes, and the plain character each one compares as. */
/** ‘ ’, and the low and reversed forms ‚ ‛ that German and other languages open a quote with. */
const SINGLE_QUOTES = /[\u2018-\u201b]/g;
/** “ ”, and the low and reversed forms „ ‟. */
const DOUBLE_QUOTES = /[\u201c-\u201f]/g;
const DASHES = /[\u2013\u2014]/g;

/**
 * Typographic quotes and dashes as their plain forms. A page shows "It’s saved" and a check is
 * typed as "It's saved": the text is on the screen, so a `no` would report a defect that does not
 * exist. One character for one character, so an index into the result is an index into the input.
 */
export function foldTypography(value: string): string {
  return value.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(DASHES, '-');
}

/**
 * Format characters that the screen does not paint: the soft hyphen, zero-width space and joiners,
 * direction marks and embeddings, the word joiner and invisible operators, bidi isolates, and the
 * byte order mark. i18n formatters wrap a value in isolates, so "$4,449" on the screen was
 * "$\u20684,449\u2069" in the text, and a check for "$4,449" read `no`. Named one by one, not as
 * the whole `Cf` category, because that category also holds visible Arabic number signs.
 */
const INVISIBLE_FORMAT = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Visible text in the form two texts are compared in. For comparison only: text that a caller
 * reads keeps the page's own characters (`normaliseVisibleText`).
 */
export function comparableText(value: string): string {
  return foldTypography(normaliseVisibleText(value.replace(INVISIBLE_FORMAT, '')));
}

export function fuzzyVisibleText(actual: string, expected: string): boolean {
  return comparableText(actual).toLowerCase().includes(comparableText(expected).toLowerCase());
}

/** The text rule a query asked for: case-exact when it is a check, forgiving when it is a search. */
export function textMatches(actual: string, query: ElementQuery, expected: string): boolean {
  if (true !== query.matchCase) {
    return fuzzyVisibleText(actual, expected);
  }
  return comparableText(actual).includes(comparableText(expected));
}

export function exactVisibleText(actual: string, expected: string): boolean {
  return comparableText(actual) === comparableText(expected);
}

/** The CSS `text-transform` values that change case, and what each paints. */
const CASE_TRANSFORMS: Readonly<Record<string, (text: string) => string>> = {
  uppercase: (text) => text.toUpperCase(),
  lowercase: (text) => text.toLowerCase(),
  // ponytail: first letter after a space; a browser also capitalizes after some punctuation.
  capitalize: (text) =>
    text.replace(/(^|\s)(\p{L})/gu, (_, gap: string, c: string) => gap + c.toUpperCase()),
};

/** `text` in the case the screen paints it on `el`, or undefined when CSS does not change it. */
export function paintedCase(el: Element, text: string): string | undefined {
  const transform = el.ownerDocument.defaultView?.getComputedStyle(el).textTransform ?? '';
  return CASE_TRANSFORMS[transform]?.(text);
}

/**
 * Below this WCAG contrast ratio a person cannot practically see the text. It is NOT the WCAG AA
 * limit (4.5:1): text at 2:1 is hard to read but readable, and calling it missing is a false red.
 */
export const UNREADABLE_CONTRAST = 1.5;

/** Below this composed opacity the text is practically not painted. */
export const UNREADABLE_OPACITY = 0.05;

type Rgba = readonly [number, number, number, number];

/** The canvas colour of a document with no background of its own: white. */
const CANVAS: Rgba = [255, 255, 255, 1];

/** An `rgb()` or `rgba()` computed colour. Any other colour space is undefined: not judged. */
function parseRgb(value: string): Rgba | undefined {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(value);
  if (null === m) {
    return undefined;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/** `top` painted over the opaque colour `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  const mix = (t: number, u: number): number => t * a + u * (1 - a);
  return [mix(top[0], under[0]), mix(top[1], under[1]), mix(top[2], under[2]), 1];
}

/** WCAG relative luminance of one 0-255 channel. */
function linear(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgba): number {
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function show(c: Rgba): string {
  return `rgb(${[c[0], c[1], c[2]].map((v) => String(Math.round(v))).join(', ')})`;
}

/** A shadow or a stroke can make text readable in the background colour, so it is not judged. */
function outlined(style: CSSStyleDeclaration): boolean {
  const stroke = Number.parseFloat(style.getPropertyValue('-webkit-text-stroke-width'));
  return /\dpx/.test(style.textShadow) || stroke > 0;
}

/** `el` and every ancestor, across shadow boundaries. */
function* selfAndAncestors(el: Element): Generator<Element> {
  for (let node: Element | null = el; null !== node; node = parentAcrossShadowBoundary(node)) {
    yield node;
  }
}

/**
 * The elements painted at the centre of `el`, from `el` down to the page, or undefined.
 *
 * Undefined when the page has no hit test (jsdom), `el` has no box, or the hit test does not reach
 * `el` (another element covers it, `pointer-events: none`, or it is off screen). The caller then
 * reads the ancestors.
 */
function paintedUnder(el: Element): Element[] | undefined {
  const root = el.getRootNode() as Partial<DocumentOrShadowRoot>;
  if (typeof root.elementsFromPoint !== 'function') {
    return undefined;
  }
  const box = el.getBoundingClientRect();
  if (0 === box.width || 0 === box.height) {
    return undefined;
  }
  const stack = root.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const at = stack.indexOf(el);
  return at < 0 ? undefined : stack.slice(at);
}

/**
 * The `background-color` of `layers`, top first, composed until the first opaque one over a white
 * canvas. Undefined when a layer has a background image or gradient, or a colour that is not rgb.
 */
function backgroundOf(layers: Iterable<Element>, view: Window): Rgba | undefined {
  const fills: Rgba[] = [];
  for (const node of layers) {
    const style = view.getComputedStyle(node);
    if ('' !== style.backgroundImage && 'none' !== style.backgroundImage) {
      return undefined;
    }
    const fill = parseRgb(style.backgroundColor);
    if (fill === undefined) {
      return undefined;
    }
    if (fill[3] > 0) {
      fills.push(fill);
    }
    if (fill[3] >= 1) {
      break;
    }
  }
  return fills.reduceRight((under, top) => over(top, under), CANVAS);
}

/**
 * Why a person cannot read the text on `el`, or undefined when they can or it cannot be judged.
 *
 * The background is read from the elements painted under the centre of the text (#2297), so a
 * positioned panel behind the text counts. Without a hit test it is read from the ancestors.
 */
export function unreadableText(el: Element): string | undefined {
  const view = el.ownerDocument.defaultView;
  if (null === view) {
    return undefined;
  }
  const own = view.getComputedStyle(el);
  const ink = parseRgb(own.color);
  if (ink === undefined || outlined(own)) {
    return undefined;
  }
  const back = backgroundOf(paintedUnder(el) ?? selfAndAncestors(el), view);
  if (back === undefined) {
    return undefined;
  }
  let opacity = 1;
  for (const node of selfAndAncestors(el)) {
    // A fade stalled by a hidden tab is not the app's opacity: visibility reads it as shown (#793).
    const alpha = stalledFade(node) ? 1 : Number.parseFloat(view.getComputedStyle(node).opacity);
    opacity *= Number.isNaN(alpha) ? 1 : alpha;
  }
  if (opacity < UNREADABLE_OPACITY) {
    return `the composed opacity is ${opacity.toFixed(2)}`;
  }
  const painted = over(ink, back);
  const ratio = contrast(painted, back);
  if (ratio >= UNREADABLE_CONTRAST) {
    return undefined;
  }
  return `text ${show(painted)} on ${show(back)}: contrast ${ratio.toFixed(2)}:1`;
}

/** Why no match can be read, or undefined when one of them can or one cannot be judged. */
export function unreadableMatch(matches: readonly Element[]): string | undefined {
  const reasons = matches.map(unreadableText);
  return reasons.length > 0 && reasons.every((r) => r !== undefined) ? reasons[0] : undefined;
}
