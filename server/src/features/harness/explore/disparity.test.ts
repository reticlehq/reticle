import { describe, expect, it } from 'vitest';
import { DisparityKind, Verified, VerifiedReason, type JournalAction } from '@reticlehq/core';
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

/* Persona 24: the agent's pre-check that the words were NOT shown was read as its claim that they were. */
describe('an agent claim that the goal is absent', () => {
  it('is not the agent claiming the goal', () => {
    const negated = [
      { claim: "the absence of text containing '--project 'shop''", verified: Verified.YES },
    ];
    expect(
      disparityFor({ text: "--project 'shop'", verified: Verified.UNKNOWN }, negated, undefined),
    ).toBeUndefined();
  });

  it('still counts the positive half of a claim that also names an absence', () => {
    const mixed = [
      {
        claim: "all of (text containing 'Saved'; the absence of text containing 'Error')",
        verified: Verified.YES,
      },
    ];
    expect(disparityFor({ text: 'Saved', verified: Verified.YES }, mixed, undefined)?.kind).toBe(
      DisparityKind.FINDABLE,
    );
  });
});

/* Persona 21: the agent's claim and the goal named the same words in different quotes and spacing. */
describe('a claim in its own words', () => {
  it('still names the goal when only quotes, case and spacing differ', () => {
    const d = disparityFor(
      { text: 'Free shipping threshold', verified: Verified.UNKNOWN },
      [{ claim: 'text containing ‘free  Shipping threshold’', verified: Verified.YES }],
      undefined,
    );
    expect(d?.kind).toBe(DisparityKind.DISCOVERABILITY);
  });
});

/* Persona 22: the goal was on screen from the first frame, and the comparison called it hard to find. */
describe('a goal on the page before the drive began', () => {
  it('is findable, never a discoverability finding', () => {
    const d = disparityFor(
      {
        text: 'Order confirmed',
        verified: Verified.UNKNOWN,
        reason: `${VerifiedReason.ALREADY_TRUE}: it was on the page before the drive started`,
      },
      [{ claim: "text containing 'Order confirmed'", verified: Verified.YES }],
      undefined,
    );
    expect(d).toMatchObject({ kind: DisparityKind.FINDABLE, harness: { found: true } });
  });
});
