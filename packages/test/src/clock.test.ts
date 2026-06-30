import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticle/server';
import { createTestContext } from './test-context.js';
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

describe('t.clock', () => {
  it('freeze calls reticle_clock with freeze:true and no other knob', async () => {
    const { invoke, calls } = fakeInvoker({ [ReticleTool.CLOCK]: () => ({ ok: true }) });
    const t = createTestContext(invoke);
    await t.clock.freeze();
    expect(calls[0]?.tool).toBe(ReticleTool.CLOCK);
    expect(calls[0]?.args['freeze']).toBe(true);
    expect('advanceMs' in (calls[0]?.args ?? {})).toBe(false);
    expect('reset' in (calls[0]?.args ?? {})).toBe(false);
  });

  it('advance(500) calls reticle_clock with advanceMs:500', async () => {
    const { invoke, calls } = fakeInvoker({ [ReticleTool.CLOCK]: () => ({ ok: true }) });
    const t = createTestContext(invoke);
    await t.clock.advance(500);
    expect(calls[0]?.args['advanceMs']).toBe(500);
    expect('freeze' in (calls[0]?.args ?? {})).toBe(false);
  });

  it('reset calls reticle_clock with reset:true', async () => {
    const { invoke, calls } = fakeInvoker({ [ReticleTool.CLOCK]: () => ({ ok: true }) });
    const t = createTestContext(invoke);
    await t.clock.reset();
    expect(calls[0]?.args['reset']).toBe(true);
  });

  it('forwards sessionId on every clock call', async () => {
    const { invoke, calls } = fakeInvoker({ [ReticleTool.CLOCK]: () => ({ ok: true }) });
    const t = createTestContext(invoke, { sessionId: 's1' });
    await t.clock.freeze();
    await t.clock.advance(10);
    await t.clock.reset();
    for (const call of calls) expect(call.args['sessionId']).toBe('s1');
  });
});

describe('t.state', () => {
  it('reads a store via reticle_state and returns it raw (no throw)', async () => {
    const stores = { workspace: { count: 2 } };
    const { invoke, calls } = fakeInvoker({ [ReticleTool.STATE]: () => ({ stores }) });
    const t = createTestContext(invoke);
    const result = await t.state('workspace');
    expect(calls[0]?.tool).toBe(ReticleTool.STATE);
    expect(calls[0]?.args['store']).toBe('workspace');
    expect(result).toEqual({ stores });
  });
});
