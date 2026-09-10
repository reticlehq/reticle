import type { ChannelId } from '@reticlehq/core';

/**
 * What the page told us about itself when it connected.
 *
 * Six facts, all arriving in one HELLO, all read much later by code that has no idea a handshake
 * happened. They lived as six loose fields on `Session` with a paragraph of documentation each,
 * which is how a session class becomes a thousand lines of things that are not sessions.
 *
 * Gathering them is not filing. Every one of these answers the same question — *what is this
 * implementation able to do, in its own words* — and the protocol treats that question as the
 * first assertion an implementation makes. What follows from it is a rule: an assertion the page
 * cannot answer must be refused BEFORE an action is spent on it, not answered with an empty
 * result that reads exactly like the thing not being there.
 *
 * **`undefined` means "an SDK too old to say", and never "no".** That distinction is the whole
 * reason these are optional rather than defaulted. A page that predates a field is a page we know
 * nothing about on that axis, and treating silence as a negative would refuse every claim from
 * every older page in the field — which is a worse failure than the one being prevented, because
 * it looks like the tool being broken rather than the tool being careful.
 */
export interface HandshakeFacts {
  /** Set when the page's SDK version differs from the daemon's. See version-skew.ts. */
  versionSkew?: string;
  /** SDK version from HELLO; kept so a remedy can check it applies. See body-capture-remedy.ts. */
  sdkVersion?: string | undefined;
  /** Whether the page records network bodies. */
  captureBodies?: boolean | undefined;
  /**
   * The channels this build declared it can observe.
   *
   * The protocol's first assertion, and the input that decides whether a claim is answerable at
   * all. See `declaredChannels()` in the browser SDK for what makes the list truthful.
   */
  channels?: readonly ChannelId[] | undefined;
  /**
   * Whether this build stamps `data-reticle-source`, when the build plugin said.
   *
   * `false` separates "the project turned it off" from "nothing provides one".
   */
  sourceMapping?: boolean | undefined;
  /**
   * Extra key names this app declared sensitive via `connect({ redact: { keys } })`.
   *
   * Held so the DRIVEN path can redact them too — a request body the daemon captures from the
   * network stack never passes through the SDK, so nothing else would.
   */
  readonly redactKeys: readonly string[];
}
