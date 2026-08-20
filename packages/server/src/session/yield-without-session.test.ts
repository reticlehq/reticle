/**
 * Ending a turn must not require a browser session.
 *
 * `reticle_session { action: "yield" }` is documented as MANDATORY before an agent stops driving,
 * and it resolved a session to do its work — so on the most common state a daemon is in, no app
 * connected, the mandatory call failed. Field reports describe the consequence exactly: the agent
 * skips yield and writes the gap into prose instead, and the panel is left showing an agent that
 * is no longer there. It was also the single largest source of refusals we recorded.
 *
 * Ending a turn is a statement about the AGENT, not about a tab. With nothing connected there is
 * simply no panel to update, and saying so is the honest answer.
 *
 * The boundary matters as much as the fix: this only applies when the caller named no session. A
 * call that names a session that does not exist is still wrong, and must still say so.
 */
import { describe, expect, it } from 'vitest';
import { YIELD_WITHOUT_SESSION_NOTE, PresenterTone } from '@reticlehq/core';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import type { ToolDef } from '../tools/tools.js';

const toolNamed = (name: string): ToolDef => {
  const found = LIVE_CONTROL_TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
};

const NO_SESSION = 'no browser session connected';

/** A registry with nothing connected: `resolve` throws exactly as the real one does. */
function emptyDeps(): unknown {
  return {
    sessions: {
      count: () => 0,
      resolve: () => {
        throw new Error(NO_SESSION);
      },
    },
  };
}

/** A registry with nothing connected that still refuses a NAMED session, which is correct. */
function unknownIdDeps(): unknown {
  return {
    sessions: {
      count: () => 0,
      resolve: (id?: string) => {
        throw new Error(id === undefined ? NO_SESSION : `no such session '${String(id)}'`);
      },
    },
  };
}

describe('yield with no browser session connected', () => {
  it('succeeds as a no-op instead of failing the call the agent is told it must make', async () => {
    const result = (await toolNamed(ReticleTool.YIELD).handler(emptyDeps() as never, {
      mode: PresenterTone.WAITING,
    })) as Record<string, unknown>;

    expect(result['yielded']).toBe(true);
    expect(result['mode']).toBe(PresenterTone.WAITING);
    expect(result['note']).toBe(YIELD_WITHOUT_SESSION_NOTE);
  });

  it('reports no sessionId rather than inventing one', async () => {
    const result = (await toolNamed(ReticleTool.YIELD).handler(emptyDeps() as never, {
      mode: PresenterTone.ASK,
    })) as Record<string, unknown>;

    // An empty string here would be a lie that reads as a real id in a log.
    expect(result['sessionId']).toBeUndefined();
    expect(result['mode']).toBe(PresenterTone.ASK);
  });

  it('ends the session as a no-op too, for the same reason', async () => {
    const result = (await toolNamed(ReticleTool.END_SESSION).handler(
      emptyDeps() as never,
      {},
    )) as Record<string, unknown>;

    expect(result['ended']).toBe(true);
    expect(result['sessionId']).toBeUndefined();
    expect(result['note']).toBe(YIELD_WITHOUT_SESSION_NOTE);
  });

  it('still refuses when the caller NAMES a session that does not exist', () => {
    // The no-op is for "I am done and nothing was connected". Naming a dead session is a mistake
    // about which tab you are talking to, and swallowing that would hide a real error.
    //
    // Synchronous `toThrow`, not `rejects`: these handlers resolve the session before returning a
    // promise, so the refusal escapes as a plain throw and `rejects` would never see it.
    expect(() =>
      toolNamed(ReticleTool.YIELD).handler(unknownIdDeps() as never, {
        mode: PresenterTone.WAITING,
        sessionId: 'sgone',
      }),
    ).toThrow(/no such session/i);

    expect(() =>
      toolNamed(ReticleTool.END_SESSION).handler(unknownIdDeps() as never, {
        sessionId: 'sgone',
      }),
    ).toThrow(/no such session/i);
  });
});
