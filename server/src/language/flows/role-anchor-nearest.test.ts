/**
 * A role+name anchor was unhealable BY CONSTRUCTION, and the message blamed the confidence floor.
 *
 * Reported from a sweep of a Next app-router project: a first-try, three-step, presence-only flow
 * failed with `button named 'Menu' did not resolve`, and `flow_heal` answered `unhealable — no
 * nearest match cleared the confidence floor`. That reads as "heal considered the candidates and
 * none was good enough". It considered nothing: `runRoleStep` returns `nearest: null` as a literal,
 * so there was never a candidate to score, whatever the drift.
 *
 * The advice attached to it ("add a data-testid") is right, and stays. What was wrong is presenting
 * a hard structural limit as a judgement call — an agent reads it as "this flow is beyond help"
 * rather than "nothing looked for a replacement".
 *
 * Auto-healing is deliberately NOT extended here. A testid is an identifier we asked the developer
 * to put there; a role name is user-visible text where "Save" and "Save as" are one edit apart, so
 * silently rebinding is exactly the wrong-element green this product exists to catch. The candidate
 * is surfaced for the agent to judge, and never applied on its own.
 */

import { describe, expect, it } from 'vitest';
import { nearestRoleName } from './role-anchor-nearest.js';

describe('a role anchor gets a candidate, not a dead end', () => {
  it('finds the closest name among controls of the SAME role', () => {
    // A plausible rename: one character of nine changed.
    expect(
      nearestRoleName('button', 'Settings', [
        { role: 'button', name: 'Setting' },
        { role: 'link', name: 'Settings' },
      ]),
    ).toBe('Setting');
  });

  it('will not stretch a SHORT name into a longer one', () => {
    // "Menu" -> "Menu bar" is four edits on a four-character name: the whole name changed. On a real
    // page those are far more likely to be two different controls than one renamed one, and naming
    // it would hand the agent a confident wrong answer. This is the case from the field report, and
    // saying nothing is the correct outcome — the flow wants a data-testid.
    expect(nearestRoleName('button', 'Menu', [{ role: 'button', name: 'Menu bar' }])).toBeNull();
  });

  it('never crosses roles — a link named Menu is not a button named Menu', () => {
    expect(nearestRoleName('button', 'Menu', [{ role: 'link', name: 'Menu' }])).toBeNull();
  });

  it('refuses to guess when two names tie — an ambiguous rebind is a coin flip', () => {
    expect(
      nearestRoleName('button', 'Save', [
        { role: 'button', name: 'Save1' },
        { role: 'button', name: 'Save2' },
      ]),
    ).toBeNull();
  });

  it('refuses when nothing is remotely close, rather than offering noise', () => {
    expect(
      nearestRoleName('button', 'Menu', [{ role: 'button', name: 'Delete everything' }]),
    ).toBeNull();
  });

  it('is null on an empty page rather than throwing', () => {
    expect(nearestRoleName('button', 'Menu', [])).toBeNull();
  });
});
