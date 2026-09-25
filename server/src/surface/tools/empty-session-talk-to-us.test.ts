/**
 * Setup that never connects is where most people give up, and it is the conversation worth having.
 * When the session list is empty, the answer carries the founder's calendar for the agent to OFFER
 * the person it is working with. A connected list carries nothing extra: nothing went wrong.
 */
import { describe, expect, it } from 'vitest';
import { DiscoveryInvite, ReticleTool } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';

const listTool = TOOLS.find((t) => t.name === ReticleTool.SESSIONS);

function deps(sessions: unknown[]): ToolDeps {
  return {
    sessions: {
      list: () => sessions,
      noSessionHint: () => 'nothing connected: open the app',
      noSessionNextAction: () => undefined,
    },
  } as unknown as ToolDeps;
}

describe('an empty session list offers the person a call', () => {
  it('carries the invitation when nothing is connected', async () => {
    const out = (await listTool?.handler(deps([]), {})) as Record<string, unknown>;
    expect(out['talk_to_us']).toBe(DiscoveryInvite.AGENT);
  });

  it('carries nothing extra when a session is connected', async () => {
    const out = (await listTool?.handler(
      deps([{ sessionId: 's1', url: 'http://localhost:3000/' }]),
      {},
    )) as Record<string, unknown>;
    expect(out['talk_to_us']).toBeUndefined();
  });
});
