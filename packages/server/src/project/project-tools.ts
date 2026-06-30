import { z } from 'zod';
import { ProjectReadError, RunKind, RunStatus, type RunRecord } from '@reticle/protocol';
import { ReticleTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'Active session ID from reticle_sessions. Omit when only one browser session is open.',
    ),
};

/** The diff between the two most-recent runs for a name — the "did it behave like last time?" answer. */
interface RunDiff {
  statusChanged: boolean;
  previousStatus: RunStatus;
  currentStatus: RunStatus;
  regressed: boolean;
  consoleErrorsDelta?: number;
  driftStepsDelta?: number;
}

const REGRESSION_STATUSES: ReadonlySet<RunStatus> = new Set([
  RunStatus.FAIL,
  RunStatus.DRIFT,
  RunStatus.ERROR,
]);

function diffRuns(previous: RunRecord, current: RunRecord): RunDiff {
  const consoleErrorsDelta = numericDelta(
    previous.evidence?.consoleErrors,
    current.evidence?.consoleErrors,
  );
  const driftStepsDelta = numericDelta(previous.evidence?.driftSteps, current.evidence?.driftSteps);
  return {
    statusChanged: previous.status !== current.status,
    previousStatus: previous.status,
    currentStatus: current.status,
    // Regressed = current is a non-pass outcome that the previous run was not.
    regressed: REGRESSION_STATUSES.has(current.status) && !REGRESSION_STATUSES.has(previous.status),
    ...(consoleErrorsDelta !== undefined ? { consoleErrorsDelta } : {}),
    ...(driftStepsDelta !== undefined ? { driftStepsDelta } : {}),
  };
}

function numericDelta(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined && after === undefined) return undefined;
  return (after ?? 0) - (before ?? 0);
}

/** The two most-recent runs for `name`, oldest-first, or undefined if there are fewer than two. */
function lastTwoFor(runs: RunRecord[], name: string): [RunRecord, RunRecord] | undefined {
  const matching = runs.filter((r) => r.name === name);
  const n = matching.length;
  if (n < 2) return undefined;
  const previous = matching[n - 2];
  const current = matching[n - 1];
  if (previous === undefined || current === undefined) return undefined;
  return [previous, current];
}

/**
 * The cross-run memory tools. `reticle_project` reads .reticle/project.json (optionally
 * scoped to a name, with a diff-vs-last summary); `reticle_run_record` explicitly records an outcome
 * (the manual companion to the auto-record on reticle_flow_replay). Both keep the agent's "did this
 * behave like last run?" question answerable without re-deriving it from raw observations.
 */
export const PROJECT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.PROJECT,
    description:
      'Read cross-run history from .reticle/project.json — the memory of how past runs behaved. With { name } it also returns the last run for that flow plus a diff-vs-last summary (status change, regressed flag, consoleErrors/driftSteps deltas) so you can answer "did it behave like last time?". Returns { runs, learned?, lastRun?, diff? } or { error, reason } when no/invalid history exists.',
    inputSchema: {
      name: z.string().optional().describe('Filter runs by this name. Omit to return all runs.'),
      ...sessionIdShape,
    },
    outputSchema: {
      runs: z.array(z.unknown()),
      diff: z.unknown().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const read = await deps.project.read();
      if (!read.ok) {
        return {
          error:
            read.reason === ProjectReadError.MISSING
              ? 'no .reticle/project.json yet — run a flow (reticle_flow_replay) or reticle_run_record first'
              : '.reticle/project.json is malformed — it will self-heal on the next recorded run',
          reason: read.reason,
        };
      }
      const name = asString(args['name']);
      if (name === undefined) {
        return { runs: read.file.runs, learned: read.file.learned };
      }
      const lastRun = await deps.project.lastRun(name);
      const pair = lastTwoFor(read.file.runs, name);
      return {
        runs: read.file.runs.filter((r) => r.name === name),
        learned: read.file.learned,
        lastRun,
        ...(pair !== undefined ? { diff: diffRuns(pair[0], pair[1]) } : {}),
      };
    },
  },
  {
    name: ReticleTool.RUN_RECORD,
    description:
      'Explicitly record a run outcome into .reticle/project.json (the manual companion to the auto-record on reticle_flow_replay). Use it to log the result of an assertion sequence or a manual journey so future runs can diff against it. Returns { recorded:true, name, status }.',
    inputSchema: {
      name: z.string().describe('Run name for grouping in reticle_project history.'),
      status: z.nativeEnum(RunStatus).describe('Outcome: pass | fail | drift | error'),
      kind: z.nativeEnum(RunKind).optional(),
      summary: z.string().optional().describe('One-line human summary of what this run covered.'),
      ...sessionIdShape,
    },
    outputSchema: {
      recorded: z.boolean(),
      runName: z.string(),
      status: z.string(),
    },
    handler: async (deps: ToolDeps, args) => {
      const name = asString(args['name']) ?? '';
      const status = args['status'] as RunStatus;
      const kindArg = args['kind'];
      const summary = asString(args['summary']);
      await deps.project.recordRun({
        kind: typeof kindArg === 'string' ? (kindArg as RunKind) : RunKind.MANUAL,
        name,
        status,
        ...(summary !== undefined ? { summary } : {}),
      });
      return { recorded: true, runName: name, status };
    },
  },
];
