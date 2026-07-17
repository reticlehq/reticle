/**
 * Stable, human-meaningful element handles. Each element gets a ref like `e7`; the same
 * element keeps its ref across snapshots, and a ref re-resolves to its element as long as
 * the element is still in the document.
 */
export class RefRegistry {
  readonly #toRef = new WeakMap<Element, string>();
  readonly #fromRef = new Map<string, WeakRef<Element>>();
  #seq = 0;

  /** Get the existing ref for an element, or mint a new one. */
  refFor(el: Element): string {
    const existing = this.#toRef.get(el);
    if (existing !== undefined) return existing;
    this.#seq += 1;
    const ref = `e${String(this.#seq)}`;
    this.#toRef.set(el, ref);
    this.#fromRef.set(ref, new WeakRef(el));
    return ref;
  }

  /** Resolve a ref back to its element, or null if it's gone/detached. */
  resolve(ref: string): Element | null {
    const weak = this.#fromRef.get(ref);
    if (weak === undefined) return null;
    const el = weak.deref();
    if (el === undefined || !el.isConnected) {
      this.#fromRef.delete(ref);
      return null;
    }
    return el;
  }
}

/** Process-wide registry shared by snapshot, query, and the action executor. */
export const refs = new RefRegistry();
