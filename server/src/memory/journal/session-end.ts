import { driveFlowsFrom, type DriveProgram, type TapeStep } from './drive-flow.js';
import {
  OnboardingPhase,
  OnboardingStepStatus,
  type OnboardingStep,
} from '@reticlehq/core/telemetry';
import { AmbientStore } from './ambient-store.js';
import type { AmbientCounts } from '@reticlehq/engine/window/ambient.js';
import { subjectOf, type JournalAction } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs/fs-port.js';
import { pruneSessions } from './on-disk/retention.js';
import { buildVerificationRun } from '../../judgement/runs/artifact/build-verification-run.js';
import { driveRunFrom, driveRunId } from '../../judgement/runs/drive-run.js';
import { RunStore } from '../../judgement/runs/artifact/run-store.js';

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
  readonly projectId?: string | undefined;
}

interface SessionEndDeps {
  fs: FileSystemPort;
  reticleRoot: string;
  /** Journaling/persistence off (opt-out) → teardown is a no-op. */
  enabled: boolean;
  /**
   * The one clock in this file, injected — the run artifact stamps `createdAt` from it.
   *
   * Optional so every existing construction keeps working; defaulted at the single call site rather
   * than reached for inside the fold, which stays pure.
   */
  now?: () => number;
  /**
   * The tape store and the flow store, so a drive can be saved as a flow at teardown.
   *
   * Optional, like `now`, so every existing construction keeps working — and absent means the
   * capture simply does not run rather than throwing at teardown, which is the rule every step in
   * this handler follows.
   */
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
  flows?: {
    save: (program: DriveProgram, annotations?: undefined, projectId?: string) => Promise<unknown>;
  };
}

/**
 * Build the teardown handler the bridge fires when a session is removed. Flushes the journal first (so no
 * evidence is lost), then folds this session's ambient counts into the persisted map so the NEXT session
 * starts already knowing which regions churn.
 */
export function makeSessionEnd(deps: SessionEndDeps): (session: SessionEndTarget) => Promise<void> {
  return async (session) => {
    if (!deps.enabled) return;
    try {
      await session.flushJournal();
    } catch {
      // a failed flush must not block ambient persistence, and must never throw at teardown
    }
    try {
      const store = new AmbientStore(deps.fs, deps.reticleRoot);
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
    // `record{start}` + `flow_save` is the agent-facing route and agents do not take it: the corpus
    // measures 3 of 33 flows mutation-testable and 6 of 112 steps declaring a consequence, while the
    // engine catches 84 of the 86 bugs it structurally can. The ceiling is how many flows EXIST that
    // could go red, so a drive that is never saved is a regression test paid for and thrown away.
    //
    // Saved only when the tape declared a consequence — see drive-flow.ts for why the alternative is
    // a false-green factory running once per session.
    try {
      await saveDrivenFlow(deps, session);
    } catch {
      // a flow is a by-product of the session; failing to write one never fails the teardown
    }
    try {
      await recordDriveRun(deps, session);
    } catch {
      // an artifact is a report ABOUT the session; failing to write one never fails the teardown
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
      // Safe against deleting the session that just ended: pruning selects the OLDEST by mtime, and the
      // directory written moments ago is the newest.
      await pruneSessions(deps.fs, deps.reticleRoot);
    } catch {
      // retention is best-effort maintenance; never surface at teardown
    }
  };
}

/**
 * Persist this session's drive as a run artifact, when it proved anything.
 *
 * Scoped to the session's OWN `artifactRoot`, never the daemon's cwd: a daemon registered globally
 * stands in `$HOME`, and writing there is how one app's evidence once reached another account's
 * dashboard.
 */
async function recordDriveRun(deps: SessionEndDeps, session: SessionEndTarget): Promise<void> {
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
  const store = new RunStore(deps.fs, session.artifactRoot ?? deps.reticleRoot);
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
