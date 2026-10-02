import { describe, expect, it } from 'vitest';
import { ReplayStatus } from '@reticlehq/core';
import type { FlowReplayResult } from '@reticlehq/core';
import { buildSuiteVerdict } from './decision.js';

/**
 * A flow whose precondition did not hold is UNVERIFIABLE, never a failure.
 *
 * THE FAILURE THIS PREVENTS. Replaying journeys back to back only works when the state one leaves is
 * the state the next expects. A suite that ignores that produces a red which looks exactly like a
 * regression and is really a missing precondition — the most expensive kind of red there is, because
 * it sends somebody to read product code that is fine, and they only find out after they have read
 * it. Nothing ran, so nothing was proved: that is `unknown`, and `unknown` is not a failure.
 *
 * It rides the `unverifiable` bucket the suite already keeps, which exists for the neighbouring case
 * — a flow that asserts nothing and so cannot go red. Same honesty, same counter: `passed` stays a
 * count of things actually verified rather than of replays that merely completed.
 */
const replay = (over: Partial<FlowReplayResult>): FlowReplayResult => ({
  name: 'f',
  status: ReplayStatus.OK,
  steps: [],
  ...over,
});

describe('a flow that never ran because its precondition failed', () => {
  it('is not counted as passed', () => {
    const verdict = buildSuiteVerdict([
      {
        replay: replay({
          name: 'needs-login',
          unverifiable: { reason: 'a precondition of this flow does not hold' },
        }),
      },
    ]);
    expect(verdict.passed).toBe(0);
  });

  it('is not counted as a failure either', () => {
    // The whole point. A precondition gap must not read as a regression.
    const verdict = buildSuiteVerdict([
      {
        replay: replay({
          name: 'needs-login',
          unverifiable: { reason: 'a precondition of this flow does not hold' },
        }),
      },
    ]);
    expect(verdict.failures.map((f) => f.flow)).not.toContain('needs-login');
  });

  it('still counts a genuine failure as a failure beside it', () => {
    // A guard that swallowed real reds while fixing false ones would be worse than the bug.
    const verdict = buildSuiteVerdict([
      { replay: replay({ name: 'needs-login', unverifiable: { reason: 'precondition' } }) },
      { replay: replay({ name: 'broken', status: ReplayStatus.DRIFT }) },
    ]);
    expect(verdict.failures.map((f) => f.flow)).toEqual(['broken']);
    expect(verdict.passed).toBe(0);
  });
});
