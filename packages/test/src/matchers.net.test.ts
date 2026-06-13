import { describe, expect, it } from 'vitest';
import { IrisTool } from '@iris/server';
import { createTestContext } from './test-context.js';
import { IrisAssertionError } from './skip.js';
import { PredicateKind } from './constants.js';
import type { ToolInvoker } from '@iris/server';

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

describe('t.expectNet', () => {
  it('passes and sends a net predicate including status', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.ASSERT]: () => ({ pass: true, evidence: { method: 'POST', status: 200 } }),
    });
    const t = createTestContext(invoke);
    await expect(t.expectNet('POST', '/chat-script', 200)).resolves.toBeUndefined();
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect(predicate['kind']).toBe(PredicateKind.NET);
    expect(predicate['method']).toBe('POST');
    expect(predicate['urlContains']).toBe('/chat-script');
    expect(predicate['status']).toBe(200);
  });

  it('omits the status key when status is undefined', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.ASSERT]: () => ({ pass: true }),
    });
    const t = createTestContext(invoke);
    await t.expectNet('GET', '/me');
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect('status' in predicate).toBe(false);
  });

  it('throws IrisAssertionError when no call matched', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.ASSERT]: () => ({ pass: false, failureReason: 'no network call matched ...' }),
    });
    const t = createTestContext(invoke);
    await t.expectNet('POST', '/chat-script', 200).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(IrisAssertionError);
        expect((error as IrisAssertionError).failureReason).toBe('no network call matched ...');
      },
    );
  });
});
