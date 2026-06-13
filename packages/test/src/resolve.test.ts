import { describe, expect, it } from 'vitest';
import { IrisTool } from '@iris/server';
import { QueryBy } from '@iris/protocol';
import { resolveTestid } from './resolve.js';
import { IrisQueryEmptyError } from './skip.js';
import { NO_ELEMENT_FOR_TESTID } from './constants.js';
import type { ToolInvoker } from '@iris/server';

/** A fake invoker scripted per tool name; records every call for assertion. */
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

describe('resolveTestid', () => {
  it('returns the first ref of a non-empty query', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
    });
    await expect(resolveTestid(invoke, 'add-section')).resolves.toBe('e1');
  });

  it('uses the first of multiple refs', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }, { ref: 'e2' }] }),
    });
    await expect(resolveTestid(invoke, 'row')).resolves.toBe('e1');
  });

  it('queries by testid with the given value', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
    });
    await resolveTestid(invoke, 'add-section');
    expect(calls[0]?.tool).toBe(IrisTool.QUERY);
    expect(calls[0]?.args['by']).toBe(QueryBy.TESTID);
    expect(calls[0]?.args['value']).toBe('add-section');
  });

  it('throws IrisQueryEmptyError on an empty result', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [], hint: { presentTestids: ['add-row'] } }),
    });
    await expect(resolveTestid(invoke, 'add-section')).rejects.toBeInstanceOf(IrisQueryEmptyError);
  });

  it('names the missing testid in the thrown message', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [] }),
    });
    await expect(resolveTestid(invoke, 'add-section')).rejects.toThrow(
      `${NO_ELEMENT_FOR_TESTID} add-section`,
    );
  });

  it('carries presentTestids as evidence on the empty error', async () => {
    const { invoke } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [], hint: { presentTestids: ['add-sectionn'] } }),
    });
    await resolveTestid(invoke, 'add-section').then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(IrisQueryEmptyError);
        expect((error as IrisQueryEmptyError).evidence).toEqual({
          presentTestids: ['add-sectionn'],
        });
      },
    );
  });

  it('forwards sessionId to the query when supplied', async () => {
    const { invoke, calls } = fakeInvoker({
      [IrisTool.QUERY]: () => ({ elements: [{ ref: 'e1' }] }),
    });
    await resolveTestid(invoke, 'add-section', 's1');
    expect(calls[0]?.args['sessionId']).toBe('s1');
  });
});
