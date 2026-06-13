export { irisTest } from './spec.js';
export { register, getRegistered, clearRegistry } from './registry.js';
export { runSpecs, runOne } from './runner.js';
export { summarize, printSummary } from './summary.js';
export { toJUnitXml, writeJUnit } from './junit.js';
export { bootSession } from './boot.js';
export type { BootedRun, BootOptions } from './boot.js';
export { IrisSkip, IrisAssertionError, IrisQueryEmptyError, isSkip } from './skip.js';
export type { AssertionDetail } from './skip.js';
export { createTestContext } from './test-context.js';
export type { TestContext, TestContextOptions, Predicate } from './test-context.js';
export { buildClock } from './clock.js';
export type { TestClock } from './clock.js';
export { resolveTestid } from './resolve.js';
export { expectInputModeReal, InputModeTracker, readInputMode } from './input-mode.js';
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
} from './constants.js';
export type {
  SpecContext,
  SpecFn,
  IrisSpec,
  SpecResult,
  RunSummary,
  ContextFactory,
  RunnerOptions,
} from './types.js';

// FLOW2SPEC (P4): flows under .iris/flows become the runnable suite.
export { flowToSpec, flowsAsSpecs } from './flow-spec.js';
export type { FlowSpec, FlowSpecOptions, FlowsAsSpecsOptions, SpecRunResult } from './flow-spec.js';
export { assertSuccess, successToPredicate } from './success-assert.js';
export {
  registerFlowSpecs,
  irisFlowsAsSpecs,
  FlowMalformedError,
  SpecFailure,
} from './register.js';
export type { RegisterFn, RegisterFlowSpecsOptions } from './register.js';
export { SpecKind, SpecOutcome, SpecMessage, FLOW_LOAD_ERROR_PREFIX } from './constants.js';
