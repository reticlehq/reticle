export { reticleTest } from './spec.js';
export { register, getRegistered, clearRegistry } from './registry.js';
export { runSpecs, runOne } from './runner.js';
export { summarize, printSummary } from './summary.js';
export { toJUnitXml, writeJUnit } from './junit.js';
export { bootSession } from './boot.js';
export type { BootedRun, BootOptions } from './boot.js';
export {
  ReticleSkip,
  ReticleAssertionError,
  ReticleQueryEmptyError,
  isSkip,
} from './outcome/skip.js';
export type { AssertionDetail } from './outcome/skip.js';
export { createTestContext } from './test-context.js';
export type { TestContext, TestContextOptions, Predicate } from './test-context.js';
export type { TestClock } from './context/clock.js';
export { resolveTestid } from './context/resolve.js';
export { expectInputModeReal, InputModeTracker, readInputMode } from './context/input-mode.js';
export {
  TestStatus,
  STATUS_GLYPH,
  SUMMARY_FOOTER_PREFIX,
  JUnit,
  DEFAULT_JUNIT_SUITE_NAME,
  SKIP_REASON_REAL_INPUT,
  DEFAULT_ASSERT_TIMEOUT_MS,
  PredicateKind,
  PROBE_TESTID,
} from './outcome/constants.js';
export type {
  SpecContext,
  SpecFn,
  ReticleSpec,
  SpecResult,
  RunSummary,
  ContextFactory,
  RunnerOptions,
} from './types.js';

// flows under .reticle/flows become the runnable suite.
export { flowToSpec, flowsAsSpecs } from './flow-spec.js';
export type { FlowSpec, FlowSpecOptions, FlowsAsSpecsOptions, SpecRunResult } from './flow-spec.js';
export { assertSuccess, successToPredicate } from './outcome/success-assert.js';
export { registerFlowSpecs, FlowMalformedError, SpecFailure } from './register.js';
export type { RegisterFn, RegisterFlowSpecsOptions } from './register.js';
export { SpecKind, SpecOutcome, SpecMessage, FLOW_LOAD_ERROR_PREFIX } from './outcome/constants.js';
