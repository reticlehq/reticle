/**
 * `reticle_run` checks the target's argument TYPES, not only its keys (#1118).
 *
 * A direct call is validated by the SDK against the tool's schema. The escape hatch is not, because
 * `reticle_run`'s own shape (`args: record(unknown)`) is always valid, and it checked only for
 * unknown keys. So a client that stringified numbers or arrays reached the handler with them, and
 * two handlers turned the bad value into a plausible success: `reticle_viewport` set a 64x64 page,
 * and `reticle_intent` declared nothing and answered `{ intents: [] }`.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { INTENT_TOOLS } from '@/memory/intent/intent-tools.js';
import { VIEWPORT_TOOLS } from '@/portal/input/viewport-tools.js';
import type { RealInputProvider } from '@/portal/input/real-input.js';
import { buildDynamicTools } from './dynamic-tools.js';
import type { ToolDeps } from './tools.js';

interface RunAnswer {
  error?: string;
  tool?: string;
  params?: unknown;
  applied?: boolean;
  width?: number;
  height?: number;
  intents?: { id: string }[];
}

function harness(): {
  run: (tool: string, args: Record<string, unknown>) => Promise<RunAnswer>;
  resized: { width: number; height: number }[];
} {
  const resized: { width: number; height: number }[] = [];
  const realInput = {
    isAvailableFor: () => Promise.resolve(true),
    perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
    setViewport: (_url: string, size: { width: number; height: number }) => {
      resized.push(size);
      return Promise.resolve(true);
    },
  } as unknown as RealInputProvider;
  const { fs } = createMemoryFs();
  const deps = {
    fs,
    reticleRoot: '/repo/.reticle',
    now: () => 1,
    realInput,
    sessions: { resolve: () => ({ id: 's1', url: 'http://localhost:5173/' }), count: () => 1 },
  } as unknown as ToolDeps;
  const run = buildDynamicTools([...VIEWPORT_TOOLS, ...INTENT_TOOLS]).find(
    (tool) => tool.name === ReticleTool.RUN,
  );
  if (run === undefined) throw new Error('no reticle_run');
  return {
    run: async (tool, args) => (await run.handler(deps, { tool, args })) as RunAnswer,
    resized,
  };
}

describe('reticle_run refuses a wrong-typed argument the way a direct call would', () => {
  it('a stringified viewport width is refused by name, and the page is never resized', async () => {
    const { run, resized } = harness();

    const out = await run(ReticleTool.VIEWPORT, { width: '1440', height: '900' });

    expect(out.error).toContain('invalid parameters for reticle_viewport');
    expect(out.error).toContain('width');
    expect(out.error).toContain('height');
    expect(out.error).toContain('NOT applied');
    expect(out.params).toBeDefined();
    expect(resized, 'nothing may reach the page, least of all a 64x64 resize').toEqual([]);
  });

  it('the same call with numbers goes through, at the size asked for', async () => {
    const { run, resized } = harness();

    const out = await run(ReticleTool.VIEWPORT, { width: 1440, height: 900 });

    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ applied: true, width: 1440, height: 900 });
    expect(resized).toEqual([{ width: 1440, height: 900 }]);
  });

  it('a stringified intents array is refused, not stored as nothing', async () => {
    const { run } = harness();

    const out = await run(ReticleTool.INTENT, {
      action: 'declare',
      intents: '[{"id":"a","statement":"an order can be cancelled"}]',
    });

    expect(out.error).toContain('invalid parameter for reticle_intent');
    expect(out.error).toContain('intents');
    expect(out.intents).toBeUndefined();
  });

  it('a well-typed declare still stores what it was given', async () => {
    const { run } = harness();

    const out = await run(ReticleTool.INTENT, {
      action: 'declare',
      intents: [{ id: 'a', statement: 'an order can be cancelled' }],
    });

    expect(out.error).toBeUndefined();
    expect(out.intents?.map((intent) => intent.id)).toEqual(['a']);
  });
});

describe('the handlers no longer turn a bad value into a plausible success', () => {
  it('reticle_viewport refuses a present, non-numeric dimension instead of reading 64', async () => {
    const viewport = VIEWPORT_TOOLS.find((tool) => tool.name === ReticleTool.VIEWPORT);
    const deps = {
      sessions: { resolve: () => ({ url: 'http://localhost:5173/' }) },
    } as unknown as ToolDeps;

    await expect(viewport?.handler(deps, { width: '1440', height: 900 })).rejects.toThrow(
      /`width` must be a number.*NOT applied/,
    );
  });

  it('reticle_intent declare with no intents is a refusal naming the field', async () => {
    const intent = INTENT_TOOLS.find((tool) => tool.name === ReticleTool.INTENT);
    const { fs } = createMemoryFs();
    const deps = {
      fs,
      reticleRoot: '/repo/.reticle',
      now: () => 1,
      sessions: {
        resolve: () => {
          throw new Error('no session');
        },
        count: () => 0,
      },
    } as unknown as ToolDeps;

    await expect(intent?.handler(deps, { action: 'declare' })).rejects.toThrow(
      /`intents` must be a non-empty array.*nothing was stored/,
    );
    await expect(intent?.handler(deps, { action: 'declare', intents: [] })).rejects.toThrow(
      /`intents` must be a non-empty array/,
    );
  });
});
