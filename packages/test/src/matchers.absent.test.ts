import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/server';
import { QueryBy } from '@reticlehq/protocol';
import { createTestContext } from './test-context.js';
import { ReticleAssertionError } from './skip.js';
import { CONSOLE_LEVEL_ERROR, PredicateKind } from './constants.js';
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

describe('t.expectAbsent', () => {
  const query = { by: QueryBy.TESTID, value: 'diff-banner' } as const;

  it('passes and sends an element predicate with absent:true', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({ pass: true, evidence: { absent: true } }),
    });
    const t = createTestContext(invoke);
    await expect(t.expectAbsent(query)).resolves.toBeUndefined();
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect(predicate['kind']).toBe(PredicateKind.ELEMENT);
    expect(predicate['query']).toEqual(query);
    expect(predicate['absent']).toBe(true);
  });

  it('throws ReticleAssertionError carrying the found elements when present', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({
        pass: false,
        failureReason: 'expected element to be absent but found 1',
        evidence: [{ ref: 'e1' }],
      }),
    });
    const t = createTestContext(invoke);
    await t.expectAbsent(query).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ReticleAssertionError);
        expect((error as ReticleAssertionError).evidence).toEqual([{ ref: 'e1' }]);
      },
    );
  });
});

describe('t.expectNoConsoleErrors', () => {
  it('passes and sends a console error-absent predicate', async () => {
    const { invoke, calls } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({ pass: true }),
    });
    const t = createTestContext(invoke);
    await expect(t.expectNoConsoleErrors()).resolves.toBeUndefined();
    const predicate = calls[0]?.args['predicate'] as Record<string, unknown>;
    expect(predicate['kind']).toBe(PredicateKind.CONSOLE);
    expect(predicate['level']).toBe(CONSOLE_LEVEL_ERROR);
    expect(predicate['absent']).toBe(true);
  });

  it('throws ReticleAssertionError carrying the error entries on failure', async () => {
    const { invoke } = fakeInvoker({
      [ReticleTool.ASSERT]: () => ({
        pass: false,
        failureReason: 'expected no error entries but found 1',
        evidence: [{ msg: 'boom' }],
      }),
    });
    const t = createTestContext(invoke);
    await t.expectNoConsoleErrors().then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ReticleAssertionError);
        expect((error as ReticleAssertionError).evidence).toEqual([{ msg: 'boom' }]);
      },
    );
  });
});
