import { z } from 'zod';
import { IrisTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { crawl, type CrawlOptions } from './crawl.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

const nodeSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The autonomous "smart monkey" tool. Builds on iris_explore (which only LISTS) by
 * actually clicking each reachable control and classifying the reaction. DESTRUCTIVE by nature —
 * it drives the app — so it's an explicit, bounded tool, never part of a passive read.
 */
export const CRAWL_TOOLS: ToolDef[] = [
  {
    name: IrisTool.CRAWL,
    description:
      'Autonomously click every reachable interactive control (bounded by maxSteps, default 25) and report anomalies WITHOUT a script: console errors, failed requests (status ≥ 400), and DEAD controls (dispatched but the app did nothing). DESTRUCTIVE — it really clicks (may navigate/mutate state); use iris_explore first for a non-destructive list. Returns { interactiveFound, stepsRun, anomalies[{kind,ref,desc,detail}], counts, visited, truncated }.',
    inputSchema: {
      maxSteps: z.number().optional(),
      settleMs: z.number().optional(),
      scope: z.string().optional(),
      sessionId: z.string().optional(),
    },
    handler: (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const maxSteps = asNumber(args['maxSteps']);
      const settleMs = asNumber(args['settleMs']);
      const scope = asString(args['scope']);
      const opts: CrawlOptions = {
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(settleMs !== undefined ? { settleMs } : {}),
        ...(scope !== undefined ? { scope } : {}),
      };
      return crawl(session, opts, nodeSleep);
    },
  },
];
