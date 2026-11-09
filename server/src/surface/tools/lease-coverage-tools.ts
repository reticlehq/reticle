/**
 * `reticle_lease { action: "coverage" }` — which code of a leased page ran, as the JS engine counted it.
 *
 * A caller outside the app cannot see which branches a drive reached. The JS engine can: each script's block
 * ranges carry a count. This reads them from the lease's own Playwright page, the way
 * `reticle_network_mock` reaches it, so it needs no change to the app.
 *
 * A take returns what ran since the previous take, and coverage keeps running across a reload.
 * Start it on acquire (`jsCoverage: true`) to see the code that runs while the page loads; a start
 * after the load misses it.
 */
import { z } from 'zod';
import { ReticleTool, asNumber, asString } from '@reticlehq/core';
import type { ScriptCoverage } from '@/portal/input/js-coverage.js';
import { sessionIdShape, type ToolDef, type ToolDeps } from './tool-kit.js';

export const LeaseCoverageMode = { START: 'start', TAKE: 'take' } as const;

/** Ranges one take returns when the caller sets no cap. */
export const DEFAULT_MAX_COVERAGE_RANGES = 20_000;
const MAX_COVERAGE_RANGES = 200_000;

const NOT_A_LEASE =
  'reticle_lease { action: "coverage" } reads a leased tab only. Acquire one with reticle_lease { action: "acquire", url, jsCoverage: true }, then pass its sessionId.';
const CANNOT_MEASURE =
  'This leased page cannot measure JS coverage. Coverage needs Chromium, and a page that is still open.';
const WAS_NOT_RUNNING =
  'Coverage was not running, so this take holds nothing. It runs now: do the work, then take again. To see the code that runs while the page loads, acquire with jsCoverage: true.';

interface Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

/** What a take returns: each kept script with its ranges, and what the cap and filter left out. */
export interface CoverageTake {
  scripts: { url: string; ranges: Range[] }[];
  scriptCount: number;
  rangeCount: number;
  filteredOut?: number;
  truncated?: { scripts: number; ranges: number; maxRanges: number };
}

/**
 * Flatten each script's functions into one range list, keep the scripts `urlContains` names, and
 * stop at `maxRanges`. What the cap drops is counted in `truncated`, beside the value.
 */
export function flattenCoverage(
  entries: readonly ScriptCoverage[],
  maxRanges: number,
  urlContains?: string,
): CoverageTake {
  const kept = entries.filter((e) => urlContains === undefined || e.url.includes(urlContains));
  const scripts: CoverageTake['scripts'] = [];
  let rangeCount = 0;
  let droppedRanges = 0;
  let droppedScripts = 0;
  for (const entry of kept) {
    const ranges = entry.functions.flatMap((f) => f.ranges);
    const room = maxRanges - rangeCount;
    if (room <= 0 && 0 < ranges.length) {
      droppedScripts += 1;
      droppedRanges += ranges.length;
      continue;
    }
    const taken = ranges
      .slice(0, Math.max(0, room))
      .map(({ startOffset, endOffset, count }) => ({ startOffset, endOffset, count }));
    droppedRanges += ranges.length - taken.length;
    rangeCount += taken.length;
    scripts.push({ url: entry.url, ranges: taken });
  }
  const filteredOut = entries.length - kept.length;
  return {
    scripts,
    scriptCount: scripts.length,
    rangeCount,
    ...(0 < filteredOut ? { filteredOut } : {}),
    ...(0 < droppedRanges
      ? { truncated: { scripts: droppedScripts, ranges: droppedRanges, maxRanges } }
      : {}),
  };
}

/** The acquire argument that starts coverage before the page's first script. */
export const LEASE_JS_COVERAGE_ARG = z
  .boolean()
  .optional()
  .describe(
    'Start JS coverage before the page runs its first script, so reticle_lease { action: "coverage" } also counts the code that runs while the page loads.',
  );

export const LEASE_COVERAGE_TOOL: ToolDef = {
  name: ReticleTool.LEASE_COVERAGE,
  description:
    'JS coverage of a leased tab: which code ran. { mode: "start" } starts it; { mode: "take" } (the default) returns, for each script, its url and block ranges { startOffset, endOffset, count } since the previous take. A count of 0 is code that did not run. Acquire with jsCoverage: true to include the code that runs while the page loads. Use urlContains to keep only your own scripts; a take that hits maxRanges says what it dropped in `truncated`.',
  example: { mode: 'take', urlContains: '/src/' },
  inputSchema: {
    mode: z
      .enum([LeaseCoverageMode.START, LeaseCoverageMode.TAKE])
      .optional()
      .describe(
        '"start" starts coverage; "take" (default) returns what ran since the previous take.',
      ),
    urlContains: z
      .string()
      .min(1)
      .optional()
      .describe('Keep only the scripts whose url contains this text, for example "/src/".'),
    maxRanges: z
      .number()
      .int()
      .min(1)
      .max(MAX_COVERAGE_RANGES)
      .optional()
      .describe(
        `The most ranges one take returns. Default ${String(DEFAULT_MAX_COVERAGE_RANGES)}.`,
      ),
    ...sessionIdShape,
  },
  outputSchema: {
    running: z.boolean().describe('Whether coverage runs on the page after this call.'),
    scripts: z
      .array(
        z.object({
          url: z.string(),
          ranges: z.array(
            z.object({ startOffset: z.number(), endOffset: z.number(), count: z.number() }),
          ),
        }),
      )
      .optional(),
    scriptCount: z.number().optional(),
    rangeCount: z.number().optional(),
    filteredOut: z
      .number()
      .optional()
      .describe('Scripts left out because their url did not contain urlContains.'),
    truncated: z
      .object({ scripts: z.number(), ranges: z.number(), maxRanges: z.number() })
      .optional()
      .describe(
        'Present when the take hit maxRanges: the scripts and ranges it dropped. Absent means nothing was dropped.',
      ),
    hint: z.string().optional(),
  },
  handler: async (deps: ToolDeps, args) => {
    const session = deps.sessions.resolve(asString(args['sessionId']));
    const coverage = deps.pool?.coverageOf(session.id);
    if (coverage === undefined) {
      throw new Error(NOT_A_LEASE);
    }
    if (LeaseCoverageMode.START === args['mode']) {
      if (!(await coverage.start())) {
        throw new Error(CANNOT_MEASURE);
      }
      return { running: true };
    }
    const entries = await coverage.take();
    if (entries === undefined) {
      if (!(await coverage.start())) {
        throw new Error(CANNOT_MEASURE);
      }
      return { running: true, scripts: [], scriptCount: 0, rangeCount: 0, hint: WAS_NOT_RUNNING };
    }
    const maxRanges = asNumber(args['maxRanges']) ?? DEFAULT_MAX_COVERAGE_RANGES;
    return { running: true, ...flattenCoverage(entries, maxRanges, asString(args['urlContains'])) };
  },
};
