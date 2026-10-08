import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BLOCKING_WAIT_MS } from '@/surface/tools/args/numeric-bounds.js';
import { LastAct } from '@/portal/session/last-act.js';
import { ReticleTool, SessionState, Verified } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { VERDICT_TOOLS } from '@/surface/tools/feedback-tools.js';
import { createFakeSession } from '@/portal/session/fake-session.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';

/**
 * `reticle_assert { action: "wait" }` is graded like `now` (#1119).
 *
 * The merged tool's description says "Both return a verdict; only `verified:"yes"` is a pass", and
 * `wait` returned `{ pass, evidence }` with no `verified` at all. So an agent following the rule had
 * to call `now` after every `wait`, and a `wait` pass over an evicted buffer carried no grade that
 * could say so. The check the issue names: one passing predicate, the same `verified` and
 * `verifiedReason` from `wait` and from `now` with a budget.
 */
function deps(dropped = 0): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    recordAction: () => 'a1',
    lastAct: new LastAct(),
    bufferHealth: () => ({ total: 12, dropped }),
    lostSince: () => 0 < dropped,
    blindSpots: () => ({}),
    eventsSince: () => [],
    queryEvents: () => Promise.resolve([]),
    onEvent: () => () => undefined,
    elapsed: () => 1000,
    throttled: () => false,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    now: () => 1,
    recordings: new RecordingStore(),
  } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

const cleanConsole = { kind: 'console', level: 'error', absent: true };

interface Graded {
  pass: boolean;
  verified?: string;
  verifiedReason?: string;
}

describe('wait and now are one verdict under two budgets', () => {
  it('a passing predicate carries the same verified and verifiedReason under both', async () => {
    const waited = (await tool(ReticleTool.WAIT_FOR).handler(deps(), {
      predicate: cleanConsole,
      timeout_ms: 500,
    })) as Graded;
    const now = (await tool(ReticleTool.ASSERT).handler(deps(), {
      predicate: cleanConsole,
      timeout_ms: 500,
    })) as Graded;

    expect(waited.pass).toBe(true);
    expect(waited.verified, 'wait must carry the field agents are told to read').toBeDefined();
    expect(waited.verified).toBe(now.verified);
    expect(waited.verifiedReason).toBe(now.verifiedReason);
  });

  it('a wait over an evicted window is graded down, not a clean pass', async () => {
    const intact = (await tool(ReticleTool.WAIT_FOR).handler(deps(0), {
      predicate: cleanConsole,
      timeout_ms: 500,
    })) as Graded;
    const evicted = (await tool(ReticleTool.WAIT_FOR).handler(deps(7), {
      predicate: cleanConsole,
      timeout_ms: 500,
    })) as Graded;

    expect(intact.verified).toBe(Verified.YES);
    expect(evicted.verified).not.toBe(Verified.YES);
  });

  it('counts as a verification, like every other tool that returns a verdict', () => {
    expect(VERDICT_TOOLS.has(ReticleTool.WAIT_FOR)).toBe(true);
  });
});

describe('what the graded wait declares and points at', () => {
  it('declares verified and verifiedReason, so a validating client keeps them', () => {
    for (const name of [ReticleTool.ASSERT, ReticleTool.WAIT_FOR]) {
      const declared = Object.keys(tool(name).outputSchema ?? {});
      expect(declared, name).toContain('verified');
      expect(declared, name).toContain('verifiedReason');
    }
  });

  it('an inconclusive wait borrows no file:line from an earlier act', async () => {
    const lastAct = new LastAct();
    lastAct.markSource('src/components/Toolbar.tsx:44');
    const session = createFakeSession({
      lastAct,
      elapsed: () => 1000,
      // The page never answers the store read, so the wait could not look at the app at all.
      command: () => Promise.reject(new Error('command timed out')),
    });
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const out = (await tool(ReticleTool.WAIT_FOR).handler(
      {
        sessions: sessions as SessionManager,
        now: () => 1,
        recordings: new RecordingStore(),
      } as unknown as ToolDeps,
      { predicate: { kind: 'state', path: 'cart.count', equals: 1 }, timeout_ms: 50 },
    )) as { pass: boolean; inconclusive?: string; source?: string };

    expect(out.pass).toBe(false);
    expect(out.inconclusive).toBeDefined();
    expect(out.source, 'nothing was proven, so there is nothing to point at').toBeUndefined();
  });
});

// A wait longer than one call may block comes back with `resume_ms` when the predicate is not met
// yet. That is "not yet": grading it made a check still in progress a red verdict, recorded as one,
// since `wait` counts as a verification.
describe('a wait the per-call cap paused', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not graded and records nothing, and says how long is left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const recorded: string[] = [];
    const session = createFakeSession({
      lastAct: new LastAct(),
      elapsed: () => 1000,
      recordAction: (tool: string) => {
        recorded.push(tool);
        return 'a1';
      },
      eventsSince: () => [],
      queryEvents: () => Promise.resolve([]),
    });
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const requested = MAX_BLOCKING_WAIT_MS + 30_000;

    const pending = tool(ReticleTool.WAIT_FOR).handler(
      {
        sessions: sessions as SessionManager,
        now: () => 1,
        recordings: new RecordingStore(),
      } as unknown as ToolDeps,
      { predicate: { kind: 'signal', name: 'never:fires' }, timeout_ms: requested },
    );
    await vi.advanceTimersByTimeAsync(MAX_BLOCKING_WAIT_MS + 1_000);
    const out = (await pending) as Record<string, unknown>;

    expect(out['pass']).toBe(false);
    expect(out['resume_ms']).toBe(30_000);
    expect(out['verified'], '"not yet" must not read as "no"').toBeUndefined();
    expect(recorded, 'nothing is journaled until the wait ends').toEqual([]);
  });
});
