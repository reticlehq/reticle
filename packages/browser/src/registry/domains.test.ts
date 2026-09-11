import { describe, it, expect, vi } from 'vitest';

type DomainsModule = typeof import('./domains.js');
type CapModule = typeof import('./capabilities.js');

/** Both modules capture the global registry at load, so re-import per test for isolation. */
async function fresh(): Promise<DomainsModule & CapModule> {
  delete (globalThis as { __reticleCapabilities?: unknown }).__reticleCapabilities;
  vi.resetModules();
  const domains = await import('./domains.js');
  const capabilities = await import('./capabilities.js');
  return { ...domains, ...capabilities };
}

describe('registerReticleDomain (P5c self-registering domains)', () => {
  it('merges a domain into reticle_capabilities', async () => {
    const { registerReticleDomain, getCapabilities } = await fresh();
    registerReticleDomain({ testids: ['a'], signals: ['s'], stores: ['st'] });
    expect(getCapabilities()).toEqual({
      testids: ['a'],
      signals: ['s'],
      stores: ['st'],
      flows: [],
    });
  });

  it('accumulates two domains as a union with no dupes', async () => {
    const { registerReticleDomain, getCapabilities } = await fresh();
    registerReticleDomain({ testids: ['a', 'b'], signals: ['s'] });
    registerReticleDomain({ testids: ['b', 'c'], stores: ['st'] });
    const caps = getCapabilities();
    expect(caps.testids).toEqual(['a', 'b', 'c']);
    expect(caps.signals).toEqual(['s']);
    expect(caps.stores).toEqual(['st']);
  });

  it('composes with registerCapabilities (deduped across both APIs)', async () => {
    const { registerReticleDomain, registerCapabilities, getCapabilities } = await fresh();
    registerCapabilities({ testids: ['x'] });
    registerReticleDomain({ testids: ['x', 'y'] });
    expect(getCapabilities().testids).toEqual(['x', 'y']);
  });

  it('getCapabilities reflects the union after registerReticleDomain', async () => {
    const { registerReticleDomain, getCapabilities } = await fresh();
    registerReticleDomain({ testids: ['a'], signals: ['s1'] });
    registerReticleDomain({ testids: ['a2'], signals: ['s2'] });
    const caps = getCapabilities();
    expect(caps.testids).toEqual(['a', 'a2']);
    expect(caps.signals).toEqual(['s1', 's2']);
  });

  it('empty domain is a no-op', async () => {
    const { registerReticleDomain, getCapabilities, hasCapabilities } = await fresh();
    registerReticleDomain({});
    expect(getCapabilities()).toEqual({ testids: [], signals: [], stores: [], flows: [] });
    expect(hasCapabilities()).toBe(false);
  });

  it('domain with empty arrays is a no-op', async () => {
    const { registerReticleDomain, hasCapabilities } = await fresh();
    expect(() => registerReticleDomain({ testids: [], signals: [] })).not.toThrow();
    expect(hasCapabilities()).toBe(false);
  });

  it('omitted keys do not clobber existing capabilities', async () => {
    const { registerReticleDomain, getCapabilities } = await fresh();
    registerReticleDomain({ signals: ['s'] });
    registerReticleDomain({ testids: ['a'] });
    const caps = getCapabilities();
    expect(caps.signals).toEqual(['s']);
    expect(caps.testids).toEqual(['a']);
  });

  it('re-registering the same domain is idempotent', async () => {
    const { registerReticleDomain, getCapabilities } = await fresh();
    registerReticleDomain({ testids: ['a'] });
    registerReticleDomain({ testids: ['a'] });
    expect(getCapabilities().testids).toEqual(['a']);
  });
});
