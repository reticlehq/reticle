import { describe, expect, it } from 'vitest';
import { captureVerdictedAct } from './replay.js';
import { AMBIENT_RECORDING, RecordingStore } from './recording/tape/recordings.js';

/**
 * A failing act_and_wait must take its OWN claim off the tape and leave the step before it alone.
 *
 * Merged with a branch that also stripped refuted claims, the strip ran before the failing act was
 * captured and took the expectation off the PREVIOUS step, which had passed: the saved flow then
 * replayed green without checking what that step proved. Reproduced on the merged tree of the two
 * branches, before either had landed.
 */
describe('recording an act_and_wait once its verdict is known', () => {
  const act = (value: string, signal: string): Record<string, unknown> => ({
    by: 'testid',
    value,
    action: 'click',
    until: { kind: 'signal', name: signal },
  });

  it('keeps a passing step’s proof when the next step fails', () => {
    const store = new RecordingStore();
    captureVerdictedAct(store, act('save', 'saved'), { ok: true }, undefined, 'yes');
    captureVerdictedAct(store, act('publish', 'published'), { ok: true }, undefined, 'no');
    const steps = store.stop(AMBIENT_RECORDING)?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.expect).toEqual({ kind: 'signal', name: 'saved' });
    expect(steps[1]?.expect).toBeUndefined();
  });
});
