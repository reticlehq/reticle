import { isIgnored } from '../dom/dom-ignore.js';

/** Cap on the reported text. Enough for an error message, far short of a re-rendered page. */
const APPEARED_MAX = 200;

/** Separator between distinct fragments that appeared in the same window. */
const JOIN = ' | ';

const TEXT_NODE = 3;

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

  /** `{ appeared }` when text was added, `{}` otherwise — an absent key means none was. */
  effect(): { appeared?: string } {
    if (0 === this.#seen.size) return {};
    const joined = [...this.#seen].join(JOIN);
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
    if (this.#seen.has(text)) return;
    this.#seen.add(text);
    this.#length += text.length + JOIN.length;
  }
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}
