import { describe, expect, it } from 'vitest';
import { MutationKind, MutationOutcome } from '@reticlehq/openreality';
import { mutationTest } from './mutation-run.js';

/**
 * Replay, break the thing the flow watches, replay again, and grade the FLOW.
 *
 * This is the loop that turns "95% of recorded steps would not notice if the feature broke" from a
 * complaint into a number the engine assigns itself. Everything it needs already exists; what it
 * adds is the one property that makes running it safe.
 *
 * **The reversal is the whole design.** A mutation is a real break on a real page. If a replay throws
 * mid-flight and the break is not undone, the next flow inherits a subject that is not the subject —
 * every verdict after it is about an app that answers 500 to something the developer never broke,
 * and the run would report a cascade of failures with no cause anybody can find. So the undo runs on
 * every path out of here, including the ones nobody planned.
 */

const BREAK = { kind: MutationKind.REQUEST_FAILS, target: '/api/orders' };

function harness(
  replays: ('pass' | 'fail' | Error)[],
  over: { mutate?: () => Promise<{ mutation: string }> } = {},
) {
  const log: string[] = [];
  let call = 0;
  return {
    log,
    deps: {
      replay: (): Promise<'pass' | 'fail'> => {
        const next = replays[call] ?? 'pass';
        call += 1;
        log.push('replay');
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      mutate:
        over.mutate ??
        ((): Promise<{ mutation: string }> => {
          log.push('mutate');
          return Promise.resolve({ mutation: 'request-fails:/api/orders' });
        }),
      revert: (): Promise<void> => {
        log.push('revert');
        return Promise.resolve();
      },
    },
  };
}

describe('what the loop establishes', () => {
  it('KILLS when a green flow goes red against the break', async () => {
    const { deps } = harness(['pass', 'fail']);
    expect(await mutationTest(deps, BREAK)).toBe(MutationOutcome.KILLED);
  });

  it('SURVIVES when the flow stays green through it', async () => {
    const { deps } = harness(['pass', 'pass']);
    expect(await mutationTest(deps, BREAK)).toBe(MutationOutcome.SURVIVED);
  });
});

describe('what it refuses to do', () => {
  it('never breaks the page for a flow that was already failing', async () => {
    // Inconclusive whatever happens next, so breaking a real page to learn nothing is pure cost —
    // and every mutation carries the risk of not being undone.
    const { deps, log } = harness(['fail']);
    expect(await mutationTest(deps, BREAK)).toBe(MutationOutcome.INCONCLUSIVE);
    expect(log).toEqual(['replay']);
  });

  it('is inconclusive when the realm refused the mutation, and reverts nothing', async () => {
    const { deps, log } = harness(['pass'], {
      mutate: () => Promise.reject(new Error('a driven web page cannot perform that')),
    });
    expect(await mutationTest(deps, BREAK)).toBe(MutationOutcome.INCONCLUSIVE);
    expect(log).not.toContain('revert');
  });
});

describe('putting the page back', () => {
  it('reverts after a completed run', async () => {
    const { deps, log } = harness(['pass', 'fail']);
    await mutationTest(deps, BREAK);
    expect(log).toEqual(['replay', 'mutate', 'replay', 'revert']);
  });

  it('reverts even when the second replay THROWS', async () => {
    // The property the whole loop is built around. A break left behind makes every later verdict a
    // statement about a different app.
    const { deps, log } = harness(['pass', new Error('session died mid-replay')]);
    expect(await mutationTest(deps, BREAK)).toBe(MutationOutcome.INCONCLUSIVE);
    expect(log).toEqual(['replay', 'mutate', 'replay', 'revert']);
  });

  it('reports inconclusive rather than a survival when the run could not finish', async () => {
    // A replay that threw did not stay green — it said nothing. Grading that as SURVIVED would
    // demote a flow for an error in the harness.
    const { deps } = harness(['pass', new Error('boom')]);
    expect(await mutationTest(deps, BREAK)).toBe(MutationOutcome.INCONCLUSIVE);
  });

  it('still answers when the revert itself fails, having tried', async () => {
    // Nothing here can fix a page that will not be fixed, and throwing would replace a usable grade
    // with an exception. The failure belongs to the caller that owns the page.
    const { deps } = harness(['pass', 'fail']);
    const failing = { ...deps, revert: () => Promise.reject(new Error('target closed')) };
    expect(await mutationTest(failing, BREAK)).toBe(MutationOutcome.KILLED);
  });
});
