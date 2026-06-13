import { describe, expect, it } from 'vitest';
import { IrisTool } from '@syrin/iris-server';
import { ActionType, InputMode } from '@syrin/iris-protocol';
import { createTestContext } from './test-context.js';
import { IrisAssertionError, IrisQueryEmptyError } from './skip.js';
import type { ToolInvoker } from '@syrin/iris-server';

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
  it('resolves the testid then calls iris_act with the ref', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [IrisTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await t.act('add-section', ActionType.CLICK);
    expect(calls[0]?.tool).toBe(IrisTool.QUERY);
    expect(calls[1]?.tool).toBe(IrisTool.ACT);
    expect(calls[1]?.args['ref']).toBe('e1');
    expect(calls[1]?.args['action']).toBe(ActionType.CLICK);
  });

  it('forwards args and sessionId into iris_act', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [IrisTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke, { sessionId: 's1' });
    await t.act('add-section', ActionType.CLICK, { delay: 10 });
    expect(calls[1]?.args['sessionId']).toBe('s1');
    expect(calls[1]?.args['args']).toEqual({ delay: 10 });
  });

  it('fill maps to action FILL with the value in args', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [IrisTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await t.fill('email', 'hi');
    expect(calls[1]?.args['action']).toBe(ActionType.FILL);
    expect(calls[1]?.args['args']).toEqual({ value: 'hi' });
  });

  it('throws IrisQueryEmptyError on an unknown testid and never calls iris_act', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [] }),
      [IrisTool.ACT]: () => ({ inputMode: InputMode.SYNTHETIC, result: {} }),
    });
    const t = createTestContext(invoke);
    await expect(t.act('ghost', ActionType.CLICK)).rejects.toBeInstanceOf(IrisQueryEmptyError);
    expect(calls.some((c) => c.tool === IrisTool.ACT)).toBe(false);
  });
});

describe('t.actAndWait', () => {
  const until = { kind: 'signal', name: 'section:added' } as const;

  it('passes the until predicate and resolves when verdict.pass is true', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [IrisTool.ACT_AND_WAIT]: () => ({ verdict: { pass: true } }),
    });
    const t = createTestContext(invoke);
    await expect(t.actAndWait('add-section', ActionType.CLICK, until)).resolves.toBeUndefined();
    const waitCall = calls.find((c) => c.tool === IrisTool.ACT_AND_WAIT);
    expect(waitCall?.args['until']).toEqual(until);
    expect(waitCall?.args['ref']).toBe('e1');
  });

  it('throws IrisAssertionError with trace evidence when the verdict fails', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
      [IrisTool.ACT_AND_WAIT]: () => ({
        verdict: { pass: false, failureReason: 'no signal fired' },
        trace: { events: 3 },
      }),
    });
    const t = createTestContext(invoke);
    await t.actAndWait('add-section', ActionType.CLICK, until).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(IrisAssertionError);
        expect((error as IrisAssertionError).failureReason).toBe('no signal fired');
        expect((error as IrisAssertionError).evidence).toMatchObject({ trace: { events: 3 } });
      },
    );
  });
});
