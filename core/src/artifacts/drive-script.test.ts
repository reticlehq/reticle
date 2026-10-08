import { describe, expect, it } from 'vitest';
import { DriveScriptSchema, barriersOf, checkScript, stepLabel } from './drive-script.js';

const merchant = {
  version: 1,
  source: 'local',
  personas: [{ name: 'Support agent', journey: 'refund a disputed order' }],
  journeys: [
    { id: 'signin', title: 'Sign in', steps: [{ kind: 'replay', flow: 'signin' }] },
    {
      id: 'refund',
      title: 'Refund an order',
      persona: 'Support agent',
      dependsOn: ['signin'],
      steps: [
        { kind: 'replay', flow: 'refund-flow', to: 3 },
        { kind: 'checkpoint', id: 'dialog', reenter: { flow: 'refund-flow', to: 3 } },
        {
          kind: 'branch',
          at: 'dialog',
          cases: [
            {
              label: 'full',
              steps: [
                {
                  kind: 'act',
                  target: { testid: 'refund-full' },
                  action: 'click',
                  until: { kind: 'signal', name: 'refund:issued' },
                },
              ],
            },
            { label: 'partial', steps: [{ kind: 'act', goal: 'refund part of the order' }] },
          ],
        },
      ],
    },
    {
      id: 'settings',
      title: 'Payout settings',
      dependsOn: ['signin'],
      steps: [{ kind: 'replay', flow: 'payout-settings' }],
    },
    {
      id: 'audit',
      title: 'Audit the refund',
      dependsOn: ['refund'],
      steps: [{ kind: 'replay', flow: 'audit-log' }],
    },
  ],
  lanes: [
    { id: 'A', journeys: ['signin', 'refund'] },
    { id: 'B', journeys: ['signin', 'settings', 'audit'] },
  ],
};

describe('drive script', () => {
  it('parses a plan with lanes, a barrier, a checkpoint and a branch, and finds nothing wrong', () => {
    const script = DriveScriptSchema.parse(merchant);
    expect(checkScript(script)).toEqual([]);
    expect(barriersOf(script, 'B', 'audit')).toEqual(['refund']);
    expect(barriersOf(script, 'B', 'settings')).toEqual([]);
    const first = script.journeys[1]?.steps[0];
    expect(first === undefined ? '' : stepLabel(first)).toBe('Replay refund-flow to step 3');
  });

  it('refuses an act that is both exact and open', () => {
    const bad = structuredClone(merchant);
    bad.journeys[0] = {
      id: 'signin',
      title: 'Sign in',
      steps: [{ kind: 'act', action: 'click', goal: 'sign in' } as never],
    };
    expect(DriveScriptSchema.safeParse(bad).success).toBe(false);
  });

  it('names a barrier pointing at a later lane, a dangling dependency and a branch with no checkpoint', () => {
    const script = DriveScriptSchema.parse({
      ...merchant,
      journeys: [
        ...merchant.journeys.filter((j) => 'refund' !== j.id),
        {
          id: 'refund',
          title: 'Refund',
          dependsOn: ['settings', 'ghost'],
          steps: [{ ...(merchant.journeys[1]?.steps[2] as object), at: 'nowhere' }],
        },
      ],
    });
    const problems = checkScript(script).join('\n');
    expect(problems).toContain('needs "settings", which is neither earlier');
    expect(problems).toContain('depends on unknown "ghost"');
    expect(problems).toContain('branches at "nowhere"');
  });
});
