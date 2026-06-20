import { z } from 'zod';
import { RunReadError } from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { RunStore } from './run-store.js';

/**
 * The verification-run export tool. `iris_run_export` reads a persisted IrisVerificationRun artifact
 * from .iris/runs/ — the stable verdict a host platform (OEM/design partner) or CI consumes. With a
 * runId it returns that run; without one it returns the most recent. The RunStore is built inline
 * from the injected fs + irisRoot (it is stateless), so this needs no new ToolDeps wiring.
 */
export const RUN_TOOLS: ToolDef[] = [
  {
    name: IrisTool.RUN_EXPORT,
    description:
      'Export a verification-run artifact (the OEM/CI-consumable verdict) from .iris/runs/. With { runId } returns that specific run; without it returns the most recent run. Returns { run } (the full IrisVerificationRun: verdict, flows, checks, risks, evidence, repair) or { error, reason } when none exists.',
    inputSchema: {
      runId: z
        .string()
        .optional()
        .describe('The run id to export. Omit to return the most recent run.'),
      ...sessionIdShape,
    },
    outputSchema: {
      run: z.unknown().optional(),
      error: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args: Record<string, unknown>) => {
      const store = new RunStore(deps.fs, deps.irisRoot);
      const runId = asString(args['runId']);
      if (runId !== undefined) {
        const read = await store.read(runId);
        if (!read.ok) {
          return {
            error:
              read.reason === RunReadError.MISSING
                ? `no run '${runId}' in .iris/runs/`
                : `run '${runId}' is malformed`,
            reason: read.reason,
          };
        }
        return { run: read.run };
      }
      const latest = await store.latest();
      if (latest === undefined) {
        return {
          error: 'no verification runs yet — produce one with the verify flow first',
          reason: RunReadError.MISSING,
        };
      }
      return { run: latest };
    },
  },
];
