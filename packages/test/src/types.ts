import type { ToolInvoker } from '@reticlehq/server';
import type { TestContext } from './test-context.js';
import type { TestStatus } from './constants.js';

/**
 * The per-spec `t` handed to a spec body.
 *
 * This used to declare only `invoke`, on the reasoning that the RUNNER treats `t` as opaque and
 * should stay decoupled from the matchers. That is true of the runner and false of the caller: the
 * thing actually handed to a spec is a `TestContext`, and `reticleTest` is a public export. So
 * every TypeScript spec written against the documented API failed to compile on its first matcher —
 * `Property 'expectText' does not exist on type 'SpecContext'` — while the same spec ran correctly.
 * Nothing caught it because this repo's own spec is `.mjs`, which type-checks none of it.
 *
 * The runner's decoupling is preserved by `ContextFactory` below: the runner still never builds a
 * context, it only calls the one it is given. What it does not get to do any more is describe that
 * context to the outside world as less than it is.
 */
export type SpecContext = TestContext;

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
  /**
   * The one field a CI gate should branch on: nothing failed AND something actually ran.
   *
   * Deliberately not `failed === 0` — a suite where every spec skipped has verified nothing, and
   * calling that a pass is exactly the false green this product exists to catch. An empty suite is
   * still ok, because recording no flows yet is not the same as running none of the ones you have.
   */
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
