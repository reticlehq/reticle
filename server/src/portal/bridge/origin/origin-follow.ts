/**
 * Let a session follow its own top-level navigation to another origin, when the host says so.
 *
 * The bridge checks a WebSocket's `Origin` against an allow-list fixed when the bridge is built. A
 * daemon on a developer's machine never needs more: the app is on localhost. A hosted verifier does.
 * A journey that starts on `www.wikipedia.org` and clicks through to `en.wikipedia.org` loads a new
 * page on a new origin, and the injected SDK in it dials the same bridge with the same session id.
 * The bridge refused it, so the drive lost its session on the step it was there to check.
 *
 * Nothing is followed by default. The host passes `followNavigation`, and the bridge asks it only
 * after every other gate has passed. A page on an origin nobody admitted may follow only when ALL of
 * these hold:
 *
 *  - its HELLO names a session this bridge already admitted: first from an allowed origin, then from
 *    each origin it followed to. A new origin can never START a session, so an arbitrary page cannot
 *    open one of its own;
 *  - its HELLO passed the token or nonce check, the same as any other page;
 *  - the page address in the HELLO is on the origin the socket came from;
 *  - the host returns `true` for this move. The host is the one party that knows whether its own
 *    drive caused the navigation (its browser's top frame is now on `to`), so it decides.
 */
import { OPAQUE_ORIGIN } from '@reticlehq/core';

/**
 * Canonical comparable form of a WS `Origin`. Web origins collapse to scheme://host[:port]. An
 * OPAQUE origin — a desktop webview (`tauri://localhost`, `app://.`) or `file://`, whose `URL.origin`
 * is the string "null" — is kept VERBATIM instead, so it survives into the allow-list and can be
 * compared. Collapsing those to "null" would both merge every desktop scheme into one bucket and
 * feed an unparseable string to `new URL`. Returns null only for a header that is not an origin.
 */
export function normalizeOrigin(origin: string): string | null {
  if (origin === OPAQUE_ORIGIN) return OPAQUE_ORIGIN;
  try {
    const web = new URL(origin).origin;
    return web === OPAQUE_ORIGIN ? origin : web;
  } catch {
    return null;
  }
}

/** One move the host is asked to allow. */
export interface OriginFollowRequest {
  /** The session the new page claims, as its HELLO names it. */
  sessionId: string;
  /** The origin this session was last admitted from. */
  from: string;
  /** The origin the new page dialled from. */
  to: string;
  /** The page address the new page reports. Its origin is `to`. */
  url: string;
}

/** The host's decision. Return `true` only for a navigation the host's own drive caused. */
export type FollowNavigation = (request: OriginFollowRequest) => boolean;

/** Origins remembered per session. Bounded so a long-lived bridge does not grow without end. */
const MAX_REMEMBERED = 1000;

const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/** True for an http(s) origin. Only a web page can follow; opaque and other schemes cannot. */
export function isWebOrigin(origin: string): boolean {
  try {
    return WEB_PROTOCOLS.has(new URL(origin).protocol);
  } catch {
    return false;
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export class OriginFollower {
  readonly #policy: FollowNavigation;
  /** The origin each session was last admitted from. Insertion order is age, for the bound. */
  readonly #admitted = new Map<string, string>();

  constructor(policy: FollowNavigation) {
    this.#policy = policy;
  }

  /** True when a page on this normalized origin may be judged at its HELLO: web origins only. */
  mayDial(origin: string | null): boolean {
    return origin !== null && isWebOrigin(origin);
  }

  /** Record the origin a session was admitted from. Non-web origins are never followed. */
  remember(sessionId: string, origin: string | null): void {
    if (!this.mayDial(origin) || null === origin) return;
    this.#admitted.delete(sessionId);
    this.#admitted.set(sessionId, origin);
    if (this.#admitted.size > MAX_REMEMBERED) {
      const oldest = this.#admitted.keys().next().value;
      if (oldest !== undefined) this.#admitted.delete(oldest);
    }
  }

  /**
   * Why this HELLO may not follow to `to`, or undefined when it may.
   *
   * A policy that throws refuses: a failure to decide is never permission.
   */
  refusal(hello: { sessionId: string; url: string }, to: string): string | undefined {
    const from = this.#admitted.get(hello.sessionId);
    if (from === undefined) return FollowRefusal.UNKNOWN_SESSION;
    if (originOf(hello.url) !== to) return FollowRefusal.URL_MISMATCH;
    let allowed = false;
    try {
      allowed = this.#policy({ sessionId: hello.sessionId, from, to, url: hello.url });
    } catch {
      allowed = false;
    }
    return allowed ? undefined : FollowRefusal.POLICY_REFUSED;
  }
}

/** Close reasons for a refused follow. Each is under the 123-byte limit of a close frame. */
export const FollowRefusal = {
  UNKNOWN_SESSION:
    'refused: a page on a new origin may only continue a session this bridge admitted',
  URL_MISMATCH: 'refused: the page address is not on the origin the socket dialled from',
  POLICY_REFUSED: 'refused: the host did not allow this session to follow to the new origin',
} as const;
