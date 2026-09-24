/**
 * Journal wiring for the composition root.
 *
 * A sibling of `index.ts` rather than a move into `memory/journal/`: this is COMPOSITION, not
 * journalling. It reaches the bridge, the flow store, the telemetry funnel and the recording tape to
 * join them together, and putting those reaches inside the journal domain would make that domain
 * depend on four areas it has no business knowing. `index.ts` already holds every one of them, and
 * the 1000-line backstop is what asked for the split.
 */
import { artifactRootResolver } from './memory/project/artifact-root-resolver.js';
import { originOf } from './portal/session/session-manager.js';
import { Bridge } from './portal/bridge/bridge.js';
import { FlowStore } from './language/flows/flows.js';
import type { FileSystemPort } from './memory/project/fs/fs-port.js';
import { makeJournalAttach } from './memory/journal/attach-journal.js';
import { makeSessionEnd, recordDriveRun } from './memory/journal/session-end.js';
import { attachDriveRunFlush } from './memory/journal/drive-run-flush.js';
import type { TapeStep } from './memory/journal/drive-flow.js';
import type { OnboardingStep } from '@reticlehq/core/telemetry';
import { AmbientStore } from './memory/journal/ambient-store.js';
import { ensureWorkspaceGitignore } from './memory/journal/on-disk/workspace-gitignore.js';
import {
  pruneWorkspace,
  type PruneWorkspaceOptions,
} from './memory/journal/on-disk/startup-maintenance.js';

/**
 * Wire journal capture, ambient seeding and the journal-tail flush onto a bridge.
 *
 * Both entry points need all three, and both used to hand-roll them. `startDaemon` only ever wired the
 * first, so on the path every user actually takes (`reticle serve` / `reticle mcp`) the journal tail was
 * dropped at session end and the learned ambient map was never persisted OR seeded — meaning ambient
 * learning could not converge across sessions and the last events of every session were lost. The two
 * call sites had already drifted once before, which is why this is one function rather than a
 * copy-paste both are asked to keep in step.
 */
export function attachJournal(
  bridge: Bridge,
  deps: {
    fs: FileSystemPort;
    reticleRoot: string;
    enabled: boolean;
    takeAmbientTape?: () => { steps: readonly TapeStep[]; startPath?: string } | undefined;
    reportStep?: (step: OnboardingStep) => Promise<boolean>;
    /** Tell cloud sync a run landed, so it cycles instead of waiting for its timer. */
    onRunPersisted?: () => void;
    flows?: FlowStore;
    /** What this project is willing to keep — the `retain` block of its `.reticle.json`. */
    retain?: PruneWorkspaceOptions;
  },
): void {
  const journalAttach = makeJournalAttach(deps);
  const ambientStore = new AmbientStore(deps.fs, deps.reticleRoot);
  // Built once, not per session: the resolver walks config discovery and the user-level registry,
  // and neither changes between two tabs connecting a second apart.
  const resolveArtifactRoot = artifactRootResolver(deps.reticleRoot);
  bridge.attachSessionCreate((session) => {
    // Stamp the project's own `.reticle` before ANY counter fires for this session. Without it every
    // verdict is recorded against wherever the daemon was started, which is how one app's evidence
    // reached a different account's production dashboard.
    // The origin is passed for the case where the page never stamped a project id: it is the only
    // distinguishing fact left, and without it every such app shares one bucket.
    session.artifactRoot = resolveArtifactRoot(session.projectId, originOf(session.url)).root;
    // Here rather than on the start path, which was neither the moment we were about to write into a
    // repository nor the root we were about to write into: it created `.reticle/` — holding nothing
    // but the ignore file — wherever the daemon was launched, coming back every boot after the user
    // deleted it, while the journals this ignore protects landed in another tree, uncovered.
    if (deps.enabled) void ensureWorkspaceGitignore(deps.fs, session.artifactRoot);
    journalAttach(session);
    // Seed the learned ambient map so a fresh session starts knowing which regions churn, instead of
    // re-learning from zero. Best-effort + async: a late seed still helps, a failure is silent.
    if (deps.enabled) {
      void ambientStore
        .load()
        .then((counts) => session.seedAmbient(counts))
        .catch(() => undefined);
    }
  });
  // Teardown: flush the journal tail to disk + persist what this session learned.
  bridge.attachSessionEnd(
    makeSessionEnd({
      ...deps,
      ...(deps.retain === undefined ? {} : { retain: deps.retain }),
      // Retention runs from teardown, and it must not delete the journal of a session that is still
      // being written. The registry is the only thing that knows which those are.
      liveSessionIds: () => new Set(bridge.sessions.all().map((s) => s.id)),
    }),
  );
  /*
   * And the same write, DURING the session rather than only at the end of it.
   *
   * Teardown was the only writer of a run artifact, so every verdict produced while a tab stayed
   * open was invisible to cloud sync — which can only push artifacts that exist. Reported as "sync
   * is not happening" and diagnosed as the agent forgetting to sync; there is no sync command to
   * forget. The evidence simply was not on disk yet.
   *
   * Safe to call repeatedly because the run id is derived from the session, so this rewrites one
   * artifact rather than accumulating them — a property `recordDriveRun` already had, for the
   * unrelated reason that a reconnecting tab must not publish two overlapping rows.
   */
  if (deps.enabled) {
    attachDriveRunFlush({
      resolve: (sessionId: string) => bridge.sessions.get(sessionId),
      write: (session) => recordDriveRun(deps, session),
    });
  }
  // One call, because "what maintenance runs at startup" needs one answer. Inlined here, the byte
  // budget was simply missing — written, tested, and called by nothing, while the three count
  // bounds beside it ran every time. See startup-maintenance.ts.
  //
  // Deliberately NOT behind `deps.enabled`. Switching journalling off is what somebody does BECAUSE
  // the directory got too big, and both sweep sites were gated on it, so that setting was the one
  // under which nothing ever deleted what was already there. Visual diffs, feedback copies and run
  // artifacts do not need the journal to be written at all and kept accumulating regardless.
  void pruneWorkspace(
    deps.fs,
    deps.reticleRoot,
    new Set(bridge.sessions.all().map((s) => s.id)),
    deps.retain ?? {},
  );
}
