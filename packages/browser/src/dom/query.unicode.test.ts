/**
 * The same text, written two legal ways, did not match itself.
 *
 * Unicode lets `café` be one code point (`é`, NFC) or two (`e` + a combining acute, NFD). They render
 * identically, they are canonically equivalent, and JavaScript string comparison says they are
 * different — so a query typed one way against a DOM holding the other found nothing.
 *
 * That is a false RED, which is the failure this product exists to prevent: the agent asserts text
 * that is visibly on the screen, is told the element is not there, and reports a working app as
 * broken. It cannot happen in English, which is why nobody hit it here; it is ordinary in French,
 * Vietnamese and Korean, and NFD is what macOS filesystems, several IMEs and some databases hand
 * back.
 *
 * Normalising both sides to NFC can only ever ADD matches: two strings that were equal before are
 * still equal after, because normalisation is idempotent and canonical-equivalence-preserving. So
 * nothing that matched can stop matching — the reason this is safe to do on the matching core.
 *
 * Scoped to the queries that match USER-VISIBLE text. A testid is an attribute the developer typed
 * on both sides and a component name is an identifier; normalising those would be changing what an
 * exact match means, for no case anyone has.
 */

import { describe, expect, it } from 'vitest';
import { runQuery } from './query.js';

/** `café`, one code point for the é. */
const NFC = 'café';
/** `café`, `e` followed by a combining acute. Renders identically. */
const NFD = 'café';
/** `한`, composed. */
const HANGUL_NFC = '한';
/** `한`, decomposed into its jamo. */
const HANGUL_NFD = '한';

const hits = (query: Parameters<typeof runQuery>[0]): number =>
  runQuery(query)?.elements?.length ?? 0;

describe('text queries match across unicode normalisation forms', () => {
  it('finds NFD text with an NFC query', () => {
    document.body.innerHTML = `<button>${NFD}</button>`;
    expect(hits({ text: NFC })).toBe(1);
  });

  it('finds NFC text with an NFD query', () => {
    document.body.innerHTML = `<button>${NFC}</button>`;
    expect(hits({ text: NFD })).toBe(1);
  });

  it('does the same for hangul, where the two forms differ in length', () => {
    document.body.innerHTML = `<button>${HANGUL_NFD}</button>`;
    expect(hits({ text: HANGUL_NFC })).toBe(1);
  });

  it('and for the by/value spelling of the same query', () => {
    document.body.innerHTML = `<button>${NFD}</button>`;
    expect(hits({ by: 'text', value: NFC })).toBe(1);
  });

  it('covers the other user-visible text queries', () => {
    document.body.innerHTML =
      `<label for="a">${NFD}</label><input id="a" placeholder="${NFD}" />` +
      `<img alt="${NFD}" src="x" />`;
    expect(hits({ label: NFC }), 'label').toBe(1);
    expect(hits({ placeholder: NFC }), 'placeholder').toBe(1);
    expect(hits({ alt: NFC }), 'alt').toBe(1);
  });

  /**
   * The property that makes this safe: normalising cannot remove a match. Same-form matching is the
   * overwhelmingly common case and must be untouched.
   */
  it('still matches when both sides are already the same form', () => {
    document.body.innerHTML = `<button>${NFC}</button>`;
    expect(hits({ text: NFC })).toBe(1);
    document.body.innerHTML = `<button>Save</button>`;
    expect(hits({ text: 'Save' })).toBe(1);
  });

  it('does not start matching text that is genuinely different', () => {
    document.body.innerHTML = `<button>${NFC}</button>`;
    expect(hits({ text: 'cafe' }), 'an unaccented e is a different word, not a form').toBe(0);
    expect(hits({ text: 'tea' })).toBe(0);
  });

  /**
   * A testid is an attribute the developer typed on both sides, not rendered prose. Leaving it exact
   * is deliberate — normalising it would quietly change what an exact attribute match means.
   */
  it('leaves testid matching exact', () => {
    document.body.innerHTML = `<button data-testid="${NFD}">x</button>`;
    expect(hits({ testid: NFC })).toBe(0);
  });

  /**
   * The deliberate limit, pinned so nobody widens it casually.
   *
   * NFC is a CANONICAL fold: it only unifies sequences that are the same character written
   * differently. NFKC is a COMPATIBILITY fold, and it would also make `１` match `1`, `²` match `2`
   * and a ligature match its letters — strings that are genuinely different text that happens to
   * look related.
   *
   * That direction is the dangerous one. Failing to match text that is on screen is a false red and
   * costs a wasted investigation; matching text that is NOT what was asked for is a false green, and
   * this codebase does not buy those. So a fullwidth digit does not match an ASCII one, and the
   * remedy for a CJK app is to query what the page actually renders.
   *
   * If this is ever revisited, the question to answer first is what a compatibility fold would make
   * match that should not — not whether it would fix this case, which it obviously would.
   */
  it('does NOT apply a compatibility fold — fullwidth is different text, not a different form', () => {
    document.body.innerHTML = `<button>Page \uFF11</button>`;
    expect(hits({ text: 'Page 1' })).toBe(0);
    expect(hits({ text: 'Page \uFF11' }), 'querying what the page renders still works').toBe(1);
  });
});
