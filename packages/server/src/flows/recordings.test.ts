import { describe, it, expect } from 'vitest';
import { RecordingStore, type RecordedStep, type CompiledProgram } from './recordings.js';

const step = (tool: string, stable = true): RecordedStep => ({ tool, stable, args: {} });

describe('RecordingStore (G6)', () => {
  it('accumulates captured steps and clears on stop', () => {
    const store = new RecordingStore();
    store.start('flow', 0);
    expect(store.isRecording('flow')).toBe(true);
    store.capture(step('iris_act'));
    store.capture(step('iris_act_sequence'));
    const rec = store.stop('flow');
    expect(rec?.steps).toHaveLength(2);
    expect(rec?.cursor).toBe(0);
    expect(store.isRecording('flow')).toBe(false);
    expect(store.stop('flow')).toBeUndefined();
  });

  it('capture with no active recording is a no-op', () => {
    const store = new RecordingStore();
    expect(() => {
      store.capture(step('iris_act'));
    }).not.toThrow();
    expect(store.active()).toEqual([]);
  });

  it('appends captured steps to every active recording', () => {
    const store = new RecordingStore();
    store.start('a', 0);
    store.start('b', 5);
    store.capture(step('iris_act'));
    expect(store.stop('a')?.steps).toHaveLength(1);
    expect(store.stop('b')?.steps).toHaveLength(1);
  });

  it('round-trips compiled programs by name', () => {
    const store = new RecordingStore();
    const program: CompiledProgram = { name: 'flow', version: 1, steps: [step('iris_act')] };
    store.saveCompiled(program);
    expect(store.getCompiled('flow')).toBe(program);
    expect(store.getCompiled('nope')).toBeUndefined();
  });
});
