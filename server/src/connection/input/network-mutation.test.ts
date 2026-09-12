import { describe, expect, it } from 'vitest';
import { MutationKind } from '@reticlehq/openreality';
import { mutationPortFor } from './network-mutation.js';
import type { RealInputProvider } from './real-input.js';

/**
 * Breaking a page on purpose, with the machinery that already exists.
 *
 * A flow that would stay green if the feature broke is a false green with a maintenance cost, and
 * the only way to find one is to break the thing it watches. `setMocks` already fails a request on a
 * driven page, and clearing the rules already puts it back — which makes it a real mutation with a
 * real reversal, rather than a new capability nobody has proved.
 *
 * A failing request is the sharpest single mutation available here: a flow whose action fires a
 * request that 500s and STILL passes is one that never asserted the consequence, which is exactly
 * the shape the demotion grade exists to catch.
 */

const URL = 'http://localhost:4312/';

const asProvider = (parts: Partial<RealInputProvider>): RealInputProvider =>
  parts as RealInputProvider;

const driving = (applied: unknown[][]): Partial<RealInputProvider> => ({
  isAvailableFor: () => Promise.resolve(true),
  setMocks: (_url: string, rules: unknown[]) => {
    applied.push(rules);
    return Promise.resolve(true);
  },
});

describe('when a page can be broken at all', () => {
  it('is not offered by a provider that cannot install mocks', async () => {
    const noMocks = { isAvailableFor: () => Promise.resolve(true) };
    expect(await mutationPortFor(asProvider(noMocks), URL)).toBeUndefined();
  });

  it('is not offered when no driven page matches this session', async () => {
    // Breaking a page this provider is not driving would perturb somebody else's subject.
    const elsewhere = { ...driving([]), isAvailableFor: () => Promise.resolve(false) };
    expect(await mutationPortFor(asProvider(elsewhere), URL)).toBeUndefined();
  });
});

describe('failing a request the subject depends on', () => {
  it('installs a rule that fails the named endpoint', async () => {
    const applied: unknown[][] = [];
    const port = await mutationPortFor(asProvider(driving(applied)), URL);
    await port?.mutate({ kind: MutationKind.REQUEST_FAILS, target: '/api/orders' });
    expect(applied).toEqual([[{ urlContains: '/api/orders', status: 500 }]]);
  });

  it('hands back a reversal that names what it undoes', async () => {
    const port = await mutationPortFor(asProvider(driving([])), URL);
    const reversal = await port?.mutate({
      kind: MutationKind.REQUEST_FAILS,
      target: '/api/orders',
    });
    expect(reversal?.mutation).toContain('/api/orders');
  });

  it('puts the page back by clearing the rules', async () => {
    const applied: unknown[][] = [];
    const port = await mutationPortFor(asProvider(driving(applied)), URL);
    await port?.mutate({ kind: MutationKind.REQUEST_FAILS, target: '/api/orders' });
    await port?.revert();
    // A break nobody undoes is damage: the next run would inherit a subject that is not the subject.
    expect(applied[1]).toEqual([]);
  });

  it('REFUSES a kind this page cannot perform, rather than pretending it broke something', async () => {
    // The mutation set is allowed to be small. What it may not do is report a perturbation it never
    // applied — a flow would then be demoted for surviving something that never happened to it.
    const port = await mutationPortFor(asProvider(driving([])), URL);
    await expect(
      port?.mutate({ kind: MutationKind.HANDLER_REMOVED, target: 'submit' }),
    ).rejects.toThrow(/handler-removed|cannot/i);
  });

  it('REFUSES a failing-request mutation with nothing to aim at', async () => {
    const port = await mutationPortFor(asProvider(driving([])), URL);
    await expect(port?.mutate({ kind: MutationKind.REQUEST_FAILS })).rejects.toThrow(/target/i);
  });
});
