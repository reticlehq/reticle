import { SessionState } from '@reticle/protocol';
import { LOG_KIND, LOG_RESULT, type LogKind, type LogResult } from './presenter-log.js';
import { getCapabilities, type Capabilities } from '../registry/capabilities.js';

/** The in-page run-state export (Copy/Export buttons). The full event ring-buffer is server-side. */
export interface PresenterRunState {
  session: string;
  url: string;
  state: SessionState;
  startedMs: number;
  durationMs: number;
  counts: {
    reads: number;
    acts: number;
    narrations: number;
    human: number;
    passes: number;
    fails: number;
  };
  capabilities: Capabilities;
  log: { at: number; kind: LogKind; text: string; result?: LogResult }[];
}

/** Everything the controller hands the builder — the live fields a run state is computed from. */
interface RunStateInput {
  sessionId: string;
  state: SessionState;
  startMs: number | undefined;
  endMs: number | undefined;
  now: number;
  runLog: { at: number; kind: LogKind; text: string; result?: LogResult }[];
}

/**
 * Compute the exported run-state from the controller's live fields: per-kind + pass/fail counts over
 * the activity log, the session duration, and the current capability surface. Extracted from
 * presenter.ts so the controller stays under the size cap; the counting is the same as before.
 */
export function buildRunState(input: RunStateInput): PresenterRunState {
  const start = input.startMs ?? input.now;
  const counts = { reads: 0, acts: 0, narrations: 0, human: 0, passes: 0, fails: 0 };
  for (const e of input.runLog) {
    if (e.kind === LOG_KIND.READ) counts.reads += 1;
    else if (e.kind === LOG_KIND.ACT) counts.acts += 1;
    else if (e.kind === LOG_KIND.NARRATION) counts.narrations += 1;
    else if (e.kind === LOG_KIND.HUMAN) counts.human += 1;
    if (e.result === LOG_RESULT.PASS) counts.passes += 1;
    else if (e.result === LOG_RESULT.FAIL) counts.fails += 1;
  }
  return {
    session: input.sessionId,
    url: typeof location === 'undefined' ? '' : location.href,
    state: input.state,
    startedMs: start,
    durationMs: Math.max(0, (input.endMs ?? input.now) - start),
    counts,
    capabilities: getCapabilities(),
    log: input.runLog.map((e) => ({ ...e })),
  };
}
