import { z } from 'zod';
import { sessionRoot } from '../../features/project/session-root.js';
import { RunReadError, type ReticleVerificationRun } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { asString } from '@reticlehq/core';
import { sessionIdShape } from '../../surface/tools/tool-kit.js';
import { isValidRunId } from '../../features/project/dir/reticle-dir.js';
import type { ToolDef, ToolDeps } from '../../surface/tools/tools.js';
import { RunStore } from './artifact/run-store.js';
import { renderRunReport } from './artifact/render-report.js';
import { diffRuns } from './artifact/run-diff.js';
import { toArtifact } from './artifact/to-artifact.js';

/**
 * The verification-run export tool. `reticle_run_export` reads a persisted ReticleVerificationRun artifact
 * from .reticle/runs/ — the stable verdict a host platform (OEM/design partner) or CI consumes. With a
 * runId it returns that run; without one it returns the most recent. With format:"report" it returns a
 * legible ✓/✗ text report instead of raw JSON. The RunStore is built inline from the injected fs +
 * reticleRoot (it is stateless), so this needs no new ToolDeps wiring.
 *
 * format:"openreality" is where the protocol leaves this tool. `toArtifact` had been built, tested
 * and exported with no caller anywhere -- a run could be exported in Reticle's own shape and in no
 * other, so the specification this repository publishes could be implemented by everybody except
 * us. It surfaces HERE rather than as a new tool or a file written beside the run, because the
 * question "give me this run in a format somebody else can read" is the one this tool already
 * answers three ways; a fourth format is a smaller surface than a fourth tool, and a consumer who
 * already knows `reticle_run_export` needs to learn nothing.
 */
export const RUN_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.RUN_EXPORT,
    description:
      'Export a verification-run artifact (the OEM/CI-consumable verdict) from .reticle/runs/. With { runId } returns that specific run; without it returns the most recent. With { format: "report" } returns a legible ✓/✗ text summary; with { format: "diff" } returns the run-to-run delta between the two most-recent runs (per-flow duration deltas past a noise floor, status changes, new/removed flows, verdict change, headline). Returns { run } | { report } | { diff } or { error, reason } when none exists.',
    inputSchema: {
      runId: z
        .string()
        .optional()
        .describe('The run id to export. Omit to return the most recent run.'),
      format: z
        .enum(['json', 'report', 'diff', 'openreality'])
        .optional()
        .describe(
          'json (default) returns the full run; report returns a legible text summary; diff returns the delta vs the previous run; openreality returns the run as an OpenReality (OVP) artifact a non-Reticle consumer can read.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      run: z.unknown().optional(),
      report: z.string().optional(),
      diff: z.unknown().optional(),
      artifact: z.unknown().optional(),
      error: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args: Record<string, unknown>) => {
      const store = new RunStore(deps.fs, sessionRoot(deps, asString(args['sessionId'])));
      // format:"diff" is a whole-history operation (two most-recent runs), not a single-run read.
      if ('diff' === asString(args['format'])) {
        const pair = await store.latestTwo();
        if (pair === undefined) {
          return {
            error:
              'need at least two verification runs to diff — produce another with the verify flow',
            reason: RunReadError.MISSING,
          };
        }
        return { diff: diffRuns(pair[0], pair[1]) };
      }
      const runId = asString(args['runId']);
      let run: ReticleVerificationRun;
      if (runId !== undefined) {
        if (!isValidRunId(runId)) {
          return { error: `no run '${runId}' in .reticle/runs/`, reason: RunReadError.MISSING };
        }
        const read = await store.read(runId);
        if (!read.ok) {
          return {
            error:
              read.reason === RunReadError.MISSING
                ? `no run '${runId}' in .reticle/runs/`
                : `run '${runId}' is malformed`,
            reason: read.reason,
          };
        }
        run = read.run;
      } else {
        const latest = await store.latest();
        if (latest === undefined) {
          return {
            error: 'no verification runs yet — produce one with the verify flow first',
            reason: RunReadError.MISSING,
          };
        }
        run = latest;
      }
      const format = asString(args['format']);
      if ('report' === format) return { report: renderRunReport(run) };
      if ('openreality' === format) return { artifact: toArtifact(run) };
      return { run };
    },
  },
];
