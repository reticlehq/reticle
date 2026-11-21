/**
 * `timeout_ms` is one deadline for the whole `reticle_assert` call (#2443).
 *
 * The handler gave the full `timeout_ms` to the wait for a session, then the full `timeout_ms` again
 * to the wait for the predicate. A session that connected late and a predicate that held late made
 * one call run for about two times its budget. The CLI and MCP clients stop waiting at the budget
 * plus a fixed slack, so a `yes` that the daemon reached came back as "Request timed out".
 *
 * The clock is fake, so no real time passes and no duration is asserted (rule 15). The check is
 * whether the call has answered once the fake clock reaches the budget plus the grading bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { EventType, ReticleTool, type ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';
import { createFakeSession } from '@/portal/session/fake-session.js';

const SIGNAL_NAME = 'order:placed';
const TIMEOUT_MS = 2_000;
/** The session connects after this much of the budget: three quarters of it. */
const SESSION_LATE_MS = 1_500;
/** The session connects after this much of the budget: a tenth of it. */
const SESSION_EARLY_MS = 200;
/** Room for the grading work after the deadline. Fixed, and far below a second budget. */
const GRADING_BOUND_MS = 300;

const signal = (): ReticleEvent => ({
  t: 1,
  type: EventType.SIGNAL,
  sessionId: 'late',
  data: { name: SIGNAL_NAME, data: {} },
});

/** A page whose signal never fires, so the predicate waits out whatever budget it is given. */
function lateSession(saw: boolean): Session {
  return createFakeSession(
    {
      eventsSince: () => (saw ? [signal()] : []),
      health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      bufferHealth: () => ({ total: 0, dropped: 0 }),
    },
    { sessionId: 'late', url: 'http://app.test/' },
  );
}

/** An empty session map until `lateMs` after the call starts. */
function depsWithLateSession(session: Session, lateMs = SESSION_LATE_MS): ToolDeps {
  const connectsAt = Date.now() + lateMs;
  const connected = (): boolean => Date.now() >= connectsAt;
  const sessions: Partial<SessionManager> = {
    resolve: () => {
      if (!connected()) {
        throw new Error('no browser session connected');
      }
      return session;
    },
    count: () => (connected() ? 1 : 0),
    get: (id: string) => (connected() && id === session.id ? session : undefined),
    all: () => (connected() ? [session] : []),
  };
  return { sessions: sessions as SessionManager, recordings: new RecordingStore() } as ToolDeps;
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`no ${name} tool`);
  }
  return found;
}

/** Start the call, move the fake clock to the deadline plus the bound, and say if it answered. */
async function answeredByDeadline(
  args: Record<string, unknown>,
  saw: boolean,
  lateMs = SESSION_LATE_MS,
): Promise<{ answered: boolean; result: Record<string, unknown> }> {
  let answered = false;
  let result: Record<string, unknown> = {};
  const call = tool(ReticleTool.ASSERT)
    .handler(depsWithLateSession(lateSession(saw), lateMs), args)
    .then(
      (value) => {
        answered = true;
        result = value as Record<string, unknown>;
      },
      () => {
        answered = true;
      },
    );
  await vi.advanceTimersByTimeAsync(TIMEOUT_MS + GRADING_BOUND_MS);
  const byDeadline = answered;
  await vi.runAllTimersAsync();
  await call;
  return { answered: byDeadline, result };
}

describe('reticle_assert spends one budget on the session wait and the predicate wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The check ran only on what the session wait left, on a page that had just connected. A late
  // `no` there is not a statement about the app, so the verdict is `unknown`, not `no`.
  it('answers within timeout_ms, unknown, when the session connects late and the predicate never holds', async () => {
    const args = { predicate: { kind: 'signal', name: SIGNAL_NAME }, timeout_ms: TIMEOUT_MS };
    const { answered, result } = await answeredByDeadline(args, false);
    expect(answered).toBe(true);
    expect(result['pass']).toBe(false);
    expect(result['verified']).toBe('unknown');
    expect(String(result['inconclusive'])).toContain('ms before the deadline');
  });

  it('answers within timeout_ms, unknown, in the wait form too', async () => {
    const args = {
      action: 'wait',
      predicate: { kind: 'signal', name: SIGNAL_NAME },
      timeout_ms: TIMEOUT_MS,
    };
    const { answered, result } = await answeredByDeadline(args, false);
    expect(answered).toBe(true);
    expect(result['verified']).toBe('unknown');
    expect(String(result['inconclusive'])).toContain('ms before the deadline');
  });

  // Connected early, the check had most of its window: a `no` there is about the app (review on #2444).
  it('answers a plain no when the session connects early and the predicate never holds', async () => {
    const args = { predicate: { kind: 'signal', name: SIGNAL_NAME }, timeout_ms: TIMEOUT_MS };
    const { answered, result } = await answeredByDeadline(args, false, SESSION_EARLY_MS);
    expect(answered).toBe(true);
    expect(result['pass']).toBe(false);
    expect(result['inconclusive']).toBeUndefined();
    expect(result['verified']).toBe('no');
  });

  it('still answers yes when the late session shows the consequence', async () => {
    const args = { predicate: { kind: 'signal', name: SIGNAL_NAME }, timeout_ms: TIMEOUT_MS };
    const { answered, result } = await answeredByDeadline(args, true);
    expect(answered).toBe(true);
    expect(result['pass']).toBe(true);
    expect(result['inconclusive']).toBeUndefined();
  });

  it('still answers a plain no when the session was connected from the start', async () => {
    vi.useRealTimers();
    const session = lateSession(false);
    const deps = {
      sessions: {
        resolve: () => session,
        count: () => 1,
        get: () => session,
        all: () => [session],
      },
      recordings: new RecordingStore(),
    } as unknown as ToolDeps;
    const result = (await tool(ReticleTool.ASSERT).handler(deps, {
      predicate: { kind: 'signal', name: SIGNAL_NAME },
      timeout_ms: 0,
    })) as { pass: boolean; inconclusive?: string };
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('still passes when the late session shows the consequence', async () => {
    vi.useRealTimers();
    const session = lateSession(true);
    const deps = {
      sessions: {
        resolve: () => session,
        count: () => 1,
        get: () => session,
        all: () => [session],
      },
      recordings: new RecordingStore(),
    } as unknown as ToolDeps;
    const result = (await tool(ReticleTool.ASSERT).handler(deps, {
      predicate: { kind: 'signal', name: SIGNAL_NAME },
      timeout_ms: TIMEOUT_MS,
    })) as { pass: boolean };
    expect(result.pass).toBe(true);
  });
});
