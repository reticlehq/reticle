import { driveFlowsFrom, type DriveProgram, type TapeStep } from './drive-flow.js';
import { log } from '@/log.js';

/** What a session's teardown writes to the daemon log when a by-product fails to save. */
const SESSION_END_LOG = {
  FLOW_SAVE_FAILED: 'reticle_drive_flow_save_failed',
  RUN_RECORD_FAILED: 'reticle_drive_run_record_failed',
} as const;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
import { journalActionsPath, sessionDirPath } from '@/memory/project/dir/reticle-dir.js';
import { asSessionId, type SessionId } from '@reticlehq/core';
import {
  OnboardingPhase,
  OnboardingStepStatus,
  type OnboardingStep,
} from '@reticlehq/core/telemetry';
import { AmbientStore } from './ambient-store.js';
import type { AmbientCounts } from '@reticlehq/engine/window/ambient.js';
import { type ProjectId, subjectOf, type JournalAction } from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { pruneWorkspace, type PruneWorkspaceOptions } from './on-disk/startup-maintenance.js';
import { buildVerificationRun } from '@/judgement/runs/artifact/build-verification-run.js';
import { driveRunFrom, driveRunId } from '@/judgement/runs/drive-run.js';
import { RunStore } from '@/judgement/runs/artifact/run-store.js';

/**
 * Session teardown: the durable half of ending a session. Two things must happen when a tab disconnects,
 * and neither did before — the journal batches events and only writes at its flush threshold, so the tail
 * of every session (< one batch) was silently lost from disk, and the learned ambient map was never
 * persisted at all, so every session re-learned the page's churn from zero.
 *
 * Both are best-effort: a teardown failure must never surface as a session error (the tab is already gone).
 */

/** The minimal Session surface teardown needs (Session satisfies it structurally). */
export interface SessionEndTarget {
  readonly id: string;
  /**
   * Enough of the session to name the subject in the protocol's terms.
   *
   * Optional for the same reason `readJournalActions` is: an existing double keeps compiling and
   * simply produces a run with no subject, which is the honest outcome rather than an invented
   * one. See `subjectOf` -- there is one definition of what identifies a subject, and this reads
   * it rather than assembling a second.
   */
  readonly url?: string | undefined;
  readonly runtime?: string | undefined;
  readonly currentDocumentId?: string | undefined;
  readonly currentEditEpoch?: number | undefined;
  /** Write any batched journal events to disk. */
  flushJournal(): Promise<void>;
  /** The ambient-churn counts learned during this session. */
  ambientCounts(): AmbientCounts;
  ownAmbientCounts(): AmbientCounts;
  /**
   * This session's journal, for the run fold below. Optional so every existing double keeps
   * compiling and simply produces no run — the safe direction for an artifact whose only failure
   * mode is being absent.
   */
  readJournalActions?(): Promise<JournalAction[]>;
  /** The project's own `.reticle`, so a run lands in the repo it is about. */
  readonly artifactRoot?: string | undefined;
  readonly projectId?: ProjectId | undefined;
}

interface SessionEndDeps {
  fs: FileSystemPort;
  reticleRoot: string;
  /** Journaling/persistence off (opt-out) → teardown is a no-op. Retention still runs. */
  enabled: boolean;
  /** What this project is willing to keep — the `retain` block of its `.reticle.json`. */
  retain?: PruneWorkspaceOptions;
  /**
   * The one clock in this file, injected — the run artifact stamps `createdAt` from it.
   *
   * Optional so every existing construction keeps working; defaulted at the single call site rather
   * than reached for inside the fold, which stays pure.
   */
  now?: () => number;
  /**
   * Take this session's ambient tape, closing it. Bound by the CALLER, which is the half that
   * already holds the recorder — teardown needs the data, not the recorder, and reaching two
   * directories into `language/flows/recording/tape/` for a constant and two types was a dependency
   * nobody needed. `directory-reach.test.ts` refused it, and its advice was right.
   */
  takeAmbientTape?: () => { steps: readonly TapeStep[]; startPath?: string } | undefined;
  /**
   * Report one funnel step. Injected rather than imported, because this module is teardown and the
   * reach guard is right that it should not grow a dependency on the telemetry tree to say so.
   */
  reportStep?: (step: OnboardingStep) => Promise<boolean>;
  /**
   * The flow store, so a drive can be saved as a flow at teardown.
   *
   * Optional, like `now`, so every existing construction keeps working — and absent means the
   * capture simply does not run rather than throwing at teardown, which is the rule every step in
   * this handler follows.
   */
  flows?: {
    save: (
      program: DriveProgram,
      annotations?: undefined,
      projectId?: ProjectId,
    ) => Promise<unknown>;
  };
  /**
   * Called when a run artifact is written, so cloud sync can cycle instead of waiting for its timer.
   *
   * Optional, like everything else here: absent simply means the next scheduled cycle picks it up.
   */
  onRunPersisted?: () => void;
  /**
   * The ids of the sessions still OPEN, read at each teardown so retention never deletes a journal
   * that is still being written. A getter rather than a snapshot: this handler is built once at
   * wiring and fires for every session for the life of the daemon.
   *
   * Injected, like the clock and the reporter — teardown needs the answer, not the registry.
   * Optional so every existing construction keeps compiling, and absent means "none known", which
   * is exactly the old behaviour.
   */
  liveSessionIds?: () => ReadonlySet<string>;
}

/**
 * Build the teardown handler the bridge fires when a session is removed. Flushes the journal first (so no
 * evidence is lost), then folds this session's ambient counts into the persisted map so the NEXT session
 * starts already knowing which regions churn.
 */
export function makeSessionEnd(deps: SessionEndDeps): (session: SessionEndTarget) => Promise<void> {
  return async (session) => {
    /*
     * Retention is maintenance of a directory, not a part of journalling, so it runs either way.
     *
     * Teardown used to return here, and this is the one setting under which that mattered most:
     * somebody switches journalling off BECAUSE `.reticle/` got too big, and switching it off was
     * what stopped anything ever deleting what was already there. It also stopped the sweep of
     * visual diffs, feedback copies and run artifacts, none of which need the journal to be written
     * at all. The daemon's own start-path sweep was gated on the same flag, so there was no second
     * site still running — both are ungated now.
     */
    const sweep = async (): Promise<void> => {
      try {
        await pruneWorkspace(
          deps.fs,
          session.artifactRoot ?? deps.reticleRoot,
          deps.liveSessionIds?.() ?? new Set(),
          deps.retain ?? {},
        );
      } catch {
        // retention is best-effort maintenance; never surface at teardown
      }
    };
    if (!deps.enabled) {
      await sweep();
      return;
    }
    try {
      await session.flushJournal();
    } catch {
      // a failed flush must not block ambient persistence, and must never throw at teardown
    }
    try {
      // The session's own root, like the run artifact below: a churn map learned from one app is
      // not about another, and writing it to the daemon's cwd both mixed two apps' maps together and
      // left an `ambient.json` in a tree the user never instrumented.
      const store = new AmbientStore(deps.fs, session.artifactRoot ?? deps.reticleRoot);
      const persisted = await store.load();
      // Accumulate history + what is NEW. `ownAmbientCounts` excludes the map this session was
      // seeded from at startup; `ambientCounts` includes it, and adding that onto `persisted` wrote
      // `2 x persisted + own` on every teardown — a doubling per session that had driven the
      // committed map to ~9.1e23.
      const merged: AmbientCounts = { ...persisted };
      for (const [ref, count] of Object.entries(session.ownAmbientCounts())) {
        merged[ref] = (merged[ref] ?? 0) + count;
      }
      await store.save(merged);
    } catch {
      // ambient learning is an optimization; a disk failure never breaks teardown
    }
    // A DRIVE IS A VERIFICATION, and it used to leave no artifact.
    //
    // `.reticle/runs/` is what the cloud sync reads, and its only writer was the flow-replay path —
    // so a session that drove the app and produced a hundred verdicts synced nothing, and the
    // dashboard stayed empty with `lastPushAt: null`. This folds what the journal already recorded
    // into the same artifact replay writes; the sync daemon needs no change to pick it up.
    //
    // AFTER the flush above, because the fold reads the ledger the flush just completed. Silent when
    // nothing was proved either way — see drive-run.ts on why a green "nothing measured" row is
    // worse than no row.
    //
    // Not nudged: the sync daemon re-reads `.reticle/runs/` from disk on every cycle, so this lands
    // within one interval and survives a daemon that exits first. Threading a wake-up through here
    // would buy under a minute of latency for a mutable handle held across two wiring sites.
    // A DRIVE IS A REGRESSION TEST, and it used to need somebody to remember to say so.
    //
    // `record{start}` + `flow_save` is the agent-facing route and agents do not take it: few saved
    // flows are mutation-testable and few steps declare a consequence, while the engine catches
    // nearly every bug it structurally can. The ceiling is how many flows EXIST that could go red,
    // so a drive that is never saved is a regression test paid for and thrown away.
    //
    // Saved only when the tape declared a consequence — see drive-flow.ts for why the alternative is
    // a false-green factory running once per session.
    try {
      await saveDrivenFlow(deps, session);
    } catch (error: unknown) {
      // A flow is a by-product of the session; failing to write one never fails the teardown. It is
      // logged, because a drive that leaves no flow and no reason is otherwise undiagnosable.
      log(SESSION_END_LOG.FLOW_SAVE_FAILED, { error: errorMessage(error) });
    }
    try {
      await recordDriveRun(deps, session);
    } catch (error: unknown) {
      // An artifact is a report ABOUT the session; failing to write one never fails the teardown.
      log(SESSION_END_LOG.RUN_RECORD_FAILED, { error: errorMessage(error) });
    }
    try {
      // Bound the journal on disk HERE, not only at daemon start.
      //
      // Pruning ran exactly once, during wiring. A daemon that stays up — which is the normal case for
      // a dev session, and the whole point of the pool — therefore never pruned again, so session
      // directories accumulated without bound for as long as it lived. Session end is the right moment
      // because it is precisely when a new directory has just been created, which makes this amortized
      // rather than periodic (no timer to leak) and mirrors what RunStore already does.
      //
      // What makes this safe is the `live` set, NOT the order.
      //
      // This used to read "safe against deleting the session that just ended: pruning selects the
      // OLDEST by mtime, and the directory written moments ago is the newest". That is true of the
      // session that ENDED and says nothing about the ones still open — and it is not even true of
      // the byte budget, which has no count floor and will evict the single oldest entry the moment
      // the tier is over, however few there are.
      //
      // A session directory's mtime is stamped at creation and never moves again (appending to a
      // file inside it advances the FILE's mtime), so the longest-running open session is the
      // oldest-looking thing on disk and was the first candidate for both bounds. Passing the open
      // ids is what actually holds. The ended session is already out of the registry by the time
      // this runs — the bridge removes it before firing teardown — so it is eligible again, which
      // is correct: it is finished, and its journal was flushed above.
      // The root this session actually journalled into. Pruning the daemon's tree instead meant a
      // per-project workspace was never swept at all, so the one place journals really accumulate
      // was the one place retention never ran.
      /*
       * A session nobody ever drove keeps no journal.
       *
       * The observers run from the moment the SDK attaches, so an idle tab on a busy page
       * accumulates megabytes without a single tool call. The cost is not the disk: those
       * directories occupy retention SLOTS, so a journal that could answer a verdict question is
       * evicted by one that was never asked one.
       *
       * Decided at the END and never by gating CAPTURE. Whether a tool call will happen is not
       * knowable while the events that would answer it are being recorded, and gating capture on it
       * would leave the first assertion of a session with nothing to read.
       */
      await dropUndrivenJournal(
        deps.fs,
        session.artifactRoot ?? deps.reticleRoot,
        asSessionId(session.id),
      );
    } catch {
      // teardown must never throw: the tab is already gone
    }
    // EVERY tier, not just sessions. Visual diffs and feedback copies were pruned only at daemon
    // start, against the DAEMON's root — which for a globally registered daemon is `$HOME` and not
    // the project at all, so the two tiers that only ever grow in a project workspace were the two
    // never swept there. Same defect as the one this line already fixed for sessions, one move
    // behind. The byte budget rides along for the same reason: it was wired at daemon start too.
    //
    // Outside the try above, so a failure anywhere in teardown still leaves the directory swept.
    await sweep();
  };
}

/**
 * Persist this session's drive as a run artifact, when it proved anything.
 *
 * Scoped to the session's OWN `artifactRoot`, never the daemon's cwd: a daemon registered globally
 * stands in `$HOME`, and writing there is how one app's evidence once reached another account's
 * dashboard.
 */
export async function recordDriveRun(
  deps: SessionEndDeps,
  session: SessionEndTarget,
): Promise<void> {
  // Called through the object, not lifted into a local: a lifted method loses its `this`, and the
  // real Session's reader closes over the journal it was constructed with.
  if (session.readJournalActions === undefined) return;
  const actions = await session.readJournalActions();
  const input = driveRunFrom(actions, {
    // Derived from the session, NOT random. Teardown fires on every socket close, and a reconnecting
    // tab keeps its session id and appends to the same ledger — so a drive across two page reloads
    // would fold the whole ledger twice and publish two overlapping rows, the second a superset of
    // the first. A stable id makes the artifact idempotent: the same session rewrites its own run,
    // and the cloud diffs by runId, so a re-push supersedes rather than duplicates.
    runId: driveRunId(session.id),
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  });
  if (input === undefined) return;
  // The protocol reaching the artifact a person actually reads. Only when the session could say
  // where it was: a subject with no locator is not a weaker subject, it is a guess, and the
  // schema makes the field optional so that absence can be told from invention.
  const subject =
    session.url === undefined
      ? undefined
      : subjectOf({
          id: session.id,
          url: session.url,
          runtime: session.runtime,
          currentDocumentId: session.currentDocumentId,
          currentEditEpoch: session.currentEditEpoch,
        });
  const store = new RunStore(
    deps.fs,
    session.artifactRoot ?? deps.reticleRoot,
    // Tell the sync daemon a run landed, rather than letting it find out on its next tick. Teardown
    // used to write this artifact with no callback at all, so the evidence from a whole session sat
    // on disk until a timer noticed — which, for the last session of the day, could be never.
    deps.onRunPersisted === undefined ? undefined : { onWrote: deps.onRunPersisted },
  );
  await store.write(
    buildVerificationRun(
      { ...input, ...(subject === undefined ? {} : { subject }) },
      deps.now ?? ((): number => Date.now()),
    ),
  );
}

/** Persist what this session drove as a replayable flow, when it declared anything provable. */
async function saveDrivenFlow(deps: SessionEndDeps, session: SessionEndTarget): Promise<void> {
  const takeTape = deps.takeAmbientTape;
  const flows = deps.flows;
  if (takeTape === undefined || flows === undefined) return;
  // One flow per journey the session contained, not one flow per session — see drive-flow.ts.
  const { programs, outcome } = driveFlowsFrom(session.id, takeTape());
  for (const program of programs) {
    await flows.save(program, undefined, session.projectId);
  }
  // The funnel step that makes the SECOND run cheap.
  //
  // SKIPPED, not failed, when a drive proved nothing: the agent drove and declared no consequence,
  // which is a real outcome and not our bug. Counting it as a failure would blame the product for a
  // choice the agent made, and counting it as success would claim a regression test that cannot go
  // red. `unprovenSteps` is what separates "drove and proved nothing" from "drove nothing at all".
  await deps.reportStep?.({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'flow_recorded',
    status: 0 === programs.length ? OnboardingStepStatus.SKIPPED : OnboardingStepStatus.COMPLETED,
    ...(outcome.unprovenSteps === undefined ? {} : { reason: 'no_declared_consequence' }),
  });
}

/**
 * Remove this session's journal when it served no tool call.
 *
 * "Served no tool call" is read off the actions ledger, which is written one line per call: absent
 * or empty means nothing was ever driven here. Best-effort like every other maintenance step —
 * a session that cannot be tidied is not a session that failed.
 */
async function dropUndrivenJournal(
  fs: SessionEndDeps['fs'],
  root: string,
  sessionId: SessionId,
): Promise<void> {
  try {
    const actions = await fs.readFile(journalActionsPath(root, sessionId)).catch(() => '');
    if (actions.trim().length > 0) return;
    await fs.rm(sessionDirPath(root, sessionId));
  } catch {
    // tidying is never the reason a teardown fails
  }
}
