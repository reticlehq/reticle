/**
 * `bug_found` fires once per occurrence, and two occurrences of one defect in one session used to
 * produce byte-identical rows: the same kind, source, route, fingerprint and `repeat: true`. Nothing
 * on the row could tell a real second hit from a duplicated delivery. Each now carries its
 * `occurrence` index per (session, fingerprint), so `occurrence: 1` is the distinct defect and a
 * truly duplicated row is detectable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReticleTool, SessionState, TelemetryEventKind } from '@reticlehq/core';
import { getTelemetry } from './telemetry.js';
import { resetSessionMetrics } from './session-metrics.js';
import { runTool } from '@/surface/tools/invoke-tool.js';
import type { ToolDef, ToolDeps } from '@/surface/tools/tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

function deps(): ToolDeps {
  const session: Partial<Session> = {
    id: 'bug-occurrence-test',
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session, list: () => [] };
  return { sessions, reticleRoot: '/tmp/reticle-bug-occurrence/.reticle' } as ToolDeps;
}

const contradicting: ToolDef = {
  name: ReticleTool.ASSERT,
  description: '',
  inputSchema: {},
  handler: () =>
    Promise.resolve({ verified: 'no', contradictions: [{ kind: 'signal-contradicted' }] }),
};

beforeEach(() => resetSessionMetrics());
afterEach(() => {
  vi.restoreAllMocks();
  resetSessionMetrics();
});

describe('bug_found rows are never byte-identical', () => {
  it('numbers each occurrence of one defect within the session', async () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    await runTool(contradicting, deps(), {});
    await runTool(contradicting, deps(), {});
    const bugs = emit.mock.calls
      .filter((call) => TelemetryEventKind.BUG_FOUND === call[0])
      .map((call) => call[1]?.bug);
    expect(bugs).toHaveLength(2);
    expect(bugs.map((bug) => bug?.occurrence)).toEqual([1, 2]);
    expect(JSON.stringify(bugs[0])).not.toBe(JSON.stringify(bugs[1]));
  });
});
