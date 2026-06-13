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
