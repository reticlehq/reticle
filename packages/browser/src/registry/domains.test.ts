import { describe, it, expect, vi } from 'vitest';

type DomainsModule = typeof import('./domains.js');
type CapModule = typeof import('./capabilities.js');

/** Both modules capture the global registry at load, so re-import per test for isolation. */
async function fresh(): Promise<DomainsModule & CapModule> {
  delete (globalThis as { __irisCapabilities?: unknown }).__irisCapabilities;
  vi.resetModules();
  const domains = await import('./domains.js');
  const capabilities = await import('./capabilities.js');
  return { ...domains, ...capabilities };
}

describe('registerIrisDomain (P5c self-registering domains)', () => {
  it('merges a domain into iris_capabilities', async () => {
    const { registerIrisDomain, getCapabilities } = await fresh();
    registerIrisDomain({ testids: ['a'], signals: ['s'], stores: ['st'] });
    expect(getCapabilities()).toEqual({
      testids: ['a'],
      signals: ['s'],
      stores: ['st'],
      flows: [],
    });
  });

  it('accumulates two domains as a union with no dupes', async () => {
    const { registerIrisDomain, getCapabilities } = await fresh();
    registerIrisDomain({ testids: ['a', 'b'], signals: ['s'] });
    registerIrisDomain({ testids: ['b', 'c'], stores: ['st'] });
    const caps = getCapabilities();
    expect(caps.testids).toEqual(['a', 'b', 'c']);
    expect(caps.signals).toEqual(['s']);
    expect(caps.stores).toEqual(['st']);
  });

  it('composes with registerCapabilities (deduped across both APIs)', async () => {
    const { registerIrisDomain, registerCapabilities, getCapabilities } = await fresh();
    registerCapabilities({ testids: ['x'] });
    registerIrisDomain({ testids: ['x', 'y'] });
    expect(getCapabilities().testids).toEqual(['x', 'y']);
  });

  it('getCapabilities reflects the union after registerIrisDomain', async () => {
    const { registerIrisDomain, getCapabilities } = await fresh();
    registerIrisDomain({ testids: ['a'], signals: ['s1'] });
    registerIrisDomain({ testids: ['a2'], signals: ['s2'] });
    const caps = getCapabilities();
    expect(caps.testids).toEqual(['a', 'a2']);
    expect(caps.signals).toEqual(['s1', 's2']);
  });

  it('empty domain is a no-op', async () => {
    const { registerIrisDomain, getCapabilities, hasCapabilities } = await fresh();
    registerIrisDomain({});
    expect(getCapabilities()).toEqual({ testids: [], signals: [], stores: [], flows: [] });
    expect(hasCapabilities()).toBe(false);
  });

  it('domain with empty arrays is a no-op', async () => {
    const { registerIrisDomain, hasCapabilities } = await fresh();
    expect(() => registerIrisDomain({ testids: [], signals: [] })).not.toThrow();
    expect(hasCapabilities()).toBe(false);
  });

  it('omitted keys do not clobber existing capabilities', async () => {
    const { registerIrisDomain, getCapabilities } = await fresh();
    registerIrisDomain({ signals: ['s'] });
    registerIrisDomain({ testids: ['a'] });
    const caps = getCapabilities();
    expect(caps.signals).toEqual(['s']);
    expect(caps.testids).toEqual(['a']);
  });

  it('re-registering the same domain is idempotent', async () => {
    const { registerIrisDomain, getCapabilities } = await fresh();
    registerIrisDomain({ testids: ['a'] });
    registerIrisDomain({ testids: ['a'] });
    expect(getCapabilities().testids).toEqual(['a']);
  });
});
