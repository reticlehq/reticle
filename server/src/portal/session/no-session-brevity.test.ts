/**
 * The sentence a PERSON reads is short. The differential behind it is still there, one call away.
 *
 * THE DEFECT THIS EXISTS FOR: `reticle init` prints the daemon's account of a failed connect, and
 * that account was one unbroken paragraph of roughly five hundred words. Observed on 2026-09-22 in
 * a real failed run: a port-scan disclaimer, a four-item differential, a lease offer and a
 * non-localhost essay, concatenated, with the one line that named the fix in the middle of it.
 * Every clause in it is true and most were written for a named field incident, which is why the
 * answer is to SPLIT rather than to delete: the reader who has thirty seconds gets the lead and the
 * next action, and the agent that is about to spend a drive on a wrong guess still gets all of it.
 *
 * The cap is a bound, not a style rule. It is deliberately loose enough that rephrasing a sentence
 * never reddens it, and tight enough that concatenating a second clause into the lead does.
 */
import { describe, expect, it } from 'vitest';
import {
  diagnoseNoSession,
  explainNoSession,
  type NoSessionFacts,
} from './no-session-diagnosis.js';

/**
 * What a lead may cost, in characters.
 *
 * Roughly four sentences. The longest lead in the set is the two-possibilities branch, which has
 * genuinely two things to weigh and says so; everything else sits well under this.
 */
const LEAD_BUDGET = 700;

/** One representative set of facts per branch, so no branch is measured by another's shape. */
const BRANCHES: readonly { readonly name: string; readonly facts: NoSessionFacts }[] = [
  {
    name: 'a refused hello',
    facts: {
      everConnected: false,
      initialized: true,
      listening: [5173],
      port: 4400,
      authRefused: true,
    },
  },
  {
    name: 'a lease that aged out',
    facts: {
      everConnected: true,
      initialized: true,
      listening: [5173],
      port: 4400,
      leaseExpired: true,
    },
  },
  {
    name: 'a tab that went away',
    facts: { everConnected: true, initialized: true, listening: [5173], port: 4400 },
  },
  {
    name: 'a project that connected on an earlier daemon',
    facts: {
      everConnected: false,
      initialized: true,
      listening: [5173],
      port: 4400,
      previouslyConnected: true,
    },
  },
  {
    name: 'a config in another directory',
    facts: {
      everConnected: false,
      initialized: false,
      listening: [5173],
      port: 4400,
      configsElsewhere: [{ directory: 'apps/web' }],
    },
  },
  {
    name: 'nothing listening and no config',
    facts: { everConnected: false, initialized: false, listening: [], port: 4400 },
  },
  {
    name: 'nothing listening, wired',
    facts: { everConnected: false, initialized: true, listening: [], port: 4400 },
  },
  {
    name: 'no config, something listening',
    facts: { everConnected: false, initialized: false, listening: [5173], port: 4400 },
  },
  {
    name: 'wired and silent',
    facts: { everConnected: false, initialized: true, listening: [5173], port: 4400 },
  },
];

describe('the lead a person reads', () => {
  it('covers every branch, so a pass is not a pass over three of them', () => {
    const reasons = new Set(BRANCHES.map((b) => explainNoSession(b.facts).reason));
    expect(reasons.size).toBe(BRANCHES.length);
  });

  for (const branch of BRANCHES) {
    it(`${branch.name}: the lead fits in ${String(LEAD_BUDGET)} characters`, () => {
      const { message } = explainNoSession(branch.facts);
      expect(
        message.length,
        `the lead for this branch is ${String(message.length)} characters:\n${message}`,
      ).toBeLessThanOrEqual(LEAD_BUDGET);
      // Not vacuous the other way either: a lead that says nothing is not a short lead.
      expect(message.length).toBeGreaterThan(60);
    });
  }
});

describe('nothing was thrown away', () => {
  for (const branch of BRANCHES) {
    it(`${branch.name}: the full text still contains the lead`, () => {
      const { message } = explainNoSession(branch.facts);
      expect(diagnoseNoSession(branch.facts)).toContain(message);
    });
  }

  it('the branches that had a differential still carry one', () => {
    const wired = BRANCHES.find((b) => 'wired and silent' === b.name);
    if (wired === undefined) throw new Error('fixture missing');
    const { detail } = explainNoSession(wired.facts);
    expect(detail ?? '').not.toBe('');
    // The clauses that exist because somebody was sent the wrong way without them.
    expect(detail ?? '').toContain('machine-wide scan');
    expect(diagnoseNoSession(wired.facts).length).toBeGreaterThan(
      explainNoSession(wired.facts).message.length,
    );
  });
});
