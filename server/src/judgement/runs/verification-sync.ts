/**
 * Turn an MCP verification (a `reticle_flow_verify` suite run) into a first-class ReticleVerificationRun:
 * assemble the artifact from the already-computed replays, persist it to .reticle/runs/ (so
 * `reticle_run_export` and CI can read it), and — when logged in (cloud creds set) — best-effort push it
 * to the cloud's `POST /v1/runs` so the team's dashboard Runs tab shows what the agent just verified.
 *
 * This is the artifact tier that maps to the dashboard's "Runs" (the OEM/CI-consumable verdict); the
 * lighter per-flow RunRecord that feeds regression memory is synced separately in flow-replay-run.ts.
 * Both are best-effort + opt-in: no creds → the artifact still lands on disk, nothing leaves the machine.
 */
import { callerClientName } from '@/hooks/coding-agents.js';
import { currentDrivenBy } from '@/hooks/driven-by.js';
import {
  RunAgentKind,
  RunFramework,
  RunProfile,
  RunTrigger,
  type FlowFile,
  type FlowReplayResult,
  type ReticleVerificationRun,
  asRunId,
} from '@reticlehq/core';
import { homedir } from 'node:os';
import {
  buildVerificationRun,
  type VerificationRunInput,
} from './artifact/build-verification-run.js';
import { mapReplayToFlowResult } from './artifact/replay-mapping.js';
import { defaultRunId } from './default-run-id.js';
import { currentShotRun } from './default-run-id.js';
import { RunStore } from './artifact/run-store.js';
import { cloudFetch, syncRunToCloud, SyncOutcome } from '@/memory/cloud/cloud-sync.js';
import { resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import { log } from '@/log.js';
import { rootForTarget, type ProjectTarget } from '@/memory/project/session-root.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

/** The author of record when no MCP peer introduced itself — a CLI run, or a client that skipped the handshake. */
const RETICLE_MCP_AGENT_ID = 'reticle-mcp';

/** A replay plus the wall-clock time it took — the shape the verify handler already collects. */
export interface TimedReplay {
  replay: FlowReplayResult;
  durationMs: number;
  /** The flow file that was replayed, so the synced run can carry its recording. */
  flow?: FlowFile;
}

/** The MCP client name `reticle verify` (the command line, CI's path) connects to a daemon as. */
export const CLI_CLIENT_NAME = 'reticle-cli';

/**
 * Who ran a suite, and why. The command line is the pipeline, whichever daemon replays for it:
 * through a running daemon its runs read as a coding agent, trigger manual, credited to whoever
 * minted the key, while the path that boots its own daemon said pipeline.
 */
function agentAndTrigger(
  client: string | undefined,
): Pick<VerificationRunInput, 'agent' | 'trigger'> {
  return CLI_CLIENT_NAME === client
    ? { agent: { id: client, kind: RunAgentKind.OEM_PIPELINE }, trigger: { kind: RunTrigger.OEM } }
    : {
        agent: { id: client ?? RETICLE_MCP_AGENT_ID, kind: RunAgentKind.CODING_AGENT },
        trigger: { kind: RunTrigger.MANUAL },
      };
}

/** Assemble the ReticleVerificationRun artifact for a verify suite (pure — no IO). */
function assembleRun(
  deps: ToolDeps,
  timed: TimedReplay[],
  /** The dashboard project this checkout is linked to, else the session's own id. */
  projectName: string | undefined,
): ReticleVerificationRun {
  const flows = timed.map((t) => mapReplayToFlowResult(t.replay, t.durationMs, t.flow));
  const input: VerificationRunInput = {
    // The run its replays' screenshots were filed under, when the verify minted one first.
    runId: asRunId(currentShotRun() ?? defaultRunId()),
    durationMs: flows.reduce((sum, f) => sum + f.durationMs, 0),
    profile: RunProfile.DEV,
    project: { name: projectName ?? 'reticle', framework: RunFramework.OTHER },
    /*
     * WHICH agent drove this, not merely THAT one did.
     *
     * This was hardcoded to 'reticle-mcp', so every run in every workspace claimed the same author.
     * A dashboard built on it could say "an agent verified this" and never "Claude Code verified
     * this, Cursor broke it" — which is the question a team actually has once more than one agent
     * touches the repo. The name is the client's own claim from the MCP handshake, for the call that
     * ran this suite only; a plain CLI run, or a dashboard Re-verify no agent made, keeps the old id,
     * because inventing a vendor there would be worse than admitting we do not know.
     */
    ...agentAndTrigger(callerClientName()),
    changedFiles: [],
    flows,
    checks: [],
    risks: [],
    evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
  };
  return buildVerificationRun(input, () => deps.now());
}

/**
 * Persist the suite's run artifact and best-effort mirror it to the cloud. Never throws into the verify
 * tool — a disk or network failure is logged and swallowed so the verdict the agent asked for is
 * unaffected. Returns the runId (for logging/tests); undefined if nothing was produced (empty suite).
 */
export async function persistAndSyncVerificationRun(
  deps: ToolDeps,
  timed: TimedReplay[],
  target: ProjectTarget,
): Promise<string | undefined> {
  const { projectId } = target;
  if (0 === timed.length) return undefined;
  // A replay the Harness made inside its own drive is part of that drive's run: written on its own
  // it was a second row ("Passed · Flow replay · Your agent") beside the plan run it belonged to.
  if (currentDrivenBy() !== undefined) return undefined;
  let run: ReticleVerificationRun;
  // The project the suite ran for, not the directory the daemon was started in. Both halves below
  // take it: the artifact `reticle_run` reads back through `sessionRoot`, and the cloud link that
  // decides WHICH DASHBOARD this run is pushed to. The daemon's own directory has no link file, so
  // a misrouted read silently meant "not attached" — and where it DID have one, the run was pushed
  // to a dashboard belonging to whoever that checkout was linked to.
  const root = rootForTarget(deps, target);
  const cloud = await resolveProjectCloud(deps.fs, root, homedir(), process.env);
  try {
    // Named after the dashboard project the checkout is linked to: a Re-verify run read "reticle".
    run = assembleRun(deps, timed, cloud.projectId ?? projectId);
    await new RunStore(deps.fs, root).write(run);
  } catch (error) {
    log('verification-run-persist-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  // Per-project cloud: only push when THIS project has cloud attached AND its policy allows runs.
  if (null === cloud.config || !cloud.policy.runs) return run.runId; // not attached / runs disabled → local only
  const result = await syncRunToCloud(run, cloud.config, cloudFetch);
  if (result.outcome !== SyncOutcome.SYNCED) {
    log('cloud-run-sync-failed', { runId: run.runId, status: result.status, error: result.error });
  }
  // The run is up; its CONTEXT is not. Nudged rather than pushed inline, so the counters and flows
  // ride the ordinary cycle (with its cursor and its overlap guard) instead of growing a second,
  // subtly different upload path here.
  deps.onRunPersisted?.();
  return run.runId;
}
