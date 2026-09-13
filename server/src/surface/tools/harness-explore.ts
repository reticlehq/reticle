/**
 * One autonomous drive of a connected app, and what it left behind.
 *
 * This is the glue between the loop, the model and Reticle's own tools — and the place where the
 * economics of the feature are decided. A drive costs a model; a SAVED FLOW costs nothing to run
 * again. So the thing this returns that matters is not the model's account of what it did (which
 * nothing grades) but the flows that now exist on disk, because every future run replays those
 * deterministically with no model in the loop at all.
 */

import { ReticleEnv } from '@reticlehq/core';
import type { ToolDeps } from './tools.js';
import { harnessDriver, harnessOptionsFromEnv } from '../../features/harness/driver.js';
import {
  DEFAULT_MAX_STEPS,
  runHarness,
  type HarnessResult,
  type ModelDriver,
} from '../../features/harness/harness.js';
import { reticleToolset } from './harness-toolset.js';

export interface ExploreOptions {
  /** Who to be, or what to accomplish. Appended to the standing instruction. */
  focus?: string;
  /** Pinned tab, when the app has more than one connected. */
  sessionId?: string;
  /** Hard ceiling on model turns. Bounds cost, not value — the drive is usable however it ends. */
  maxSteps?: number;
  /** Injected for tests, and for anyone driving with a model this repo does not ship a binding for. */
  driver?: ModelDriver;
}

export interface ExploreResult {
  drive: HarnessResult;
  /** Flows that exist now and did not before — the part of a drive that is worth paying for twice. */
  savedFlows: readonly string[];
}

/**
 * Why the harness is unavailable, phrased as the way to make it available.
 *
 * A missing key is a configuration fact, not a fault, and the sentence a user reads has to tell them
 * the one thing to do about it. Named here because both the CLI and the honest no-flows refusal
 * print it, and two copies of this sentence would drift.
 */
export const MSG_NO_HARNESS_KEY =
  `No model configured to drive the app: set ${ReticleEnv.HARNESS_KEY} to let Reticle explore it ` +
  `for you. Without it, flows are recorded by your own coding agent through the MCP tools.`;

/** Is there a model the harness can drive with? A read, because "not configured" is not a failure. */
export function harnessAvailable(env: Record<string, string | undefined>): boolean {
  return harnessOptionsFromEnv(env) !== undefined;
}

/**
 * Read the step ceiling out of the environment.
 *
 * Exported because the number is a budget somebody pays, and a budget that can only be changed by
 * editing the source is not a budget. A value that is not a positive number is IGNORED rather than
 * treated as zero: a typo that silently drove nothing would report a clean-looking run over an app
 * nobody touched.
 */
export function maxStepsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[ReticleEnv.HARNESS_MAX_STEPS];
  if (raw === undefined) return DEFAULT_MAX_STEPS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STEPS;
}

/**
 * Drive a connected app with a model, through Reticle's own tools.
 *
 * The flow list is read before and after rather than taken from the model's word for it. A model
 * that says it saved a flow and did not is the same false green as an app that says it saved a
 * record and did not — and this product does not get to make that mistake about its own work.
 */
export async function exploreApp(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
  options: ExploreOptions = {},
): Promise<ExploreResult> {
  const driver = options.driver ?? buildDriver(env);
  const before = new Set(await deps.flows.list());

  const drive = await runHarness(driver, reticleToolset(deps, pinned(options)), {
    maxSteps: options.maxSteps ?? maxStepsFromEnv(env),
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });

  const after = await deps.flows.list();
  return { drive, savedFlows: after.filter((name) => !before.has(name)) };
}

function pinned(options: ExploreOptions): { sessionId?: string } {
  return options.sessionId === undefined ? {} : { sessionId: options.sessionId };
}

function buildDriver(env: Record<string, string | undefined>): ModelDriver {
  const configured = harnessOptionsFromEnv(env);
  if (configured === undefined) throw new Error(MSG_NO_HARNESS_KEY);
  return harnessDriver(configured);
}
