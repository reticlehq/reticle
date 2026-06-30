import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/server';
import { ElementState, QueryBy } from '@reticlehq/protocol';
import { createTestContext } from './test-context.js';
import { ReticleAssertionError } from './skip.js';
import { PredicateKind } from './constants.js';
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

describe('t.expectElement', () => {
  const query = { by: QueryBy.TESTID, value: 'banner' } as const;

  it('passes and sends an element predicate with the state', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({ pass: true }),
    });
    const t = createTestContext(invoke);
    await expect(t.expectElement(query, ElementState.VISIBLE)).resolves.toBeUndefined();
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect(predicate['kind']).toBe(PredicateKind.ELEMENT);
    expect(predicate['query']).toEqual(query);
    expect(predicate['state']).toBe(ElementState.VISIBLE);
  });

  it('omits the state key when state is undefined', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({ pass: true }),
    });
    const t = createTestContext(invoke);
    await t.expectElement(query);
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect('state' in predicate).toBe(false);
  });

  it('throws ReticleAssertionError with wrong-state nearMiss evidence on failure', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({
        pass: false,
        failureReason: "element exists but not in state 'visible'",
        evidence: { nearMiss: [{ ref: 'e2' }] },
      }),
    });
    const t = createTestContext(invoke);
    await t.expectElement(query, ElementState.VISIBLE).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ReticleAssertionError);
        expect((error as ReticleAssertionError).evidence).toEqual({ nearMiss: [{ ref: 'e2' }] });
      },
    );
  });
});

describe('t.expectText', () => {
  it('maps to a text predicate', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({ pass: true }),
    });
    const t = createTestContext(invoke);
    await t.expectText('Saved');
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect(predicate['kind']).toBe(PredicateKind.TEXT);
    expect(predicate['contains']).toBe('Saved');
  });

  it('throws ReticleAssertionError when text is absent', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({ pass: false, failureReason: 'no element matched' }),
    });
    const t = createTestContext(invoke);
    await expect(t.expectText('Saved')).rejects.toBeInstanceOf(ReticleAssertionError);
  });
});
