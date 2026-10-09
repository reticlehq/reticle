/**
 * CLI commands that operate on SAVED FLOWS: watch, capsules, and the gate.
 *
 * Split out of cli.ts, which was 653 lines — over the project's own cap, and the file a contributor
 * opens first. These five functions form one cohesive group: they all read the flow store and report on
 * verification state, and none of them touch daemon lifecycle, which is what the rest of cli.ts does.
 */

import { GateExit } from './answers/gate-exit.js';
import { gateHookMessage, GATE_SKIP_ENV } from './answers/gate-hook-message.js';
import { readProjectId } from './ports/resolve/cli-port.js';
import { changedFilesSince, type ChangedFiles } from '@/language/flows/change/git-changed.js';
import { join } from 'node:path';
import { type ProjectId, ReticleDir } from '@reticlehq/core';
import { FlowStore } from '@/language/flows/flows.js';
import { RunStore } from '@/judgement/runs/artifact/run-store.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  affectedSavedFlows,
  toFlowSources,
  type NamedFlow,
} from '@/language/flows/change/flow-sources.js';
import { isInteractiveSource, unflowedFiles } from '@/language/flows/change/affected.js';
import {
  LedgerStore,
  regressions,
  staleChanged,
  unexecutedChanged,
} from '@/features/exhaust/ledger.js';
import { gateDecision, passingFlowNames } from '@/language/flows/change/gate.js';
import { FlakeStore } from '@/language/flows/stores/flake-store.js';
import { AssertionTiersStore } from '@/language/flows/stores/assertion-tiers-store.js';
import { detectDowngrades } from '@/judgement/outcome/assertion-integrity.js';
import { computeCoverage, flowCoverageReport } from '@/language/flows/suite/coverage.js';
import { readFileSync, statSync } from 'node:fs';
import { log } from '@/log.js';
/** Load the {name, steps} of every saved flow for the active project. */
/** Explicit files plus, when --since is given, the git-changed files since that ref. */
/**
 * `cwd` is the tree to diff, and it is a PARAMETER because the two callers do not share one. From a
 * terminal `process.cwd()` is the project; inside a globally-registered daemon it is `/` or `$HOME`,
 * where `git diff` answers about the wrong repository or about none.
 */
export async function resolveChangedFiles(
  files: string[],
  since: string | undefined,
  cwd: string,
): Promise<ChangedFiles> {
  // No ref means no question was asked of git, which is not a failure to answer one.
  if (since === undefined) return { files, failed: false };
  const changed = await changedFilesSince(since, cwd);
  return {
    files: [...new Set([...files, ...changed.files])],
    failed: changed.failed,
    ...(changed.reason === undefined ? {} : { reason: changed.reason }),
  };
}

/**
 * `projectId` is a PARAMETER for the same reason `reticleRoot` already is: the two together are one
 * address, and reading half of it from a global made them disagree. Resolved through `sessionRoot`
 * the root named the session's project while `readProjectId(process.cwd())` named the daemon's —
 * and a daemon started outside a project has none, so the list came back EMPTY. `affected` renders
 * that as "no saved flows exist yet" and `verify_change` as nothing covering the change: a
 * confident negative about somebody else's project, which is worse than an error.
 */
export async function loadNamedFlows(
  fs: FileSystemPort,
  reticleRoot: string,
  projectId: ProjectId | undefined,
): Promise<NamedFlow[]> {
  const store = new FlowStore(fs, reticleRoot, { now: () => Date.now() });
  const flows: NamedFlow[] = [];
  for (const name of await store.list(projectId)) {
    const loaded = await store.load(name, projectId);
    if (loaded.ok) flows.push({ name: loaded.value.name, steps: loaded.value.steps });
  }
  return flows;
}

/**
 * `reticle gate <file...>` — exit non-zero unless passing artifacts cover the flows affected by the
 * changed files. Flaky flows are quarantined (surfaced, not blocking). The environment-side enforcement
 * that makes verification unavoidable. Never throws; a fault fails closed (exit 1).
 */
/**
 * A changed file's text, or '' when it is gone. `git diff --name-only` answers from the repository
 * root while the gate may run in a package below it, so leading segments are dropped until the path
 * resolves from `cwd`.
 */
function atChangedPath<T>(cwd: string, file: string, read: (path: string) => T): T | undefined {
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    try {
      return read(join(cwd, ...parts.slice(i)));
    } catch {
      // not at this depth; try the path one segment shorter
    }
  }
  return undefined;
}

function readChangedFile(cwd: string, file: string): string {
  return atChangedPath(cwd, file, (path) => readFileSync(path, 'utf8')) ?? '';
}

/** When a changed file was last modified, or undefined when it is gone. Same lookup as its text. */
function changedFileModifiedAt(cwd: string, file: string): number | undefined {
  return atChangedPath(cwd, file, (path) => statSync(path).mtimeMs);
}

export async function handleGate(
  files: string[],
  since: string | undefined,
  /** Hook mode: prose for a human, and silence when there was simply nothing to check. */
  hook = false,
  /** Accept today's coverage levels as the best before judging, for a drop that was intended. */
  acceptCoverage = false,
): Promise<void> {
  try {
    const fs = createNodeFileSystem();
    const reticleRoot = join(process.cwd(), ReticleDir.ROOT);
    // Same deliberate degradation as the gate: a terminal caller sees git's own error anyway.
    const changed = (await resolveChangedFiles(files, since, process.cwd())).files;
    const allFlows = await loadNamedFlows(fs, reticleRoot, readProjectId(process.cwd()));
    const affected = affectedSavedFlows(allFlows, changed).affected;
    const latest = await new RunStore(fs, reticleRoot).latest();
    const passing = passingFlowNames(latest?.flows ?? []);
    const flaky = await new FlakeStore(fs, reticleRoot).flakyFlows();
    // Anti-reward-hacking: diff each flow's CURRENT assertions against what it asserted the last
    // time it passed. A mustHold that dropped from a real consequence to a fakeable presence check is a
    // green bought by weakening the test — and a flow that covered a changed file but no longer exists
    // is coverage deleted rather than satisfied. Both block.
    const baseline = await new AssertionTiersStore(fs, reticleRoot).load();
    const byName = new Map(allFlows.map((f) => [f.name, f]));
    const downgraded = Object.entries(baseline)
      .filter(([name]) => affected.includes(name) && byName.has(name))
      .map(([name, before]) => {
        const current = byName.get(name);
        const after = (current?.steps ?? []).map((s, i) => ({
          step: i,
          ...(s.expect === undefined ? {} : { expect: s.expect }),
        }));
        return { flow: name, steps: detectDowngrades(before.steps, after).map((d) => d.step) };
      })
      .filter((d) => d.steps.length > 0);
    // A flow with a recorded passing baseline that has since vanished, while its files changed.
    // A flow that PASSED covering these files and has since vanished is coverage DELETED, not satisfied —
    // and it can never appear in `affected` (that is derived from flows that still exist), so it must be
    // matched against the baseline's own recorded sources. Missing this made deleting a flow turn the
    // gate green, which is precisely the gaming move exists to stop.
    const changedSet = new Set(changed);
    const deleted = Object.entries(baseline)
      .filter(([name, entry]) => !byName.has(name) && entry.sources.some((f) => changedSet.has(f)))
      .map(([name]) => name);
    // Only against a suite that exists: a project with no flows yet is NOTHING_TO_CHECK, and
    // demanding a flow per edited component on its first day would block every stop.
    const unflowed =
      0 === allFlows.length
        ? []
        : unflowedFiles(toFlowSources(allFlows), changed, (file) =>
            isInteractiveSource(readChangedFile(process.cwd(), file)),
          );
    // The coverage ledger, when one exists: a level that fell below its best, and changed code the
    // browser loaded and never ran. A project that never folded coverage has an empty ledger and
    // neither can fire.
    const ledgerStore = new LedgerStore(fs, reticleRoot);
    const coverageAccepted = acceptCoverage ? await ledgerStore.acceptCurrent() : [];
    const ledger = await ledgerStore.load();
    const unexecuted = unexecutedChanged(ledger.code, changed);
    // Changed files whose coverage predates the edit: their counts describe the old code, so
    // `unexecuted` cannot judge them either way. Named rather than silently read as covered; not
    // blocking, because a destructive exhaustive crawl after every edit is not a price a gate may set.
    const coverageStale = staleChanged(ledger, changed, (file) =>
      changedFileModifiedAt(process.cwd(), file),
    ).filter((file) => !unexecuted.includes(file));
    const result = gateDecision({
      affected,
      passing,
      flaky,
      downgraded,
      deleted,
      unflowed,
      coverageRegressed: regressions(ledger),
      unexecuted,
    });
    // Verified-surface coverage over flows: how much of the saved suite this run actually exercised.
    const coverage = computeCoverage(
      { testids: [], signals: [], flows: allFlows.map((f) => f.name) },
      { testids: [], signals: [], flows: passing },
    );
    // A gate over an empty suite has not passed — it had nothing to check. Same rule the suite
    // verdict already applies to `reticle verify`; see flowCoverageReport.
    const flowCoverage = flowCoverageReport(coverage.flows);
    const pass = result.pass && flowCoverage.outcome === undefined;
    log('reticle_gate', {
      pass,
      uncovered: result.uncovered,
      quarantined: result.quarantined,
      ...(result.downgraded.length > 0 ? { downgraded: result.downgraded } : {}),
      ...(result.deleted.length > 0 ? { deletedCoverage: result.deleted } : {}),
      ...(result.unflowed.length > 0 ? { unflowed: result.unflowed } : {}),
      ...(result.coverageRegressed.length > 0
        ? { coverageRegressed: result.coverageRegressed }
        : {}),
      ...(result.unexecuted.length > 0 ? { unexecuted: result.unexecuted } : {}),
      ...(coverageStale.length > 0 ? { coverageStale } : {}),
      ...(coverageAccepted.length > 0 ? { coverageAccepted } : {}),
      coverage: flowCoverage,
    });
    // Two non-zero codes, because two callers want opposite things from the same run. CI wants any
    // problem to fail. A Stop hook wants to block a real regression and NOT block a project that
    // has simply not recorded a flow yet — which is every project on its first day, and measured
    // before this change as an exit 1 that would have blocked every stop. See GateExit.
    if (!pass) {
      const code =
        result.pass && flowCoverage.outcome !== undefined
          ? GateExit.NOTHING_TO_CHECK
          : GateExit.FAIL;
      process.exitCode = code;
      if (hook) {
        // An honest escape hatch, because the alternative to one is not compliance — it is somebody
        // deleting the hook, and a deleted gate protects nothing. Recorded either way.
        if (process.env[GATE_SKIP_ENV] !== undefined) {
          process.stderr.write(
            `Reticle: gate skipped via ${GATE_SKIP_ENV}. This change is unverified.\n`,
          );
          process.exitCode = GateExit.PASS;
          return;
        }
        const message = gateHookMessage(code, {
          uncovered: result.uncovered,
          quarantined: result.quarantined,
          // A downgrade is reported per flow with its step indices; the hook names the flow.
          downgraded: result.downgraded.map((d) => d.flow),
          deleted: result.deleted,
          unflowed: result.unflowed,
          coverageRegressed: result.coverageRegressed.map(
            (r) => `${r.level} ${String(r.was)}% -> ${String(r.now)}%`,
          ),
          unexecuted: result.unexecuted,
        });
        if (message !== undefined) process.stderr.write(`${message}\n`);
      }
    }
  } catch (error) {
    log('reticle_gate_failed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = GateExit.FAIL;
  }
}
