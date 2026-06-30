import type { ToolInvoker } from '@reticle/server';
import type { TestStatus } from './constants.js';

/**
 * The per-spec `t` handed to a spec body. Defined by the MATCHERS facet (out of scope here);
 * the RUNNER treats it as opaque except for the skip protocol it raises (see skip.ts).
 */
export interface SpecContext {
  readonly invoke: ToolInvoker;
}

export type SpecFn = (t: SpecContext) => void | Promise<void>;

export interface ReticleSpec {
  readonly name: string;
  readonly fn: SpecFn;
}

export interface SpecResult {
  name: string;
  status: TestStatus;
  durationMs: number;
  /** Present only on a fail (exactOptionalPropertyTypes ⇒ conditionally spread, never =undefined). */
  error?: string;
  /** Present only on a skip. */
  skipReason?: string;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

/** Builds the per-spec `t` from the invoker — supplied by MATCHERS; the runner only calls it. */
export type ContextFactory = (invoke: ToolInvoker) => SpecContext;

export interface RunnerOptions {
  /** Injected — the ONLY way the runner reaches the browser/tools. */
  invoke: ToolInvoker;
  /** Injected — builds the opaque `t`, keeping the runner decoupled from MATCHERS. */
  buildContext: ContextFactory;
  /** Injected clock (rule 7) — the durationMs source. */
  now: () => number;
  /** Injected sink; when present, the runner prints a summary. The runner never touches console. */
  print?: (line: string) => void;
  /** Defaults to a snapshot of the module registry taken at call time. */
  specs?: readonly ReticleSpec[];
}
