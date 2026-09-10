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
 * ── WHAT IT REFUSES TO SAY ──────────────────────────────────────────────────────────────────────
 * `RunCheckStatus` is binary, and `Verified` is not: `unknown` ("I could not tell") and `no-fault`
 * ("nothing was declared to prove") are neither pass nor fail, and the product's own rule is to
 * report both as NOT PROVED. Mapping them to PASS would put a false green on a dashboard, which is
 * the single failure this codebase exists to prevent; mapping them to FAIL would invent bugs. So
 * they are excluded from the checks and COUNTED IN THE NOTE, and a session whose verdicts were all
 * undetermined produces no run at all — because a run with zero checks computes to PASS, and a green
 * that means "nothing was measured" is worse than no row on the dashboard.
 */

import { isValidRunId } from '../project/reticle-dir.js';
import { defaultRunId } from './runner-port.js';
import {
  JournalVerdictEffectSchema,
  RunAgentKind,
  RunCheckKind,
  RunCheckStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  Verified,
  type JournalAction,
  type RunCheck,
} from '@reticlehq/core';
import type { VerificationRunInput } from './build-verification-run.js';

/** The author of record when no MCP peer introduced itself. Mirrors verification-sync's default. */
const UNNAMED_AGENT = 'reticle-mcp';

/** Only these two are evidence about the app. See the note above on why the others are not. */
const CHECK_STATUS: Partial<Record<Verified, RunCheckStatus>> = {
  [Verified.YES]: RunCheckStatus.PASS,
  [Verified.NO]: RunCheckStatus.FAIL,
};

export interface DriveRunDeps {
  runId: string;
  /** The project this session belonged to, for the dashboard's row. */
  projectId?: string | undefined;
  /** The MCP client's own claim from the handshake, when it made one. */
  agentId?: string | undefined;
  framework?: RunFramework | undefined;
}

/** Every verdict a verification tool recorded on this session's actions, in order. */
function verdicts(
  actions: readonly JournalAction[],
): { claim: string; verified: Verified; source?: string | undefined }[] {
  const out: { claim: string; verified: Verified; source?: string | undefined }[] = [];
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
  let undetermined = 0;
  for (const verdict of found) {
    const status = CHECK_STATUS[verdict.verified];
    if (status === undefined) {
      undetermined += 1;
      continue;
    }
    checks.push({
      kind: RunCheckKind.ELEMENT,
      predicate: verdict.claim,
      status,
      ...(verdict.source === undefined ? {} : { evidence: { source: verdict.source } }),
    });
  }
  // A session that never verified anything has nothing to report, and saying so on a dashboard every
  // time somebody opens an app would be noise. A session that DID verify and resolved none of it is
  // the opposite: it is the thing they most need to see, because it means their verification is not
  // working.
  //
  // This used to refuse both, and the reason was sound at the time -- a run with zero checks computed
  // to PASS, so writing one put a green row meaning "nothing was measured" on the dashboard, which is
  // the false green this product exists to prevent. Silence was the only honest answer available.
  //
  // A zero-check run now reads UNKNOWN, so the honest answer exists and can be given. The count of
  // what went undetermined already travels in the note.
  if (0 === checks.length && 0 === undetermined) return undefined;
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
      // The undetermined count is stated rather than dropped: a reader comparing this row against
      // their transcript would otherwise find verdicts that are simply missing, and conclude the
      // artifact is lossy rather than deliberately silent about what was never proved.
      note:
        0 === undetermined
          ? 'driven live through the Reticle tools'
          : `driven live through the Reticle tools; ${String(undetermined)} further verdict(s) were ` +
            'undetermined (unknown / no-fault) and are not counted as passes or failures',
    },
    changedFiles: [],
    flows: [],
    checks,
    risks: [],
    // Empty rather than harvested. The journal holds the events, but the evidence block is a claim
    // about what was WRONG, and a fold that guessed at anomalies would be inventing findings — the
    // failure this artifact is supposed to make impossible. Checks are the evidence here.
    evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
  };
}
