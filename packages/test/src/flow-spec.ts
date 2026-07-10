import {
  AnchorKind,
  FLOW_SIGNAL_TIMEOUT_MS,
  type FlowErrorCode,
  type FlowFile,
  type FlowStepResult,
} from '@reticlehq/core';
import { FlowStore, createNodeFileSystem, replayFlow, waitForPredicate } from '@reticlehq/server';
import type {
  Clock,
  EvalResult,
  FileSystemPort,
  FlowReplaySession,
  WaitForSignal,
} from '@reticlehq/server';
import { SpecKind, SpecMessage, SpecOutcome } from './constants.js';
import { assertSuccess } from './success-assert.js';

/** FLOW2SPEC — the result of running one RUNNABLE flow spec, evidence-bearing on a FAIL. */
export interface SpecRunResult {
  outcome: SpecOutcome;
  /** Verbatim from replayFlow — carries each step's drift/nearest evidence. */
  steps: FlowStepResult[];
  /** From assertSuccess — carries the predicate failureReason + near-miss on a FAIL. */
  successResult: EvalResult;
  /** A named SpecMessage explaining a FAIL (never set on a PASS). */
  message?: SpecMessage;
}

/**
 * FLOW2SPEC — one flow rendered as a runnable spec. Every spec carries `run`. A RUNNABLE spec
 * replays + asserts success; an ERROR spec (file missing/malformed/badly-named) carries `loadError`
 * and a `run` whose returned SpecRunResult is FAIL, so a corrupted flow fails loudly in the suite
 * rather than vanishing. The vitest binding (register.ts) turns the load error into a thrown Error.
 */
export interface FlowSpec {
  name: string;
  kind: SpecKind;
  loadError?: { code: FlowErrorCode };
  run: (session: FlowReplaySession) => Promise<SpecRunResult>;
}

export interface FlowSpecOptions {
  /** Defaults to waitForPredicate from @reticlehq/server (the real engine). */
  waitForSignal?: WaitForSignal;
  /** Defaults to FLOW_SIGNAL_TIMEOUT_MS. Injected so a spec never reads the wall clock. */
  signalTimeoutMs?: number;
}

/** Derive the dynamic testid skip-set exactly as replayFlow does (testid anchors only). */
function toDynamicSet(flow: FlowFile): Set<string> {
  return new Set<string>(
    (flow.dynamic ?? [])
      .filter((a) => a.kind === AnchorKind.TESTID)
      .map((a) => (a.kind === AnchorKind.TESTID ? a.value : '')),
  );
}

/**
 * Build one RUNNABLE FlowSpec from an already-loaded FlowFile. Composition only — replay (anchored
 * steps + per-step expect + dynamic skip) comes from @reticlehq/server's replayFlow; the sole new
 * assertion is flow.success via the same predicate engine.
 */
export function flowToSpec(flow: FlowFile, opts?: FlowSpecOptions): FlowSpec {
  const waitForSignal = opts?.waitForSignal ?? waitForPredicate;
  const timeoutMs = opts?.signalTimeoutMs ?? FLOW_SIGNAL_TIMEOUT_MS;
  return {
    name: flow.name,
    kind: SpecKind.RUNNABLE,
    run: async (session: FlowReplaySession): Promise<SpecRunResult> => {
      const steps = await replayFlow(session, flow, waitForSignal, timeoutMs);
      const stepsOk = steps.every((s) => s.ok);
      const dynamic = toDynamicSet(flow);
      const successResult = await assertSuccess(
        session,
        flow.success,
        dynamic,
        waitForSignal,
        timeoutMs,
      );
      if (!stepsOk) {
        return { outcome: SpecOutcome.FAIL, steps, successResult, message: SpecMessage.STEP_DRIFT };
      }
      if (!successResult.pass) {
        return {
          outcome: SpecOutcome.FAIL,
          steps,
          successResult,
          message: SpecMessage.SUCCESS_NOT_MET,
        };
      }
      return { outcome: SpecOutcome.PASS, steps, successResult };
    },
  };
}

/** An ERROR spec for a flow file that failed to load. Its run() returns a FAIL with no steps. */
function errorSpec(name: string, code: FlowErrorCode): FlowSpec {
  const result: SpecRunResult = {
    outcome: SpecOutcome.FAIL,
    steps: [],
    successResult: { pass: false, failureReason: code },
    message: SpecMessage.STEP_DRIFT,
  };
  return {
    name,
    kind: SpecKind.ERROR,
    loadError: { code },
    run: (): Promise<SpecRunResult> => Promise.resolve(result),
  };
}

export interface FlowsAsSpecsOptions extends FlowSpecOptions {
  /** Injected fs port when `source` is a dir string (defaults to the node fs). */
  fs?: FileSystemPort;
  /** Injected clock for the FlowStore createdAt (rule 7) when `source` is a dir string. */
  clock?: Clock;
}

/**
 * FLOW2SPEC — enumerate a flows dir (or a live FlowStore) into FlowSpec[]. The map (.reticle/flows)
 * IS the suite. An empty/absent dir yields [] (no throw). A malformed/badly-named file becomes an
 * ERROR spec; enumeration of its siblings is never aborted.
 */
export async function flowsAsSpecs(
  source: string | FlowStore,
  opts?: FlowsAsSpecsOptions,
): Promise<FlowSpec[]> {
  const store =
    typeof source === 'string'
      ? new FlowStore(opts?.fs ?? createNodeFileSystem(), source, opts?.clock ?? { now: () => 0 })
      : source;

  const names = await store.list();
  const specs: FlowSpec[] = [];
  for (const name of names) {
    const loaded = await store.load(name);
    if (loaded.ok) {
      specs.push(flowToSpec(loaded.value, opts));
    } else {
      specs.push(errorSpec(name, loaded.code));
    }
  }
  return specs;
}
