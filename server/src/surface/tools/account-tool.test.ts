/**
 * In 16 real coding-agent runs, none could tell its user how many credits they had or whether the
 * Harness could run: those facts lived only in the HUD and the dashboard.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { ACCOUNT_NEXT, ACCOUNT_TOOLS, accountFacts } from './account-tool.js';
import type { ToolDeps } from './tool-kit.js';

const ready = {
  provider: 'jev',
  available: { jev: true },
  harnessEnabled: true,
  credits: { used: 2, limit: 500, kind: 'trial' },
  plan: { kind: 'trial', daysLeft: 14, seats: 2 },
  harnessRunCredits: { typical: 5, max: 10 },
};

describe('where the user stands, for the coding agent', () => {
  it('signed out: one step, sign in, and nothing it cannot know', () => {
    const facts = accountFacts({ signedIn: false, platform: undefined });
    expect(facts).toEqual({ signedIn: false, linked: false, next: ACCOUNT_NEXT.SIGN_IN });
    // Free credit is granted once per person: the engine cannot promise a number (night 7b).
    expect(ACCOUNT_NEXT.SIGN_IN).not.toMatch(/\d/);
  });

  it('signed in, project not linked: link it', () => {
    expect(accountFacts({ signedIn: true, platform: undefined })['next']).toBe(ACCOUNT_NEXT.LINK);
  });

  it('the platform did not answer: says so, and does not guess credits', () => {
    const facts = accountFacts({
      signedIn: true,
      platform: null,
      cloudUrl: 'http://localhost:8899',
    });
    expect(facts['next']).toBe(ACCOUNT_NEXT.unreachable('http://localhost:8899'));
    expect(facts['credits']).toBeUndefined();
  });

  // Night 7b: the cloud unreachable must not read as "not linked", and the answer names the fix.
  it('unreachable names the cloud and what to do, never "link this project"', () => {
    const said = ACCOUNT_NEXT.unreachable('http://localhost:8899');
    expect(said).toContain('http://localhost:8899');
    expect(said).toMatch(/connection/);
    expect(said).not.toMatch(/Link this project|reticle connect/);
  });

  // Night 7: a tab of a linked project answered "press Link this project" when the daemon itself
  // started outside that project. The account is the tab's project's, as the Harness reads it.
  it("reads the link of the tab's own project, not the daemon's", async () => {
    const asked: (string | undefined)[] = [];
    const deps = {
      reticleRoot: '/daemon/.reticle',
      artifactRootFor: () => ({ root: '/app/.reticle' }),
      sessions: { resolve: () => ({ id: 's1', projectId: 'app' }) },
      linkedCloud: (root?: string) => {
        asked.push(root);
        return Promise.resolve(null);
      },
    } as unknown as ToolDeps;
    const tool = ACCOUNT_TOOLS.find((t) => ReticleTool.ACCOUNT === t.name);
    await tool?.handler(deps, { sessionId: 's1' });
    expect(asked).toEqual(['/app/.reticle']);
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
      harness: { on: true, runCredits: { typical: 5, max: 10 } },
    });
    expect(facts['next']).toBe(ACCOUNT_NEXT.ready(5, 10));
  });

  it("an older platform's low setup score and lock change nothing: the Harness is ready", () => {
    const facts = accountFacts({
      signedIn: true,
      platform: {
        ...ready,
        harnessUnlocked: false,
        coverageScore: 0.12,
        harnessLock: { reason: 'Missing: Stable test ids.', prompt: 'Add data-testid…' },
      },
    });
    expect(facts['harness']).toEqual({ on: true, runCredits: { typical: 5, max: 10 } });
    expect(facts['next']).toBe(ACCOUNT_NEXT.ready(5, 10));
  });

  it('off: switch it on; no credits left: says so first', () => {
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
