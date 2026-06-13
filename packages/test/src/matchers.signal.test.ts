import { describe, expect, it } from 'vitest';
import { IrisTool } from '@syrin/server';
import { createTestContext } from './test-context.js';
import { IrisAssertionError } from './skip.js';
import { DEFAULT_ASSERT_TIMEOUT_MS, PredicateKind } from './constants.js';
import type { ToolInvoker } from '@syrin/server';

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

describe('t.expectSignal', () => {
  it('passes and sends a signal predicate when assert passes', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.ASSERT]: () => ({ pass: true, evidence: { name: 'section:added' } }),
    });
    const t = createTestContext(invoke);
    await expect(t.expectSignal('section:added')).resolves.toBeUndefined();
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect(predicate['kind']).toBe(PredicateKind.SIGNAL);
    expect(predicate['name']).toBe('section:added');
  });

  it('forwards the dataMatches pattern into the predicate', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.ASSERT]: () => ({ pass: true }),
    });
    const t = createTestContext(invoke);
    await t.expectSignal('section:added', { id: '*' });
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect(predicate['dataMatches']).toEqual({ id: '*' });
  });

  it('throws IrisAssertionError with near-miss evidence on failure', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.ASSERT]: () => ({
        pass: false,
        failureReason: "signal 'x' fired 2x but data didn't match",
        evidence: { nearMiss: [{ id: 9 }] },
      }),
    });
    const t = createTestContext(invoke);
    await t.expectSignal('x', { id: 1 }).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(IrisAssertionError);
        expect((error as IrisAssertionError).failureReason).toBe(
          "signal 'x' fired 2x but data didn't match",
        );
        expect((error as IrisAssertionError).evidence).toEqual({ nearMiss: [{ id: 9 }] });
      },
    );
  });

  it('applies the default assert timeout', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.ASSERT]: () => ({ pass: true }),
    });
    const t = createTestContext(invoke);
    await t.expectSignal('section:added');
    expect(calls[0]?.args['timeout_ms']).toBe(DEFAULT_ASSERT_TIMEOUT_MS);
  });
});
