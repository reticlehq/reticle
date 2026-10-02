import { describe, expect, it } from 'vitest';
import { appearanceDecision } from './appearance-budget.js';

/**
 * What to do when the thing you named is not there YET.
 *
 * Batching a journey into one round trip needs every step's element named up front, and the element
 * a later step acts on often does not exist when the batch is submitted — the modal that step 1
 * opens, the row that step 2 creates. Resolving with a single query fails those instantly, which is
 * the whole reason an agent falls back to snapshot / act / snapshot / act and pays a model turn for
 * every step.
 *
 * Waiting fixes it, but only one kind of waiting is safe, and the difference is the entire design:
 *
 *   ZERO matches  -> wait. The element may be arriving. Nothing can be acted on meanwhile, so
 *                    waiting cannot pick the wrong thing.
 *   MANY matches  -> REFUSE NOW, never wait. Waiting on an ambiguous name is the dangerous case:
 *                    a second element arriving later could make the tool act on something the
 *                    caller did not mean, and "it became unambiguous while I waited" is not the
 *                    caller's intent, it is a race the caller never saw.
 *   ONE match     -> go.
 *
 * The budget is the same one the step's own expectation uses, so a slow app is slow once, not twice.
 */
describe('appearanceDecision', () => {
  it('acts immediately on exactly one match', () => {
    expect(appearanceDecision({ matches: 1, elapsedMs: 0, budgetMs: 8000 }).do).toBe('act');
  });

  it('waits on zero matches while budget remains — the modal that has not opened yet', () => {
    const d = appearanceDecision({ matches: 0, elapsedMs: 0, budgetMs: 8000 });
    expect(d.do).toBe('wait');
    if ('wait' !== d.do) return;
    expect(d.waitMs).toBeGreaterThan(0);
  });

  it('REFUSES ambiguity instantly and never waits it out', () => {
    // The safety property. A name matching two things is the caller's mistake to fix, and time
    // cannot fix it — it can only change which of the two gets clicked.
    const d = appearanceDecision({ matches: 3, elapsedMs: 0, budgetMs: 8000 });
    expect(d.do).toBe('refuse');
    if ('refuse' !== d.do) return;
    expect(d.because).toMatch(/ambiguous/i);
  });

  it('still refuses ambiguity at the very end of the budget', () => {
    expect(appearanceDecision({ matches: 2, elapsedMs: 7999, budgetMs: 8000 }).do).toBe('refuse');
  });

  it('gives up when the budget is spent, and says the element never appeared', () => {
    const d = appearanceDecision({ matches: 0, elapsedMs: 8000, budgetMs: 8000 });
    expect(d.do).toBe('refuse');
    if ('refuse' !== d.do) return;
    expect(d.because).toMatch(/never appeared/i);
  });

  it('never waits past the budget — the last wait is clipped to what remains', () => {
    const d = appearanceDecision({ matches: 0, elapsedMs: 7950, budgetMs: 8000 });
    expect(d.do).toBe('wait');
    if ('wait' !== d.do) return;
    expect(d.waitMs).toBeLessThanOrEqual(50);
  });

  it('does not wait at all when the caller allowed no budget', () => {
    // timeout_ms: 0 means "do not wait for anything", and that has to hold here too.
    expect(appearanceDecision({ matches: 0, elapsedMs: 0, budgetMs: 0 }).do).toBe('refuse');
  });
});
