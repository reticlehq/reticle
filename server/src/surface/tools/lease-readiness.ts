/**
 * Is a leased tab usable right now? The checks `reticle_lease` runs before it may say `ready: true`.
 * Presence in the sessions map is not enough: the tab has to answer, and it has to be visible.
 * The wait for the tab to connect is here too, with the zero-install reader for a page that stays silent.
 */

import { LeaseNotReadyReason, ReticleCommand } from '@reticlehq/core';
import { NotHtmlDocumentError } from '@/portal/pool/zero-install.js';

/**
 * How long a liveness probe waits for the tab to say anything at all.
 *
 * Short on purpose. This is not "finish the work", it is "are you there" — a page executing
 * JavaScript answers a no-argument command in single-digit milliseconds, and a wedged one is not
 * going to answer in two seconds either.
 */
const LEASE_PROBE_TIMEOUT_MS = 1_500;

/** The narrow slice of a session the probe needs. Anything that quacks like this works. */
interface ProbeableSession {
  command?: (name: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
}

/**
 * Did the SDK report its tab hidden? A hidden tab answers commands while its timers and rAF are
 * throttled, so a lease on it is `ready` by every other test and verifies nothing (#1351).
 *
 * Known gap: this reads the last PAGE_HEALTH, which lands just after HELLO — a check in that gap sees the
 * default `false`. The pool foregrounding the page is what covers the gap; this catches the rest.
 */
export function tabHidden(session: unknown): boolean {
  return (
    null !== session &&
    'object' === typeof session &&
    true === (session as { info?: () => { hidden?: unknown } }).info?.().hidden
  );
}

/**
 * Does this tab still answer?
 *
 * PRESENCE IS NOT LIVENESS. The sessions map still holds a tab that is attached, streaming events,
 * and answering nothing, so `ready` read off a row in that map hands back a lease that `snapshot`,
 * `state` and `console` then reject (#692). It has to mean the tab replied.
 *
 * ANY reply counts, including one that reports the command failed. The question is whether the SDK
 * answers at all, not what it says — so an SDK too old to know the command replies
 * `unknown command '…'`, and that is proof. Only the absence of a reply is evidence of absence:
 * `PendingCommands.track` REJECTS on timeout and on a dropped socket, and resolves on every real
 * answer, so the two cases are already separated for us.
 *
 * `CAPABILITIES` is the probe because it takes no arguments and returns a small fixed list. No new
 * wire command is introduced: this rides an existing round trip.
 *
 * Fails OPEN. A registry entry with no `command` is a shape this code did not put there, and
 * turning a lease that works into a refusal over a probe that could not run would be a worse
 * failure than the one being fixed.
 */
export async function probeLeaseAlive(
  session: ProbeableSession | undefined,
  timeoutMs: number = LEASE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const send = session?.command;
  if (send === undefined) return true;
  try {
    await send.call(session, ReticleCommand.CAPABILITIES, {}, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

const LEASE_READY_ATTEMPTS = 100;
const LEASE_READY_POLL_MS = 100;
/** Extra readiness waits allowed while the leased page is still loading (each one is ~10 s). */
const LEASE_LOADING_GRACE_ROUNDS = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the leased tab's SDK has actually registered on the bridge, so the sessionId we return
 * is immediately usable (the page navigates first, then connects a moment later — without this wait
 * an agent's very next call could race and hit "no connected session"). Returns whether it connected
 * in time. `isConnected`, `sleeper`, and `attempts` are injected so this is fast to unit-test.
 */
export async function waitForLeasedSession(
  isConnected: () => boolean,
  sleeper: (ms: number) => Promise<void> = sleep,
  attempts: number = LEASE_READY_ATTEMPTS,
  pollMs: number = LEASE_READY_POLL_MS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (isConnected()) return true;
    await sleeper(pollMs);
  }
  return isConnected();
}

/**
 * Wait for the leased tab to connect; if its app never does, hand it the zero-install reader.
 *
 * The decision is taken HERE, by the daemon, on the one fact that settles it: no HELLO arrived. A
 * timer inside the page cannot know that — an app can connect from a dynamic import that resolves
 * after `load` — and a reader injected into a page whose app was about to connect would take its
 * place and drop the app's own options. So an app that connected itself is never touched, and a page
 * that stayed silent through the whole readiness wait is the one that gets a reader.
 */
export async function connectOrInject(
  lease: {
    injectReader?: () => Promise<boolean>;
    isLoading?: () => Promise<boolean>;
    release?: () => Promise<void>;
  },
  isConnected: () => boolean,
  wait: (isConnected: () => boolean) => Promise<boolean> = waitForLeasedSession,
  graceRounds: number = LEASE_LOADING_GRACE_ROUNDS,
): Promise<{
  ready: boolean;
  zeroInstall: boolean;
  stillLoading?: true;
  readerFailure?: LeaseReaderFailure;
}> {
  if (await wait(isConnected)) return { ready: true, zeroInstall: false };
  let injected: boolean;
  try {
    injected = true === (await lease.injectReader?.());
  } catch (err) {
    // No SDK can connect to this tab now (#1701). Release the lease, so that its slot is free.
    await lease.release?.().catch(() => undefined);
    return { ready: false, zeroInstall: false, readerFailure: readerFailureOf(err) };
  }
  if (injected && (await wait(isConnected))) return { ready: true, zeroInstall: true };
  // A slow first dev compile can hold the document past both waits, and its app connects a moment
  // later (#1555). Keep waiting while the page itself says it is still loading, bounded so a page
  // that never finishes cannot hold the acquire forever.
  for (let round = 0; round < graceRounds; round++) {
    if (!(await pageStillLoading(lease))) break;
    if (await wait(isConnected)) return { ready: true, zeroInstall: injected };
  }
  // Re-check right before answering: a connect that landed during the last loading probe counts.
  if (isConnected()) return { ready: true, zeroInstall: injected };
  return (await pageStillLoading(lease))
    ? { ready: false, zeroInstall: false, stillLoading: true }
    : { ready: false, zeroInstall: false };
}

/** Whether the leased page reports it has not finished loading. Unknown counts as loaded. */
async function pageStillLoading(lease: { isLoading?: () => Promise<boolean> }): Promise<boolean> {
  try {
    return true === (await lease.isLoading?.());
  } catch {
    return false;
  }
}

/** Why the zero-install reader did not run, and the short cause that the hint shows. */
export interface LeaseReaderFailure {
  reason: LeaseNotReadyReason;
  cause: string;
}

/** The longest cause that a reader failure keeps. A Playwright error can carry a long call log. */
const READER_CAUSE_MAX_CHARS = 200;

function readerFailureOf(err: unknown): LeaseReaderFailure {
  const message = err instanceof Error ? err.message : String(err);
  // Only the first line: the lines after it are the Playwright call log, not the cause.
  const cause = (message.split('\n')[0] ?? '').slice(0, READER_CAUSE_MAX_CHARS);
  return {
    reason:
      err instanceof NotHtmlDocumentError
        ? LeaseNotReadyReason.NOT_HTML_DOCUMENT
        : LeaseNotReadyReason.READER_FAILED,
    cause,
  };
}
