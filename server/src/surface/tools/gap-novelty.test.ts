/**
 * An instrumentation gap teaches its remedy once, then stops charging for it.
 *
 * The incident: on a 61-call drive of the razorpay merchant-dashboard fixture, `no-source-mapping`
 * was emitted **11 times with byte-identical `missing`/`cost`/`fix` prose**, 365 B each.
 * `instrumentationGaps` came to 11.5% of the whole run's token cost and 17 of its occurrences were
 * advice the agent had already been given in the same session. That drive cost MORE tokens than the
 * Playwright MCP arm it was measured against, and this was one of the two reasons why.
 *
 * `instrumentation-gap.ts` already states the rule — a gap fires only when an absence changed the
 * answer, "never as a survey". Repeating the same remedy on every verdict is that survey, delivered
 * one call at a time.
 *
 * What must NOT be lost: the per-element facts. "This control also has no source mapping" is news;
 * "here is what source mapping is" is not. A repeat keeps `ref`/`source` and carries `repeat: true`
 * so nobody reads the shorter form as something being withheld.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { forgetGapNovelty, resetGapNovelty, withGapNovelty } from './gap-novelty.js';

const gap = (kind: string, ref?: string): Record<string, unknown> => ({
  kind,
  missing: 'the control that was driven carries no source mapping',
  cost: 'this verdict can name the control but not the file and line that render it',
  fix: 'add the Reticle build plugin so elements carry data-reticle-source',
  ...(ref === undefined ? {} : { ref }),
});

describe('withGapNovelty', () => {
  beforeEach(() => resetGapNovelty());

  it('sends the full remedy the first time a kind is seen', () => {
    const [first] = withGapNovelty('s1', [gap('no-source-mapping', 'e1')]);
    expect(first?.['fix']).toBeDefined();
    expect(first?.['repeat']).toBeUndefined();
  });

  it('drops the remedy on a repeat but keeps which element it was', () => {
    withGapNovelty('s1', [gap('no-source-mapping', 'e1')]);
    const [second] = withGapNovelty('s1', [gap('no-source-mapping', 'e2')]);
    expect(second?.['fix'], 'the remedy was already given in this session').toBeUndefined();
    expect(second?.['ref'], 'WHICH element is the news in a repeat').toBe('e2');
    expect(second?.['repeat']).toBe(true);
  });

  it('is much smaller on a repeat — the entire point', () => {
    const full = JSON.stringify(withGapNovelty('s1', [gap('no-source-mapping', 'e1')]));
    const rep = JSON.stringify(withGapNovelty('s1', [gap('no-source-mapping', 'e2')]));
    expect(rep.length).toBeLessThan(full.length / 3);
  });

  it('treats a different kind as new, even after another has been told', () => {
    withGapNovelty('s1', [gap('no-source-mapping')]);
    const [other] = withGapNovelty('s1', [gap('no-signal-on-mutation')]);
    expect(other?.['fix'], 'a kind nobody has been told about must arrive in full').toBeDefined();
  });

  it('starts fresh for a different session — a new agent has been told nothing', () => {
    withGapNovelty('s1', [gap('no-source-mapping')]);
    const [fresh] = withGapNovelty('s2', [gap('no-source-mapping')]);
    expect(fresh?.['fix']).toBeDefined();
  });

  it('sends the full remedy when there is no session to remember against', () => {
    withGapNovelty(undefined, [gap('no-source-mapping')]);
    const [again] = withGapNovelty(undefined, [gap('no-source-mapping')]);
    expect(
      again?.['fix'],
      'without a session id nothing can be known to be a repeat',
    ).toBeDefined();
  });

  it('never mutates the callers gaps — telemetry and the stored capsule read the full text', () => {
    const original = gap('no-source-mapping', 'e1');
    withGapNovelty('s1', [original]);
    withGapNovelty('s1', [original]);
    expect(original['fix'], 'the source object must be untouched').toBeDefined();
  });

  it('forgets a session on request, so a long-lived daemon does not grow forever', () => {
    withGapNovelty('s1', [gap('no-source-mapping')]);
    forgetGapNovelty('s1');
    const [afterForget] = withGapNovelty('s1', [gap('no-source-mapping')]);
    expect(afterForget?.['fix']).toBeDefined();
  });
});
