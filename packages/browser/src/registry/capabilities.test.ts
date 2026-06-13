import { describe, it, expect, beforeEach, vi } from 'vitest';

type CapModule = typeof import('./capabilities.js');

/** The registry binds the global store at module load, so re-import per test for isolation. */
async function freshModule(): Promise<CapModule> {
  delete (globalThis as { __irisCapabilities?: unknown }).__irisCapabilities;
  vi.resetModules();
  return import('./capabilities.js');
}

describe('capability registry (G5)', () => {
  beforeEach(() => {
    delete (globalThis as { __irisCapabilities?: unknown }).__irisCapabilities;
  });

  it('registers then returns the merged object', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({
      testids: ['item-list'],
      signals: ['webhook:received'],
      stores: ['cart'],
      flows: [{ name: 'checkout', steps: ['fill', 'submit'] }],
    });
    const caps = getCapabilities();
    expect(caps.testids).toEqual(['item-list']);
    expect(caps.signals).toEqual(['webhook:received']);
    expect(caps.stores).toEqual(['cart']);
    expect(caps.flows).toEqual([{ name: 'checkout', steps: ['fill', 'submit'] }]);
  });

  it('merges idempotently (no duplicate testids across calls)', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ testids: ['a'] });
    registerCapabilities({ testids: ['a'] });
    expect(getCapabilities().testids).toEqual(['a']);
  });

  it('dedupes flows by name with last-writer-wins on steps', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ flows: [{ name: 'pay', steps: ['one'] }] });
    registerCapabilities({ flows: [{ name: 'pay', steps: ['two', 'three'] }] });
    const flows = getCapabilities().flows;
    expect(flows).toHaveLength(1);
    expect(flows[0]).toEqual({ name: 'pay', steps: ['two', 'three'] });
  });

  it('partial input leaves other arrays empty', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ signals: ['x'] });
    const caps = getCapabilities();
    expect(caps.signals).toEqual(['x']);
    expect(caps.testids).toEqual([]);
    expect(caps.stores).toEqual([]);
    expect(caps.flows).toEqual([]);
  });

  it('hasCapabilities is false on a fresh store and true after registration', async () => {
    const { registerCapabilities, hasCapabilities } = await freshModule();
    expect(hasCapabilities()).toBe(false);
    registerCapabilities({ testids: ['a'] });
    expect(hasCapabilities()).toBe(true);
  });

  it('returns a defensive copy (mutating the result does not affect the store)', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ testids: ['a'] });
    const first = getCapabilities();
    first.testids.push('mutated');
    first.flows.push({ name: 'rogue', steps: [] });
    expect(getCapabilities().testids).toEqual(['a']);
    expect(getCapabilities().flows).toEqual([]);
  });
});
