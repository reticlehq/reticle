/**
 * Plain constants of the impact snapshot the HUD shows.
 *
 * No zod here: the SDK reads these on the way in, and a module that builds classic zod schemas
 * brings about 85 KB onto every page (#2369).
 */

/** The grant credits came from: sign-up, the card-started trial, or a paid plan. */
export const CreditKind = { FREE: 'free', TRIAL: 'trial', PAID: 'paid' } as const;
export type CreditKind = (typeof CreditKind)[keyof typeof CreditKind];

/**
 * How many recent defects a scope remembers.
 *
 * Small on purpose. `counts.failed` already says HOW MANY defects there have been; this list exists
 * so the HUD can say WHICH ONES, and a panel in the corner of somebody's app is not a triage queue.
 * Ten is enough to recognise what is currently broken and short enough that the record stays a
 * counters file rather than becoming a log.
 */
export const IMPACT_DEFECT_LIMIT = 10;
