/**
 * The SDK reporting its OWN failures.
 *
 * Half of Reticle runs inside the page, and that half was completely silent. Every `catch` in the SDK
 * swallows by design — correctly, because an instrumentation layer must never break the app it
 * observes — but the consequence was that an observer throwing on page load just produced a quieter
 * product. No error, no signal, no way to know. A user would report "Reticle doesn't see my network
 * calls" and there would be nothing on our side to look at.
 *
 * Two properties make this safe to add:
 *
 *   1. IT MAKES NO NETWORK REQUEST. The report rides the bridge WebSocket the SDK is already connected
 *      to — localhost, the same channel every other event uses. The published promise that the SDK
 *      talks only to a local bridge stays exactly true, and the daemon decides what (if anything) goes
 *      anywhere else. Adding an outbound call from inside someone's app would have been a different
 *      product with a different privacy posture.
 *   2. IT CANNOT BREAK THE APP. Reporting is wrapped in its own try/catch and is strictly additive to
 *      an existing `catch` block. A failure to report a failure is discarded.
 */
import { EventType } from '@reticlehq/core';
import type { Emit } from './types.js';

/**
 * Where in the SDK a failure happened. A fixed vocabulary of OUR module names — never a file path,
 * never anything derived from the user's app — so the field stays low-cardinality and non-identifying
 * while still telling a maintainer which subsystem to open.
 */
export const SdkSite = {
  CONNECT: 'connect',
  DOM_OBSERVER: 'dom_observer',
  NETWORK_OBSERVER: 'network_observer',
  CONSOLE_OBSERVER: 'console_observer',
  IPC_OBSERVER: 'ipc_observer',
  HEALTH_OBSERVER: 'health_observer',
  ROUTER_OBSERVER: 'router_observer',
  ANIMATION_OBSERVER: 'animation_observer',
  STORE_ADAPTER: 'store_adapter',
  SNAPSHOT: 'snapshot',
  ACTION: 'action',
  COMMAND: 'command',
  RECORDER: 'recorder',
  TRANSPORT: 'transport',
} as const;
export type SdkSite = (typeof SdkSite)[keyof typeof SdkSite];

/** Cap the message here too — the server strips variables, but an unbounded string is a bad idea twice. */
const MAX_MESSAGE = 500;

/**
 * Report that a piece of the SDK failed. Never throws, and never prevents the caller from doing what
 * it was going to do anyway (which is almost always: carry on degraded).
 */
export function reportSdkFailure(emit: Emit, site: SdkSite, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    emit(EventType.SDK_FAILED, {
      site,
      message: message.slice(0, MAX_MESSAGE),
      ...(error instanceof Error ? { errorType: error.constructor.name.slice(0, 64) } : {}),
    });
  } catch {
    /* a failure report must never become a second failure */
  }
}
