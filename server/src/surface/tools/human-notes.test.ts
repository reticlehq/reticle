import { afterEach, describe, expect, it } from 'vitest';
import { SessionState } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { LiveControl } from '@/portal/session/human/live-control.js';
import { forgetAgents, noteAgentAttached, callingAgent } from '@/hooks/coding-agents.js';
import { forgetDrives, startDrive, DriveOrigin } from '@/features/harness/drive-runs.js';
import { runTool } from './invoke-tool.js';
import { EnvelopeKey, type ToolDef, type ToolDeps } from './tool-kit.js';

afterEach(() => {
  forgetAgents();
  forgetDrives();
});

/** A tab with a real inbox, crediting a drain to the agent whose call took it, as Session does. */
function tab(live: LiveControl): Session {
  return {
    id: 'tab-1',
    getState: () => SessionState.ACTIVE,
    inboxSize: () => live.size(),
    drainInbox: () => live.drain(callingAgent()),
  } as unknown as Session;
}

function deps(session: Session, attachId?: string): ToolDeps {
  const sessions = {
    resolve: () => session,
    all: () => [session],
  } as unknown as SessionManager;
  return {
    sessions,
    reticleRoot: '/tmp/reticle-human-notes/.reticle',
    now: () => 0,
    ...(attachId === undefined ? {} : { attachId }),
  } as unknown as ToolDeps;
}

/** A session-exempt tool that answers a plain record, like most of the surface. */
const plain: ToolDef = {
  name: 'reticle_tools',
  description: 'test',
  inputSchema: {},
  handler: () => Promise.resolve({ ok: true }),
};

const record = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

describe('the person’s HUD notes and Harness news reach the agent on its next call, any tool', () => {
  it('hands a note to the agent on a tool that is not an act, once, and credits that agent', async () => {
    noteAgentAttached('a1', 'claude-code');
    const live = new LiveControl();
    live.push('check the empty cart too', 1);
    const out = record(await runTool(plain, deps(tab(live), 'a1'), {}));
    expect(out[EnvelopeKey.CONTROL]).toEqual({
      state: SessionState.ACTIVE,
      guidance: ['check the empty cart too'],
    });
    expect(live.history()[0]).toMatchObject({ seen: true, by: 'Claude Code' });
    const again = record(await runTool(plain, deps(tab(live), 'a1'), {}));
    expect(again[EnvelopeKey.CONTROL]).toBeUndefined();
  });

  it('a daemon-internal call (the HUD’s own Run Harness) takes neither notes nor drive news', async () => {
    const live = new LiveControl();
    live.push('for the agent, not the HUD', 1);
    startDrive({
      harness: 'h1',
      runId: 'harness-h1',
      origin: DriveOrigin.HUD,
      sessionId: 'tab-1',
      now: () => 0,
      persist: () => Promise.resolve(),
      run: () => new Promise(() => undefined),
    });
    const internal = record(await runTool(plain, deps(tab(live)), {}));
    expect(internal[EnvelopeKey.CONTROL]).toBeUndefined();
    expect(internal[EnvelopeKey.HARNESS]).toBeUndefined();
    expect(live.size()).toBe(1);
    const agent = record(await runTool(plain, deps(tab(live), 'a1'), {}));
    expect(String(agent[EnvelopeKey.HARNESS])).toContain('started from the HUD');
    expect(agent[EnvelopeKey.CONTROL]).toMatchObject({ guidance: ['for the agent, not the HUD'] });
  });
});
