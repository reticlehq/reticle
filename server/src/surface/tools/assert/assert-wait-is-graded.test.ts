import { describe, expect, it } from 'vitest';
import { LastAct } from '@/portal/session/last-act.js';
import { ReticleTool, SessionState, Verified } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { VERDICT_TOOLS } from '@/surface/tools/feedback-tools.js';

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
  return { sessions: sessions as SessionManager, now: () => 1 } as unknown as ToolDeps;
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
