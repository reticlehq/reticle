/**
 * A crawl that opened a door must not report the room beyond it as clean.
 *
 * Found by driving the bench app. `reticle_crawl { maxSteps: 12 }` on the login screen returned:
 *
 *   interactiveFound: 3, stepsRun: 3, anomalies: [], counts.deadControls: 0, truncated: false
 *
 * and a snapshot taken immediately afterwards showed seven dashboard controls — Overview,
 * Deployments, Compose, Diagnostics, Hostile, search, Sign out — that the crawl's OWN click on
 * "Sign in" had put on the page. It stopped at three steps with nine of its twelve unused.
 *
 * The one-pass design is defensible: re-scanning after every click needs a frontier order, a
 * visited-set that survives re-render, and a story for controls that navigate away. What is not
 * defensible is the report. `truncated: false` positively asserts nothing was cut off, and
 * `deadControls: 0` reads as a verdict on the app rather than on three controls — so anyone pointing
 * this at an app behind a login gets an empty anomaly list from the login form and calls it a sweep.
 *
 * This repo already names that failure in `serialization.ts`: "a partial answer that cannot be
 * distinguished from a complete one is the precise shape of a false green".
 *
 * The fix reuses the vocabulary already here rather than inventing a field. `truncated` is documented
 * as "coverage was bounded", and coverage IS bounded when the surface grew and the crawl did not
 * follow. `coverageNote` already exists to say why. The sibling case — a page larger than one
 * snapshot — says `interactiveFound` "is a floor, not a total"; that sentence is true here too, for
 * a different reason, and was simply never emitted.
 */

import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { crawl } from './crawl.js';

const noSleep = (): Promise<void> => Promise.resolve();

/** A page whose interactive surface changes after the Nth snapshot, the way a login does. */
class RevealingSession {
  snapshots = 0;
  constructor(
    private readonly before: string,
    private readonly after: string,
  ) {}
  elapsed(): number {
    return 0;
  }
  command(name: string): Promise<CommandResult> {
    if (name === ReticleCommand.SNAPSHOT) {
      this.snapshots += 1;
      // The first snapshot is the crawl's enumeration; any later one is the re-check.
      const tree = 1 === this.snapshots ? this.before : this.after;
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: { tree } });
    }
    // Every click "works": dispatched, and the app reacts, so nothing is a dead control.
    return Promise.resolve({
      kind: 'command_result',
      id: 'x',
      ok: true,
      result: { ok: true, dispatched: true },
    });
  }
  eventsSince(): ReticleEvent[] {
    // One DOM event so the click never counts as inert — this test is about coverage, not anomalies.
    return [{ type: 'dom.added', t: 1, data: {} } as unknown as ReticleEvent];
  }
}

const LOGIN =
  '- textbox "Email" (ref=e1)\n- textbox "Password" (ref=e2)\n- button "Sign in" (ref=e3)';
const DASHBOARD =
  '- button "Overview" (ref=e17)\n- button "Deployments" (ref=e18)\n- button "Compose" (ref=e19)\n' +
  '- button "Diagnostics" (ref=e20)\n- button "Hostile" (ref=e21)\n- button "Sign out" (ref=e23)';

describe('a crawl says so when its own clicks revealed controls it did not visit', () => {
  it('does not claim untruncated coverage after the surface grew', async () => {
    // The exact shape measured against the bench app: budget to spare, and a clean-looking result.
    const session = new RevealingSession(LOGIN, DASHBOARD);
    const report = await crawl(session, { maxSteps: 12 }, noSleep);
    expect(report.stepsRun).toBe(3);
    expect(report.truncated).toBe(true);
  });

  it('says how many appeared and were never visited', async () => {
    const session = new RevealingSession(LOGIN, DASHBOARD);
    const report = await crawl(session, { maxSteps: 12 }, noSleep);
    expect(report.coverageNote).toBeDefined();
    expect(report.coverageNote).toContain('6');
    // "floor, not a total" is the existing phrasing for the sibling case; the reader should meet the
    // same words rather than a second vocabulary for the same idea.
    expect(report.coverageNote).toContain('floor');
  });

  it('stays quiet when the surface did not change', async () => {
    // The common case must not grow a warning it does not deserve, or the warning stops being read.
    const session = new RevealingSession(LOGIN, LOGIN);
    const report = await crawl(session, { maxSteps: 12 }, noSleep);
    expect(report.stepsRun).toBe(3);
    expect(report.truncated).toBe(false);
    expect(report.coverageNote).toBeUndefined();
  });

  it('does not mistake controls DISAPPEARING for new coverage', async () => {
    // A crawl that closes a modal shrinks the surface. Nothing went unvisited, so nothing to say.
    const session = new RevealingSession(DASHBOARD, '- button "Overview" (ref=e17)');
    const report = await crawl(session, { maxSteps: 12 }, noSleep);
    expect(report.coverageNote).toBeUndefined();
    expect(report.truncated).toBe(false);
  });

  it('still reports the step budget running out, independently', async () => {
    // The pre-existing reason for `truncated` must keep working on its own.
    const session = new RevealingSession(DASHBOARD, DASHBOARD);
    const report = await crawl(session, { maxSteps: 2 }, noSleep);
    expect(report.stepsRun).toBe(2);
    expect(report.truncated).toBe(true);
  });
});
