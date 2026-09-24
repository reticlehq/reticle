import {
  DEFAULT_DIFF_RETENTION,
  DEFAULT_EVIDENCE_BUDGET_BYTES,
  DEFAULT_FEEDBACK_RETENTION,
  DEFAULT_SESSION_RETENTION,
} from './retention.js';

/** The key a project writes in `.reticle.json`. */
const RETAIN_KEY = 'retain';
const BYTES_PER_MB = 1024 * 1024;

/**
 * What a project is willing to keep.
 *
 * The only answer `.reticle.json` used to offer a full directory was `journal: false` — turning off
 * the thing the product is FOR, and, until the sweep was ungated, the one setting under which
 * nothing was deleted either. The bounds themselves were four constants no user could reach.
 *
 * `0` is a real answer and means keep none, which the count bounds already do for free: a sweep that
 * keeps zero directories deletes all of them. It is not the same as "unset", which is why every
 * field is read explicitly rather than with `??` over a falsy value.
 */
export interface RetainPolicy {
  /** Session journal directories under `sessions/`. */
  sessions: number;
  /** Overlay diffs under `visual/`. Baselines are memory and are never counted here. */
  visual: number;
  /** Local copies of reports the outbox already carries. */
  feedback: number;
  /** The TOTAL the evidence tier may occupy, in bytes. Stated in the file as `budgetMb`. */
  budgetBytes: number;
}

export const DEFAULT_RETAIN: RetainPolicy = {
  sessions: DEFAULT_SESSION_RETENTION,
  visual: DEFAULT_DIFF_RETENTION,
  feedback: DEFAULT_FEEDBACK_RETENTION,
  budgetBytes: DEFAULT_EVIDENCE_BUDGET_BYTES,
};

/**
 * A count a sweep can act on, or `undefined` for anything else.
 *
 * Negative and fractional are refused rather than coerced. "Keep -1 sessions" and "keep 1.5" are
 * both a user saying something they did not mean, and a sweep that guesses at what they meant is
 * deleting files on a guess.
 */
function count(value: unknown): number | undefined {
  return 'number' === typeof value && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Read the `retain` block out of an already-parsed `.reticle.json`.
 *
 * Takes the record rather than a path: the config search belongs to the caller that already does it
 * once at startup, and reaching for it from here would point the retention domain at the
 * command-line surface for a single lookup.
 *
 * Never throws, and falls back PER FIELD. A project that mistypes one bound keeps the other three —
 * the alternative silently reverts every bound the user did set, which is the same class of quiet
 * disagreement the whole partition of `.reticle/` exists to prevent.
 */
export function readRetainPolicy(config: Record<string, unknown> | undefined): RetainPolicy {
  const raw = config?.[RETAIN_KEY];
  if ('object' !== typeof raw || null === raw || Array.isArray(raw)) return DEFAULT_RETAIN;
  const retain = raw as Record<string, unknown>;
  const mb = count(retain['budgetMb']);
  return {
    sessions: count(retain['sessions']) ?? DEFAULT_RETAIN.sessions,
    visual: count(retain['visual']) ?? DEFAULT_RETAIN.visual,
    feedback: count(retain['feedback']) ?? DEFAULT_RETAIN.feedback,
    budgetBytes: mb === undefined ? DEFAULT_RETAIN.budgetBytes : mb * BYTES_PER_MB,
  };
}
