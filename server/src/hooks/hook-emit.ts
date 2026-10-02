/**
 * Turning what just happened inside the daemon into what Reticle says happened.
 *
 * A separate file from the dispatcher on purpose. The mapping from an internal object to a public
 * payload is the part that has to stay stable while the internals move, and keeping it beside the
 * call sites would make every change to a result shape look like a change to the contract. Here,
 * a field disappearing from a result is a visible edit to a mapping rather than a silent one.
 *
 * Every function is fire-and-forget and returns `void`: these are called from the verdict path, and
 * the bus's promise — that a hook cannot break or slow a verification — is only true if the code
 * feeding it makes the same promise.
 */

import { HookEvent } from '@reticlehq/core/hooks';
import { emitHook } from './hook-bus.js';

/** The fields of a tool result this mapping reads. Everything is optional; results vary by tool. */
interface ResultFacts {
  sessionId?: unknown;
  url?: unknown;
  verifiedReason?: unknown;
  because?: unknown;
}

const str = (value: unknown): string | undefined =>
  'string' === typeof value && value.length > 0 ? value : undefined;

/** Read once per emit so a payload's `at` is the moment it happened, not the moment it was written. */
const nowIso = (): string => new Date().toISOString();

/**
 * The project this happened in.
 *
 * Read from the daemon's own resolved project rather than passed down through every call site.
 * Absent is normal and correct: a session driven outside a wired project has no project id, and
 * inventing one would make a consumer's grouping wrong in a way they could not detect.
 */
let currentProjectId: string | undefined;

/** Told once at daemon start; there is no per-call plumbing for something that does not change. */
export function setHookProjectId(projectId: string | undefined): void {
  currentProjectId = projectId;
}

const withProject = <T extends object>(payload: T): T & { projectId?: string } =>
  currentProjectId === undefined ? payload : { ...payload, projectId: currentProjectId };

/** A verdict landed, in the protocol's own four-valued words. */
export function emitVerdictHook(
  toolName: string,
  result: Record<string, unknown>,
  verified: string,
  sessionId?: string,
): void {
  const facts = result as ResultFacts;
  // The RESOLVED session wins over anything the result happens to echo. The dispatcher knows which
  // session it actually drove; a result's own field is whatever that tool chose to include.
  const session = sessionId ?? str(facts.sessionId);
  emitHook(
    withProject({
      event: HookEvent.VERDICT,
      at: nowIso(),
      tool: toolName,
      verified,
      ...(str(facts.because) === undefined ? {} : { because: str(facts.because) }),
      ...(session === undefined ? {} : { sessionId: session }),
      ...(str(facts.url) === undefined ? {} : { url: str(facts.url) }),
    }),
  );
}

/** One defect. The caller has already decided this is a defect and whether it is a repeat. */
export function emitBugFoundHook(
  toolName: string,
  bug: { kind: string; source?: string | undefined },
  extra: {
    repeat: boolean;
    fingerprint?: string | undefined;
    route?: string | undefined;
    sessionId?: string | undefined;
  },
): void {
  emitHook(
    withProject({
      event: HookEvent.BUG_FOUND,
      at: nowIso(),
      kind: bug.kind,
      repeat: extra.repeat,
      tool: toolName,
      ...(bug.source === undefined ? {} : { source: bug.source }),
      ...(extra.fingerprint === undefined ? {} : { fingerprint: extra.fingerprint }),
      ...(extra.route === undefined ? {} : { route: extra.route }),
      ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    }),
  );
}

/** A browser session attached or detached. */
export function emitSessionHook(
  kind: typeof HookEvent.SESSION_STARTED | typeof HookEvent.SESSION_ENDED,
  session: { id: string; url?: string | undefined; runtime?: string | undefined },
): void {
  emitHook(
    withProject({
      event: kind,
      at: nowIso(),
      sessionId: session.id,
      ...(session.url === undefined ? {} : { url: session.url }),
      ...(session.runtime === undefined ? {} : { runtime: session.runtime }),
    }),
  );
}

/**
 * A sync cycle finished, including the ones that moved nothing.
 *
 * `runsPushed: 0, ok: true` is the common and useful case: from outside, "nothing changed" and
 * "sync has been broken since Tuesday" are indistinguishable without it.
 */
export function emitSyncHook(report: {
  runsPushed: number;
  ok: boolean;
  error?: string | undefined;
}): void {
  emitHook(
    withProject({
      event: HookEvent.SYNC_COMPLETED,
      at: nowIso(),
      runsPushed: report.runsPushed,
      ok: report.ok,
      ...(report.error === undefined ? {} : { error: report.error }),
    }),
  );
}
