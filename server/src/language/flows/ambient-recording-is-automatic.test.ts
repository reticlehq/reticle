import { describe, expect, it } from 'vitest';
import { RecordingStore, AMBIENT_RECORDING } from './recording/tape/recordings.js';
import { captureAct } from './replay.js';
import { ReticleTool } from '@reticlehq/core';

/**
 * Recording must be a property of the system, not a rule the agent has to remember.
 *
 * `RecordingStore.capture` opens the AMBIENT recording lazily and says so in its own comment:
 * "the journey that could have become a regression test, for free, out of work the agent was doing
 * anyway, existed only when somebody called `record_start` first. A rule that must be remembered on
 * every drive is a rule that is followed on some of them."
 *
 * That branch was UNREACHABLE from the drive path. Both callers of `capture` gate on
 * `recordings.active().length`, and the only thing that puts a name in `active()` is
 * `reticle_record { action: "start" }` — so the lazy open could only happen once a recording was
 * already open, and the rule the comment retired was still the rule.
 *
 * Found while making capture deterministic rather than agent-controlled. The comment was true about
 * the intent and false about the code, which is the most expensive kind of comment there is.
 */
describe('a drive is recorded without anybody starting a recording', () => {
  it('captures an act into the ambient tape on a store nobody started', () => {
    const store = new RecordingStore();
    expect(store.active(), 'nothing is open before the first act').toEqual([]);

    captureAct(
      store,
      { ref: 'e1', action: 'click', until: { kind: 'signal', name: 'saved' } },
      { ok: true },
    );

    expect(
      store.active(),
      'the first captured act must open the ambient tape — otherwise a drive that nobody ' +
        'wrapped in record_start is gone, which is every drive an agent forgot to wrap',
    ).toContain(AMBIENT_RECORDING);
    expect(store.stepCount(AMBIENT_RECORDING)).toBe(1);
  });

  it('keeps the assertion the agent declared, so the saved flow can go red', () => {
    const store = new RecordingStore();
    captureAct(
      store,
      { ref: 'e1', action: 'click', until: { kind: 'signal', name: 'saved' } },
      { ok: true },
    );
    const tape = store.stop(AMBIENT_RECORDING);
    expect(
      tape?.steps[0]?.expect,
      'a flow with no expect passes even when the feature is broken',
    ).toBeDefined();
    expect(tape?.steps[0]?.tool).toBe(ReticleTool.ACT);
  });
});
