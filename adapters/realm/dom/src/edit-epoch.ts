import { NO_EDITS_OBSERVED } from '@reticlehq/core';
import { echoRef, refs, type RefRegistry } from './dom/refs.js';

/**
 * What the page can tell us about its own source being edited underneath it.
 *
 * The agent driving Reticle edits source and re-verifies in a loop. When an edit lands, the dev
 * server hot-updates the module and the framework re-renders: DOM nodes are REPLACED, every ref the
 * agent holds points at a detached node — and there was no navigation, so the document is the same
 * one and `documentId` never moves. The agent got a generic "that ref is stale" and could not tell
 * its own edit landing from a bug in the app it was verifying.
 *
 * DELIBERATELY NOT A BUILD INTEGRATION. Nothing here watches files, reads the user's repo or knows
 * what a module graph is. The page is told by its own dev server that it hot-updated; this records
 * that it happened and what it named, and that is the whole feature.
 */

/**
 * Vite's "the update has been applied" event, on a hot context.
 *
 * `vite:afterUpdate` rather than `vite:beforeUpdate`: the point of the epoch is that the DOM has
 * been replaced, and before the update it has not been yet.
 *
 * The SDK does NOT depend on Vite — it ships to Next, Electron, Tauri and plain pages, and it cannot
 * read `import.meta.hot` of its own module in any of them (a dependency is pre-bundled by Vite's
 * optimizer and gets no hot context at all). The channel is handed IN by whoever has one, and this
 * name is the only Vite-shaped thing in the SDK.
 */
const HOT_UPDATE_APPLIED = 'vite:afterUpdate';

/** How many changed files a refusal names before it stops being a diagnosis and starts being a list. */
const MAX_NAMED_FILES = 3;

/** The exact substring the server's recovery table keys off. Changing it silently unclassifies. */
const STALE_REF_REFUSAL = 'no longer resolves to an element';

/** The clause that turns a dead end into a diagnosis, and the one the server's table matches on. */
const CODE_CHANGED = 'the code changed underneath it';

/** A hot-update channel: anything that can be subscribed to by event name. Vite's `import.meta.hot`
 *  is one, and nothing here requires it to be that one. */
interface HotLike {
  on(event: string, listener: (payload: unknown) => void): void;
}

/** Anything object-shaped, as a bag of unknowns. The payload comes from the page, so nothing about
 *  its shape is guaranteed and every field has to be checked before it is read. */
function fields(value: unknown): Record<string, unknown> | undefined {
  return null !== value && 'object' === typeof value
    ? (value as Record<string, unknown>)
    : undefined;
}

function isHotLike(value: unknown): value is HotLike {
  return 'function' === typeof fields(value)?.['on'];
}

/** The file paths a hot-update payload named, narrowed from `unknown`. */
function updatedPaths(payload: unknown): string[] {
  const updates = fields(payload)?.['updates'];
  if (!Array.isArray(updates)) return [];
  const paths: string[] = [];
  for (const update of updates as unknown[]) {
    const path = fields(update)?.['path'];
    if ('string' === typeof path && path.length > 0 && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

export class EditEpoch {
  #epoch: number = NO_EDITS_OBSERVED;
  #files: readonly string[] = [];
  readonly #refs: RefRegistry;

  /** The registry is injected for the same reason the clock is: the interesting property is the
   *  RELATION between when a ref was minted and when an edit landed, and a global has no seam. */
  constructor(registry: RefRegistry) {
    this.#refs = registry;
  }

  /**
   * How many hot updates this document has applied.
   *
   * `NO_EDITS_OBSERVED` means exactly that and never "none happened": most pages Reticle instruments
   * have no channel that could report one, so absence here is UNKNOWN.
   */
  get current(): number {
    return this.#epoch;
  }

  /** Subscribe to a hot-update channel if one was handed in. Anything else is silently ignored —
   *  no channel is the normal case, not an error. */
  observe(hot: unknown): void {
    if (!isHotLike(hot)) return;
    hot.on(HOT_UPDATE_APPLIED, (payload) => this.applied(updatedPaths(payload)));
  }

  /** Record that an update was applied, naming the files it changed (which may be none). */
  applied(files: readonly string[]): void {
    this.#epoch += 1;
    this.#files = files.slice(0, MAX_NAMED_FILES);
    this.#refs.markEdited();
  }

  /**
   * The refusal for a ref that no longer resolves — saying WHY when the page can tell us.
   *
   * The generic wording is untouched and stays at the front: it is already tuned, and the server's
   * recovery table matches on it. When the ref predates the last hot update the diagnosis is
   * appended, because "you edited TripCard.tsx and it re-rendered" is a next step and "that ref is
   * stale" is a dead end. A ref minted AFTER the last update gets the generic message unchanged —
   * blaming an edit for an ordinary post-click stale ref would be a confident wrong answer, which is
   * worse than the vague right one.
   */
  staleRefMessage(ref: string): string {
    const generic = `ref '${echoRef(ref)}' ${STALE_REF_REFUSAL}`;
    if (!this.#refs.mintedBeforeLastEdit(ref)) return generic;
    const named =
      0 === this.#files.length ? 'the page hot-updated' : `${this.#files.join(', ')} hot-updated`;
    return (
      `${generic} — ${named} after this ref was taken, so ${CODE_CHANGED} and the framework ` +
      'replaced the node. Query again for a fresh ref: this is your own edit landing, not the app failing.'
    );
  }
}

/** The epoch of the page, paired with the process-wide ref registry it has to reason against. */
export const editEpoch = new EditEpoch(refs);
