import { TRANSPORT_LIMITS, asRef, type Ref } from '@reticlehq/core';
/**
 * Stable, human-meaningful element handles. Each element gets a ref like `e7`; the same
 * element keeps its ref across snapshots, and a ref re-resolves to its element as long as
 * the element is still in the document.
 */
/**
 * How many ref -> element entries are retained.
 *
 * The forward map is weak, so elements are always collectable; this bounds the BOOKKEEPING, which was
 * not. Refs are minted far more often than an agent asks about them — every meaningful DOM addition,
 * every transitionend, every scroll reveal — and the only eviction used to be "the agent happened to
 * resolve this exact dead ref". A busy app over a long session therefore accumulated entries for
 * elements that had been garbage for hours.
 *
 * Sized generously because eviction is not free of consequence (see refFor): the useful lifetime of a
 * ref is one agent turn, and this is far more than any one turn produces.
 */
export const MAX_TRACKED_REFS = 10000;

/** Marks a ref that was too long to echo in full. */
const REF_ELISION = '…';

/** Every ref Reticle mints is this letter followed by its sequence number. */
const REF_PREFIX = 'e';

/**
 * A ref, made safe to interpolate into an error message.
 *
 * A ref Reticle mints is `e7` — three characters. A ref a CALLER passes is whatever they typed, and
 * an agent guessing at the schema can pass 100KB of it. Every stale-ref message interpolates that
 * value directly, so the caller's own bad argument came back as a 100KB error.
 *
 * The server caps error messages centrally, but it cannot help here: the browser's transport
 * serializer truncates from the TAIL first, which severs "… no longer resolves to an element" — the
 * exact substring the server's recovery table matches on. A stale ref then arrives classified as a
 * possible Reticle defect. So the echo is bounded at the source, where the untrusted value enters
 * the message.
 */
export function echoRef(ref: string): string {
  const max = TRANSPORT_LIMITS.MAX_REF_LENGTH;
  return max >= ref.length ? ref : `${ref.slice(0, max)}${REF_ELISION}`;
}

/**
 * Full-sweep cadence. The deref-sweep is O(retained), and a page legitimately holding ≥ MAX_TRACKED_REFS
 * live elements (a 10k-node dashboard) can never get under the cap that way, so running it on EVERY mint
 * over the cap turned each mint into a 10k-entry scan — measured 264µs vs 0.20µs (1,300x) on the app's
 * main thread, ~2.6% of it forever on a churning page. The cap is instead held by an O(1) oldest-drop per
 * over-cap mint, and the expensive dead-entry sweep runs once per this many mints (amortized O(1)).
 */
const SWEEP_EVERY_MINTS = 1000;

/**
 * Where a document records the ref numbers it has claimed, so the next one starts past them.
 *
 * Refs are per-DOCUMENT: a reload or a cross-page link tears this module down and the next document
 * used to start minting from `e1` again. So `e7` from page A was a valid, resolvable, DIFFERENT
 * element on page B — nothing refused, the wrong element was acted on, and the result came back `ok`.
 * The SPA case was always safe (WeakRef liveness + isConnected); this was the other half, and the
 * more dangerous one, because it produced a false green instead of an error.
 *
 * Deliberately NOT a change to the ref grammar. Stamping refs `e7@3` would have worked too, but every
 * agent passes refs back verbatim and every saved flow on disk already holds bare ones, so it buys a
 * wire-format migration for a property the sequence itself can carry. A number that never restarts
 * means a stale ref simply misses the map, and the refusal that already exists — already worded for
 * exactly this case — fires unchanged.
 *
 * Namespaced like the session key it sits beside; `sessionStorage` is the right scope for the same
 * reason session continuity uses it (survives reloads and same-tab navigations, not shared with
 * another tab, which is a different session with its own registry anyway).
 */
const REF_BASE_KEY = '__reticle_ref_base';

/**
 * How many numbers a document claims at once.
 *
 * The reservation is a synchronous storage write, so it cannot happen per mint — mints are frequent
 * (every meaningful DOM addition, every transitionend, every scroll reveal). One write per this many
 * mints is free.
 *
 * Sized to keep refs SHORT, and the first attempt at that reasoned about the wrong axis. It bounded
 * how many navigations it took to reach seven digits and concluded "a hundred" — but the cost is not
 * paid at seven digits, it is paid at every digit, on every ref, in every snapshot and every error
 * message, on every turn. At 10,000 the SECOND document already mints five-digit refs.
 *
 * Measured on one unchanged three-element page across a session: 61 tokens on the first document,
 * 64 after a reload, 65 later — +6.5% for the same page, entirely in ref width. The benchmark saw the
 * same thing as a ~4% rise in average observation cost, which is what a benchmark is for.
 *
 * So the block is small. A document claims another one when it outmints this, which costs one more
 * storage write and is exactly proportional: a page with thousands of elements has a long snapshot
 * anyway, and a small page — the common case, and the one an agent drives repeatedly — keeps
 * three-digit refs across dozens of navigations.
 */
export const REF_BLOCK = 100;

/** The reserved-block high-water mark, or 0 when storage is unavailable or its value is junk. */
function readBase(store: Storage | undefined): number {
  try {
    const raw = store?.getItem(REF_BASE_KEY);
    const value = null === raw || undefined === raw ? Number.NaN : Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0; // a sandboxed iframe throws on access; a session must still start
  }
}

/**
 * `WeakRef` (ES2021) is a deliberate, minimal exception to the ES2017 target/lib pin (issue #680):
 * unlike `.at()` or `Object.hasOwn`, there is no downlevel-able equivalent — a strong reference here
 * would leak every detached element this registry has ever seen. Universally supported in evergreen
 * browsers since 2021, well ahead of the webpack-4-parseable syntax floor this pin targets.
 */
export class RefRegistry {
  readonly #toRef = new WeakMap<Element, Ref>();
  readonly #fromRef = new Map<string, WeakRef<Element>>();
  readonly #storage: () => Storage | undefined;
  #seq = 0;
  /** The end of the block currently reserved. Minting past it claims the next one. */
  #reserved = 0;
  #mintsSinceSweep = 0;
  /**
   * The highest number handed out before the last hot update was applied, or 0 while none has been.
   *
   * A watermark rather than a per-ref stamp: the sequence never restarts within a document, so one
   * number separates "minted before the code changed" from "minted after it" for every ref at once.
   * The alternative — an epoch on every map entry — is bookkeeping paid on every mint for an answer
   * needed only on the rare refusal.
   */
  #editedAtSeq = 0;

  /**
   * Storage is injected rather than read from the global for the same reason the clock is: it is an
   * ambient dependency that decides behaviour, and the cross-document property is untestable if the
   * only way to get a second document is to actually navigate.
   */
  constructor(storage: () => Storage | undefined = () => globalThis.sessionStorage) {
    this.#storage = storage;
  }

  /** Read the tab's high-water mark and claim the next block, BEFORE any of it is handed out. */
  #reserve(): void {
    let store: Storage | undefined;
    try {
      store = this.#storage();
    } catch {
      store = undefined; // hostile storage: no cross-document guarantee, but the session still starts
    }
    const base = Math.max(readBase(store), this.#seq);
    this.#reserved = base + REF_BLOCK;
    try {
      store?.setItem(REF_BASE_KEY, String(this.#reserved));
    } catch {
      /* same: never block a mint on storage */
    }
    // Claimed on the FIRST mint, not at unload — a page that crashes, is killed, or navigates away
    // without firing unload has still permanently spent its numbers.
    this.#seq = base;
  }

  /** How many reverse entries are currently retained. Exposed so the bound can be asserted. */
  get size(): number {
    return this.#fromRef.size;
  }

  /** O(1): drop the least-recently-minted reverse entry. Map iterates in insertion order, so the front
   *  is the oldest. A still-live element whose entry is dropped re-registers on its next refFor. */
  #evictOldest(): void {
    const oldest = this.#fromRef.keys().next();
    if (oldest.done !== true) this.#fromRef.delete(oldest.value);
  }

  /** Full pass: drop every entry whose element has been collected or detached (frees genuinely dead
   *  bookkeeping), then any remaining excess by age. Amortized — called once per SWEEP_EVERY_MINTS. */
  #sweep(): void {
    for (const [ref, weak] of this.#fromRef) {
      const el = weak.deref();
      if (el === undefined || !el.isConnected) this.#fromRef.delete(ref);
    }
    while (this.#fromRef.size > MAX_TRACKED_REFS) this.#evictOldest();
  }

  /**
   * A hot update just replaced modules in this document: every ref handed out so far was minted
   * against the DOM the previous version of that code produced.
   *
   * Only the boundary is recorded. Nothing is evicted — a hot update is not a navigation, and most
   * of the page survives one, so refs minted before it very often still resolve. This exists so the
   * ones that DON'T can say why.
   */
  markEdited(): void {
    this.#editedAtSeq = this.#seq;
  }

  /** Was this ref handed out before the last hot update? False while no update has been observed. */
  mintedBeforeLastEdit(ref: string): boolean {
    if (0 === this.#editedAtSeq || !ref.startsWith(REF_PREFIX)) return false;
    const n = Number(ref.slice(REF_PREFIX.length));
    return Number.isSafeInteger(n) && n > 0 && n <= this.#editedAtSeq;
  }

  /** Get the existing ref for an element, or mint a new one. */
  refFor(el: Element): Ref {
    const existing = this.#toRef.get(el);
    if (existing !== undefined) {
      // Re-register if this element's entry was evicted while it was off the agent's radar. Without
      // this, an element that is still on the page could hold a ref that no longer resolves — the
      // eviction would surface as "element not found", which is a wrong answer rather than a slow one.
      // Either way, TOUCH it to the recent end (LRU): an element being surfaced right now must not be
      // the oldest-drop victim of a mint storm before the agent gets to act on it.
      const weak = this.#fromRef.get(existing);
      this.#fromRef.delete(existing);
      this.#fromRef.set(existing, weak ?? new WeakRef(el));
      return existing;
    }
    if (this.#seq >= this.#reserved) this.#reserve();
    this.#seq += 1;
    const ref = asRef(`${REF_PREFIX}${String(this.#seq)}`);
    this.#toRef.set(el, ref);
    this.#fromRef.set(ref, new WeakRef(el));
    // Keep bounded cheaply on every mint; run the full dead-entry sweep only periodically.
    this.#mintsSinceSweep += 1;
    if (this.#mintsSinceSweep >= SWEEP_EVERY_MINTS) {
      this.#mintsSinceSweep = 0;
      this.#sweep();
    } else if (this.#fromRef.size > MAX_TRACKED_REFS) {
      this.#evictOldest();
    }
    return ref;
  }

  /**
   * Resolve a ref back to its element, or null if it's gone/detached.
   *
   * Takes a plain `string` ON PURPOSE: this is the untrusted-input path — the ref comes from the agent
   * over the wire, and a miss is answered with null rather than an error. Requiring a branded Ref here
   * would force a meaningless cast at every wire boundary and buy nothing; the brand's value is on the
   * MINT (refFor) so our own code cannot pass, say, a sessionId where a handle is expected.
   */
  resolve(ref: string): Element | null {
    const weak = this.#fromRef.get(ref);
    if (weak === undefined) return null;
    const el = weak.deref();
    if (el === undefined || !el.isConnected) {
      this.#fromRef.delete(ref);
      return null;
    }
    // LRU touch: a ref the agent just resolved is in ACTIVE use — move it to the most-recent end so an
    // oldest-drop eviction between this resolve and the follow-up act can't reclaim it and turn a live
    // element into a false "ref no longer resolves". O(1) — Map preserves insertion order.
    this.#fromRef.delete(ref);
    this.#fromRef.set(ref, weak);
    return el;
  }
}

/** Process-wide registry shared by snapshot, query, and the action executor. */
export const refs = new RefRegistry();
