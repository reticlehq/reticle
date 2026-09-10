import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/server';
import { ActionType, InputMode } from '@reticlehq/core';
import { createTestContext } from './test-context.js';
import { ReticleAssertionError, ReticleQueryEmptyError } from './skip.js';
import type { ToolInvoker } from '@reticlehq/server';

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

describe('t.act', () => {
  it('resolves the testid then calls reticle_act with the ref', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await t.act('add-section', ActionType.CLICK);
    expect(calls[0]?.tool).toBe(ReticleTool.QUERY);
    expect(calls[1]?.tool).toBe(ReticleTool.ACT);
    expect(calls[1]?.args['ref']).toBe('e1');
    expect(calls[1]?.args['action']).toBe(ActionType.CLICK);
  });

  it('forwards args and sessionId into reticle_act', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke, { sessionId: 's1' });
    await t.act('add-section', ActionType.CLICK, { delay: 10 });
    expect(calls[1]?.args['sessionId']).toBe('s1');
    expect(calls[1]?.args['args']).toEqual({ delay: 10 });
  });

  it('fill maps to action FILL with the value in args', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await t.fill('email', 'hi');
    expect(calls[1]?.args['action']).toBe(ActionType.FILL);
    expect(calls[1]?.args['args']).toEqual({ value: 'hi' });
  });

  it('throws ReticleQueryEmptyError on an unknown testid and never calls reticle_act', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [] }),
      [ReticleTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await expect(t.act('ghost', ActionType.CLICK)).rejects.toBeInstanceOf(ReticleQueryEmptyError);
    expect(calls.some((c) => c.tool === ReticleTool.ACT)).toBe(false);
  });
});

describe('t.actAndWait', () => {
  const until = { kind: 'signal', name: 'section:added' } as const;

  it('passes the until predicate and resolves when verdict.pass is true', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT_AND_WAIT]: () => ({ verdict: { pass: true } }),
    });
    const t = createTestContext(invoke);
    await expect(t.actAndWait('add-section', ActionType.CLICK, until)).resolves.toBeUndefined();
    const waitCall = calls.find((c) => c.tool === ReticleTool.ACT_AND_WAIT);
    expect(waitCall?.args['until']).toEqual(until);
    expect(waitCall?.args['ref']).toBe('e1');
  });

  it('throws ReticleAssertionError with trace evidence when the verdict fails', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [ReticleTool.ACT_AND_WAIT]: () => ({
        verdict: { pass: false, failureReason: 'no signal fired' },
        trace: { events: 3 },
      }),
    });
    const t = createTestContext(invoke);
    await t.actAndWait('add-section', ActionType.CLICK, until).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ReticleAssertionError);
        expect((error as ReticleAssertionError).failureReason).toBe('no signal fired');
        expect((error as ReticleAssertionError).evidence).toMatchObject({ trace: { events: 3 } });
      },
    );
  });
});
