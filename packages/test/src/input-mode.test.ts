import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticle/server';
import { ActionType, InputMode } from '@reticle/protocol';
import { createTestContext } from './test-context.js';
import { ReticleSkip, isSkip } from './skip.js';
import { SKIP_REASON_REAL_INPUT } from './constants.js';
import type { ToolInvoker } from '@reticle/server';

function fakeInvoker(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  invoke: ToolInvoker;
  calls: { tool: string; args: Record<string, unknown> }[];
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const invoke: ToolInvoker = (tool, args) => {
    calls.push({ tool, args });
    const handler = handlers[tool];
    if (handler === undefined) return Promise.reject(new Error(`no fake for ${tool}`));
    return Promise.resolve(handler(args));
  };
  return { invoke, calls };
}

describe('t.expectInputModeReal', () => {
  it('passes when the last act reported inputMode real, without an extra probe', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT]: () => ({ inputMode: InputMode.REAL, result: {} }),
    });
    const t = createTestContext(invoke);
    await t.act('add-section', ActionType.CLICK);
    const actsBefore = calls.filter((c) => c.tool === ReticleTool.ACT).length;
    await expect(t.expectInputModeReal()).resolves.toBeUndefined();
    const actsAfter = calls.filter((c) => c.tool === ReticleTool.ACT).length;
    expect(actsAfter).toBe(actsBefore); // no probe act issued
  });

  it('throws an ReticleSkip when the last act was synthetic', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await t.act('add-section', ActionType.CLICK);
    await t.expectInputModeReal().then(
      () => expect.unreachable('should have skipped, not passed'),
      (error: unknown) => {
        expect(isSkip(error)).toBe(true);
        expect((error as ReticleSkip).reason).toBe(SKIP_REASON_REAL_INPUT);
      },
    );
  });

  it('never silently passes on synthetic (rejects rather than resolves)', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await t.act('add-section', ActionType.CLICK);
    await expect(t.expectInputModeReal()).rejects.toBeInstanceOf(ReticleSkip);
  });

  it('reads reticle_sessions (no page mutation) when no prior act ran, passing on realInputAvailable', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.SESSIONS]: () => ({ sessions: [{ sessionId: 's1', realInputAvailable: true }] }),
    });
    const t = createTestContext(invoke);
    await expect(t.expectInputModeReal()).resolves.toBeUndefined();
    expect(calls.find((c) => c.tool === ReticleTool.SESSIONS)).toBeDefined();
    expect(calls.find((c) => c.tool === ReticleTool.ACT)).toBeUndefined(); // never touches the page
  });

  it('skips when the session reports real input is not available', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.SESSIONS]: () => ({
        sessions: [{ sessionId: 's1', realInputAvailable: false }],
      }),
    });
    const t = createTestContext(invoke);
    await t.expectInputModeReal().then(
      () => expect.unreachable('should have skipped'),
      (error: unknown) => {
        expect(isSkip(error)).toBe(true);
        expect((error as ReticleSkip).reason).toBe(SKIP_REASON_REAL_INPUT);
      },
    );
  });
});
