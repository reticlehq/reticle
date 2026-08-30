/**
 * reticle_wait_for must not block longer than the MCP client's request timeout.
 *
 * The SDK default is 60 s; some clients are configured lower. A timeout_ms that
 * exceeds MCP_CALL_BUDGET_MS would cause the transport to time out before the
 * server returns — the caller sees a transport error instead of a Reticle verdict:
 * no pass/fail, no near-miss, nothing to act on. #601
 *
 * The fix: cap each call at MCP_CALL_BUDGET_MS and return resume_ms when the
 * predicate has not yet been seen. The caller re-invokes with the same predicate,
 * the same since, and timeout_ms set to resume_ms to continue waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionState } from '@reticlehq/core';
import { LastAct } from '../session/last-act.js';
import { MCP_CALL_BUDGET_MS } from './numeric-bounds.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

function makeDeps(): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    recordAction: () => 'a1',
    lastAct: new LastAct(),
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    blindSpots: () => ({}),
    eventsSince: () => [],
    queryEvents: () => Promise.resolve([]),
    onEvent: () => () => {},
    elapsed: () => 1000,
    throttled: () => false,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true }),
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

/** A predicate that never fires — signal is never emitted on the fake session. */
const neverFires = { kind: 'signal', name: 'timer:done' };

describe('reticle_wait_for bounded-wait cursor (issue #601)', () => {
  it('declares resume_ms in the output schema', () => {
    expect(Object.keys(tool(ReticleTool.WAIT_FOR).outputSchema ?? {})).toContain('resume_ms');
  });

  it('omits resume_ms when timeout_ms fits within the per-call budget', async () => {
    // timeout_ms: 0 means evaluate once, no wait — always within budget.
    const result = (await tool(ReticleTool.WAIT_FOR).handler(makeDeps(), {
      predicate: neverFires,
      timeout_ms: 0,
    })) as { pass: boolean; resume_ms?: number };
    expect(result.pass).toBe(false);
    expect(result.resume_ms).toBeUndefined();
  });

  describe('when timeout_ms exceeds MCP_CALL_BUDGET_MS', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns resume_ms carrying the remaining budget after one chunk', async () => {
      const extra = 10_000;
      const promise = tool(ReticleTool.WAIT_FOR).handler(makeDeps(), {
        predicate: neverFires,
        timeout_ms: MCP_CALL_BUDGET_MS + extra,
      });
      // Advance past the per-call budget so the timeout fires and the Promise resolves.
      await vi.advanceTimersByTimeAsync(MCP_CALL_BUDGET_MS + 100);
      const result = (await promise) as { pass: boolean; resume_ms?: number };
      expect(result.pass).toBe(false);
      expect(result.resume_ms).toBe(extra);
    });

    it('omits resume_ms when the predicate satisfies within the first chunk', async () => {
      // Absent-console with no events in the buffer passes on the very first check.
      const promise = tool(ReticleTool.WAIT_FOR).handler(makeDeps(), {
        predicate: { kind: 'console', level: 'error', absent: true },
        timeout_ms: MCP_CALL_BUDGET_MS + 5_000,
      });
      // A single microtask tick is enough — the initial check resolves immediately.
      await vi.advanceTimersByTimeAsync(1);
      const result = (await promise) as { pass: boolean; resume_ms?: number };
      expect(result.pass).toBe(true);
      expect(result.resume_ms).toBeUndefined();
    });
  });
});
