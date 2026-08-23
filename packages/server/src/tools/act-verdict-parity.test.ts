/**
 * Both verdict paths must look at the same evidence for the same question.
 *
 * `reticle_act_and_wait` is the tool the product tells agents to reach for first — it is named in
 * the MCP handshake, in SKILL.md, and in the cheatsheet. `reticle_assert` is the other one. They
 * answer the same question and they were not reading the same inputs: `assert` passed `prior` to
 * the contradiction engine and `act_and_wait` did not.
 *
 * `prior` is what makes `unit-mismatch` possible — the money false green, where a total renders 100x
 * off because a value in minor units is displayed as major. A scale error disagrees with a value the
 * API stated EARLIER in the session, so an action-scoped window can never contain both halves. No
 * `prior`, no comparison, no finding.
 *
 * So the flagship detector could not fire on the flagship path, and nothing anywhere said so: the
 * finding was not suppressed or downgraded, it was simply never produced. That is the same shape as
 * the three wiring defects already fixed this release — a capability that exists, is tested, and
 * never reaches the caller.
 *
 * This pins the property rather than the plumbing: whatever the two paths pass, they must agree on
 * the inputs that decide which contradiction kinds are REACHABLE.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8');

describe('act_and_wait and assert see the same evidence', () => {
  const act = src('act-tools.ts');
  const assert = src('assert-verdict.ts');

  it('both paths pass `prior` to the contradiction engine', () => {
    // Without this on the act path, `unit-mismatch` cannot fire there at all.
    expect(act).toMatch(/findContradictions\([\s\S]{0,200}prior/);
    expect(assert).toMatch(/findContradictions\([\s\S]{0,120}prior/);
  });

  it('both compute `prior` as everything strictly before the window', () => {
    // Same definition on both sides — a `prior` that overlapped the window would let an event be
    // both the claim and the counter-evidence.
    const shape = /queryEvents\(\{ since: 0 \}\)\)\.filter\(\(e\) => e\.t < since\)/;
    expect(act).toMatch(shape);
    expect(assert).toMatch(shape);
  });

  it('act_and_wait still passes the action and its effect — prior is added, not swapped', () => {
    expect(act).toMatch(/findContradictions\([\s\S]{0,450}action: acted/);
    expect(act).toMatch(/findContradictions\([\s\S]{0,450}session\.lastAct\.effect\(\)/);
  });

  /**
   * The declaration the caller wrote before acting has to reach the detector on BOTH paths. A fix
   * that lived only on `act_and_wait` would leave `reticle_assert` — the other half of the verdict
   * surface — still reporting an expected failure as a contradiction.
   */
  it('both paths hand the caller-declared expectations to the contradiction engine', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/declaredExpectations\(/);
      expect(file).toMatch(/expectedFailures:/);
      expect(file).toMatch(/renderProved:/);
    }
  });

  /**
   * Both verdict paths have to say which document is on screen, or the engine scopes nothing.
   *
   * The scoping is inert without it — `isSameDocument` reads an unknown current document as "counts
   * as current", which is right for an older SDK and wrong for a caller that simply forgot. A path
   * that stopped passing it would go on citing a replaced page's traffic with every gate green.
   */
  it('both paths tell the contradiction engine which document is on screen', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/currentDocumentId: session\.currentDocumentId/);
    }
  });

  /**
   * The caller's declaration has to reach the RULE, not only the detector.
   *
   * A satisfied `until` decides the verdict and settlement only corroborates it — but the rule
   * cannot tell a declared consequence from the implicit "wait for idle" unless the caller says so,
   * and a fix that reached only one of these two tools would leave half the verdict surface still
   * answering `unknown` to a consequence its caller named and Reticle watched hold.
   */
  it('both paths tell the rule whether the caller DECLARED the consequence', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/declaredConsequence:[\s\S]{0,60}!== PredicateKind\.SETTLED/);
    }
  });

  /**
   * An unread 2xx body is not a veto when the caller already proved the action on a channel the
   * body does not own. Both verdict paths have to say so, or half the surface still answers
   * `unknown` to a unique row the caller named and Reticle watched land.
   */
  it('both paths tell the rule when that declaration is independent of the response body', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/declaresBodyIndependentChannel\(/);
      expect(file).toMatch(/independentOfBody: true/);
    }
  });

  it('both paths name what kept the page busy when nothing was left in flight', () => {
    for (const file of [act, assert]) expect(file).toMatch(/repeated: repeatedRequestLabels\(/);
  });

  it('prior is documented as learning material, so nobody later attributes findings to it', () => {
    // Attribution must stay window-scoped on both paths: `prior` explains a value, it never sources
    // a finding. Stated in both files because the next person will read only one of them.
    expect(act).toMatch(/[Ll]earning material/);
    expect(assert).toMatch(/LEARNING material/);
  });

  it('both paths pass absenceBlindSpot to decideVerified', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/absenceBlindSpotNote\(/);
      expect(file).toMatch(/absenceBlindSpot === undefined \? \{\} : \{ absenceBlindSpot \}/);
    }
  });
});
