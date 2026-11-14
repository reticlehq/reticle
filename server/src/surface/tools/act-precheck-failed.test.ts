/**
 * An `act_and_wait` whose pre-action read fails must grade `unknown` and close its action window.
 *
 * It used to throw the raw read error with no verdict, and leave the window open so later events
 * were attributed to an action that had already ended (#2038).
 */
import { describe, expect, it } from 'vitest';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { EventType, ReticleCommand, ReticleTool, Verified, VerifiedReason } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { createFakeSession } from '@/portal/session/fake-session.js';

const run = async (matchFails: string, errorText: string) => {
  const sent: string[] = [];
  const session = createFakeSession({
    command(name: string) {
      sent.push(name);
      if (ReticleCommand.MATCH !== name) {
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
      }
      return 'match rejected' === matchFails
        ? Promise.reject(new Error(errorText))
        : Promise.resolve({ kind: 'command_result', id: 'c', ok: false, error: errorText });
    },
  });
  const result = (await (TOOLS.find((t) => t.name === ReticleTool.ACT_AND_WAIT) as ToolDef).handler(
    {
      sessions: { resolve: () => session } as unknown as SessionManager,
      recordings: new RecordingStore(),
      now: () => 0,
    } as unknown as ToolDeps,
    {
      ref: 'e1',
      action: 'click',
      until: { kind: 'text', contains: 'Saved draft', absent: true },
      timeout_ms: 30,
    },
  )) as Record<string, unknown>;
  // An event that arrives after the handler returned belongs to no action.
  session.pushEvent({ t: 0, type: EventType.DOM_ADDED, sessionId: session.id, data: {} });
  const late = session.eventsSince(0).find((e) => EventType.DOM_ADDED === e.type);
  return { result, sent, lateActionId: late?.actionId };
};

describe('an act_and_wait whose pre-action read failed', () => {
  it.each([
    ['match answered ok:false', 'page matcher fault'],
    ['match rejected', "command 'match' timed out after 1500ms"],
  ] as const)('is unknown, sends no act and closes its window (%s)', async (how, errorText) => {
    const { result, sent, lateActionId } = await run(how, errorText);
    expect(sent).not.toContain(ReticleCommand.ACT);
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.INCONCLUSIVE);
    expect(String(result.because)).toContain(errorText);
    expect(String(result.because)).toContain('the action was not sent');
    expect(lateActionId).toBeUndefined();
  });
});
