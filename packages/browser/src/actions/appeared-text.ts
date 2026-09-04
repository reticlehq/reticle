import { isIgnored } from '../dom/dom-ignore.js';

/** Cap on the reported text. Enough for an error message, far short of a re-rendered page. */
const APPEARED_MAX = 200;

/** Separator between distinct fragments that appeared in the same window. */
const JOIN = ' | ';

const TEXT_NODE = 3;

/**
 * Any letter, in any script — Latin, Cyrillic, CJK, Arabic.
 *
 * Built from a string, not a literal: a `/\p{L}/u` literal is ES2018 syntax, and tsc never
 * downlevels regex bodies, so the literal would ride the lowered target straight into dist and
 * break webpack 4 parsing (issue #680). Construction from a string parses under any grammar;
 * engines without unicode property escapes take the range fallback instead of throwing. The
 * fallback covers the letter blocks the product's locales need (Latin, Greek, Cyrillic,
 * Armenian, Hebrew, Arabic, Thai, Georgian, Hiragana, Katakana, CJK, Hangul); scripts still
 * outside it behave as letterless on those engines only, where the previous bundle did not parse
 * at all. Any astral-plane character (a surrogate pair, \uD800-\uDBFF followed by
 * \uDC00-\uDFFF) counts as a letter too: matching a supplementary-plane symbol that is not a
 * letter (rare outside emoji) is the same over-inclusive direction saysSomething already takes
 * everywhere else — a false "this counts as a message" costs less than silently dropping real
 * feedback in a script this fallback has no range for.
 */
/**
 * The range fallback, exported separately so a test can exercise it directly — on every engine
 * this suite runs on, `\p{L}` is supported, so `HAS_LETTER` below never takes this branch and a
 * test written against `HAS_LETTER` alone would never prove these ranges actually work.
 */
export const HAS_LETTER_FALLBACK: RegExp = new RegExp(
  '[A-Za-zªµºÀ-ÖØ-öø-ʯ' +
    '\\u0370-\\u0373\\u0376-\\u0377\\u037B-\\u037D\\u037F\\u0386\\u0388-\\u038A\\u038C' +
    '\\u038E-\\u03A1\\u03A3-\\u03F5\\u03F7-\\u0481\\u048A-\\u052F' +
    '\\u0531-\\u0556\\u0559\\u0560-\\u0588' +
    '\\u05D0-\\u05EA\\u05F0-\\u05F2' +
    '\\u0621-\\u064A\\u066E-\\u06D3\\u06D5\\u06EE-\\u06EF\\u06FA-\\u06FC\\u06FF' +
    '\\u0E01-\\u0E30\\u0E32-\\u0E33\\u0E40-\\u0E46' +
    '\\u10A0-\\u10C5\\u10C7\\u10CD\\u10D0-\\u10FA\\u10FC-\\u10FF' +
    '\\u1C90-\\u1CBA\\u1CBD-\\u1CBF\\u2D00-\\u2D25\\u2D27\\u2D2D' +
    '\\u3041-\\u3096\\u309B-\\u309F\\u30A1-\\u30FA\\u30FC-\\u30FF' +
    '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7A3' +
    ']|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]',
);

const HAS_LETTER: RegExp = (() => {
  try {
    return new RegExp('\\p{L}', 'u');
  } catch {
    return HAS_LETTER_FALLBACK;
  }
})();

/**
 * A fragment with no letters at all is not the app saying something.
 *
 * The Hostile fixture mutates a counter every 16ms, and clicking a button on that page reported
 * `appeared: "409"` — the ticker, not the action's effect. A count-up animation is exactly what
 * emits a bare number into the settle window, and a bare number carries no message a reader can
 * act on. Deliberately conservative: it drops only fragments with NO letters, so "status 500",
 * "3 items deleted" and "Could not save" all survive. An app whose only feedback is a naked
 * numeral loses it here — the snapshot still shows it, and that is the cheaper mistake.
 */
function saysSomething(text: string): boolean {
  return HAS_LETTER.test(text);
}

/**
 * Gathers the text an action put on the page, from mutation records the observer already receives.
 *
 * `domMutatedWithin` counts records and throws their content away, so a failed login reports
 * `ok / settled / mutated` and reads exactly like a successful one. The message the app rendered
 * was passing through this callback the whole time.
 *
 * Deliberately reports what appeared, never what it means: no error/success classification, no
 * guessing which fragment matters. Truncated, because a route change can add a whole page.
 */
export class AppearedText {
  readonly #seen = new Set<string>();
  #length = 0;

  collect(records: readonly MutationRecord[]): void {
    for (const record of records) {
      if (this.#full()) return;
      if ('characterData' === record.type) {
        // The NEW value; oldValue is not requested, so this is what the reader now sees.
        this.#add(record.target.textContent, record.target.parentElement);
        continue;
      }
      for (const node of record.addedNodes) {
        if (this.#full()) return;
        const owner = TEXT_NODE === node.nodeType ? node.parentElement : elementOf(node);
        this.#add(node.textContent, owner);
      }
    }
  }

  /**
   * `{ appeared }` when the APP added text, `{}` otherwise — an absent key means it added none.
   *
   * `wrote` is the value the action itself just set, and is excluded: a textarea carries its value
   * in a child text node, so a controlled one re-rendering after the write mutates characterData
   * with the caller's own string. Handing that back is noise wearing the name of evidence, and
   * `valueChanged` already reports that the write landed. Exact-match only, so an app that quotes
   * your input inside a sentence of its own ("No results for zzz") is still reported — that is
   * the app talking.
   */
  effect(wrote?: string): { appeared?: string } {
    const said = [...this.#seen].filter((text) => text !== wrote);
    if (0 === said.length) return {};
    const joined = said.join(JOIN);
    return {
      appeared: joined.length > APPEARED_MAX ? `${joined.slice(0, APPEARED_MAX)}…` : joined,
    };
  }

  #full(): boolean {
    return this.#length > APPEARED_MAX;
  }

  #add(raw: string | null, owner: Element | null): void {
    // Reticle's own overlay mutates constantly (the "live" panel); reporting it as the app's
    // response would be worse than reporting nothing.
    if (null !== owner && isIgnored(owner)) return;
    const text = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (0 === text.length) return;
    if (!saysSomething(text)) return;
    if (this.#seen.has(text)) return;
    this.#seen.add(text);
    this.#length += text.length + JOIN.length;
  }
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}
