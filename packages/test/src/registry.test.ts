import { afterEach, describe, expect, it } from 'vitest';
import { register, getRegistered, clearRegistry } from './registry.js';
import { reticleTest } from './spec.js';

afterEach(() => clearRegistry());

describe('registry', () => {
  it('clearRegistry empties the registry (test hygiene)', () => {
    register({ name: 'a', fn: () => undefined });
    register({ name: 'b', fn: () => undefined });
    expect(getRegistered()).toHaveLength(2);
    clearRegistry();
    expect(getRegistered()).toHaveLength(0);
  });

  it('getRegistered returns a snapshot copy, not the live array', () => {
    register({ name: 'a', fn: () => undefined });
    const snap = getRegistered();
    register({ name: 'b', fn: () => undefined });
    expect(snap).toHaveLength(1);
    expect(getRegistered()).toHaveLength(2);
  });

  it('reticleTest registers a spec by name', () => {
    reticleTest('hello', () => undefined);
    const specs = getRegistered();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe('hello');
  });
});
