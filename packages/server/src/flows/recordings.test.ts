import { describe, it, expect } from 'vitest';
import { ActionType, DANGEROUS_ACTION_CONFIRM_ARG } from '@reticle/protocol';
import { RecordingStore, type RecordedStep, type CompiledProgram } from './recordings.js';
import { compileActStep, compileSequenceStep } from './replay.js';

const step = (tool: string, stable = true): RecordedStep => ({ tool, stable, args: {} });

describe('RecordingStore', () => {
  it('accumulates captured steps and clears on stop', () => {
    const store = new RecordingStore();
    store.start('flow', 0);
    expect(store.isRecording('flow')).toBe(true);
    store.capture(step('reticle_act'));
    store.capture(step('reticle_act_sequence'));
    const rec = store.stop('flow');
    expect(rec?.steps).toHaveLength(2);
    expect(rec?.cursor).toBe(0);
    expect(store.isRecording('flow')).toBe(false);
    expect(store.stop('flow')).toBeUndefined();
  });

  it('capture with no active recording is a no-op', () => {
    const store = new RecordingStore();
    expect(() => {
      store.capture(step('reticle_act'));
    }).not.toThrow();
    expect(store.active()).toEqual([]);
  });

  it('appends captured steps to every active recording', () => {
    const store = new RecordingStore();
    store.start('a', 0);
    store.start('b', 5);
    store.capture(step('reticle_act'));
    expect(store.stop('a')?.steps).toHaveLength(1);
    expect(store.stop('b')?.steps).toHaveLength(1);
  });

  it('round-trips compiled programs by name', () => {
    const store = new RecordingStore();
    const program: CompiledProgram = { name: 'flow', version: 1, steps: [step('reticle_act')] };
    store.saveCompiled(program);
    expect(store.getCompiled('flow')).toBe(program);
    expect(store.getCompiled('nope')).toBeUndefined();
  });

  it('never persists one-shot destructive-action confirmations', () => {
    const act = compileActStep(
      {
        ref: 'e1',
        action: ActionType.CLICK,
        args: { [DANGEROUS_ACTION_CONFIRM_ARG]: true, value: 'kept' },
      },
      { testid: 'delete-account' },
    );
    expect(act.args['args']).toEqual({ value: 'kept' });

    const sequence = compileSequenceStep(
      {
        steps: [
          {
            ref: 'e1',
            action: ActionType.CLICK,
            args: { [DANGEROUS_ACTION_CONFIRM_ARG]: true },
          },
        ],
      },
      { steps: [{ testid: 'delete-account' }] },
    );
    expect((sequence.args['steps'] as { args: Record<string, unknown> }[])[0]?.args).toEqual({});
  });

  it('compiles a stable component (auto-anchor) step when the result has no testid but a component/source', () => {
    const act = compileActStep(
      { ref: 'e9', action: ActionType.CLICK, args: {} },
      {
        component: 'NewDeployButton',
        source: { file: 'src/Deployments.tsx', line: 107, column: 4 },
      },
    );
    expect(act.stable).toBe(true); // NOT degraded — the auto-anchor keeps it replayable
    expect(act.args['by']).toBe('component');
    expect(act.args['component']).toBe('NewDeployButton');
    expect(act.args['source']).toEqual({ file: 'src/Deployments.tsx', line: 107, column: 4 });
  });

  it('falls back to a ref-bound (unstable) step only when there is neither testid nor component/source', () => {
    const act = compileActStep({ ref: 'e9', action: ActionType.CLICK, args: {} }, { effect: {} });
    expect(act.stable).toBe(false);
    expect(act.args['ref']).toBe('e9');
  });
});
