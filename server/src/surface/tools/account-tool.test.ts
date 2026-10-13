/**
 * In 16 real coding-agent runs, none could tell its user how many credits they had or whether the
 * Harness could run: those facts lived only in the HUD and the dashboard.
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNT_NEXT, accountFacts } from './account-tool.js';

const ready = {
  provider: 'jev',
  available: { jev: true },
  harnessEnabled: true,
  harnessUnlocked: true,
  coverageScore: 0.875,
  credits: { used: 2, limit: 500, kind: 'trial' },
  plan: { kind: 'trial', daysLeft: 14, seats: 2 },
  harnessRunCredits: { typical: 5, max: 10 },
};

describe('where the user stands, for the coding agent', () => {
  it('signed out: one step, sign in, and nothing it cannot know', () => {
    const facts = accountFacts({ signedIn: false, platform: undefined });
    expect(facts).toEqual({ signedIn: false, linked: false, next: ACCOUNT_NEXT.SIGN_IN });
  });

  it('signed in, project not linked: link it', () => {
    expect(accountFacts({ signedIn: true, platform: undefined })['next']).toBe(ACCOUNT_NEXT.LINK);
  });

  it('the platform did not answer: says so, and does not guess credits', () => {
    const facts = accountFacts({ signedIn: true, platform: null });
    expect(facts['next']).toBe(ACCOUNT_NEXT.UNREACHABLE);
    expect(facts['credits']).toBeUndefined();
  });

  it('ready: the plan, the credits in the platform words, the run cost, and how to start one', () => {
    const facts = accountFacts({
      signedIn: true,
      workspace: 'example',
      dashboardUrl: 'http://localhost:16580/issues?project=shop',
      platform: ready,
    });
    expect(facts).toMatchObject({
      signedIn: true,
      workspace: 'example',
      linked: true,
      plan: { kind: 'trial', daysLeft: 14, seats: 2 },
      credits: {
        used: 2,
        limit: 500,
        left: 498,
        said: 'Trial: 2 of 500 credits used · 498 left · 14 days left',
      },
      harness: { on: true, unlocked: true, setupScore: 87, runCredits: { typical: 5, max: 10 } },
    });
    expect(facts['next']).toBe(ACCOUNT_NEXT.ready(5, 10));
  });

  it('below the gate: the score, what is missing, and the setup prompt', () => {
    const facts = accountFacts({
      signedIn: true,
      platform: {
        ...ready,
        harnessUnlocked: false,
        coverageScore: 0.62,
        harnessLock: { reason: 'Missing: Stable test ids.', prompt: 'Add data-testid…' },
      },
    });
    expect(facts['harness']).toMatchObject({
      unlocked: false,
      setupScore: 62,
      missing: 'Missing: Stable test ids.',
      setupPrompt: 'Add data-testid…',
    });
    expect(facts['next']).toBe(ACCOUNT_NEXT.locked(62, 'Missing: Stable test ids.'));
  });

  it('unlocked and off: switch it on; no credits left: says so first', () => {
    expect(
      accountFacts({ signedIn: true, platform: { ...ready, harnessEnabled: false } })['next'],
    ).toBe(ACCOUNT_NEXT.OFF);
    const spent = accountFacts({
      signedIn: true,
      platform: { ...ready, credits: { used: 500, limit: 500, kind: 'trial' } },
    });
    expect(String(spent['next'])).toContain('cannot run until the user gets more credits');
  });
});
