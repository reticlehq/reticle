/**
 * The incident: both flow specs graded a replay on fields the replay result does not have.
 *
 * `apps/e2e/specs/flow-record-replay-test.mjs` and `flow-self-heal-test.mjs` asked
 * `(rep.ok !== false) && !rep.drift`. `ok` and `drift` live on `FlowStepResult`, not on
 * `FlowReplayResult`, so both operands were `undefined` for every result the tool can return and the
 * check was constant true. A `status:'error'` replay with zero steps scored a green tick.
 *
 * This file runs in the unit gate (root `test:bench`) rather than in the battery, because the
 * battery is what it is guarding: a predicate that cannot fail cannot be caught by the suite that
 * depends on it.
 */

import { describe, expect, it } from 'vitest';
import { replayIsGreen, replayNotGreen } from './replay-is-green.mjs';

/** The shapes the old predicate scored green. Each one must now be a refusal. */
const NOT_GREEN = [
  ['a load failure', { name: 'f', status: 'error', steps: [], error: { code: 'flow_not_found' } }],
  ['drift', { name: 'f', status: 'drift', steps: [{ ok: false, drift: { reason: 'renamed' } }] }],
  ['an empty object', {}],
  ['undefined', undefined],
  ['ok with no steps', { name: 'f', status: 'ok', steps: [] }],
  [
    'ok that proves nothing',
    { name: 'f', status: 'ok', steps: [{ ok: true }], unverifiable: { reason: 'asserts nothing' } },
  ],
  [
    'ok that stopped early',
    { name: 'f', status: 'ok', steps: [{ ok: true }], halted: { atStep: 1, notAttempted: 2 } },
  ],
  ['ok carrying a failed step', { name: 'f', status: 'ok', steps: [{ ok: true }, { ok: false }] }],
];

describe('a replay is green only when it ran every step and proved something', () => {
  for (const [label, replay] of NOT_GREEN) {
    it(`refuses ${label}`, () => {
      expect(replayIsGreen(replay)).toBe(false);
      expect(replayNotGreen(replay)).toBeTypeOf('string');
    });
  }

  it('accepts a replay that ran its steps and asserted a consequence', () => {
    const replay = { name: 'f', status: 'ok', steps: [{ ok: true }, { ok: true }] };
    expect(replayNotGreen(replay)).toBeUndefined();
    expect(replayIsGreen(replay)).toBe(true);
  });

  /*
   * The reason this file exists, stated as an assertion: the old predicate passed everything above.
   * If someone reintroduces it, this goes red rather than the battery going quietly green.
   */
  it('the predicate this replaced scored every one of those as a pass', () => {
    const old = (rep) => (rep?.ok !== false) && !rep?.drift;
    for (const [, replay] of NOT_GREEN) expect(old(replay)).toBe(true);
  });
});
