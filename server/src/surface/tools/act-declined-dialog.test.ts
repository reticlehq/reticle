/**
 * A click whose handler asks `confirm()` while Reticle drives it.
 *
 * Reticle answers the dialog "no" so that the tab cannot wedge, and the page records that answer as
 * `dialog.opened`. The `until` that needed the user to say yes then failed, and the verdict read
 * `no` / `assertion_failed`: an app defect, for a path that Reticle itself chose (#1350).
 */
import { describe, expect, it } from 'vitest';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import {
  EventType,
  ReticleCommand,
  ReticleTool,
  Verified,
  VerifiedReason,
  type ReticleEvent,
} from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { createFakeSession } from '@/portal/session/fake-session.js';

const QUESTION = 'Delete this item?';
const DELETED_SIGNAL = 'item:deleted';

const declinedConfirm = (sessionId: string): ReticleEvent => ({
  t: 0,
  type: EventType.DIALOG_OPENED,
  sessionId,
  data: { kind: 'confirm', message: QUESTION, answered: false },
});

/** Click a button. When `withDialog`, its handler opens a `confirm()` that Reticle declines. */
const clickDelete = (withDialog: boolean): Promise<Record<string, unknown>> => {
  const session = createFakeSession();
  session.command = (name: string) => {
    if (ReticleCommand.ACT === name && withDialog) {
      session.pushEvent(declinedConfirm(session.id));
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  };
  return (TOOLS.find((t) => t.name === ReticleTool.ACT_AND_WAIT) as ToolDef).handler(
    {
      sessions: { resolve: () => session } as unknown as SessionManager,
      recordings: new RecordingStore(),
      now: () => 0,
    } as unknown as ToolDeps,
    {
      ref: 'e1',
      action: 'click',
      until: { kind: 'signal', name: DELETED_SIGNAL },
      timeout_ms: 30,
    },
  ) as Promise<Record<string, unknown>>;
};

describe('an act_and_wait whose click opened a confirm() that Reticle declined', () => {
  it('is unknown, and names the declined dialog and its question', async () => {
    const result = await clickDelete(true);
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.DIALOG_DECLINED);
    expect(String(result.because)).toContain('confirm');
    expect(String(result.because)).toContain(QUESTION);
  });

  it('is still no when the click opened no dialog', async () => {
    const result = await clickDelete(false);
    expect(result.verified).toBe(Verified.NO);
    expect(result.verifiedReason).toBe(VerifiedReason.ASSERTION_FAILED);
  });
});
