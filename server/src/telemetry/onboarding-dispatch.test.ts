import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReticleTool, SessionState, TelemetryEventKind, TRANSPORT_LIMITS } from '@reticlehq/core';
import { getTelemetry } from './telemetry.js';
import { resetOnboardingFirsts } from './onboarding-firsts.js';
import { resetSessionMetrics } from './session-metrics.js';
import { runTool } from '@/surface/tools/invoke-tool.js';
import type { ToolDef, ToolDeps } from '@/surface/tools/tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

function deps(): ToolDeps {
  const session: Partial<Session> = {
    id: 'onboarding-test',
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session, list: () => [] };
  return { sessions, reticleRoot: '/tmp/reticle-onboarding-dispatch/.reticle' } as ToolDeps;
}

function tool(name: string, value: unknown): ToolDef {
  return { name, description: '', inputSchema: {}, handler: () => Promise.resolve(value) };
}

function reportedSteps(): () => string[] {
  const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
  return () =>
    emit.mock.calls
      .filter((call) => call[0] === TelemetryEventKind.ONBOARDING_STEP)
      .flatMap((call) => call[1]?.onboarding?.step ?? []);
}

beforeEach(() => {
  resetOnboardingFirsts();
  resetSessionMetrics();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetOnboardingFirsts();
});

describe('onboarding milestones reflect dispatched tool outcomes', () => {
  it.each([ReticleTool.LOOK, ReticleTool.ACT, ReticleTool.ACT_AND_WAIT])(
    'does not count %s when its handler throws',
    async (name) => {
      const steps = reportedSteps();
      const failing = tool(name, undefined);
      failing.handler = () => Promise.reject(new Error('No session connected'));
      await expect(runTool(failing, deps(), { action: 'click' })).rejects.toThrow('No session');
      expect(steps()).not.toContain('first_look');
      expect(steps()).not.toContain('first_act');
      expect(steps()).not.toContain('driven');
    },
  );

  it.each([
    { error: 'No target found' },
    { paused: true },
    { dispatched: false },
    { effect: { dispatched: false } },
  ])('does not count an action that did not run: %j', async (result) => {
    const steps = reportedSteps();
    await runTool(tool(ReticleTool.ACT_AND_WAIT, result), deps(), { action: 'click' });
    expect(steps()).not.toContain('first_act');
    expect(steps()).not.toContain('driven');
    // A later success must still get its first milestone.
    await runTool(tool(ReticleTool.ACT_AND_WAIT, { effect: {} }), deps(), { action: 'click' });
    expect(steps().filter((s) => 'first_act' === s)).toHaveLength(1);
  });

  it('counts a dispatched action even if its asserted consequence fails', async () => {
    const steps = reportedSteps();
    await runTool(
      tool(ReticleTool.ACT_AND_WAIT, {
        effect: {},
        verified: 'no',
        verdict: { pass: false },
      }),
      deps(),
      { action: 'click' },
    );
    expect(steps()).toContain('first_act');
    expect(steps()).toContain('driven');
    expect(steps()).toContain('first_verdict');
    expect(steps().indexOf('first_act')).toBeLessThan(steps().indexOf('first_verdict'));
  });

  it('does not count a refused look, then counts the first successful look once', async () => {
    const steps = reportedSteps();
    const handler = vi.fn(() => Promise.resolve({}));
    const look = { ...tool(ReticleTool.LOOK, {}), handler };
    await runTool(look, deps(), { target: 'x'.repeat(TRANSPORT_LIMITS.MAX_STRING_LENGTH + 1) });
    expect(handler).not.toHaveBeenCalled();
    expect(steps()).not.toContain('first_look');
    await runTool(tool(ReticleTool.LOOK, { error: 'No page' }), deps(), {});
    expect(steps()).not.toContain('first_look');
    await runTool(look, deps(), {});
    await runTool(look, deps(), {});
    expect(steps().filter((s) => 'first_look' === s)).toHaveLength(1);
  });

  it('does not count an empty or stalled sequence as a drive', async () => {
    const steps = reportedSteps();
    await runTool(tool(ReticleTool.ACT_SEQUENCE, { dispatched: false, completed: 0 }), deps(), {});
    expect(steps()).not.toContain('driven');
    await runTool(tool(ReticleTool.ACT_SEQUENCE, { dispatched: true, completed: 1 }), deps(), {});
    expect(steps()).toContain('driven');
  });
});
