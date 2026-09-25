/**
 * `reticle_session { action: "end" }` must end the session it was given, or none.
 *
 * `resolve` answers a departed id with its live SUCCESSOR, which is right for everything that
 * observes: a tab reloads, its id survives in sessionStorage, and an `assert` keeps working. It is
 * wrong for a destructive call. Reported from the field twice: passing `sessionId: "sac14d46c…"`
 * returned `ended: true` for `"s08e37e5c…"`, once where the requested session's browser had just
 * closed — so the behaviour was "target missing ⇒ end something else" rather than "target missing
 * ⇒ say so". Ending another agent's session mid-verification is not recoverable (#983).
 */

import { describe, expect, it } from 'vitest';
import { ReticleTool, SessionState } from '@reticlehq/core';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';

const REQUESTED = 'sac14d46c';
const SUCCESSOR = 's08e37e5c';

function endTool() {
  const tool = LIVE_CONTROL_TOOLS.find((t) => t.name === ReticleTool.END_SESSION);
  if (tool === undefined) throw new Error('reticle_end_session is not defined');
  return tool;
}

/** A registry where `REQUESTED` has departed and `SUCCESSOR` is the live tab at the same origin. */
function depsWithSuccessor(): { deps: unknown; ended: string[] } {
  const ended: string[] = [];
  const successor = {
    id: SUCCESSOR,
    url: 'http://localhost:5173/app',
    setState: (state: SessionState) => {
      if (SessionState.ENDED === state) ended.push(SUCCESSOR);
    },
    // Ending a session reports what it proved, read from its journal.
    readJournalActions: () => Promise.resolve([]),
  };
  return {
    ended,
    deps: {
      sessions: {
        count: () => 1,
        get: (id: string) => (SUCCESSOR === id ? successor : undefined),
        departed: (id: string) => (REQUESTED === id ? { id, url: successor.url } : undefined),
        // What the real manager does for a departed id: hand back the successor.
        resolve: () => successor,
      },
    },
  };
}

describe('a named session is matched exactly, never substituted', () => {
  it('does not end a different session when the named one has departed', async () => {
    const { deps, ended } = depsWithSuccessor();

    await endTool().handler(deps as never, { sessionId: REQUESTED });

    expect(ended).toEqual([]);
  });

  it('answers idempotently, naming the session the caller asked about', async () => {
    const { deps } = depsWithSuccessor();

    const result = (await endTool().handler(deps as never, { sessionId: REQUESTED })) as Record<
      string,
      unknown
    >;

    // `ended: true` because the session IS ended — it disconnected. The id echoed back is the one
    // the caller named, so a reader can never mistake this for a report about another tab.
    expect(result['ended']).toBe(true);
    expect(result['sessionId']).toBe(REQUESTED);
    expect(String(result['note'])).toMatch(/already disconnected/i);
    expect(String(result['note'])).not.toContain(SUCCESSOR);
  });

  it('still ends a named session that is live', async () => {
    const { deps, ended } = depsWithSuccessor();

    const result = (await endTool().handler(deps as never, { sessionId: SUCCESSOR })) as Record<
      string,
      unknown
    >;

    expect(ended).toEqual([SUCCESSOR]);
    expect(result['sessionId']).toBe(SUCCESSOR);
    expect(result['note']).toBeUndefined();
  });

  it('refuses an id the daemon has never seen, rather than ending anything', () => {
    const ended: string[] = [];
    const deps = {
      sessions: {
        count: () => 1,
        get: () => undefined,
        departed: () => undefined,
        resolve: (id?: string) => {
          throw new Error(`no connected session with id '${String(id)}'`);
        },
      },
    };

    expect(() => endTool().handler(deps as never, { sessionId: 'never-existed' })).toThrow(
      /no connected session/i,
    );
    expect(ended).toEqual([]);
  });
});
