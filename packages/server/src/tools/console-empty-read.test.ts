import { describe, expect, it } from 'vitest';
import { SessionState } from '@reticlehq/core';
import { LastAct } from '../session/last-act.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * "No console errors" is the single most common claim an agent makes, and a quiet page and a dead
 * console observer produced the same JSON for it: `{ logs: [] }`.
 *
 * `observed-nothing.ts` exists precisely for this — its own header names "console with 0 logs" as
 * one of the seven cases a field sweep found. The helper was written, tested in isolation, and
 * wired into `reticle_network`, `reticle_animations` and the message inbox. `reticle_console`, the
 * case it was named after, was never wired to it.
 */
function depsWithNoConsole(): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    lastAct: new LastAct(),
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    blindSpots: () => ({}),
    eventsSince: () => [],
    queryEvents: () => Promise.resolve([]),
    elapsed: () => 1000,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

describe('an empty console read says the look happened', () => {
  it('reticle_console states it observed nothing rather than returning a bare []', async () => {
    const result = (await tool(ReticleTool.CONSOLE).handler(depsWithNoConsole(), {})) as {
      logs: unknown[];
      observed?: boolean;
      note?: string;
    };
    expect(result.logs).toEqual([]);
    expect(result.observed).toBe(true);
    expect(String(result.note)).toContain('console');
  });
});
