import { z } from 'zod';
import { RunReadError, type ReticleVerificationRun } from '@reticlehq/protocol';
import { ReticleTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { isValidRunId } from '../project/reticle-dir.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { RunStore } from './run-store.js';
import { renderRunReport } from './render-report.js';

/**
 * The verification-run export tool. `reticle_run_export` reads a persisted ReticleVerificationRun artifact
 * from .reticle/runs/ — the stable verdict a host platform (OEM/design partner) or CI consumes. With a
 * runId it returns that run; without one it returns the most recent. With format:"report" it returns a
 * legible ✓/✗ text report instead of raw JSON. The RunStore is built inline from the injected fs +
 * reticleRoot (it is stateless), so this needs no new ToolDeps wiring.
 */
export const RUN_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.RUN_EXPORT,
    description:
      'Export a verification-run artifact (the OEM/CI-consumable verdict) from .reticle/runs/. With { runId } returns that specific run; without it returns the most recent. With { format: "report" } returns a legible ✓/✗ text summary (flows, checks, risks, repair, why-it-failed) instead of the raw run. Returns { run } | { report } or { error, reason } when none exists.',
    inputSchema: {
      runId: z
        .string()
        .optional()
        .describe('The run id to export. Omit to return the most recent run.'),
      format: z
        .enum(['json', 'report'])
        .optional()
        .describe('json (default) returns the full run; report returns a legible text summary.'),
      ...sessionIdShape,
    },
    outputSchema: {
      run: z.unknown().optional(),
      report: z.string().optional(),
      error: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args: Record<string, unknown>) => {
      const store = new RunStore(deps.fs, deps.reticleRoot);
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
      return asString(args['format']) === 'report' ? { report: renderRunReport(run) } : { run };
    },
  },
];
