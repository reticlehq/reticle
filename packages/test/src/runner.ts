import { TestStatus } from './constants.js';
import { isSkip } from './skip.js';
import { getRegistered } from './registry.js';
import { summarize, printSummary } from './summary.js';
import type { IrisSpec, RunSummary, RunnerOptions, SpecResult } from './types.js';

/** Classify a thrown value: skip (sentinel) vs fail (everything else). */
function classify(error: unknown): Pick<SpecResult, 'status' | 'error' | 'skipReason'> {
  if (isSkip(error)) {
    return { status: TestStatus.SKIP, skipReason: error.reason };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: TestStatus.FAIL, error: message };
}

/** Run one spec to a result. Never throws — a spec failure is captured, not propagated. */
export async function runOne(spec: IrisSpec, opts: RunnerOptions): Promise<SpecResult> {
  const start = opts.now();
  let outcome: Pick<SpecResult, 'status' | 'error' | 'skipReason'>;
  try {
    const t = opts.buildContext(opts.invoke);
    await spec.fn(t);
    outcome = { status: TestStatus.PASS };
  } catch (error) {
    outcome = classify(error);
  }
  const durationMs = opts.now() - start;
  // exactOptionalPropertyTypes: only spread an optional field when it is actually present.
  return {
    name: spec.name,
    status: outcome.status,
    durationMs,
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...(outcome.skipReason !== undefined ? { skipReason: outcome.skipReason } : {}),
  };
}

/**
 * Run all specs sequentially, in registration order, isolating each through runOne so one
 * failure never aborts the rest. Snapshots the spec list at call time (re-entrant registration
 * during a run is ignored for that run). Returns the JSON result + summary; prints if a sink is set.
 */
export async function runSpecs(
  opts: RunnerOptions,
): Promise<{ results: SpecResult[]; summary: RunSummary }> {
  const specs = opts.specs ?? getRegistered();
  const results: SpecResult[] = [];
  for (const spec of specs) {
    results.push(await runOne(spec, opts));
  }
  const summary = summarize(results);
  if (opts.print !== undefined) {
    printSummary(summary, results, opts.print);
  }
  return { results, summary };
}
