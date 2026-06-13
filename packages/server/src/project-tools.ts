import { z } from 'zod';
import { ProjectReadError, RunKind, RunStatus, type RunRecord } from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import type { ToolDef, ToolDeps } from './tools.js';

const sessionIdShape = { sessionId: z.string().optional() };

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
 * 0.3.7 RUNHISTORY: the cross-run memory tools. `iris_project` reads .iris/project.json (optionally
 * scoped to a name, with a diff-vs-last summary); `iris_run_record` explicitly records an outcome
 * (the manual companion to the auto-record on iris_flow_replay). Both keep the agent's "did this
 * behave like last run?" question answerable without re-deriving it from raw observations.
 */
export const PROJECT_TOOLS: ToolDef[] = [
  {
    name: IrisTool.PROJECT,
    description:
      'Read cross-run history from .iris/project.json — the memory of how past runs behaved. With { name } it also returns the last run for that flow plus a diff-vs-last summary (status change, regressed flag, consoleErrors/driftSteps deltas) so you can answer "did it behave like last time?". Returns { runs, learned?, lastRun?, diff? } or { error, reason } when no/invalid history exists.',
    inputSchema: { name: z.string().optional(), ...sessionIdShape },
    handler: async (deps: ToolDeps, args) => {
      const read = await deps.project.read();
      if (!read.ok) {
        return {
          error:
            read.reason === ProjectReadError.MISSING
              ? 'no .iris/project.json yet — run a flow (iris_flow_replay) or iris_run_record first'
              : '.iris/project.json is malformed — it will self-heal on the next recorded run',
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
    name: IrisTool.RUN_RECORD,
    description:
      'Explicitly record a run outcome into .iris/project.json (the manual companion to the auto-record on iris_flow_replay). Use it to log the result of an assertion sequence or a manual journey so future runs can diff against it. Returns { recorded:true, name, status }.',
    inputSchema: {
      name: z.string(),
      status: z.nativeEnum(RunStatus),
      kind: z.nativeEnum(RunKind).optional(),
      summary: z.string().optional(),
      ...sessionIdShape,
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
      return { recorded: true, name, status };
    },
  },
];
