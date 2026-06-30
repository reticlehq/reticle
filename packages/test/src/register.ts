import type { FlowErrorCode } from '@reticle/protocol';
import type { FlowReplaySession } from '@reticle/server';
import { FLOW_LOAD_ERROR_PREFIX, SpecKind, SpecOutcome } from './constants.js';
import { flowsAsSpecs } from './flow-spec.js';
import type { FlowSpec, FlowsAsSpecsOptions, SpecRunResult } from './flow-spec.js';

/** A loaded flow file was missing/malformed/badly-named — its spec throws this when run. */
export class FlowMalformedError extends Error {
  readonly code: FlowErrorCode;
  constructor(name: string, code: FlowErrorCode) {
    super(`${FLOW_LOAD_ERROR_PREFIX}: '${name}' (${code})`);
    this.name = 'FlowMalformedError';
    this.code = code;
  }
}

/** A RUNNABLE flow spec ran but failed — carries the verbatim replay + success evidence. */
export class SpecFailure extends Error {
  readonly result: SpecRunResult;
  constructor(name: string, result: SpecRunResult) {
    super(`${result.message ?? 'flow spec failed'}: ${name}\n${renderEvidence(result)}`);
    this.name = 'SpecFailure';
    this.result = result;
  }
}

/** Render the structured drift/near-miss evidence into the Error message so a CI log self-explains. */
function renderEvidence(result: SpecRunResult): string {
  const driftLines = result.steps
    .filter((s) => s.drift !== undefined)
    .map((s) => {
      const nearest = s.drift?.nearest;
      const fix = nearest === null || nearest === undefined ? '' : ` (nearest: ${nearest})`;
      return `  step ${String(s.step)}: ${s.drift?.reason ?? 'drift'}${fix}`;
    });
  const successLine =
    result.successResult.pass || result.successResult.failureReason === undefined
      ? []
      : [`  success: ${result.successResult.failureReason}`];
  return [...driftLines, ...successLine].join('\n');
}

/** The injectable test-registrar — vitest's `it` in CI, a collector stub in unit tests. */
export type RegisterFn = (name: string, fn: () => Promise<void> | void) => void;

export interface RegisterFlowSpecsOptions extends FlowsAsSpecsOptions {
  /** Defaults to vitest's `it`. Injected so registration can be unit-tested without nested vitest. */
  register?: RegisterFn;
}

/**
 * Resolve the default registrar (vitest's `it`) lazily. vitest is an OPTIONAL peer dependency, so the
 * public barrel (`@reticle/test`) must stay importable when vitest is absent — only callers that actually
 * register flow specs without injecting their own `register` fn need it. A static top-level import
 * would pull vitest into the eager module graph of every `import { reticleTest } from '@reticle/test'`.
 */
async function defaultRegister(): Promise<RegisterFn> {
  const vitest = await import('vitest');
  return vitest.it;
}

/** Turn one FlowSpec into a (name, fn) registration. The fn throws structured evidence on failure. */
function specToCase(
  spec: FlowSpec,
  getSession: () => Promise<FlowReplaySession> | FlowReplaySession,
): () => Promise<void> {
  return async (): Promise<void> => {
    if (spec.kind === SpecKind.ERROR && spec.loadError !== undefined) {
      throw new FlowMalformedError(spec.name, spec.loadError.code);
    }
    const result = await spec.run(await getSession());
    if (result.outcome === SpecOutcome.FAIL) {
      throw new SpecFailure(spec.name, result);
    }
  };
}

/**
 * FLOW2SPEC — register one vitest test per flow under `source`. The agent-readable map (.reticle/flows)
 * becomes the executable suite: a passing flow registers a green `it`, a malformed file registers a
 * loudly-failing ERROR `it`, an empty dir registers nothing. `getSession` is the seam — the
 * `reticle drive` launched session in CI, a fake in unit tests. MUST be awaited at module top level so
 * vitest collects the registered cases.
 */
export async function registerFlowSpecs(
  source: Parameters<typeof flowsAsSpecs>[0],
  getSession: () => Promise<FlowReplaySession> | FlowReplaySession,
  opts?: RegisterFlowSpecsOptions,
): Promise<void> {
  const register = opts?.register ?? (await defaultRegister());
  const specs = await flowsAsSpecs(source, opts);
  for (const spec of specs) {
    register(spec.name, specToCase(spec, getSession));
  }
}

/** Public alias matching the design's stated entrypoint name. */
export const reticleFlowsAsSpecs = registerFlowSpecs;
