/** Outcome of a single spec. No free strings — every status crosses the result boundary. */
export const TestStatus = { PASS: 'pass', FAIL: 'fail', SKIP: 'skip' } as const;
export type TestStatus = (typeof TestStatus)[keyof typeof TestStatus];

/** Per-status glyph the printer prepends to each result line. */
export const STATUS_GLYPH = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
} as const satisfies Record<TestStatus, string>;

/** The footer prefix on the summary totals line: "iris test: N passed, M failed, K skipped". */
export const SUMMARY_FOOTER_PREFIX = 'iris test:';

/** JUnit XML tag + attribute names (no free strings in the emitter). */
export const JUnit = {
  SUITE: 'testsuite',
  CASE: 'testcase',
  FAILURE: 'failure',
  SKIPPED: 'skipped',
  ATTR_NAME: 'name',
  ATTR_TESTS: 'tests',
  ATTR_FAILURES: 'failures',
  ATTR_SKIPPED: 'skipped',
  ATTR_TIME: 'time',
  ATTR_MESSAGE: 'message',
} as const;

/** Default JUnit <testsuite name=...> when the caller does not supply one. */
export const DEFAULT_JUNIT_SUITE_NAME = 'iris';

/**
 * Skip reason `t.expectInputModeReal()` raises when the active input mode is 'synthetic'.
 * The runner turns the IrisSkip carrying this into status:'skip' (never a silent pass).
 */
export const SKIP_REASON_REAL_INPUT = 'real input not active — run via iris drive';

/** Default wait window for assertion matchers (iris_assert timeout_ms). */
export const DEFAULT_ASSERT_TIMEOUT_MS = 4000;

/** Predicate `kind` discriminants the matchers build. Mirrors @iris/server's Predicate union. */
export const PredicateKind = {
  SIGNAL: 'signal',
  NET: 'net',
  ELEMENT: 'element',
  TEXT: 'text',
  CONSOLE: 'console',
} as const;
export type PredicateKind = (typeof PredicateKind)[keyof typeof PredicateKind];

/** Console level the expectNoConsoleErrors matcher asserts is absent. */
export const CONSOLE_LEVEL_ERROR = 'error';

/** Prefix of the IrisQueryEmptyError message when a testid resolves to nothing. */
export const NO_ELEMENT_FOR_TESTID = 'no element for testid';

/**
 * Default testid the input-mode probe resolves to when no act has run yet. Apps that opt into
 * `expectInputModeReal()` before any act should tag a stable benign element with this testid;
 * the probe runs a non-mutating SCROLL_INTO_VIEW against it purely to read the reported inputMode.
 */
export const PROBE_TESTID = 'iris-root';
