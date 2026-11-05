/**
 * `reticle_verify { action: "compare" }`: `reticle compare` for an agent whose tools are loaded.
 *
 * It runs the CLI's own compare (`runCompareCommand`) against this daemon, over the same loopback
 * transport the CLI uses, so the answer is the `--json` object of `reticle compare` and nothing
 * else. The leased tabs resolve their own project from the page, as every lease does. A compare takes minutes, longer than one tool call may wait, so within `wait` seconds it
 * answers the result, or `{ status: "running", runId }` to poll with `runId`, as `explore` does.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RETICLE_DEFAULT_PORT, ReticleTool } from '@reticlehq/core';
import {
  pairingToken,
  runCompareCommand,
  type CompareCommandOptions,
} from '@/command/cli/two-builds/compare-command.js';
import type { ToolDef } from './tool-kit.js';

type RunCompare = (options: CompareCommandOptions) => Promise<{ code: number; lines: string[] }>;
type Sleep = (ms: number) => Promise<void>;

const RUN_PREFIX = 'compare-';
const COMPARE_ACTION = 'compare';
const RUNNING = 'running';
/** Seconds one call waits for the result before it answers with a run id. */
const DEFAULT_WAIT_S = 50;
const MAX_WAIT_S = 240;
const MS_PER_S = 1000;
/** The most finished runs kept for polling. A run is read back once or twice, not for ever. */
const KEPT_RUNS = 8;
const MSG_NEEDS_URLS = 'compare needs `reference` and `candidate`, the urls of two running builds';
const MSG_UNKNOWN_RUN = 'no compare run has the id';

const asText = (value: unknown): string | undefined =>
  'string' === typeof value && value.length > 0 ? value : undefined;

/** The JSON object the CLI printed, or the line itself when it is not one. */
function parsed(lines: readonly string[]): unknown {
  const line = lines[0] ?? '';
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return { error: line };
  }
}

/** The compare tool. `run` and `sleep` are injected so a test needs no daemon. */
export function compareTool(
  run: RunCompare = runCompareCommand,
  sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): ToolDef {
  const runs = new Map<string, Promise<unknown>>();
  const answer = async (
    runId: string,
    result: Promise<unknown>,
    waitS: number,
  ): Promise<unknown> => {
    const timedOut = Symbol(RUNNING);
    const first = await Promise.race([result, sleep(waitS * MS_PER_S).then(() => timedOut)]);
    if (first !== timedOut) {
      return first;
    }
    return { status: RUNNING, runId, next: { action: COMPARE_ACTION, runId } };
  };
  return {
    name: ReticleTool.VERIFY_COMPARE,
    description:
      'Drive two running builds of one app the same way (for example main and a pull request preview) and list each difference in what users see and in the requests and console errors the app made. Nothing is installed in the app. One opinionated recipe: plan every action on the reference, drive it on the reference two times and the candidate one time, and ignore what changes between the two reference runs. With `base`, each difference is tagged regression, target-missed or changed, with a score. Answers the JSON of `reticle compare --json`: `verified` yes (same), no (different) or unknown (the run proves nothing). Within `wait` seconds the result, or { status: "running", runId } to poll with `runId`. DESTRUCTIVE: it presses every button it finds.',
    inputSchema: {
      reference: z.string().optional().describe('URL of the build that is right, e.g. main.'),
      candidate: z.string().optional().describe('URL of the build to check.'),
      base: z.string().optional().describe('URL of the build before the change.'),
      runId: z
        .string()
        .optional()
        .describe('The run id a compare call answered with; pass it to poll that run.'),
      wait: z.number().min(0).max(MAX_WAIT_S).optional().describe('Seconds; default 50.'),
    },
    handler: async (deps, args) => {
      const waitS = 'number' === typeof args['wait'] ? args['wait'] : DEFAULT_WAIT_S;
      const polled = asText(args['runId']);
      if (polled !== undefined) {
        const result = runs.get(polled);
        if (result === undefined) {
          return { error: `${MSG_UNKNOWN_RUN} ${polled}` };
        }
        return answer(polled, result, waitS);
      }
      const reference = asText(args['reference']);
      const candidate = asText(args['candidate']);
      if (reference === undefined || candidate === undefined) {
        return { error: MSG_NEEDS_URLS };
      }
      const base = asText(args['base']);
      const token = pairingToken();
      const runId = `${RUN_PREFIX}${randomUUID()}`;
      const result = run({
        reference,
        candidate,
        ...(base === undefined ? {} : { base }),
        json: true,
        port: deps.bridgePort ?? RETICLE_DEFAULT_PORT,
        ...(token === undefined ? {} : { token }),
      }).then((out) => parsed(out.lines));
      runs.set(runId, result);
      // ponytail: the oldest runs are dropped by count. Drop by age if a session polls very late.
      for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - KEPT_RUNS))) {
        runs.delete(old);
      }
      return answer(runId, result, waitS);
    },
  };
}

export const COMPARE_TOOLS: ToolDef[] = [compareTool()];
