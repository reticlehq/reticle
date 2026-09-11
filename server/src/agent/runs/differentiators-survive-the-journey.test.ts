import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { buildVerificationRun } from './build-verification-run.js';
import { driveRunFrom } from './drive-run.js';
import { toArtifact } from './artifact/to-artifact.js';

/**
 * The four properties survive the whole way from the verdict to the exported document.
 *
 * Each link in this chain was correct on its own and the chain did not carry anything. The verdict
 * knew the grade and the blind spots; the journal recorded neither; the run built from the journal
 * could not invent them; and the export had nothing to export. Everything compiled and every test
 * passed, and the artifact came out looking like an ordinary test report.
 *
 * So this checks the JOURNEY, not the links. A test per link would have gone on passing throughout.
 */

const action = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  tool: 'reticle_act_and_wait',
  args: {},
  at: 120,
  effect: {
    claim: 'the save request went out',
    verified: Verified.YES,
    declaredBeforeActing: true,
    grade: 'net',
    couldNotSee: ['closed-shadow-root'],
    ...over,
  },
});

/** The real path: fold the journal into a run input, then build the run the way production does. */
const runFrom = (actions: ReturnType<typeof action>[], editEpoch?: number) => {
  const input = driveRunFrom(actions as never, {
    runId: 'run-1',
    agentId: 'agent-1',
    ...(editEpoch === undefined ? {} : { editEpoch }),
  });
  if (input === undefined) throw new Error('the journal produced no run');
  return buildVerificationRun(input, () => 1_700_000_000_000);
};

describe('what a verdict knew reaches the document somebody else reads', () => {
  it('carries all four, from the recorded verdict to the export', () => {
    const artifact = toArtifact(runFrom([action()], 7));
    const [check] = artifact.checks;
    expect(check?.declaredBeforeActing).toBe(true);
    expect(check?.grade).toBe('net');
    expect(check?.couldNotSee).toEqual(['closed-shadow-root']);
    expect(artifact.editEpoch).toBe(7);
  });

  it('carries a claim made AFTER the action as exactly that', () => {
    // The value that matters most and is easiest to get wrong. `assert` reads a window that is
    // already open, so its claim is not pre-registered -- and recording it as if it were would put
    // the product's headline property on evidence that does not have it.
    const artifact = toArtifact(runFrom([action({ declaredBeforeActing: false })]));
    expect(artifact.checks[0]?.declaredBeforeActing).toBe(false);
  });

  it('says nothing about what a verdict did not record', () => {
    const artifact = toArtifact(
      runFrom([
        action({ declaredBeforeActing: undefined, grade: undefined, couldNotSee: undefined }),
      ]),
    );
    const [check] = artifact.checks;
    expect('declaredBeforeActing' in (check ?? {})).toBe(false);
    expect('grade' in (check ?? {})).toBe(false);
    expect('couldNotSee' in (check ?? {})).toBe(false);
  });
});
