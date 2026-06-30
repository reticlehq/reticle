/**
 * The skip sentinel. MATCHERS' `t.expectInputModeReal()` throws this when the active input mode
 * is not 'real', so the runner reports `status:'skip'` (with the reason) instead of a silent pass.
 */
export class ReticleSkip extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'ReticleSkip';
    this.reason = reason;
  }
}

/** Structured diagnosis attached to a matcher failure so the runner surfaces the tool's own evidence. */
export interface AssertionDetail {
  /** The predicate engine's near-miss / matched-element / found-entries evidence. */
  evidence?: unknown;
  /** The tool's own failureReason, preserved verbatim (the Error message may add framing). */
  failureReason?: string;
}

/**
 * A failed matcher (e.g. an `reticle_assert` returning `{ pass:false, failureReason }`). Carries the
 * reason as its message plus the tool's structured `evidence`/`failureReason`; the runner treats it
 * as an ordinary fail (the message becomes SpecResult.error).
 */
export class ReticleAssertionError extends Error {
  readonly evidence?: unknown;
  readonly failureReason?: string;

  constructor(message: string, detail?: AssertionDetail) {
    super(message);
    this.name = 'ReticleAssertionError';
    // exactOptionalPropertyTypes: only assign optional fields when actually provided.
    if (detail?.evidence !== undefined) this.evidence = detail.evidence;
    if (detail?.failureReason !== undefined) this.failureReason = detail.failureReason;
  }
}

/**
 * Raised when a testid resolves to zero elements (the act/fill chokepoint). A subclass so a runner
 * can special-case "unknown testid" if it wants, but it is still an ordinary fail.
 */
export class ReticleQueryEmptyError extends ReticleAssertionError {
  constructor(message: string, detail?: AssertionDetail) {
    super(message, detail);
    this.name = 'ReticleQueryEmptyError';
  }
}

export function isSkip(error: unknown): error is ReticleSkip {
  return error instanceof ReticleSkip;
}
