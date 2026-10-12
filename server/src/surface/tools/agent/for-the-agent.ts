/**
 * What an agent's own call (an MCP connection, not the Harness or the HUD) receives: compacted, its
 * advisories folded into once-per-session notices, the rule it just broke re-taught once, and — on
 * its first answer — the pointer to the primer and this app's notes.
 *
 * `detail: "full"` keeps today's envelope. `reticle_run` passes its inner call's answer through,
 * which was already shaped. Everything here runs AFTER the verdict was decided and after telemetry
 * read the full result; none of it can change a verdict.
 */
import { ReticleTool } from '@reticlehq/core';
import { addAppNote, readAppNotes } from './app-notes.js';
import { shapeForAgent, wantsFull } from './compact-envelope.js';
import { learnFromVerdict } from './app-notes-learning.js';
import { reteachFor } from './reteach.js';
import { staleBuildNotice } from './build-staleness.js';
import { PRIMER_POINTER, type NoticeFold, foldNotices } from './notices.js';
import { dirname } from 'node:path';
import { keychainNoticeOnce, projectReader } from '@/command/cli/doctor/doctor-signing-line.js';

export interface AgentAnswer {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** The agent session; undefined for every caller that is not an agent's own connection. */
  attach: string | undefined;
  /** The project's `.reticle` root, when one resolves. */
  root: string | undefined;
  fold: NoticeFold;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  'object' === typeof value && null !== value && !Array.isArray(value);

export function forTheAgent(answer: AgentAnswer): unknown {
  const { name, args, attach, root } = answer;
  const shaped = shapeForAgent(name, args, answer.result, attach !== undefined);
  if (attach === undefined || ReticleTool.RUN === name || !isRecord(shaped)) return shaped;
  // A corrected failure that just passed becomes an app note: a hint for the next session.
  const learned = learnFromVerdict(attach, args, shaped);
  if (learned !== undefined && root !== undefined) addAppNote(root, learned);
  if (wantsFull(args)) return shaped;
  const notes = root === undefined ? [] : readAppNotes(root).map((note) => `App note: ${note}`);
  const stale = staleBuildNotice();
  const project = root === undefined ? undefined : dirname(root);
  const keychain =
    project === undefined
      ? undefined
      : keychainNoticeOnce(attach, { read: projectReader(project), dir: project });
  return foldNotices(shaped, attach, answer.fold, [
    ...(stale === undefined ? [] : [stale]),
    ...(keychain === undefined ? [] : [keychain]),
    PRIMER_POINTER,
    ...notes,
    ...reteachFor(attach, name, args, shaped),
  ]);
}
