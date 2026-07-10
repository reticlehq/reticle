import { ReticleTool, type ToolInvoker } from '@reticlehq/server';
import type { ElementQuery, ElementState } from '@reticlehq/core';
import { ReticleAssertionError } from './skip.js';
import { CONSOLE_LEVEL_ERROR, DEFAULT_ASSERT_TIMEOUT_MS, PredicateKind } from './constants.js';

/** The verdict envelope returned by reticle_assert / the `verdict` field of reticle_act_and_wait. */
export interface Verdict {
  pass: boolean;
  evidence?: unknown;
  failureReason?: string;
}

function asVerdict(value: unknown): Verdict {
  if (typeof value !== 'object' || value === null) {
    return { pass: false, failureReason: 'assert returned a non-object result' };
  }
  const record = value as Record<string, unknown>;
  const pass = record['pass'] === true;
  const failureReason =
    typeof record['failureReason'] === 'string' ? record['failureReason'] : undefined;
  return {
    pass,
    evidence: record['evidence'],
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

/**
 * Throw an ReticleAssertionError carrying the verdict's own evidence + failureReason. Used by every
 * `expect*` matcher and by actAndWait, so the runner's single catch boundary marks fail with the
 * predicate engine's structured diagnosis intact. `extraEvidence` lets actAndWait attach its trace.
 */
export function failFromVerdict(verdict: Verdict, extraEvidence?: Record<string, unknown>): never {
  const message = verdict.failureReason ?? 'assertion failed';
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
  if (!verdict.pass) failFromVerdict(verdict);
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
