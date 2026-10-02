import { describe, expect, it } from 'vitest';
import { FlowFileSchema } from './flow-types.js';

/**
 * A flow that learned something can still be LOADED.
 *
 * This is a data-loss defect, found by review and reproduced here. A replay writes what it learned
 * straight to the flow file through a narrow writer that does not validate; `load` DOES validate.
 * The two disagreed about one field, and the consequence is total: a cross-step contradiction is
 * addressed as step `-1` — the convention this repo already uses for a finding that belongs to no
 * single step — while `learned[].step` was declared `nonnegative()`. So the first cross-step finding
 * wrote a file that could never be read again, and replay, heal and the whole suite lost that flow
 * permanently. It reads as a corrupt user file rather than as our write.
 *
 * Two lessons, both pinned below. A writer that skips the schema its reader enforces is not a
 * shortcut, it is a way to author unreadable files. And the address of a cross-step finding is not
 * an implementation detail of one module — the moment it is persisted it is part of the contract.
 */
const flow = (learned: unknown): unknown => ({
  version: 1,
  name: 'checkout',
  createdAt: 1,
  steps: [],
  learned,
});

describe('a learned guard survives the round trip', () => {
  it('accepts a step index, the ordinary case', () => {
    expect(
      FlowFileSchema.safeParse(flow([{ kind: 'duplicate-request', step: 2, state: 'open' }]))
        .success,
    ).toBe(true);
  });

  it('accepts the CROSS-STEP address, which belongs to no single step', () => {
    // -1 is what `decision.ts` has always used for a whole-span finding. Refusing it here made the
    // file unloadable the first time one was learned.
    const parsed = FlowFileSchema.safeParse(
      flow([{ kind: 'request-never-settled', step: -1, state: 'open' }]),
    );
    expect(parsed.success, 'a cross-step finding must not brick the flow').toBe(true);
  });

  it('still refuses an address that means nothing', () => {
    // Widening to accept -1 must not widen to accept anything: -2 is not an address this repo uses,
    // and a number nobody writes deliberately is a bug arriving as data.
    expect(FlowFileSchema.safeParse(flow([{ kind: 'x', step: -2, state: 'open' }])).success).toBe(
      false,
    );
    expect(FlowFileSchema.safeParse(flow([{ kind: 'x', step: 1.5, state: 'open' }])).success).toBe(
      false,
    );
  });

  it('refuses a state that is neither open nor guarded', () => {
    expect(FlowFileSchema.safeParse(flow([{ kind: 'x', step: 0, state: 'maybe' }])).success).toBe(
      false,
    );
  });
});
