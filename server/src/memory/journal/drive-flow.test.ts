import { describe, expect, it } from 'vitest';
import { driveFlowsFrom, driveFlowName, carriesAnAssertion } from './drive-flow.js';
import { ReticleTool } from '@reticlehq/core';
import type { RecordedStep } from '../../language/flows/recording/tape/recordings.js';

const step = (expectIt: boolean, route?: string): RecordedStep => ({
  tool: ReticleTool.ACT,
  args: { ref: 'e1', action: 'click' },
  stable: true,
  ...(route === undefined ? {} : { route }),
  ...(expectIt ? { expect: { signal: 'saved' } } : {}),
});

describe('a drive becomes a flow without anybody asking', () => {
  it('saves a tape that declared a consequence', () => {
    const { programs, outcome } = driveFlowsFrom('tab-1', { steps: [step(false), step(true)] });
    expect(programs[0]?.steps).toHaveLength(2);
    expect(outcome.saved).toEqual([driveFlowName('tab-1')]);
    expect(outcome.unprovenSteps).toBeUndefined();
  });

  /**
   * The single condition, and the reason automatic saving is safe rather than reckless.
   *
   * A tape with no `expect` replays green whatever the app does. Saving one on every session would
   * manufacture a permanent pass per drive — a false-green factory, built by the product whose whole
   * purpose is to prevent them, running unattended. So it is counted and not written.
   */
  it('REFUSES to save a tape that asserts nothing, and says how much was driven', () => {
    const { programs, outcome } = driveFlowsFrom('tab-1', { steps: [step(false), step(false)] });
    expect(programs, 'a flow that cannot go red is not a regression test').toEqual([]);
    expect(outcome.saved).toBeUndefined();
    expect(outcome.unprovenSteps, 'drove and proved nothing must stay visible').toBe(2);
  });

  it('writes nothing for a session that drove nothing', () => {
    expect(driveFlowsFrom('tab-1', { steps: [] })).toEqual({ programs: [], outcome: {} });
    expect(driveFlowsFrom('tab-1', undefined)).toEqual({ programs: [], outcome: {} });
  });

  /**
   * Teardown fires on every socket close and a reconnecting tab keeps its session id, so a random
   * name would scatter one journey across several files, each a partial copy of the others. Same
   * reasoning as `driveRunId`, which was fixed for exactly this.
   */
  it('names the flow from the session, so a reconnect rewrites rather than duplicates', () => {
    expect(driveFlowName('tab-1')).toBe(driveFlowName('tab-1'));
    expect(driveFlowName('tab-1')).not.toBe(driveFlowName('tab-2'));
  });

  it('keeps a name usable as a filename under .reticle/flows/', () => {
    expect(driveFlowName('weird/../id with spaces')).toMatch(/^drive-[a-zA-Z0-9-]+$/);
  });

  it('carriesAnAssertion is the whole gate, and is exported so the caller cannot re-derive it', () => {
    expect(carriesAnAssertion([step(false)])).toBe(false);
    expect(carriesAnAssertion([step(false), step(true)])).toBe(true);
  });
});

/**
 * The login problem, which is what makes an ambient tape different from a recording somebody chose.
 *
 * A drive is a whole session: sign in, go somewhere, do a thing, go somewhere else. Saved whole, it
 * is ONE flow that begins at the login screen — and a suite of those fails from the second flow on,
 * because the app is already authenticated and the login steps no longer apply.
 *
 * MEASURED on the first implementation: 24 of 24 auto-captured flows embedded a login step and NONE
 * carried a `startPath`. `bench/harness/suite-rre.mjs` documents the same hazard and works around it
 * by recording its flows post-login by hand — this is that fix, done by the recorder.
 */
describe('a session that visited several routes becomes several flows', () => {
  const login = step(true, '/login');
  const compose = step(true, '/compose');
  const overview = step(true, '/overview');

  it('cuts the tape at route boundaries instead of saving one flow that starts at login', () => {
    const { programs } = driveFlowsFrom('tab-1', {
      steps: [login, compose, compose, overview],
    });
    expect(programs).toHaveLength(3);
    expect(programs.map((p) => p.startPath)).toEqual(['/login', '/compose', '/overview']);
    // The journey on /compose must NOT carry the login step — that is the whole bug.
    const composeFlow = programs.find((p) => '/compose' === p.startPath);
    expect(composeFlow?.steps).toHaveLength(2);
  });

  it('declares startPath, which is what makes a flow independent of the previous one', () => {
    // Replay navigates to `startPath` before step 1 (the FlowFile contract, flow-replay-run.ts), so
    // a segment that names its route does not care where the last flow left the tab.
    const { programs } = driveFlowsFrom('tab-1', { steps: [compose, overview] });
    for (const program of programs) expect(program.startPath).toBeDefined();
  });

  it('never writes the recorder-internal route onto the saved steps', () => {
    const { programs } = driveFlowsFrom('tab-1', { steps: [compose] });
    for (const s of programs[0]?.steps ?? []) {
      expect(s, 'route is how the tape was cut, not part of the flow').not.toHaveProperty('route');
    }
  });

  it('names each journey so two in one session do not overwrite each other', () => {
    const { programs } = driveFlowsFrom('tab-1', { steps: [compose, overview] });
    expect(new Set(programs.map((p) => p.name)).size).toBe(2);
  });

  it('still drops a journey that proved nothing, and counts it', () => {
    const { programs, outcome } = driveFlowsFrom('tab-1', {
      steps: [step(false, '/idle'), compose],
    });
    expect(programs.map((p) => p.startPath)).toEqual(['/compose']);
    expect(outcome.unprovenSteps).toBe(1);
  });
});
