import type { ElementQuery } from '@reticlehq/core';

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
  if (true !== query.matchCase) return fuzzyVisibleText(actual, expected);
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
