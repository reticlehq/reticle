import { describe, expect, it } from 'vitest';
import { suiteFixtureSeed } from './lease-tools.js';
import type { RealInputProvider } from '../../portal/input/real-input.js';

/**
 * The join: capture the state the agent is already in, and boot every leased flow from it.
 *
 * This is the answer to the gap the architecture calls the real one. A suite's flows each start from
 * cold, so fifty of them prove the login works fifty times — and worse, the flow that LOGS OUT
 * leaves every flow after it signed out, which no navigation repairs, because the problem is not
 * where the subject is but what it holds.
 *
 * Every piece existed and nothing joined them. A seed is applied to an isolated context BEFORE the
 * first navigation, which is exactly and only when a fixture can work.
 *
 * Best-effort throughout, and that is a decision rather than laziness: a fixture is an optimisation
 * over running from cold, and running from cold is CORRECT. A suite that refused to start because a
 * cookie jar could not be read would have traded a slow answer for no answer.
 */

const URL = 'http://localhost:4312/';

const state = {
  cookies: [{ name: 'sid', value: 'abc', domain: 'localhost', path: '/' }],
  origins: [{ origin: 'http://localhost:4312', localStorage: [{ name: 'token', value: 'xyz' }] }],
};

/** Only the members this function reads; the rest of the provider is irrelevant here. */
const asProvider = (parts: Partial<RealInputProvider>): RealInputProvider =>
  parts as RealInputProvider;

// `perform` is deliberately absent: this function never drives anything, and a double that
// implements what is not read invites the next reader to think it matters.
const driving: Partial<RealInputProvider> = {
  isAvailableFor: () => Promise.resolve(true),
  storageState: () => Promise.resolve(state),
  applyStorageState: () => Promise.resolve(true),
};

describe('the state a suite boots its flows from', () => {
  it('is captured from the page the agent is already driving', async () => {
    const seed = await suiteFixtureSeed(asProvider(driving), URL);
    expect(seed?.cookies).toEqual(state.cookies);
    expect(seed?.local).toEqual({ token: 'xyz' });
  });

  it('is nothing when no provider is driving anything', async () => {
    // The common case — an attached tab. Every flow runs from cold, which is correct.
    expect(await suiteFixtureSeed(undefined, URL)).toBeUndefined();
  });

  it('is nothing when the provider cannot read storage', async () => {
    const noStorage: Partial<RealInputProvider> = { isAvailableFor: () => Promise.resolve(true) };
    expect(await suiteFixtureSeed(asProvider(noStorage), URL)).toBeUndefined();
  });

  it('is nothing, rather than a failure, when the browser throws', async () => {
    // A fixture is an optimisation over running from cold, and running from cold is correct. A
    // suite that refused to start because a cookie jar could not be read would have traded a slow
    // answer for no answer.
    const broken: Partial<RealInputProvider> = {
      ...driving,
      storageState: () => Promise.reject(new Error('target closed')),
    };
    await expect(suiteFixtureSeed(asProvider(broken), URL)).resolves.toBeUndefined();
  });

  it('is nothing when the driven page holds nothing worth seeding', async () => {
    const empty: Partial<RealInputProvider> = {
      ...driving,
      storageState: () => Promise.resolve({ cookies: [], origins: [] }),
    };
    expect(await suiteFixtureSeed(asProvider(empty), URL)).toBeUndefined();
  });
});
