/**
 * One autonomous drive of a connected app, and what it left behind.
 *
 * This is the glue between the loop, the model and Reticle's own tools — and the place where the
 * economics of the feature are decided. A drive costs a model; a SAVED FLOW costs nothing to run
 * again. So the thing this returns that matters is not the model's account of what it did (which
 * nothing grades) but the flows that now exist on disk, because every future run replays those
 * deterministically with no model in the loop at all.
 */

import { ReticleEnv, ReticleTool, asRecord } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
import { harnessDriver, harnessOptionsFromEnv } from '@/features/harness/driver.js';
import {
  ANTHROPIC_DRIVER_NAME,
  CUSTOM_DRIVER_NAME,
  DRIVER_NAMES,
  JEV_DRIVER_NAME,
} from '@/features/harness/drivers.js';
import { jevDriver, jevOptionsFromEnv } from '@/features/harness/jev-driver.js';
import { fetchPlatformConfig } from '@/features/harness/platform-config.js';
import {
  DEFAULT_MAX_STEPS,
  runHarness,
  type HarnessResult,
  type ModelDriver,
} from '@/features/harness/harness.js';
import { reticleToolset } from './harness-toolset.js';

export interface ExploreOptions {
  /** Who to be, or what to accomplish. Appended to the standing instruction. */
  focus?: string;
  /** Pinned tab, when the app has more than one connected. */
  sessionId?: string;
  /** Hard ceiling on model turns. Bounds cost, not value — the drive is usable however it ends. */
  maxSteps?: number;
  /**
   * Which driver to use for THIS drive, overriding the environment.
   *
   * Per-call rather than only per-daemon because the question people actually have is comparative —
   * "is the cheap driver good enough for my app?" — and answering it with an environment variable
   * means restarting the daemon between arms, which is exactly the setup that let a stale daemon
   * answer three runs of our own benchmark with one configuration.
   */
  driverName?: string;
  /** Injected for tests, and for anyone driving with a model this repo does not ship a binding for. */
  driver?: ModelDriver;
  /**
   * Skip asking the platform which driver this project prefers.
   *
   * Set by tests and by callers that have already decided. Not a user-facing switch: naming a
   * driver explicitly already skips the lookup, which is the only reason anybody would want to.
   */
  skipPlatformConfig?: boolean;
}

export interface ExploreResult {
  drive: HarnessResult;
  /** Flows that exist now and did not before — the part of a drive that is worth paying for twice. */
  savedFlows: readonly string[];
  /**
   * Flows that already existed and were written again by this drive.
   *
   * Split from `savedFlows` because the before/after name diff cannot see a rewrite, and read on its
   * own it reported a drive that saved a perfectly good ten-step flow as having saved nothing — over
   * which the caller was told "nothing is proved and nothing will replay". That sentence was false,
   * and a false "nothing was verified" is the same class of mistake as a false "everything passed":
   * the product exists to stop a drive lying about its own outcome, including to us.
   *
   * It happens on any SECOND drive, because a drive that covers the same app records the same
   * journeys under the same names — so this is the ordinary case, not the corner one.
   */
  rewroteFlows: readonly string[];
  /**
   * Which driver actually drove.
   *
   * Reported rather than re-derived by the caller. A second copy of "which driver would be chosen"
   * is a copy that can disagree with the one that chose, and the whole point of naming a driver is
   * to attribute a result to it — a comparison that mislabels its own arms is worse than no
   * comparison. `custom` is an injected driver, which is neither of ours to name.
   */
  driverName: string;
}

/**
 * Why the harness is unavailable, phrased as the way to make it available.
 *
 * A missing key is a configuration fact, not a fault, and the sentence a user reads has to tell them
 * the one thing to do about it. Named here because both the CLI and the honest no-flows refusal
 * print it, and two copies of this sentence would drift.
 */
export const MSG_NO_HARNESS_KEY =
  `No model configured to drive the app: set ${ReticleEnv.HARNESS_KEY}, or run \`reticle link\` and ` +
  `set ${ReticleEnv.CLOUD_KEY}, to let Reticle explore it for you. Without either, flows are ` +
  `recorded by your own coding agent through the MCP tools.`;

/** Asked for Jev specifically and it is not configured. Distinct from having no model at all. */
export const MSG_NO_JEV_KEY =
  `The \`${JEV_DRIVER_NAME}\` driver was asked for but is not configured: set ` +
  `${ReticleEnv.HARNESS_JEV_KEY}, or run \`reticle link\` and set ${ReticleEnv.CLOUD_KEY}. ` +
  `Refusing rather than quietly driving with another model, which would misattribute the result.`;

const msgUnknownDriver = (asked: string): string =>
  `Unknown harness driver \`${asked}\`. Known drivers: ${DRIVER_NAMES.join(', ')}.`;

/** Is there a model the harness can drive with? A read, because "not configured" is not a failure. */
export function harnessAvailable(env: Record<string, string | undefined>): boolean {
  return harnessOptionsFromEnv(env) !== undefined || jevOptionsFromEnv(env) !== undefined;
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
  const maxSteps = options.maxSteps ?? maxStepsFromEnv(env);
  const before = new Set(await deps.flows.list());
  const requested =
    options.driverName ?? env[ReticleEnv.HARNESS_DRIVER] ?? (await preferredDriver(env, options));
  const built =
    options.driver === undefined
      ? buildDriver(env, maxSteps, freeFlowName(before), requested)
      : { driver: options.driver, name: CUSTOM_DRIVER_NAME };
  const driver = built.driver;

  const drive = await runHarness(driver, reticleToolset(deps, pinned(options)), {
    maxSteps,
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });

  const after = await deps.flows.list();
  return { drive, driverName: built.name, ...reconcileFlows(before, after, drive.toolCalls) };
}

/**
 * What a drive actually left behind, split into flows that are NEW and flows it wrote over.
 *
 * Pure, and exported, because it is the part that was wrong and the part worth pinning. The
 * integration around it — a real toolset dispatching a real save — is covered by driving a real app;
 * what a test can usefully hold still is the reconciliation itself.
 *
 * A rewrite is only counted when the drive claims the save AND the store lists the name afterwards.
 * The claim on its own is not evidence, which is the rule this function existed to keep: a model
 * that says it saved something it did not must not be believed. Requiring both is what lets a
 * rewrite be seen at all, since a name that was already there cannot show up in a before/after diff.
 */
export function reconcileFlows(
  before: ReadonlySet<string>,
  after: readonly string[],
  toolCalls: readonly {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    isError: boolean;
  }[],
): { savedFlows: readonly string[]; rewroteFlows: readonly string[] } {
  const present = new Set(after);
  const claimed = toolCalls
    .filter((call) => ReticleTool.FLOW_SAVE === call.name && !call.isError)
    .map((call) => {
      // The flow's filename is `saveAs` when given, and the recording's name otherwise. Read from
      // the result first, which is what the store actually wrote, and fall back to the request.
      const result = asRecord(call.result)['name'];
      if ('string' === typeof result) return result;
      const args = asRecord(call.args);
      const saveAs = args['saveAs'];
      const flowName = args['flowName'];
      if ('string' === typeof saveAs) return saveAs;
      return 'string' === typeof flowName ? flowName : undefined;
    })
    .filter((name): name is string => name !== undefined && present.has(name));

  return {
    savedFlows: after.filter((name) => !before.has(name)),
    rewroteFlows: [...new Set(claimed.filter((name) => before.has(name)))],
  };
}

/**
 * A flow name this drive can use without destroying an earlier one.
 *
 * Only the Jev driver needs this: it cannot invent a name, so one has to be chosen for it, and a
 * fixed one meant every autonomous drive silently overwrote the previous drive's flow. The
 * Anthropic driver names its own flows from what it drove, which is better, and is left alone.
 */
function freeFlowName(existing: ReadonlySet<string>): string {
  const base = 'harness-drive';
  if (!existing.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!existing.has(candidate)) return candidate;
  }
  return base;
}

/**
 * The driver this project chose on the platform, if it chose one, we can reach it, and we have it.
 *
 * Only asked when nobody has been explicit, so the cost is paid exactly once per drive and never on
 * a path where it could not change the answer. An unreachable platform returns undefined and the
 * environment decides, exactly as it did before this lookup existed.
 *
 * A preference naming a driver this build does not have is IGNORED rather than refused, and that
 * asymmetry with the per-call argument is deliberate. The platform offers providers this daemon may
 * be too old to know about — it already offers `openai`, which has no binding here — so a stored
 * preference is a statement about the account, not an instruction for this drive, and a daemon that
 * refused to run because a web UI knew one more word than it does would be broken by its own
 * upgrade cycle. Naming a driver in the CALL is an instruction, and an unknown one is still an
 * error there.
 *
 * It is not a silent substitution either way: the result reports the driver that actually drove.
 */
async function preferredDriver(
  env: Record<string, string | undefined>,
  options: ExploreOptions,
): Promise<string | undefined> {
  if (true === options.skipPlatformConfig) return undefined;
  const config = await fetchPlatformConfig(env);
  return knownDriver(config?.provider);
}

/**
 * A stored preference, kept only if this build can actually honour it.
 *
 * Exported because it is the whole of the asymmetry with the per-call argument, and the asymmetry
 * is the part somebody will later think is a bug.
 */
export function knownDriver(provider: string | undefined): string | undefined {
  if (provider === undefined) return undefined;
  return DRIVER_NAMES.some((name) => name === provider) ? provider : undefined;
}

function pinned(options: ExploreOptions): { sessionId?: string } {
  return options.sessionId === undefined ? {} : { sessionId: options.sessionId };
}

/**
 * Pick the driver.
 *
 * The Anthropic driver stays the default, and an explicit `RETICLE_HARNESS_DRIVER=jev` is the only
 * thing that moves off it when both are configured — a driver change is a change in how the app gets
 * driven, and inferring one from which key happens to be exported would swap it under people who
 * merely linked their account.
 *
 * The fall-through is the other direction and is not a preference: with no Anthropic key and a
 * platform key present, Jev is not the cheaper option, it is the only one. Choosing it there is what
 * makes the harness work for somebody who never had a model API key of their own, which is most
 * people — and the reason this driver is worth having at all.
 */
function buildDriver(
  env: Record<string, string | undefined>,
  maxSteps: number,
  recordingName: string,
  requested?: string,
): { driver: ModelDriver; name: string } {
  const jev = jevOptionsFromEnv(env);
  const anthropic = harnessOptionsFromEnv(env);
  const asked = requested;

  // A driver that was ASKED for and is not configured is an error, never a substitution. Quietly
  // falling back would make every comparison between two drivers a possible lie about which one
  // produced the result — and comparing them is the main reason anyone names one.
  if (JEV_DRIVER_NAME === asked) {
    if (jev === undefined) throw new Error(MSG_NO_JEV_KEY);
    // The Jev driver is told the budget because it has a teardown to reach; the Anthropic driver is
    // not, because it calls `finish` itself and being handed a number it did not ask for is how a
    // second copy of the budget starts drifting from the loop's.
    return { driver: jevDriver({ ...jev, maxSteps, recordingName }), name: JEV_DRIVER_NAME };
  }
  if (ANTHROPIC_DRIVER_NAME === asked) {
    if (anthropic === undefined) throw new Error(MSG_NO_HARNESS_KEY);
    return { driver: harnessDriver(anthropic), name: ANTHROPIC_DRIVER_NAME };
  }
  if (asked !== undefined && 0 < asked.length) throw new Error(msgUnknownDriver(asked));

  if (anthropic !== undefined)
    return { driver: harnessDriver(anthropic), name: ANTHROPIC_DRIVER_NAME };
  if (jev !== undefined)
    return { driver: jevDriver({ ...jev, maxSteps, recordingName }), name: JEV_DRIVER_NAME };
  throw new Error(MSG_NO_HARNESS_KEY);
}
