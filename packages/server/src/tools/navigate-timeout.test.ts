/**
 * `timeout_ms` reaches the wait.
 *
 * The parameter is the fix for an arrival window nobody could size (a fixed 5s, against an SPA
 * measured reattaching in 30–60s). A parameter the schema accepts and the handler then drops would
 * be the silent-ignore failure this repo refuses everywhere else — the agent asked for something,
 * did not get it, and was told nothing. So this drives the handler, not the helper.
 *
 * The session map changes between LOOKS, and the budget is proven by how many times the daemon
 * looked — never by elapsed time, which is a statement about the machine.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS } from './browser-tools.js';
import { ReticleTool } from './tool-names.js';
import { LastAct } from '../session/last-act.js';
import type { CommandResult } from '@reticlehq/core';
import type { Session, SessionManager } from '../session/session.js';
import type { ToolDeps } from './tools.js';

const FROM = 'http://localhost:3000/';
const TO = 'http://localhost:3000/dashboard';

function fakeSession(id: string, url: string): Session {
  const stub: Partial<Session> = {
    id,
    url,
    elapsed: () => 0,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    // The browser accepts every instruction; whether the page ARRIVES is the map's business below.
    command: (): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { ok: true, url: TO } }),
  };
  return stub as Session;
}

/** Just enough deps for the navigate handler: a map where the new session appears on the Nth look. */
function fakeDeps(arrivesOnLook: number): { deps: ToolDeps; looks: () => number } {
  const before = fakeSession('s-old', FROM);
  const after = fakeSession('s-new', TO);
  // Navigate reads the map ONCE before dispatch, to record who was already on the target so arrival
  // cannot be attributed to them. That read is not a poll, and these tests are about the arrival
  // budget — so it is answered "nobody was there" and left out of the count, or every assertion
  // below would silently be measuring one thing while describing another.
  let sampled = false;
  let look = 0;
  const sessions: Partial<SessionManager> = {
    resolve: () => before,
    // The reload branch asks whether a DIFFERENT object holds the id now. Same object: not back.
    get: () => before,
    all: () => {
      if (!sampled) {
        sampled = true;
        return [];
      }
      look++;
      return look >= arrivesOnLook ? [after] : [];
    },
  };
  return {
    deps: { sessions: sessions as SessionManager, now: () => 0 } as unknown as ToolDeps,
    looks: () => look,
  };
}

const nav = BROWSER_TOOLS.find((t) => t.name === ReticleTool.NAVIGATE);

describe('reticle_navigate spends the caller’s timeout_ms on arrival', () => {
  it('timeout_ms: 0 looks once and answers, naming the budget it did not have', async () => {
    const { deps, looks } = fakeDeps(2);
    const out = await nav?.handler(deps, { url: TO, timeout_ms: 0 });
    expect(out).toMatchObject({ ok: true, confirmed: false, waitedMs: 0 });
    expect(looks(), 'a zero budget is one look, not a wait').toBe(1);
  });

  it('a budget keeps the daemon looking until the page comes back', async () => {
    const { deps, looks } = fakeDeps(2);
    const out = await nav?.handler(deps, { url: TO, timeout_ms: 1_000 });
    expect(out).toMatchObject({ ok: true, confirmed: true, sessionId: 's-new' });
    expect(looks()).toBe(2);
  });

  it('applies to a reload too — the page coming back is the same wait', async () => {
    const { deps } = fakeDeps(Number.POSITIVE_INFINITY);
    const out = await nav?.handler(deps, { reload: true, timeout_ms: 0 });
    expect(out).toMatchObject({ ok: true, confirmed: false, waitedMs: 0 });
  });
});
