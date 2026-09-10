import { afterEach, describe, expect, it } from 'vitest';
import { findContradictions } from './contradictions.js';
import {
  clearCrashedRules,
  crashedRuleNotes,
  registerContradictionFold,
} from './contradiction-folds.js';
import { SessionState, Verified, type ReticleEvent } from '@reticlehq/core';
import { LastAct } from '../session/last-act.js';
import { TOOLS, type ToolDef, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '@reticlehq/core';
import type { Session, SessionManager } from '../session/session.js';

/** A healthy session with nothing wrong with it, so any UNKNOWN below comes from the crashed rule. */
function deps(): ToolDeps {
  const events: ReticleEvent[] = [];
  const session: Partial<Session> = {
    id: 'demo',
    recordAction: () => 'a1',
    lastAct: new LastAct(),
    bufferHealth: () => ({ total: 12, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    eventsSince: () => events,
    queryEvents: () => Promise.resolve(events),
    elapsed: () => 1000,
    throttled: () => false,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

/**
 * A consumer rule that crashes must not make the app look healthier.
 *
 * This engine reports what is WRONG. Run it with fewer rules and it finds fewer things, and fewer
 * things read as a cleaner app -- so a crashing rule quietly turns into a better verdict. That is a
 * false green arriving through the back door.
 *
 * The crash was always contained and always logged. What was missing is that nothing which decides a
 * verdict reads a log, so the containment alone left the verdict saying "clean" about a look that was
 * not clean. These tests follow the crash all the way to the verdict, because a connection that
 * exists but does not reach the answer is the failure this repo keeps finding in its own guards.
 */

afterEach(() => clearCrashedRules());

const brokenRule = () => {
  throw new Error('cannot read length of undefined');
};

describe('a crashed consumer rule reaches the verdict', () => {
  it('starts with nothing to report, so an empty result means something', () => {
    // The negative control. Without it every assertion below could be passing because the mechanism
    // never runs at all.
    expect(crashedRuleNotes()).toEqual([]);
  });

  it('a rule that throws is still contained -- the engine keeps working', () => {
    const undo = registerContradictionFold(brokenRule);
    expect(() => findContradictions([], {})).not.toThrow();
    undo();
  });

  it('and the crash is recorded where a verdict can see it', () => {
    const undo = registerContradictionFold(brokenRule);
    findContradictions([], {});
    undo();
    expect(crashedRuleNotes()).toHaveLength(1);
    expect(crashedRuleNotes()[0]).toContain('findings may be missing');
    expect(crashedRuleNotes()[0]).toContain('cannot read length of undefined');
  });

  it('one rule crashing on every event reports one blind spot, not thousands', () => {
    const undo = registerContradictionFold(brokenRule);
    for (let i = 0; i < 50; i += 1) findContradictions([], {});
    undo();
    expect(crashedRuleNotes()).toHaveLength(1);
  });

  it('the whole way through: a real assert call turns UNKNOWN because a rule crashed', async () => {
    // The assertion that matters, and the reason it drives the real tool rather than assembling the
    // pieces by hand. Everything above proves a part works. Only this proves the parts are JOINED --
    // that the verdict site actually asks whether a rule crashed. A test that wires the parts
    // together itself would pass just as happily with the wiring absent, which is the failure this
    // file is about.
    const call = () =>
      tool(ReticleTool.ASSERT).handler(deps(), {
        predicate: { kind: 'console', level: 'error', absent: true },
        timeout_ms: 0,
      }) as Promise<{ verified: string }>;

    expect((await call()).verified).toBe(Verified.YES);

    const undo = registerContradictionFold(brokenRule);
    findContradictions([], {});
    undo();

    const after = await call();
    expect(after.verified).toBe(Verified.UNKNOWN);
    expect(after.verified).not.toBe(Verified.YES);
  });
});
