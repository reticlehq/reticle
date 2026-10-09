/**
 * One autonomous drive of a connected app, and what it left behind.
 *
 * This is the glue between the loop, the model and Reticle's own tools — and the place where the
 * economics of the feature are decided. A drive costs a model; a SAVED FLOW costs nothing to run
 * again. So the thing this returns that matters is not the model's account of what it did (which
 * nothing grades) but the flows that now exist on disk, because every future run replays those
 * deterministically with no model in the loop at all.
 */

import { serverDriver, serverOptionsFromEnv } from '@/features/harness/platform/server-driver.js';
import { exploreScript } from './harness-script.js';
import { randomUUID } from 'node:crypto';
import { harnessRunId } from '@/judgement/runs/drive-run.js';
import {
  ReticleEnv,
  ReticleTool,
  asProjectId,
  cloudUrlFrom,
  asRecord,
  type FlowFile,
} from '@reticlehq/core';
import { flowsForSession } from '@/language/flows/flow-store-for-session.js';
import { projectForRoot } from '@/memory/project/project-for-root.js';
import type { ToolDeps } from './tool-kit.js';
import { checkTally, verdictLine } from '@/features/harness/drive-report.js';
import { CUSTOM_DRIVER_NAME, SERVER_DRIVER } from '@/features/harness/drivers.js';
import { buildDomainModel } from '@/judgement/domain/domain-model.js';
import { readContract } from '@/memory/project/dir/reticle-dir.js';
import { sessionRoot, sessionTarget } from '@/memory/project/session-root.js';
import { buildHarnessPlan, planAsText, withoutReplays, type HarnessPlan } from './harness-plan.js';
import { allSessionIntents } from '@/memory/intent/open-intents.js';
import { fetchPlatformConfig, type ConfigFetch } from '@/features/harness/platform-config.js';
import type { JourneyResult } from '@/features/harness/platform/script.js';
import {
  DEFAULT_MAX_STEPS,
  runHarness,
  StopReason,
  type HarnessOptions,
  type HarnessResult,
  type HarnessToolset,
  type ModelDriver,
  type ToolOutcome,
} from '@/features/harness/harness.js';
import { reticleToolset } from './harness-toolset.js';
import { noteDriveLine } from '@/features/harness/drive-runs.js';
import { checkExpect, checkGoals, goalsIn, type GoalCheck } from '@/features/harness/goals.js';

export interface ExploreOptions {
  /** Who to be, or what to accomplish. Appended to the standing instruction. */
  focus?: string;
  /** Texts the drive must leave on the page. Default: whatever `focus` quoted. See goals.ts. */
  goals?: readonly string[];
  /** The outcome the journey must end in, as a reticle_assert predicate. See `checkExpect`. */
  expect?: Record<string, unknown>;
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
  /**
   * The GET that asks the platform what this project wants. Injected ONLY by tests.
   *
   * It exists because the two things this answer decides — a driver preference and whether the drive
   * may happen at all — were both unreachable without a network, and the refusal test that was
   * supposed to cover the OFF switch was asserting on a path where the platform is never asked.
   */
  configFetch?: ConfigFetch;
  /** The drive's harness id, minted by the caller so its run id is known before the drive starts. */
  harnessId?: string;
  /** Asked between turns: whoever started the drive asked it to stop. */
  stopped?: () => boolean;
  /** Asked between turns: what whoever started the drive said to it since. */
  inbox?: () => readonly string[];
}

export interface ExploreResult {
  drive: HarnessResult;
  /** What the drive set out to do, read from `.reticle` before it started. */
  plan: HarnessPlan;
  /** Flows that exist now and did not before — the part of a drive that is worth paying for twice. */
  savedFlows: readonly string[];
  /** Of the saved and rewritten flows, the ones with no step that checks anything. */
  unverifiedFlows: readonly string[];
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
  /** One verdict per goal, checked by the harness after the drive rather than taken on its word. */
  goals: readonly GoalCheck[];
  /** The persona plan and how each persona ended, when the platform proposed the personas. */
  planLines?: readonly string[];
  /**
   * Which driver actually drove.
   *
   * Reported rather than re-derived by the caller. A second copy of "which driver would be chosen"
   * is a copy that can disagree with the one that chose, and the whole point of naming a driver is
   * to attribute a result to it — a comparison that mislabels its own arms is worse than no
   * comparison. `custom` is an injected driver, which is neither of ours to name.
   */
  driverName: string;
  /** The run this drive syncs as (`harness-<id>`), so a caller can find it on the platform. */
  runIds?: readonly string[];
  /** How each journey of a platform plan ended, worst lane first. Absent for an unplanned drive. */
  journeys?: readonly JourneyResult[];
}

/**
 * Why the harness is unavailable, phrased as the way to make it available.
 *
 * A missing key is a configuration fact, not a fault, and the sentence a user reads has to tell them
 * the one thing to do about it. Named here because both the CLI and the honest no-flows refusal
 * print it, and two copies of this sentence would drift.
 */
export const MSG_NO_HARNESS_KEY =
  `The Reticle Harness runs on the Reticle platform, and a new account gets 10 free credits ` +
  `to try it: run \`reticle connect\` to link this project and sign in. ` +
  `Without it, drive the journey yourself with reticle_act_and_wait and an \`until\` on its last step: ` +
  `what you drive is saved as a flow just the same.`;

/** A driver named that this build no longer has: every Harness decision is the platform's now. */
const msgUnknownDriver = (asked: string): string =>
  `The Harness driver \`${asked}\` is not available: the Harness runs on the Reticle platform, ` +
  `which drives with the model set for the project in the dashboard.`;

/**
 * The environment, plus the credential this machine already has.
 *
 * `reticle link` mints a project-scoped key and files it in `~/.reticle/credentials.json`; the CLI
 * has read it from there for as long as it has existed. The harness did not, and read only
 * `process.env` — so somebody who had signed in, linked their project and been told they were
 * connected still got "no model configured to drive the app", and the only way out was to find the
 * key in the console and export it by hand. Five manual steps to reach a feature they had already
 * finished setting up.
 *
 * Resolved into the env rather than threaded through four call sites: the drivers and the
 * preference lookup all read an env record, and giving them a completed one leaves each of them
 * exactly as simple as it was. The key precedence is the resolver's, the same as sync's and the
 * CLI's: the stored key for the link's host, else the exported one (which is how CI, with no
 * keystore, gets here). An explicitly exported HOST still wins, so a proxy is not overridden.
 *
 * The credential arrives through `deps.linkedCloud`, a port, because resolving it here would make
 * the tool surface reach into `memory/cloud` — a reach the directory guard refused, correctly.
 */
export async function withLinkedCredential(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  try {
    const linked = await deps.linkedCloud?.();
    if (linked === undefined || null === linked) return env;
    return {
      ...env,
      [ReticleEnv.API_KEY]: linked.apiKey,
      [ReticleEnv.CLOUD_URL]: cloudUrlFrom(env) ?? linked.url,
    };
  } catch {
    // A credential store that cannot be read is "not linked", not an error. The harness is optional
    // and its absence is a routine answer; a drive must never fail because a JSON file was odd.
    return env;
  }
}

/**
 * Can this machine reach the Harness? Only through the platform: a linked project or a platform
 * key. Whether the workspace is entitled is the platform's answer, asked when the drive starts.
 */
export function harnessAvailable(env: Record<string, string | undefined>): boolean {
  return serverOptionsFromEnv(env) !== undefined;
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
  const refusal = await refusedByPlatform(env, options);
  if (refusal !== undefined) throw new Error(refusal);
  // The flows a drive reads and diffs are the PROJECT's, which is where its saves land.
  const reads = withProjectFlows(deps, options.sessionId);
  // No journey named: plan the drive first. The platform's Harness proposes the people worth being;
  // the saved flows, the user's request and the unproved intents fill in the rest. The plan is drawn
  // on the HUD and updated as each part runs.
  const before = new Set(await reads.flows.list());
  // Without a named journey the drive is always planned; with one, it is planned by the platform
  // when there is one, and driven here as before when there is not.
  if (options.focus === undefined || serverOptionsFromEnv(env) !== undefined) {
    const scripted = await exploreScript(deps, env, options, before);
    if (scripted !== undefined) return scripted;
  }

  const maxSteps = options.maxSteps ?? maxStepsFromEnv(env);
  // `.reticle` FIRST, before the app and before anything reads a line of source. It already holds
  // every saved flow, the consequence that must hold for each, and the declared intent nobody has
  // tested — which is the whole of what a drive should be deciding against.
  const plan = await readPlan(reads, options.sessionId);
  const driving = withoutReplays(plan);
  const built =
    options.driver === undefined
      ? buildDriver(env, maxSteps, driving, options.driverName, options.focus)
      : { driver: options.driver, name: CUSTOM_DRIVER_NAME };
  const driver = built.driver;

  // Every action this drive takes carries who took it, so the run it folds into is the Harness's own
  // and not mixed into the run of whichever agent shares the tab.
  const harnessId = options.harnessId ?? randomUUID();
  const toolset = reticleToolset(deps, {
    ...pinned(options),
    drivenBy: {
      harness: harnessId,
      driver: built.name,
      ...(options.focus === undefined ? {} : { persona: options.focus }),
    },
  });
  const narrate = narrator(deps, options);
  narrate(`Harness is driving${options.focus === undefined ? '' : `: ${options.focus}`}`);
  const drive = await runHarness(driver, toolset, {
    ...steering(options),
    maxSteps,
    // The plan rides in as standing instruction, so it is in front of the model on every turn
    // rather than remembered from a first one. `focus` is the caller's own words and goes last:
    // somebody who named a journey meant that journey, whatever the project's backlog says.
    focus: [
      planAsText(driving),
      ...(options.focus === undefined ? [] : [`Focus: ${options.focus}`]),
    ].join('\n\n'),
  });

  narrate(
    StopReason.STOPPED === drive.stopReason
      ? `Autonomous driving switched off — the Harness stopped after ${String(drive.steps)} steps. What it drove is kept.`
      : `Harness finished — ${verdictLine(checkTally(drive.toolCalls))}`,
  );
  // MANDATORY, and deliberately outside the loop. A drive that runs out of budget mid-journey, or
  // breaks, or whose model simply stops asking for tools, leaves a recording open and everything it
  // drove unsaved — work paid for and thrown away. Saving is not a decision any model gets to make
  // and not something a step budget gets to cut off, so it happens here, after the loop, always.
  await bankOpenRecording(toolset, drive, options.focus);
  const invoke = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    toolset.invoke(name, args);
  const goals = [
    ...(await checkGoals(invoke, options.goals ?? goalsIn(options.focus))),
    ...(options.expect === undefined ? [] : [await checkExpect(invoke, options.expect)]),
  ];

  const after = await reads.flows.list();
  const reconciled = reconcileFlows(before, after, drive.toolCalls);
  if (options.focus !== undefined) {
    await recordPersona(
      reads,
      [...reconciled.savedFlows, ...reconciled.rewroteFlows],
      options.focus,
    );
  }
  const unverifiedFlows = await flowsThatCheckNothing(reads, [
    ...reconciled.savedFlows,
    ...reconciled.rewroteFlows,
  ]);
  const runId = harnessRunId(harnessId);
  return {
    drive,
    plan,
    driverName: built.name,
    ...reconciled,
    unverifiedFlows,
    goals,
    ...(runId === undefined ? {} : { runIds: [runId] }),
  };
}

/** The stop and the words of whoever started the drive, for `runHarness`. */
export function steering(options: ExploreOptions): Pick<HarnessOptions, 'stopped' | 'inbox'> {
  return {
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    ...(options.inbox === undefined ? {} : { inbox: options.inbox }),
  };
}

/** A line in the HUD's Agent Log for the person watching; nobody watching is not an error. */
export function narrator(deps: ToolDeps, options: ExploreOptions): (text: string) => void {
  return (text) => {
    // The drive's poll answers with its latest line, whether or not a tab is watching.
    if (options.harnessId !== undefined) noteDriveLine(options.harnessId, text);
    try {
      deps.sessions.resolve(options.sessionId).pushNarration(text);
    } catch {
      /* nobody is watching: the drive still runs */
    }
  };
}

/** What this project's memory says must hold, in its own words. Nothing recorded is none. */
export async function productRules(deps: ToolDeps, sessionId?: string): Promise<string[]> {
  try {
    return (await allSessionIntents(deps, sessionId)).map((intent) => intent.statement);
  } catch {
    return [];
  }
}

/** `deps` whose flow store is the session's own project, where the drive's saves land. */
export function withProjectFlows(deps: ToolDeps, sessionId?: string): ToolDeps {
  try {
    return { ...deps, flows: flowsForSession(deps, sessionTarget(deps, sessionId)).flows };
  } catch {
    return deps;
  }
}

/**
 * Write the persona onto every flow the drive saved or rewrote without an intent.
 *
 * Whichever driver saved it, and in whatever words: the cheap driver's own teardown saved its flow
 * with no intent at all, so a replay could never say which journey it was meant to prove. A flow
 * that already carries an intent keeps it. Best effort: a flow that cannot be read or rewritten is
 * still a saved flow.
 */
export async function recordPersona(
  deps: ToolDeps,
  names: readonly string[],
  persona: string,
): Promise<void> {
  // Only the journey itself, "Name: journey": the plan appends the product's rules below it, and
  // keeping them made each plan append them again to a goal that already carried them.
  const intent = (persona.split('\n')[0] ?? '').trim();
  if (0 === intent.length) return;
  for (const name of names) {
    try {
      const loaded = await deps.flows.load(name);
      if (!loaded.ok || (loaded.value.intent ?? '').length > 0) continue;
      // Its own project: without it the store files a flat duplicate beside the original.
      const project = loaded.value.projectId;
      await deps.flows.saveFlow(
        { ...loaded.value, intent },
        project === undefined ? undefined : asProjectId(project),
      );
    } catch {
      /* the flow stays as it was saved */
    }
  }
}

/**
 * The saved flows with no step that asserts a consequence.
 *
 * Such a flow replays as "verified nothing": it clicks through the journey and would pass with the
 * feature broken. Named so the drive's report does not count it as evidence. A flow that cannot be
 * read is left out rather than guessed at.
 */
export async function flowsThatCheckNothing(
  deps: ToolDeps,
  names: readonly string[],
): Promise<readonly string[]> {
  const empty: string[] = [];
  for (const name of names) {
    try {
      const loaded = await deps.flows.load(name);
      if (!loaded.ok) continue;
      if (!loaded.value.steps.some((step) => step.expect !== undefined)) empty.push(name);
    } catch {
      /* unreadable is not the same as empty */
    }
  }
  return empty;
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
 * What a person said about autonomous driving on the platform, honoured here.
 *
 * The switch existed, persisted and round-tripped, and the daemon read it and threw it away — so
 * turning the harness OFF changed a value in a database and nothing else. A control that does not
 * control anything is worse than no control: somebody turns it off, watches Reticle drive their app
 * anyway, and now correctly distrusts every other switch in the product.
 *
 * Absent means ON. The platform's own default is on, and a machine that cannot reach the platform —
 * offline, CI, no link — must not silently lose a feature it was never told to stop using.
 */
export const MSG_HARNESS_DISABLED =
  'Autonomous driving is turned OFF for this project. Turn it back on in the Reticle dashboard ' +
  '(Settings → Verification model), or drive the app yourself through the MCP tools.';

/**
 * The other reason a drive can be refused, and it is NOT the same reason.
 *
 * A drive through the platform spends Reticle's model budget, bounded by the workspace's Harness
 * credits. The platform answers this only when something other than the switch stops it.
 */
export const MSG_HARNESS_UNCLAIMED =
  'The Reticle platform says this workspace cannot drive the Harness right now, usually because its ' +
  'credits are spent: see Settings → Plan in the Reticle dashboard.';

/** The platform could not be asked, and the drive would spend Reticle's budget without its yes. */
export const MSG_HARNESS_UNCONFIRMED =
  'Could not confirm Harness access with the Reticle platform, so the drive did not start. Try ' +
  'again in a moment.';

/** One read, however many questions are asked of the answer. */
function platformConfig(env: Record<string, string | undefined>, options: ExploreOptions) {
  return options.configFetch === undefined
    ? fetchPlatformConfig(env)
    : fetchPlatformConfig(env, options.configFetch);
}

/**
 * The reason this drive must not start, or `undefined` to go ahead.
 *
 * A drive on somebody's OWN model key never waits on the platform beyond the off switch: their key,
 * their spend. A drive through the platform proxy bills Reticle, and that one needs a confirmed yes
 * — enabled, entitled, and a model ready. It used to fail open: `fetchPlatformConfig` answers
 * `undefined` on a network error, a non-2xx, a body that does not parse, or a two-second timeout,
 * and all four read as "carry on", so a slow second on a settings endpoint let an unentitled
 * workspace drive on Reticle's budget. Now the same silence refuses with a message that says to
 * retry or bring a key. Fields an older platform omits still default to yes inside
 * `fetchPlatformConfig`; only an answer that never arrived is a no.
 */
export async function refusedByPlatform(
  env: Record<string, string | undefined>,
  options: ExploreOptions,
): Promise<string | undefined> {
  if (true === options.skipPlatformConfig) return undefined;
  // No platform, no Harness: it runs there, on the workspace's credits.
  if (serverOptionsFromEnv(env) === undefined) return MSG_NO_HARNESS_KEY;
  const config = await platformConfig(env, options);
  // It needs a confirmed yes, not the absence of a no. The platform also checks on every turn.
  if (config === undefined) return MSG_HARNESS_UNCONFIRMED;
  if (!config.harnessEnabled) return MSG_HARNESS_DISABLED;
  if (!config.harnessEntitled) return MSG_HARNESS_UNCLAIMED;
  return undefined;
}

/**
 * Close and save whatever recording the drive left open.
 *
 * The driver reserves turns for its own teardown, which covers the ordinary ending. It does NOT
 * cover a drive that broke, or one whose model went quiet, or one cut off by a budget the caller
 * shortened — and in every one of those the app really was driven and the record of it is thrown
 * away. Measured before this existed: a 24-step journey through a real dashboard, saved nothing.
 *
 * Failures are swallowed on purpose. This is a last chance, not a checkpoint: if the recording was
 * already closed the stop is refused and there is nothing to do, and a drive must not fail at the
 * finish line because the thing it was trying to rescue did not need rescuing.
 */
/**
 * What a banked recording says it was for: the persona the caller named, when there was one.
 *
 * It used to be "Autonomous drive of X, banked after the run ended" whatever the caller asked for,
 * so a replay could never say which journey the flow was meant to prove.
 */
export function bankedIntent(persona: string | undefined, open: string): string {
  const named = persona?.trim();
  return named !== undefined && 0 < named.length
    ? named
    : `Autonomous drive of ${open}, banked after the run ended.`;
}

export async function bankOpenRecording(
  toolset: HarnessToolset,
  drive: HarnessResult,
  persona: string | undefined,
): Promise<void> {
  const open = openRecordingName(drive.toolCalls);
  if (open === undefined) return;
  try {
    await toolset.invoke(ReticleTool.RECORD, { action: 'stop', recordingName: open });
    await toolset.invoke(ReticleTool.FLOW_SAVE, {
      flowName: open,
      intent: bankedIntent(persona, open),
    });
  } catch {
    /* last chance, not a checkpoint */
  }
}

/** The recording started and never stopped, if there is one. Exported because it is the decision. */
export function openRecordingName(toolCalls: readonly ToolOutcome[]): string | undefined {
  let open: string | undefined;
  for (const call of toolCalls) {
    if (ReticleTool.RECORD !== call.name) continue;
    const args = asRecord(call.args);
    const name = args['recordingName'];
    if ('string' !== typeof name) continue;
    if ('start' === args['action'] && !call.isError) open = name;
    if ('stop' === args['action'] && name === open) open = undefined;
  }
  return open;
}

/**
 * Read the project's own record of what it does and what is proved about it.
 *
 * No browser, no model, no source. A failure here is "nothing is recorded yet", which is the
 * ordinary state of a new project and not a reason to refuse to drive — so it answers an empty
 * plan rather than throwing.
 */
export async function readFlows(deps: ToolDeps): Promise<FlowFile[]> {
  const flows: FlowFile[] = [];
  try {
    for (const name of await deps.flows.list()) {
      const loaded = await deps.flows.load(name);
      if (loaded.ok) flows.push(loaded.value);
    }
  } catch {
    // An unreadable store plans from what it could read, as `readPlan` does.
  }
  return flows;
}

export async function readPlan(deps: ToolDeps, sessionId?: string): Promise<HarnessPlan> {
  try {
    const flows = await readFlows(deps);
    const root = sessionRoot(deps, sessionId);
    const contract = await readContract(deps.fs, root);
    const project = await projectForRoot(deps, root).read();
    return buildHarnessPlan(
      buildDomainModel(
        flows,
        contract.ok ? contract.capabilities : null,
        project.ok ? project.file.runs : [],
      ),
    );
  } catch {
    return {
      steps: [],
      summary: 'The project record could not be read; driving without a plan.',
      vocabulary: [],
    };
  }
}

export function pinned(options: ExploreOptions): { sessionId?: string } {
  return options.sessionId === undefined ? {} : { sessionId: options.sessionId };
}

/**
 * The driver: the platform's Harness, which decides every step on its side while this machine
 * executes. There is no other: the decisions, the models and the planning run only on the platform.
 */
export function buildDriver(
  env: Record<string, string | undefined>,
  maxSteps: number,
  plan: HarnessPlan,
  requested?: string,
  persona?: string,
  /** A goal driven with no persona: it names the drive's flows as a persona would. */
  journey?: string,
): { driver: ModelDriver; name: string } {
  if (requested !== undefined && SERVER_DRIVER !== requested)
    throw new Error(msgUnknownDriver(requested));
  const platform = serverOptionsFromEnv(env);
  if (platform === undefined) throw new Error(MSG_NO_HARNESS_KEY);
  return {
    driver: serverDriver({
      ...platform,
      ...(persona === undefined ? {} : { persona }),
      ...(journey === undefined ? {} : { journey }),
      plan: planAsText(plan),
      planSteps: plan.steps,
      vocabulary: plan.vocabulary,
      maxSteps,
    }),
    name: SERVER_DRIVER,
  };
}
