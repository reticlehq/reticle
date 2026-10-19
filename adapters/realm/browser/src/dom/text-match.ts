import type { ElementQuery } from '@reticlehq/core';

/**
 * Match user-visible prose the way the public query API has always promised: trim and collapse
 * whitespace, compare canonically equivalent Unicode in NFC, and keep fuzzy text queries
 * case-insensitive. Attribute identifiers such as testid stay exact and do not pass through here.
 */
export function normaliseVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().normalize('NFC');
}

export function fuzzyVisibleText(actual: string, expected: string): boolean {
  return normaliseVisibleText(actual)
    .toLowerCase()
    .includes(normaliseVisibleText(expected).toLowerCase());
}

/** The text rule a query asked for: case-exact when it is a check, forgiving when it is a search. */
export function textMatches(actual: string, query: ElementQuery, expected: string): boolean {
  if (true !== query.matchCase) return fuzzyVisibleText(actual, expected);
  return normaliseVisibleText(actual).includes(normaliseVisibleText(expected));
}

export function exactVisibleText(actual: string, expected: string): boolean {
  return normaliseVisibleText(actual) === normaliseVisibleText(expected);
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
