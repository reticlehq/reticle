import { ReticleTool, type ToolInvoker } from '@reticlehq/server';
import { Verified, type ElementQuery, type ElementState } from '@reticlehq/core';
import { ReticleAssertionError } from '../outcome/skip.js';
import {
  CONSOLE_LEVEL_ERROR,
  DEFAULT_ASSERT_TIMEOUT_MS,
  PredicateKind,
} from '../outcome/constants.js';

/** The verdict envelope returned by reticle_assert / the `verdict` field of reticle_act_and_wait. */
export interface Verdict {
  /** The RAW predicate match, before the honesty layer has had its say. */
  pass: boolean;
  /**
   * `"yes" | "no" | "unknown"`, when the daemon reported one. `act_and_wait`'s schema calls this
   * "THE field to gate on", and it is allowed to disagree with `pass`: a UI that rendered success
   * over a POST that returned 500 comes back `pass: true, verified: "no"`, which is the flagship
   * verdict of the product rather than an edge case.
   */
  verified?: string;
  /** One sentence naming the deciding evidence behind `verified`. */
  because?: string;
  evidence?: unknown;
  failureReason?: string;
}

/**
 * Did this verdict PROVE the thing the spec asserted?
 *
 * Only `verified: "no"` overrides `pass`. That is the case where the daemon looked at the same
 * evidence and overturned a raw match, and reading `pass` alone made the one verdict this product
 * exists to produce, a contradicted green, the one a spec reported as passing.
 *
 * `unknown` deliberately still follows `pass`. The tool's own schema says "unknown is NOT failure,
 * it means the evidence could not decide, which calls for a better check rather than a code
 * change", and whether a CI spec should go red, green or skipped on that is a product decision
 * rather than something to settle inside a false-green fix.
 *
 * A daemon too old to send the field falls through to `pass`, unchanged.
 */
export function proved(verdict: Verdict): boolean {
  if (Verified.NO === verdict.verified) return false;
  return verdict.pass;
}

function asVerdict(value: unknown): Verdict {
  if (typeof value !== 'object' || null === value) {
    return { pass: false, failureReason: 'assert returned a non-object result' };
  }
  const record = value as Record<string, unknown>;
  const pass = true === record['pass'];
  const failureReason =
    'string' === typeof record['failureReason'] ? record['failureReason'] : undefined;
  const verified = 'string' === typeof record['verified'] ? record['verified'] : undefined;
  const because = 'string' === typeof record['because'] ? record['because'] : undefined;
  return {
    pass,
    evidence: record['evidence'],
    ...(verified !== undefined ? { verified } : {}),
    ...(because !== undefined ? { because } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

/**
 * Throw an ReticleAssertionError carrying the verdict's own evidence + failureReason. Used by every
 * `expect*` matcher and by actAndWait, so the runner's single catch boundary marks fail with the
 * predicate engine's structured diagnosis intact. `extraEvidence` lets actAndWait attach its trace.
 */
export function failFromVerdict(verdict: Verdict, extraEvidence?: Record<string, unknown>): never {
  // `because` before the generic fallback: an overturned verdict passed its own predicate, so it has
  // no `failureReason` to offer, and "assertion failed" would hide the contradiction that is the
  // entire finding.
  const message = verdict.failureReason ?? verdict.because ?? 'assertion failed';
  // actAndWait passes extra context (the reaction trace); merge it alongside the verdict evidence.
  const evidence =
    extraEvidence !== undefined
      ? {
          ...extraEvidence,
          ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
        }
      : verdict.evidence;
  throw new ReticleAssertionError(message, {
    ...(evidence !== undefined ? { evidence } : {}),
    ...(verdict.failureReason !== undefined ? { failureReason: verdict.failureReason } : {}),
  });
}

/** Run reticle_assert for a predicate; resolve on pass, throw the structured failure otherwise. */
async function assertPredicate(
  invoke: ToolInvoker,
  predicate: Record<string, unknown>,
  timeoutMs: number,
  sessionId?: string,
): Promise<void> {
  const args: Record<string, unknown> = {
    predicate,
    timeout_ms: timeoutMs,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  const verdict = asVerdict(await invoke(ReticleTool.ASSERT, args));
  if (!proved(verdict)) failFromVerdict(verdict);
}

export interface MatcherDeps {
  invoke: ToolInvoker;
  timeoutMs?: number;
  sessionId?: string;
}

function timeout(deps: MatcherDeps): number {
  return deps.timeoutMs ?? DEFAULT_ASSERT_TIMEOUT_MS;
}

export function expectSignal(
  deps: MatcherDeps,
  name: string,
  dataMatches?: Record<string, unknown>,
): Promise<void> {
  const predicate: Record<string, unknown> = {
    kind: PredicateKind.SIGNAL,
    name,
    ...(dataMatches !== undefined ? { dataMatches } : {}),
  };
  return assertPredicate(deps.invoke, predicate, timeout(deps), deps.sessionId);
}

export function expectNet(
  deps: MatcherDeps,
  method: string,
  urlContains: string,
  status?: number,
): Promise<void> {
  const predicate: Record<string, unknown> = {
    kind: PredicateKind.NET,
    method,
    urlContains,
    ...(status !== undefined ? { status } : {}),
  };
  return assertPredicate(deps.invoke, predicate, timeout(deps), deps.sessionId);
}

export function expectElement(
  deps: MatcherDeps,
  query: ElementQuery,
  state?: ElementState,
): Promise<void> {
  const predicate: Record<string, unknown> = {
    kind: PredicateKind.ELEMENT,
    query,
    ...(state !== undefined ? { state } : {}),
  };
  return assertPredicate(deps.invoke, predicate, timeout(deps), deps.sessionId);
}

export function expectText(deps: MatcherDeps, contains: string): Promise<void> {
  const predicate: Record<string, unknown> = { kind: PredicateKind.TEXT, contains };
  return assertPredicate(deps.invoke, predicate, timeout(deps), deps.sessionId);
}

export function expectAbsent(deps: MatcherDeps, query: ElementQuery): Promise<void> {
  const predicate: Record<string, unknown> = {
    kind: PredicateKind.ELEMENT,
    query,
    absent: true,
  };
  return assertPredicate(deps.invoke, predicate, timeout(deps), deps.sessionId);
}

export function expectNoConsoleErrors(deps: MatcherDeps): Promise<void> {
  const predicate: Record<string, unknown> = {
    kind: PredicateKind.CONSOLE,
    level: CONSOLE_LEVEL_ERROR,
    absent: true,
  };
  return assertPredicate(deps.invoke, predicate, timeout(deps), deps.sessionId);
}
