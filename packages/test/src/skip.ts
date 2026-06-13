/**
 * The skip sentinel. MATCHERS' `t.expectInputModeReal()` throws this when the active input mode
 * is not 'real', so the runner reports `status:'skip'` (with the reason) instead of a silent pass.
 */
export class IrisSkip extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'IrisSkip';
    this.reason = reason;
  }
}

/**
 * A failed matcher (e.g. an `iris_assert` returning `{ pass:false, failureReason }`). Carries the
 * reason as its message; the runner treats it as an ordinary fail (no special handling needed).
 */
export class IrisAssertionError extends Error {
  constructor(failureReason: string) {
    super(failureReason);
    this.name = 'IrisAssertionError';
  }
}

export function isSkip(error: unknown): error is IrisSkip {
  return error instanceof IrisSkip;
}
