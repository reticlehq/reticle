import { EventType, NetInitiator, type ReticleEvent } from '@reticlehq/core';

/**
 * How long a navigation-departure note stays attributable to the disconnect that follows it.
 *
 * The socket close follows a real departure within seconds; a note older than this belongs to a
 * navigation the document survived, and blaming a later disconnect on it would invent a story.
 */
const DEPARTED_TO_FRESHNESS_MS = 30_000;

/**
 * Where the SDK last saw the page heading.
 *
 * The SDK emits a navigation-initiated NET_PENDING while the old document is still alive — the
 * one fact that can outrun the socket close (#1256). This keeps it off `Session.url` deliberately:
 * successor matching and the 5xx probe need the page the tab was ON; this is where it was GOING.
 * Timestamps are session-relative milliseconds, read from the session's injected clock.
 */
export class DepartureNote {
  #note: { url: string; at: number } | undefined;

  /** Fold one inbound event into the note. */
  observe(event: ReticleEvent, elapsedMs: number): void {
    if (event.type !== EventType.NET_PENDING) return;
    // Only navigation-initiated pendings count: a fetch that never settled is in-flight work,
    // not a departure.
    if (event.data['initiator'] !== NetInitiator.NAVIGATION) return;
    // A download never takes the document away, so it must not explain a later disconnect.
    if (true === event.data['download']) return;
    const url = event.data['url'];
    if ('string' !== typeof url || 0 === url.length) return;
    this.#note = { url, at: elapsedMs };
  }

  /**
   * The navigation target, if it is fresh enough to be this departure's story.
   *
   * A navigation intent from long ago is not this departure: the document survived it — it kept
   * talking — so attributing a later disconnect to it would invent a story. Read at tombstone
   * time, when `elapsedMs` is the disconnect time.
   */
  read(elapsedMs: number): string | undefined {
    if (this.#note === undefined) return undefined;
    return elapsedMs - this.#note.at <= DEPARTED_TO_FRESHNESS_MS ? this.#note.url : undefined;
  }
}
