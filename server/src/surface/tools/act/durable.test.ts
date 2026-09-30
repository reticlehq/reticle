import { describe, expect, it } from 'vitest';
import { PredicateKind, Verified, VerifiedReason, type Predicate } from '@reticlehq/core';
import { durabilityOf, durablePart, revertedAfterMatch, withDurability } from './durable.js';

/*
 * Every verdict was scoped to one action's window, so "saved" was proved by the toast that said so
 * and nothing ever asked whether it was still there after a reload. `durable` asks.
 */
const el: Predicate = { kind: PredicateKind.ELEMENT, query: { testid: 'row' } };
const sig: Predicate = { kind: PredicateKind.SIGNAL, name: 'saved' };
const net: Predicate = { kind: PredicateKind.NET, urlContains: '/api' };

describe('durablePart — what a fresh document can be asked again', () => {
  it('keeps what describes the page, drops what happened once', () => {
    expect(durablePart(el)).toEqual(el);
    expect(durablePart(sig)).toBeUndefined();
    expect(durablePart({ kind: PredicateKind.ALL_OF, predicates: [sig, el, net] })).toEqual(el);
  });

  it('keeps an absence, which is how a deletion persists', () => {
    const gone: Predicate = { kind: PredicateKind.NOT, predicate: el };
    expect(durablePart(gone)).toEqual(gone);
  });

  it('drops an anyOf with a branch it cannot re-read, rather than narrowing the claim', () => {
    expect(durablePart({ kind: PredicateKind.ANY_OF, predicates: [el, sig] })).toBeUndefined();
  });
});

describe('withDurability', () => {
  const yes = { verified: Verified.YES, verifiedReason: VerifiedReason.PROVED, because: 'held' };
  const noReload = (): Promise<never> => Promise.reject(new Error('must not reload'));

  it('does nothing unless asked, or unless the verdict was a yes', async () => {
    expect(await withDurability(undefined, el, yes, noReload)).toEqual({ decision: yes });
    const no = { ...yes, verified: Verified.NO };
    expect(await withDurability(true, el, no, noReload)).toEqual({ decision: no });
  });

  it('turns a yes into a no when the consequence is gone after the reload', async () => {
    const out = await withDurability(true, el, yes, () =>
      Promise.resolve({ held: false, observed: 'no element matched' }),
    );
    expect(out.decision.verified).toBe(Verified.NO);
    expect(out.decision.because).toMatch(/reload/);
    expect(out.durable?.held).toBe(false);
  });

  it('is unknown, not no, when the page never came back to be asked', async () => {
    const out = await withDurability(true, el, yes, () => Promise.resolve({}));
    expect(out.decision.verified).toBe(Verified.UNKNOWN);
  });

  it('keeps the yes when it held again, and says it was re-checked', async () => {
    const out = await withDurability(true, el, yes, () => Promise.resolve({ held: true }));
    expect(out.decision).toEqual(yes);
    expect(out.durable).toEqual({ held: true });
  });

  it('says so, and changes nothing, when nothing declared can be re-read', async () => {
    const out = await withDurability(true, sig, yes, noReload);
    expect(out.decision).toEqual(yes);
    expect(out.durable?.skipped).toMatch(/signal|request/i);
  });
});

describe('revertedAfterMatch — an optimistic UI that rolled back', () => {
  const session = (present: boolean): Parameters<typeof revertedAfterMatch>[0] => ({
    command: () =>
      Promise.resolve({
        kind: 'command_result',
        id: 'm',
        ok: true,
        result: present
          ? { matched: true, count: 1, elements: [{ ref: 'e1' }] }
          : { matched: false, count: 0, elements: [] },
      }),
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  });

  it('names the revert when the element is gone', async () => {
    expect(await revertedAfterMatch(session(false), el, 0, undefined)).toMatch(/reverted/);
  });

  it('says nothing while it still holds', async () => {
    expect(await revertedAfterMatch(session(true), el, 0, undefined)).toBeUndefined();
  });

  it('says nothing for a consequence that happened once and cannot revert', async () => {
    expect(await revertedAfterMatch(session(false), sig, 0, undefined)).toBeUndefined();
  });
});

/*
 * A fresh page that cannot answer — its store not up yet, the tab gone mid-read — is not a page that
 * said no. Every non-pass used to become `held: false`, reported as a definite "did not persist".
 */
describe('durabilityOf — a re-check that could not be read is not a failed one', () => {
  it('keeps an unreadable re-check inconclusive, and the verdict unknown', async () => {
    const durable = durabilityOf({ pass: false, inconclusive: 'store unavailable' });
    expect(durable.held).toBeUndefined();
    const yes = { verified: Verified.YES, verifiedReason: VerifiedReason.PROVED, because: 'held' };
    const out = await withDurability(true, el, yes, () => Promise.resolve(durable));
    expect(out.decision.verified).toBe(Verified.UNKNOWN);
    expect(out.decision.verifiedReason).toBe(VerifiedReason.INCONCLUSIVE);
  });

  it('treats a re-check the tab left mid-read as lost, not failed', () => {
    expect(durabilityOf({ pass: false, observationLost: true }).held).toBeUndefined();
  });

  it('still says no when the fresh page answered and the consequence is gone', () => {
    expect(durabilityOf({ pass: false, observed: 'no element matched' })).toEqual({
      held: false,
      observed: 'no element matched',
    });
  });
});
