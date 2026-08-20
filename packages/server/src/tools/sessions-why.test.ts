/**
 * An empty session list must carry its own explanation.
 *
 * `reticle_sessions` is the probe an agent reaches for first, and for the largest cohort in the
 * funnel it is also the LAST tool they call: the app was never instrumented, the list comes back
 * empty, and `{"sessions":[]}` reads as a settled fact rather than a diagnosable state. The agent
 * cannot tell that apart from a daemon that is down or a tab that was closed, so it falls back to
 * static reasoning and hands the verification back to the human.
 *
 * The daemon already computes exactly this diagnosis for the error path. The only defect was that
 * the READ path never showed it.
 */

import { describe, expect, it } from 'vitest';
import { NoSessionAction } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { TOOLS } from './tools.js';
import type { NoSessionNextAction } from '../session/no-session-next-action.js';
import type { ToolDeps } from './tool-kit.js';

const sessionsTool = TOOLS.find((tool) => ReticleTool.SESSIONS === tool.name);

/** Only the fields this handler reads — the rest of ToolDeps is irrelevant here. */
function depsWith(list: unknown[], hint: string | undefined, next?: NoSessionNextAction): ToolDeps {
  return {
    sessions: {
      list: () => list,
      noSessionHint: () => hint,
      noSessionNextAction: () => next,
    },
  } as unknown as ToolDeps;
}

describe('reticle_sessions explains an empty list', () => {
  it('is a declared output field, so a strict client does not strip it', () => {
    expect(sessionsTool?.outputSchema).toHaveProperty('why');
  });

  it('carries the executable next action alongside the prose', async () => {
    const next: NoSessionNextAction = {
      action: NoSessionAction.START_DEV_SERVER,
      command: 'pnpm run dev',
      reason: 'nothing is listening',
    };
    const result = (await sessionsTool?.handler(depsWith([], 'prose', next), {})) as {
      next_action?: NoSessionNextAction;
    };
    expect(result.next_action?.command).toBe('pnpm run dev');
    expect(sessionsTool?.outputSchema).toHaveProperty('next_action');
  });

  it('omits next_action when there is none, rather than shipping an empty shell', async () => {
    const result = (await sessionsTool?.handler(depsWith([], 'prose'), {})) as {
      next_action?: NoSessionNextAction;
    };
    expect(result.next_action).toBeUndefined();
  });

  it('carries the diagnosis when nothing is connected', async () => {
    const result = (await sessionsTool?.handler(
      depsWith([], 'run `reticle init` in the app'),
      {},
    )) as {
      sessions: unknown[];
      why?: string;
    };
    expect(result.sessions).toEqual([]);
    expect(result.why).toContain('reticle init');
  });

  it('stays silent when there is nothing to diagnose', async () => {
    const result = (await sessionsTool?.handler(depsWith([], undefined), {})) as { why?: string };
    expect(result.why).toBeUndefined();
  });

  it('does not editorialise when sessions ARE connected', async () => {
    const session = {
      sessionId: 's1',
      url: 'http://localhost:5173/',
      adapters: [],
      hasCapabilities: true,
      lastSeenMs: 0,
      throttled: false,
      focused: true,
      hidden: false,
    };
    const result = (await sessionsTool?.handler(depsWith([session], 'should not appear'), {})) as {
      sessions: unknown[];
      why?: string;
    };
    expect(result.sessions).toHaveLength(1);
    expect(result.why).toBeUndefined();
  });
});
