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
const SINGLE_QUOTES = /[\u2018\u2019]/g;
const DOUBLE_QUOTES = /[\u201c\u201d]/g;
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
 * Visible text in the form two texts are compared in. For comparison only: text that a caller
 * reads keeps the page's own characters (`normaliseVisibleText`).
 */
export function comparableText(value: string): string {
  return foldTypography(normaliseVisibleText(value));
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

/**
 * Why a person cannot read the text on `el`, or undefined when they can or it cannot be judged.
 *
 * The background is the ancestors' `background-color`, composed until the first opaque one, over a
 * white canvas. A background image or gradient on that walk is not judged.
 * ponytail: ancestors only. A positioned element painted behind the text is not seen; a hit-test
 * (`elementsFromPoint`) is the upgrade if that gives a false red.
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
  let opacity = 1;
  const layers: Rgba[] = [];
  let opaque = false;
  for (let node: Element | null = el; null !== node; node = parentAcrossShadowBoundary(node)) {
    const style = view.getComputedStyle(node);
    // A fade stalled by a hidden tab is not the app's opacity: visibility reads it as shown (#793).
    const alpha = stalledFade(node) ? 1 : Number.parseFloat(style.opacity);
    opacity *= Number.isNaN(alpha) ? 1 : alpha;
    if (opaque) {
      continue;
    }
    if ('' !== style.backgroundImage && 'none' !== style.backgroundImage) {
      return undefined;
    }
    const fill = parseRgb(style.backgroundColor);
    if (fill === undefined) {
      return undefined;
    }
    if (fill[3] > 0) {
      layers.push(fill);
    }
    opaque = fill[3] >= 1;
  }
  if (opacity < UNREADABLE_OPACITY) {
    return `the composed opacity is ${opacity.toFixed(2)}`;
  }
  const back = layers.reduceRight((under, top) => over(top, under), CANVAS);
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
