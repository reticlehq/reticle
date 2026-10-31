/**
 * The single dispatch point for every ACT and ACT_SEQUENCE command, extracted from
 * act-tools.ts at the 1000-line cap.
 *
 * Attribution: this dispatch does NOT open its own window — the CALLER wraps it in
 * `session.beginAction` / `finishAction` with the tool it serves (act, act_and_wait, act_sequence
 * pass their own `command`), so the window covers the whole flow around the dispatch, not just
 * the send.
 */

import { ActionType, ReticleCommand, asRecord, asString } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import type { ToolDeps } from './tool-kit.js';
import { rewriteUploadArgs, tryRealInput, HOVER_NEEDS_POINTER_MSG } from './real-input-attempt.js';
import { sessionRoot } from '@/memory/project/session-root.js';

/**
 * Single dispatch point for every ACT and ACT_SEQUENCE command.
 *
 * reticle_act, act_and_wait and act_sequence rewrite uploads here, once. The path resolves against
 * the session's project, not the daemon's folder, so a worktree uploads its own fixture (#1769).
 *
 * captureAct is called AFTER this, so the flow-recording captures the pre-rewrite args (the path
 * the agent actually wrote) rather than the base64 blob — replay would otherwise send 750 KiB of
 * base64 to the browser as if it were an inline content call.
 */
export async function actCommand(
  deps: ToolDeps,
  session: Session,
  command: ReticleCommand,
  actArgs: Record<string, unknown>,
  timeoutMs?: number,
): Promise<import('@reticlehq/core').CommandResult> {
  const rewritten = await rewriteUploadArgs(
    { fs: deps.fs, reticleRoot: sessionRoot(deps, session.id) },
    'string' === typeof actArgs['action'] ? actArgs['action'] : '',
    asRecord(actArgs['args']),
  );
  // Sequence and act_and_wait dispatch through here without the ACT handler's tryRealInput.
  // A synthetic hover reports dispatched/settled while CSS :hover never applies — drive a real
  // pointer when one is available, otherwise refuse rather than lie. A press on a lease takes its
  // real keyboard, as reticle_act does: a synthetic Tab moves no focus.
  const hover = ActionType.HOVER === actArgs['action'];
  if (hover || (ActionType.PRESS === actArgs['action'] && deps.realInput === undefined)) {
    const ref = asString(actArgs['ref']);
    if (hover && ref === undefined) {
      throw new Error(HOVER_NEEDS_POINTER_MSG);
    }
    const action = hover ? ActionType.HOVER : ActionType.PRESS;
    const real = await tryRealInput(deps, session, ref ?? '', action, actArgs);
    if (hover && real.result === undefined) {
      throw new Error(HOVER_NEEDS_POINTER_MSG);
    }
    if (real.result !== undefined) {
      const result = { dispatched: true, settled: real.settled, ...asRecord(real.result) };
      return { kind: 'command_result', id: action, ok: true, result };
    }
  }
  const bridgeArgs: Record<string, unknown> = { ...actArgs, args: rewritten };
  // What the acted element shows (test id, source) is noted in `Session.command`, Harness acts too.
  return session.command(command, bridgeArgs, timeoutMs);
}
