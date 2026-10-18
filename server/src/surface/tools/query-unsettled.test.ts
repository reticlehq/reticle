/**
 * #1259 at the tool: `reticle_query` (and `reticle_look { action: "find" }`, which dispatches to it)
 * adds `unsettled` to a zero-match answer read while the last act is still landing.
 *
 * `unsettled-find.test.ts` pins the rule. This pins that the handler applies it to what it returns,
 * the layer where `self` and `attrs` were once dropped without a sound (query-forwarding.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { EventType, ReticleTool, type ReticleEvent } from '@reticlehq/core';
import { TOOLS } from './tools.js';
import type { ToolDeps } from './tool-kit.js';

const queryTool = TOOLS.find((tool) => ReticleTool.QUERY === tool.name);

function depsWith(events: ReticleEvent[], count: number): ToolDeps {
  const session = {
    command: () => Promise.resolve({ ok: true, result: { elements: [], count } }),
    lastAct: { cursor: () => 100 },
    eventsSince: (c: number) => events.filter((e) => e.t >= c),
    elapsed: () => 400,
    url: 'http://localhost:5173/',
    background: [],
  };
  return { sessions: { resolve: () => session } } as unknown as ToolDeps;
}

const stillOut: ReticleEvent = {
  t: 110,
  seq: 1,
  type: EventType.NET_PENDING,
  sessionId: 's',
  data: { id: 'r1', method: 'GET', url: 'http://localhost:5173/api/options' },
};

async function answer(deps: ToolDeps): Promise<Record<string, unknown>> {
  return (await queryTool?.handler(deps, { by: 'role', value: 'combobox' })) as Record<
    string,
    unknown
  >;
}

describe('reticle_query says a zero read was taken mid-render', () => {
  it('a 0 while the act’s request is still out carries unsettled', async () => {
    const out = await answer(depsWith([stillOut], 0));
    expect(out['unsettled']).toMatchObject({ inFlight: ['GET http://localhost:5173/api/options'] });
  });

  it('a 0 in a quiet window carries nothing extra', async () => {
    const out = await answer(depsWith([], 0));
    expect(out['unsettled']).toBeUndefined();
  });
});
