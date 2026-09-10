/**
 * The no-session diagnosis must not assert more than it checked.
 *
 * `initialized` is ONE fact: whether a `.reticle.json` sits in the directory this daemon happens to
 * be running in. It is routinely false for apps that are instrumented and working —
 *
 *   - a monorepo whose daemon runs at the root while the app lives in `apps/web`;
 *   - any app wired by the Vite or Babel plugin rather than by `reticle init`.
 *
 * A previous version of this branch promoted that fact into the claim "this project has not been
 * through `reticle init`" AND led with it, on the reasoning that it was a certainty while the port
 * scan was a guess. It is not a certainty. Caught by an agent driving Reticle's own repository: the
 * message told it the project had never been initialised, about a fixture that is instrumented and
 * working, and it reported that as the one sentence it was most likely to act on.
 *
 * This is the same defect the whole file exists to prevent — a confident sentence built on evidence
 * that does not support it — so it is pinned rather than left to a comment.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseNoSession } from './no-session-diagnosis.js';

const facts = {
  everConnected: false,
  initialized: false,
  listening: [] as number[],
  port: 4400,
};

describe('claims are bounded by what was checked', () => {
  const message = diagnoseNoSession(facts);

  it('does not assert that init has never run', () => {
    // The absence of a config file in ONE directory cannot support this claim.
    expect(message).not.toMatch(/has not been through `reticle init`/);
    expect(message).not.toMatch(/never been through/i);
  });

  it('says what it actually looked at', () => {
    expect(message).toContain('.reticle.json');
    expect(message).toMatch(/directory this daemon is running in/);
  });

  it('still names the SDK, which is why starting a server alone may not help', () => {
    expect(message).toMatch(/SDK/);
  });

  it('names the two cases where that absence is expected, not diagnostic', () => {
    expect(message).toMatch(/monorepo/i);
    expect(message).toMatch(/plugin/i);
  });

  it('still tells the reader what to do about it', () => {
    expect(message).toMatch(/check the app's OWN directory/i);
    // …and, when the scan really is right, who starts the dev server and where the command comes
    // from. Deliberately NOT `npm run dev`: a hardcoded command is a guess about the package manager
    // and the script name both, and the literal one now rides on `next_action` instead.
    expect(message).toMatch(/start it/i);
    expect(message).toMatch(/next_action/);
    expect(message).not.toMatch(/npm run dev/);
  });

  it('does not present an empty port scan as proof the app is down', () => {
    expect(message).toMatch(/neither of them is proof/i);
    expect(message).toMatch(/invisible to it/);
  });

  it('keeps the strong claim when a session HAS connected — that one is observed', () => {
    // Contrast case: "one WAS connected to this daemon earlier" is a fact the daemon witnessed
    // itself, so stating it plainly is correct. The rule is about evidence, not about hedging.
    const seen = diagnoseNoSession({ ...facts, everConnected: true });
    expect(seen).toContain('one WAS connected to this daemon earlier');
  });
});
