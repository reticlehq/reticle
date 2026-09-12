import { describe, expect, it } from 'vitest';
import { NoSessionReason } from '@reticlehq/core/telemetry';
import { diagnoseNoSession, explainNoSession } from './no-session-diagnosis.js';
import type { NoSessionFacts } from './no-session-diagnosis.js';

/**
 * The diagnosis already ranked its causes well. It just threw the ranking away as prose, so the
 * population that installs Reticle and never connects an app arrived as one undifferentiated
 * silence — "restarted the dev server and it still did not connect" and "never started the app"
 * being the same absence, with opposite fixes (#615).
 *
 * These pin the branch-to-code mapping, and — the case that matters most for a refactor like this —
 * that the SENTENCE is unchanged. A reason is only worth anything if it describes the diagnosis the
 * user was actually shown.
 */
const base: NoSessionFacts = {
  everConnected: false,
  initialized: false,
  listening: [],
  port: 4400,
};

const facts = (over: Partial<NoSessionFacts>): NoSessionFacts => ({ ...base, ...over });

describe('every no-session branch names itself', () => {
  it('a reaped lease, not a closed tab', () => {
    expect(explainNoSession(facts({ everConnected: true, leaseExpired: true })).reason).toBe(
      NoSessionReason.LEASE_EXPIRED,
    );
  });

  it('connected before, and what went was a tab', () => {
    expect(explainNoSession(facts({ everConnected: true })).reason).toBe(NoSessionReason.TAB_GONE);
  });

  it('the route the tab died on answers 5xx right now — a server error, not a closed tab', () => {
    // The route that 500s tears the page down and the SDK never reconnects, so the list is empty
    // and the diagnosis said "the tab went away". It had the URL (#862) and nothing else; a plain
    // GET of that URL, done out of band by the watch, is the one fact that separates a server error
    // from a closed tab and from an install problem. It outranks TAB_GONE because it is not an
    // absence — it is an answer from the route itself.
    const got = explainNoSession(
      facts({
        everConnected: true,
        lastKnownUrl: 'http://localhost:3000/orders/explode',
        lastKnownStatus: 500,
      }),
    );
    expect(got.reason).toBe(NoSessionReason.ROUTE_SERVER_ERROR);
    expect(got.message).toContain('http://localhost:3000/orders/explode');
    expect(got.message).toMatch(/HTTP 500/);
    expect(got.message).toMatch(/server error/i);
    expect(got.message).not.toMatch(/reticle init/);
  });

  it('claims the present tense only — the status is what the route answers NOW', () => {
    // A 500 now does not prove the teardown was a 500 then; a dev server recompiles. The sentence
    // must not say the page "was torn down BY" the error as though that were observed.
    const got = explainNoSession(
      facts({ everConnected: true, lastKnownUrl: 'http://localhost:3000/x', lastKnownStatus: 503 }),
    );
    expect(got.message).toMatch(/right now|answers HTTP 503/i);
  });

  it('a non-5xx status is not a server error, and the closed-tab wording stands', () => {
    // A 404 after a route rename, a 401 from an auth guard, a 200 because the route recovered — all
    // real information, none of them the claim this branch makes. Only 5xx becomes the new reason.
    for (const status of [200, 302, 401, 404]) {
      const got = explainNoSession(
        facts({
          everConnected: true,
          lastKnownUrl: 'http://localhost:3000/x',
          lastKnownStatus: status,
        }),
      );
      expect(got.reason, `status ${String(status)}`).toBe(NoSessionReason.TAB_GONE);
      expect(got.message).not.toMatch(/server error/i);
    }
  });

  it('a reaped lease still wins over a 5xx — the thing that vanished was ours, not the app', () => {
    const got = explainNoSession(
      facts({
        everConnected: true,
        leaseExpired: true,
        lastKnownUrl: 'http://localhost:3000/x',
        lastKnownStatus: 500,
      }),
    );
    expect(got.reason).toBe(NoSessionReason.LEASE_EXPIRED);
  });

  it('this project has connected before, but not on this daemon run', () => {
    expect(explainNoSession(facts({ previouslyConnected: true })).reason).toBe(
      NoSessionReason.APP_NOT_REOPENED,
    );
  });

  it('a config outside this directory is a scope problem, not an install one', () => {
    const got = explainNoSession(
      facts({ configsElsewhere: [{ directory: 'apps/web' }], listening: [3000] }),
    );
    expect(got.reason).toBe(NoSessionReason.CONFIG_ELSEWHERE);
  });

  it('nothing listening and no config here', () => {
    expect(explainNoSession(facts({})).reason).toBe(NoSessionReason.NO_LISTENER_NO_CONFIG);
  });

  it('nothing listening, but the project is wired', () => {
    expect(explainNoSession(facts({ initialized: true })).reason).toBe(NoSessionReason.NO_LISTENER);
  });

  it('something listening, but no config in this directory', () => {
    expect(explainNoSession(facts({ listening: [3000] })).reason).toBe(NoSessionReason.NO_CONFIG);
  });

  it('wired and listening, and the SDK still never arrived', () => {
    expect(explainNoSession(facts({ initialized: true, listening: [3000] })).reason).toBe(
      NoSessionReason.SDK_NOT_REACHING_DAEMON,
    );
  });
});

describe('the prose is the prose it always was', () => {
  // The refactor is only safe if the message is untouched: this is the most consequential sentence
  // in the product, and a reason bolted on at the cost of the sentence would be a bad trade.
  const cases: NoSessionFacts[] = [
    facts({ everConnected: true, leaseExpired: true }),
    facts({ everConnected: true }),
    facts({ previouslyConnected: true }),
    facts({ configsElsewhere: [{ directory: 'apps/web' }], listening: [3000] }),
    facts({}),
    facts({ initialized: true }),
    facts({ listening: [3000] }),
    facts({ initialized: true, listening: [3000] }),
  ];

  it('diagnoseNoSession returns exactly explainNoSession().message', () => {
    for (const f of cases) {
      expect(diagnoseNoSession(f)).toBe(explainNoSession(f).message);
    }
  });

  it('still says something on every branch', () => {
    // A branch that returned the empty string would satisfy the equality above and say nothing.
    for (const f of cases) {
      expect(diagnoseNoSession(f).length).toBeGreaterThan(80);
    }
  });

  it('gives a different sentence to each distinct situation', () => {
    // Eight codes over five sentences would be a vocabulary finer than the thing it describes.
    expect(new Set(cases.map((f) => diagnoseNoSession(f))).size).toBe(cases.length);
  });
});
