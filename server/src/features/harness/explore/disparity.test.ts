import { describe, expect, it } from 'vitest';
import { DisparityKind, Verified, type JournalAction } from '@reticlehq/core';
import { agentVerdictsIn, disparityFor } from './disparity.js';

const action = (claim: string, verified: string, harness?: string): JournalAction => ({
  v: 1,
  actionId: `c-${claim}`,
  tool: 'reticle_assert',
  args: {},
  effect: { claim, verified },
  tRange: { from: 0, to: 1 },
  at: 1,
  ...(harness === undefined ? {} : { drivenBy: { harness, driver: 'server' } }),
});

describe("the agent's verdicts a Harness goal is compared with", () => {
  it('are the decided ones the agent made, never the Harness', () => {
    const verdicts = agentVerdictsIn([
      action("text containing 'Reopened by'", Verified.YES),
      action("text containing 'Reopened by'", Verified.NO, 'h1'),
      action("text containing 'Fixed'", Verified.UNKNOWN),
    ]);
    expect(verdicts).toEqual([{ claim: "text containing 'Reopened by'", verified: Verified.YES }]);
  });
});

describe('one goal, judged both ways', () => {
  const agent = (verified: Verified) => [{ claim: "text containing 'Reopened by'", verified }];
  const searched = {
    found: false,
    searched: ['/issues?q=checkout+defect', '/issues'],
    gaveUpAt: '/issues',
  };

  /* Persona 7: the agent proved "Reopened by" after a scroll; the Harness never opened the issue. */
  it('is a discoverability finding when the agent proved what the Harness could not find', () => {
    const d = disparityFor(
      { text: 'Reopened by', verified: Verified.UNKNOWN },
      agent(Verified.YES),
      searched,
    );
    expect(d).toMatchObject({
      kind: DisparityKind.DISCOVERABILITY,
      harness: { found: false, gaveUpAt: '/issues', searched: searched.searched },
    });
  });

  it('classifies the other three', () => {
    const yes = { text: 'Reopened by', verified: Verified.YES };
    const no = { text: 'Reopened by', verified: Verified.NO };
    expect(disparityFor(yes, agent(Verified.YES), undefined)?.kind).toBe(DisparityKind.FINDABLE);
    expect(disparityFor(yes, agent(Verified.NO), undefined)?.kind).toBe(
      DisparityKind.AGENT_ASSUMPTION,
    );
    expect(disparityFor(no, agent(Verified.NO), undefined)?.kind).toBe(DisparityKind.DEFECT);
  });

  it('says nothing without a decided agent claim about the goal, or for an absence', () => {
    expect(
      disparityFor({ text: 'Passed', verified: Verified.YES }, agent(Verified.YES), undefined),
    ).toBeUndefined();
    expect(
      disparityFor(
        { text: 'Reopened by', absent: true, verified: Verified.YES },
        agent(Verified.YES),
        undefined,
      ),
    ).toBeUndefined();
  });
});
