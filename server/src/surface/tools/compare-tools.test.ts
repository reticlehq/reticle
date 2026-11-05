import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { compareTool } from './compare-tools.js';
import { TOOLS } from './tools.js';
import type { ToolDeps } from './tools.js';

const deps = { bridgePort: 14400, reticleRoot: '/tmp/x/.reticle' } as unknown as ToolDeps;
const SAME = { verdict: 'same', verified: 'yes', differences: [], exitCode: 0 };

/** A compare that ends when `finish` is called, and records what it was asked. */
function controlled(): {
  run: Parameters<typeof compareTool>[0];
  finish: () => void;
  asked: Record<string, unknown>[];
} {
  const asked: Record<string, unknown>[] = [];
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    asked,
    finish: () => {
      finish();
    },
    run: async (options) => {
      asked.push({ ...options });
      await done;
      return { code: 0, lines: [JSON.stringify(SAME)] };
    },
  };
}

/** Resolves only for a zero wait, so a result that is ready always wins the race. */
const noWait = (ms: number): Promise<void> =>
  0 === ms ? Promise.resolve() : new Promise<void>(() => undefined);

describe('reticle_verify { action: "compare" }', () => {
  it('is an action of reticle_verify', () => {
    const verify = TOOLS.find((t) => ReticleTool.VERIFY === t.name);
    expect(JSON.stringify(verify?.inputSchema['action']?._def)).toContain('compare');
  });

  it('refuses a call without both urls', async () => {
    const tool = compareTool(controlled().run, noWait);
    expect(await tool.handler(deps, { reference: 'http://a/' })).toMatchObject({
      error: expect.stringContaining('candidate') as unknown,
    });
  });

  it('answers the same JSON as `reticle compare --json` when it ends within the wait', async () => {
    const c = controlled();
    c.finish();
    const tool = compareTool(c.run, noWait);
    const result = await tool.handler(deps, {
      reference: 'http://a/',
      candidate: 'http://b/',
      base: 'http://c/',
    });
    expect(result).toEqual(SAME);
    expect(c.asked[0]).toMatchObject({
      reference: 'http://a/',
      candidate: 'http://b/',
      base: 'http://c/',
      json: true,
      port: 14400,
    });
  });

  it('answers a run id while it runs, and the result when polled with it', async () => {
    const c = controlled();
    const tool = compareTool(c.run, noWait);
    const first = (await tool.handler(deps, {
      reference: 'http://a/',
      candidate: 'http://b/',
      wait: 0,
    })) as { status?: string; runId?: string };
    expect(first.status).toBe('running');
    expect(first.runId).toMatch(/^compare-/);
    c.finish();
    expect(await tool.handler(deps, { runId: first.runId })).toEqual(SAME);
    expect(c.asked).toHaveLength(1);
  });

  it('names an unknown run id', async () => {
    const tool = compareTool(controlled().run, noWait);
    expect(await tool.handler(deps, { runId: 'compare-nope' })).toMatchObject({
      error: expect.stringContaining('compare-nope') as unknown,
    });
  });
});
