/**
 * A live drive is a verification, and until now it left no artifact.
 *
 * Reported from the field, and confirmed in the transcript: a session drove 89 `reticle_act_and_wait`
 * calls and 15 `reticle_assert` calls — 104 verdicts — and the dashboard stayed empty, with
 * `lastPushAt: null` throughout. Nothing was broken. `diskSource.runs()` reads `.reticle/runs/`, and
 * the ONLY writer of that directory was the flow-replay path, so a run artifact existed if and only
 * if somebody had recorded a flow and replayed it. Every verdict produced by driving the app — which
 * is the entire product experience — was local and stayed local.
 *
 * So this folds the session's journal into the same artifact the replay path writes, and the sync
 * daemon that was already running picks it up with no other change.
 *
 * ── WHAT IT WRITES DOWN ─────────────────────────────────────────────────────────────────────────
 * Every verdict, in the words it was given. `unknown` ("I could not tell") and `no-fault` ("nothing
 * was declared to prove") are neither pass nor fail, and this used to drop them, because the check
 * outcome on disk was binary and had no spelling for either. They were counted in a sentence in the
 * trigger note instead.
 *
 * That was the product's own failure mode wearing our clothes. A reader of the artifact saw only
 * the verdicts we happened to be able to spell, and "I could not see" left the document. The
 * outcome is four-valued now, so all four are recorded, and the run verdict counts an undetermined
 * check as neither a pass nor a failure -- which is what those words already meant everywhere else.
 */

import type { JournalVerdictEffect } from '@reticlehq/core/artifacts';
import { isValidRunId } from '../../features/project/dir/reticle-dir.js';
import { defaultRunId } from './runner-port.js';
import {
  JournalVerdictEffectSchema,
  RunAgentKind,
  PredicateKind,
  RunFramework,
  RunProfile,
  RunTrigger,
  type JournalAction,
  type RunCheck,
} from '@reticlehq/core';
import type { VerificationRunInput } from './artifact/build-verification-run.js';
import { withCorrections } from './late-answer.js';

/** The author of record when no MCP peer introduced itself. Mirrors verification-sync's default. */
const UNNAMED_AGENT = 'reticle-mcp';

export interface DriveRunDeps {
  runId: string;
  /** The project this session belonged to, for the dashboard's row. */
  projectId?: string | undefined;
  /** The MCP client's own claim from the handshake, when it made one. */
  agentId?: string | undefined;
  framework?: RunFramework | undefined;
  /**
   * Which round of source edits this drive's evidence belongs to.
   *
   * Passed in rather than derived, because the session knows it and a fold over the journal cannot.
   * Absent when nobody was counting edits, which must not be reported as "the first round".
   */
  editEpoch?: number | undefined;
}

/** Every verdict a verification tool recorded on this session's actions, in order. */
function verdicts(actions: readonly JournalAction[]): JournalVerdictEffect[] {
  const out: JournalVerdictEffect[] = [];
  for (const action of actions) {
    const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * The elapsed span the drive covered, from the journal's own clock.
 *
 * Journal timestamps are elapsed-ms from session start, so the last one IS the duration. Zero when
 * nothing was recorded — never `Date.now()`, which is not this session's clock and would report the
 * age of the process.
 */
function spanOf(actions: readonly JournalAction[]): number {
  return actions.reduce((max, action) => (action.at > max ? action.at : max), 0);
}

/** Marks a run as the fold of a live drive rather than a flow replay, and keeps ids from colliding. */
const DRIVE_RUN_PREFIX = 'drive-';

/**
 * The run id for a session's drive: stable, so the session rewrites its own row.
 *
 * Session teardown fires on every socket close, and a reconnecting tab keeps its session id and
 * keeps appending to the same journal. A random id per teardown would therefore publish one row per
 * reload, each a superset of the last, and the dashboard would fill with overlapping copies of one
 * drive. Derived from the session instead, so the fold is idempotent.
 *
 * A session id is a free string on the wire, so the derived id is CHECKED before it becomes a path
 * segment; anything that would not be a safe one falls back to a random id, which loses idempotence
 * for that session rather than refusing to record it.
 */
export function driveRunId(sessionId: string): string {
  const candidate = `${DRIVE_RUN_PREFIX}${sessionId}`;
  return isValidRunId(candidate) ? candidate : defaultRunId();
}

/**
 * Fold a session's journal into a run, or return undefined when there is nothing honest to report.
 *
 * Pure: it takes the ledger and returns the artifact input. Reading the ledger and writing the
 * artifact are the caller's job, which is what keeps the verdict rules testable without a disk.
 */
export function driveRunFrom(
  actions: readonly JournalAction[],
  deps: DriveRunDeps,
): VerificationRunInput | undefined {
  const found = verdicts(actions);
  const checks: RunCheck[] = [];
  for (const verdict of found) {
    checks.push({
      kind: PredicateKind.ELEMENT,
      predicate: verdict.claim,
      status: verdict.verified,
      ...(verdict.source === undefined ? {} : { evidence: { source: verdict.source } }),
      // Carried through rather than recomputed. These were established at the moment the verdict
      // was made and written down then; a run built later cannot know any of them, and inferring
      // them here would be inventing evidence about evidence.
      ...(verdict.declaredBeforeActing === undefined
        ? {}
        : { declaredBeforeActing: verdict.declaredBeforeActing }),
      ...(verdict.grade === undefined ? {} : { grade: verdict.grade }),
      ...(verdict.couldNotSee === undefined ? {} : { couldNotSee: verdict.couldNotSee }),
      // Kept so the fold below can tell a question that is still open from one that was never
      // answerable. Both are `unknown`; only one of them can be corrected later.
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    });
  }
  // A session that never verified anything has nothing to report, and saying so on a dashboard every
  // time somebody opens an app would be noise. A session that DID verify and resolved none of it is
  // the opposite: it is the thing they most need to see -- and those checks are now in the list
  // rather than counted in a sentence, so the row shows what happened instead of alluding to it.
  if (0 === checks.length) return undefined;
  // A verdict that was open because the outcome had not arrived, and a later verdict on the same
  // claim that decided it, become a correction: the second cites the first and the first is left
  // exactly as it was given. See late-answer.ts for what does and does not count as an answer.
  const corrected = withCorrections(deps.runId, checks);
  return {
    runId: deps.runId,
    durationMs: spanOf(actions),
    profile: RunProfile.DEV,
    project: {
      name: deps.projectId ?? UNNAMED_AGENT,
      framework: deps.framework ?? RunFramework.OTHER,
    },
    agent: { id: deps.agentId ?? UNNAMED_AGENT, kind: RunAgentKind.CODING_AGENT },
    trigger: {
      kind: RunTrigger.EDIT,
      note: 'driven live through the Reticle tools',
    },
    ...(deps.editEpoch === undefined ? {} : { editEpoch: deps.editEpoch }),
    changedFiles: [],
    flows: [],
    checks: corrected,
    risks: [],
    // Empty rather than harvested. The journal holds the events, but the evidence block is a claim
    // about what was WRONG, and a fold that guessed at anomalies would be inventing findings — the
    // failure this artifact is supposed to make impossible. Checks are the evidence here.
    evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
  };
}
