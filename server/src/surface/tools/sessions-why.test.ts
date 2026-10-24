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
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextStepOffered, NoSessionAction } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { TOOLS } from './tools.js';
import type { NoSessionNextAction } from '@/portal/session/no-session-next-action.js';
import type { ToolDeps } from './tool-kit.js';

const sessionsTool = TOOLS.find((tool) => ReticleTool.SESSIONS === tool.name);

/** Only the fields this handler reads — the rest of ToolDeps is irrelevant here. */
function depsWith(
  list: unknown[],
  hint: string | undefined,
  next?: NoSessionNextAction,
  lastKnown?: { sessionId: string; url: string },
): ToolDeps {
  return {
    sessions: {
      list: () => list,
      noSessionHint: () => hint,
      noSessionNextAction: () => next,
      lastKnown: () =>
        lastKnown === undefined ? undefined : { id: lastKnown.sessionId, url: lastKnown.url },
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

/**
 * An empty list with a remembered URL is the 500-overlay case: the page was here, then it was not,
 * and the SDK never HELLO'd back. `why` already says a tab went away; without `lastKnown` the agent
 * still cannot tell /orders/explode from "the human closed the tab" (#808 option 1).
 */
describe('reticle_sessions names the last known page when the list is empty', () => {
  const lastKnown = {
    sessionId: 's-torn',
    url: 'http://localhost:3000/orders/explode',
  };

  it('is a declared output field, so a strict client does not strip it', () => {
    expect(sessionsTool?.outputSchema).toHaveProperty('lastKnown');
  });

  it('carries the last session id and URL beside the empty list', async () => {
    const result = (await sessionsTool?.handler(
      depsWith([], 'the page was torn down', undefined, lastKnown),
      {},
    )) as {
      sessions: unknown[];
      lastKnown?: { sessionId: string; url: string };
    };
    expect(result.sessions).toEqual([]);
    expect(result.lastKnown).toEqual(lastKnown);
  });

  it('omits lastKnown when nothing was ever connected, rather than shipping a zeroed shell', async () => {
    const result = (await sessionsTool?.handler(depsWith([], 'run init'), {})) as {
      lastKnown?: { sessionId: string; url: string };
    };
    expect(result.lastKnown).toBeUndefined();
  });

  it('does not keep a tombstone on a LIVE listing — that would look like the current tab', async () => {
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
    const result = (await sessionsTool?.handler(
      depsWith([session], undefined, undefined, lastKnown),
      {},
    )) as { lastKnown?: { sessionId: string; url: string } };
    expect(result.lastKnown).toBeUndefined();
  });
});

/*
 * The first session call in an unwired project changes no file. It used to run `init` there
 * unasked: an agent that only listed sessions changed package.json, the lockfile and the build
 * config, and started a second dev server. Wiring needs the user's agreement; the lease does not.
 */
describe('the first session call in an unwired project', () => {
  function unwiredApp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-unwired-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }),
    );
    return dir;
  }
  const runInit: NoSessionNextAction = {
    action: NoSessionAction.RUN_INIT,
    command: 'npx @reticlehq/server init',
    port: 5173,
    reason: 'no .reticle.json',
  };

  it('writes no file, offers the lease, and asks for consent to wire', async () => {
    const dir = unwiredApp();
    const before = readdirSync(dir);
    const wireCalls: string[] = [];
    const deps = {
      ...depsWith([], 'prose', runInit),
      reticleRoot: join(dir, '.reticle'),
      firstRun: {
        projectDirectory: (d: string) => d,
        // What wiring does to the project, so a call to it shows in the file system.
        wire: (d: string) => {
          wireCalls.push(d);
          writeFileSync(join(d, '.reticle.json'), '{}');
          return Promise.resolve({ ok: true, directory: d, steps: [] });
        },
      },
    } as unknown as ToolDeps;
    const result = (await sessionsTool?.handler(deps, {})) as {
      wired?: unknown;
      next_step?: { offered: string; lease?: string; consent: string };
    };
    expect(wireCalls).toEqual([]);
    expect(readdirSync(dir)).toEqual(before);
    expect(result.wired).toBeUndefined();
    expect(result.next_step?.offered).toBe(NextStepOffered.LEASE);
    expect(result.next_step?.lease).toContain('reticle_lease');
    expect(result.next_step?.lease).toContain('http://localhost:5173');
    expect(result.next_step?.consent).toMatch(/ask the user/i);
    expect(result.next_step?.consent).toContain('npx @reticlehq/server init');
    expect(sessionsTool?.outputSchema).toHaveProperty('next_step');
  });

  it('asks for consent first when no app is up to lease', async () => {
    const dir = unwiredApp();
    const deps = {
      ...depsWith([], 'prose', {
        action: NoSessionAction.START_DEV_SERVER,
        command: 'npm run dev',
        reason: 'nothing is listening',
      }),
      reticleRoot: join(dir, '.reticle'),
      firstRun: { projectDirectory: (d: string) => d },
    } as unknown as ToolDeps;
    const result = (await sessionsTool?.handler(deps, {})) as {
      next_step?: { offered: string; lease?: string };
      next_action?: NoSessionNextAction;
    };
    expect(result.next_step?.offered).toBe(NextStepOffered.INIT_CONSENT);
    expect(result.next_step?.lease).toBeUndefined();
    expect(result.next_action?.command).toBe('npm run dev');
  });

  it('offers nothing when it cannot tell which project', async () => {
    const deps = {
      ...depsWith([], 'prose', runInit),
      reticleRoot: '/home/u/.reticle',
      firstRun: { projectDirectory: () => undefined },
    } as unknown as ToolDeps;
    const result = (await sessionsTool?.handler(deps, {})) as {
      next_action?: NoSessionNextAction;
      next_step?: unknown;
    };
    expect(result.next_step).toBeUndefined();
    expect(result.next_action?.action).toBe(NoSessionAction.RUN_INIT);
  });
});

/* Persona drive: an empty list came back with ~3 KB of speculative troubleshooting. */
describe('an empty list says the lead, not the whole differential', () => {
  it('carries the short diagnosis when one is wired', async () => {
    const deps = depsWith([], 'a long differential '.repeat(100));
    (deps.sessions as unknown as { noSessionLead: () => string }).noSessionLead = () =>
      'Nothing is connected: start the dev server (pnpm run dev).';
    const result = (await sessionsTool?.handler(deps, {})) as { why?: string };
    expect(result.why).toBe('Nothing is connected: start the dev server (pnpm run dev).');
  });
});
