import { isIgnored } from '../dom/dom-ignore.js';

/** Cap on the reported text. Enough for an error message, far short of a re-rendered page. */
const APPEARED_MAX = 200;

/** Separator between distinct fragments that appeared in the same window. */
const JOIN = ' | ';

const TEXT_NODE = 3;

/** Any letter, in any script — Latin, Cyrillic, CJK, Arabic. */
const HAS_LETTER = /\p{L}/u;

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
 * How much markup a fragment may contain and still be a MESSAGE rather than a rendered view.
 *
 * An added node's `textContent` flattens its whole subtree with no separators, so a container that
 * just rendered arrives here as one long run-on string. Measured on a real drive, clicking a nav
 * item reported `"Compose | generate a release note | DraftRelease note generatorTitle · commits on
 * blurWhat shipped?GenerateOutputYour generated note appears here."` — 36 tokens on every
 * navigation verdict, with the fragment boundaries lost ("DraftRelease", "blurWhat") so not even
 * readable as a list.
 *
 * Three is deliberately generous: a message with emphasis, a link and an icon inside it still
 * counts, and only something with the shape of a view is dropped. A view that IS dropped is not
 * lost — `reticle_snapshot` describes it properly, and a semantic tree is what a reader wanted for
 * a new screen anyway. Same trade as the bare-numeral rule above: the cheaper mistake.
 */
const MAX_MESSAGE_ELEMENTS = 3;

/** True when this node looks like a view that rendered, not a line the app wrote. */
function isRenderedView(node: Node): boolean {
  return node instanceof Element && node.querySelectorAll('*').length > MAX_MESSAGE_ELEMENTS;
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
        if (isRenderedView(node)) continue;
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
