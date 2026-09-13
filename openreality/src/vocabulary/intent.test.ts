import { describe, expect, it } from 'vitest';
import { IntentOrigin, IntentSchema, IntentStatus } from './intent.js';

/**
 * The one conditional requirement the intent vocabulary makes, and whether the schema keeps it.
 *
 * SPEC.md is unambiguous: an intent may be `abandoned` only when "deliberately closed without
 * ever being bound, **and the reason MUST be recorded**", because "`abandoned` exists so that
 * giving up is a decision somebody wrote down rather than a row that quietly stopped moving".
 *
 * The field was `.optional()` with a comment saying "Required in spirit; a bare abandonment
 * says nothing" -- which is a normative MUST, correctly identified, and then not enforced. A
 * bare `{ status: 'abandoned' }` validated, so the row that quietly stops moving was exactly
 * what the schema permitted.
 *
 * Optional in every other state is right and stays: a `declared` intent has nothing to explain.
 * This is the same shape as `valueContains`, fixed earlier in this release the same way.
 */
const base = {
  id: 'i1',
  statement: 'the checkout flow should not lose a cart',
  origin: IntentOrigin.DEVELOPER,
};

describe('an abandoned intent carries its reason', () => {
  it('refuses an abandonment with no reason', () => {
    const parsed = IntentSchema.safeParse({ ...base, status: IntentStatus.ABANDONED });
    expect(parsed.success).toBe(false);
  });

  it('refuses one whose reason is blank, which is the same row with extra characters', () => {
    const parsed = IntentSchema.safeParse({
      ...base,
      status: IntentStatus.ABANDONED,
      abandonedBecause: '   ',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an abandonment that says why', () => {
    const parsed = IntentSchema.safeParse({
      ...base,
      status: IntentStatus.ABANDONED,
      abandonedBecause: 'the flow was removed in 4.0, so there is nothing left to bind to',
    });
    expect(parsed.success).toBe(true);
  });

  it('still lets every other state omit it, because only abandonment owes an explanation', () => {
    for (const status of [IntentStatus.DECLARED, IntentStatus.BOUND]) {
      expect(IntentSchema.safeParse({ ...base, status }).success, status).toBe(true);
    }
  });
});
