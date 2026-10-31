import { describe, expect, it } from 'vitest';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { ReticleCommand, ReticleTool, Verified } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';
import { createFakeSession } from '@/portal/session/fake-session.js';

/** `reticle_act_and_wait` explains a timed-out `until` read as `reticle_assert` does (#2006). */
const call = (overrides: Partial<Session> = {}): Promise<Record<string, unknown>> => {
  let acted = false;
  const session = createFakeSession({
    command(name: string, _args?: Record<string, unknown>, t?: number) {
      acted ||= ReticleCommand.ACT === name;
      if (ReticleCommand.MATCH === name && acted) {
        return Promise.reject(new Error(`command 'match' timed out after ${String(t)}ms`));
      }
      const result = { matched: false, count: 0, elements: [] };
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    ...overrides,
  });
  return (TOOLS.find((t) => t.name === ReticleTool.ACT_AND_WAIT) as ToolDef).handler(
    {
      sessions: { resolve: () => session } as unknown as SessionManager,
      recordings: new RecordingStore(),
      now: () => 0,
    } as unknown as ToolDeps,
    {
      ref: 'e1',
      action: 'click',
      until: { kind: 'element', role: 'button', name: 'Save' },
      timeout_ms: 30,
    },
  ) as Promise<Record<string, unknown>>;
};

describe('an act_and_wait whose until read timed out', () => {
  it('names the budget that ran out, and how to widen it, on a current page', async () => {
    const result = await call();
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(String(result.because)).toContain("bounded by what the assertion's budget had left");
    expect(String(result.because)).toContain('timeout_ms');
  });

  it('names an old page SDK and the update ahead of any budget advice', async () => {
    const result = await call({ sdkVersion: '3.6.2' });
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(String(result.because)).toContain('3.6.2');
    expect(String(result.because)).toContain('reticle update');
    expect(String(result.because)).not.toContain('timeout_ms');
  });
});
