/**
 * Whether the Harness may drive at all, and with which credential — answered before a drive starts.
 *
 * Split from `harness-explore.ts`, which runs the drive. This is the gate every Harness start passes
 * through (an agent's explore, Run Harness, `reticle try`, the platform's chat): the linked
 * credential, a page and daemon from different builds, and the platform's own yes or no. No setup
 * score gates it: the Harness runs at any instrumentation.
 */
import { HarnessRunReason } from '@reticlehq/core/telemetry';
import { reportAppsNow } from '@/features/harness/platform/local-apps.js';
import { serverOptionsFromEnv } from '@/features/harness/platform/server-driver.js';
import {
  CONNECT_COMMAND,
  HARNESS_NOT_LINKED_NEXT,
  RefusalCode,
  ReticleEnv,
  ReticleTool,
  cloudUrlFrom,
} from '@reticlehq/core';
import { DriveRefusedError } from '@/features/harness/drive-runs.js';
import { creditsSpent, creditsUsedLine } from '@reticlehq/core/hud';
import { planUrl } from '@/features/harness/platform/platform-drives.js';
import type { ToolDeps } from './tool-kit.js';
import { isUnmatchedRoot } from '@/memory/project/dir/reticle-dir.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { fetchPlatformConfig, type ConfigFetch } from '@/features/harness/platform-config.js';
import { reportPlanBlocked, savedPlanDrivesNothing } from '@/features/harness/platform/script.js';
import { probeMarkers } from '@/portal/session/recorded-gaps.js';
import {
  MSG_HARNESS_DISABLED,
  MSG_HARNESS_UNCLAIMED,
  MSG_HARNESS_UNCONFIRMED,
} from '@/features/harness/platform/refusal.js';

/** What the platform half of the gate reads off a drive's options; `ExploreOptions` satisfies it. */
export interface HarnessAsk {
  skipPlatformConfig?: boolean;
  configFetch?: ConfigFetch;
  planId?: string;
}

/**
 * Why the harness is unavailable, phrased as the way to make it available.
 *
 * A missing key is a configuration fact, not a fault. This is the AGENT's sentence: who does what
 * next, short, and no credit number (free credit is granted once per person, so the engine cannot
 * know what is left). Named here because the CLI and the honest no-flows refusal print it too.
 */
export const MSG_NO_HARNESS_KEY =
  `The Reticle Harness runs on the Reticle platform, and this project is not linked to it. ` +
  `Ask the person to run \`${CONNECT_COMMAND}\`, or drive the journey yourself with ` +
  `${ReticleTool.ACT_AND_WAIT} and an \`until\` on its last step.`;

/**
 * The not-linked refusal, thrown. Its code and next steps ride on the error envelope beside the
 * sentence (`codedRefusalOf`), so the agent reads who does what as data and error-recovery keys on
 * the code. The person reads `HARNESS_NOT_LINKED_HUMAN` on the HUD instead.
 */
export class HarnessNotLinkedError extends DriveRefusedError {
  readonly code = RefusalCode.HARNESS_NOT_LINKED;
  readonly next = HARNESS_NOT_LINKED_NEXT;
  constructor() {
    super(MSG_NO_HARNESS_KEY, HarnessRunReason.NOT_LINKED);
  }
}

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
  /**
   * The tab a drive is for: its own project's link, not the daemon's. A plan saved with the
   * daemon's key while its runs synced under the tab's project left every run link of the plan
   * "Run unavailable". Absent: the daemon's own link.
   */
  tab?: { sessionId: string | undefined },
): Promise<Record<string, string | undefined>> {
  try {
    const root = tab === undefined ? undefined : tabRoot(deps, tab);
    // A tab whose page reported no project (its root is `unmatched/`) is nobody else's: it drives on
    // the daemon's own link, never "run reticle connect" to a project that is linked.
    const own = root !== undefined && isUnmatchedRoot(root) ? undefined : root;
    const linked = await deps.linkedCloud?.(own);
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

/** A tab's `.reticle`, or undefined (the daemon's) when the tab cannot be resolved to one. */
function tabRoot(deps: ToolDeps, tab: { sessionId: string | undefined }): string | undefined {
  try {
    return sessionRoot(deps, tab.sessionId);
  } catch {
    return undefined;
  }
}

/** Opens a refusal for version skew: the one thing to fix before a drive can decide anything. */
export const MSG_SKEW_LEAD =
  "The page's Reticle SDK and this daemon are different builds, so a Harness drive could only " +
  'answer "unknown" on every step. It did not start. Fix the versions first:';

/** This tab and every other live tab of its app, or undefined when the tab cannot be resolved. */
function appTabsOf(deps: ToolDeps, sessionId: string | undefined) {
  let tab: ReturnType<ToolDeps['sessions']['resolve']>;
  try {
    tab = deps.sessions.resolve(sessionId);
  } catch {
    return undefined;
  }
  // Every tab of the app, the way the platform's merged report reads it.
  const siblings = (deps.sessions.list?.() ?? [])
    .filter((info) => info.sessionId !== tab.id && sameApp(info.projectId, tab.projectId))
    .flatMap((info) => {
      const live = deps.sessions.get?.(info.sessionId);
      return live === undefined ? [] : [live];
    });
  return { tab, siblings };
}

/**
 * Why a Harness drive must not start on this tab, or undefined when it may. Only a page and daemon
 * from different builds refuse here. The setup score never does: the Harness runs at any
 * instrumentation, so an app works out of the box. A tab that cannot be resolved is not refused
 * here: the drive itself answers for a missing tab.
 */
export async function harnessStartRefusal(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<HarnessRefusal | undefined> {
  const app = appTabsOf(deps, sessionId);
  // A page and daemon from different builds answer every step `unknown`: a drive spends its credits
  // and proves nothing. The handshake already knows, so say it before anything is spent.
  const skew = app?.tab.versionSkew;
  if (skew !== undefined && 0 < skew.length)
    return refusal(`${MSG_SKEW_LEAD} ${skew}`, HarnessRunReason.VERSION_SKEW);
  // Learned something: the platform hears it before the drive, so its coverage reading is current.
  if (app !== undefined && (await probeMarkers([app.tab, ...app.siblings])))
    await reportAppsNow().catch(() => undefined);
  return undefined;
}

/** Two tabs are one app when both name the same project. A tab that names none stands alone. */
const sameApp = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && a === b;

/**
 * Can this machine reach the Harness? Only through the platform: a linked project or a platform
 * key. Whether the workspace is entitled is the platform's answer, asked when the drive starts.
 */
export function harnessAvailable(env: Record<string, string | undefined>): boolean {
  return serverOptionsFromEnv(env) !== undefined;
}

/** One read, however many questions are asked of the answer. */
function platformConfig(env: Record<string, string | undefined>, options: HarnessAsk) {
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
  options: HarnessAsk,
): Promise<HarnessRefusal | undefined> {
  if (true === options.skipPlatformConfig) return undefined;
  // No platform, no Harness: it runs there, on the workspace's credits.
  if (serverOptionsFromEnv(env) === undefined)
    return refusal(MSG_NO_HARNESS_KEY, HarnessRunReason.NOT_LINKED);
  const config = await platformConfig(env, options);
  // It needs a confirmed yes, not the absence of a no. The platform also checks on every turn.
  if (config === undefined)
    return refusal(MSG_HARNESS_UNCONFIRMED, HarnessRunReason.PLATFORM_UNREACHABLE);
  // An older platform may still send `harnessUnlocked: false`. It is not read: no setup score
  // refuses a drive.
  if (!config.harnessEnabled) return refusal(MSG_HARNESS_DISABLED, HarnessRunReason.HARNESS_OFF);
  // Before entitlement: no credits left is why most workspaces are not entitled, said as the HUD says it.
  if (config.credits !== undefined && creditsSpent(config.credits))
    return refusal(
      creditsUsedLine(
        config.credits,
        // The platform's own page; built from the API origin only for a platform that names none.
        config.planUrl ?? planUrl(config.platformUrl ?? cloudUrlFrom(env) ?? ''),
      ),
      HarnessRunReason.NO_CREDITS,
    );
  if (!config.harnessEntitled) return refusal(MSG_HARNESS_UNCLAIMED, HarnessRunReason.NOT_ENTITLED);
  return undefined;
}

/**
 * `refusedByPlatform`, for a run that may be a saved plan. A plan that only replays saved flows
 * spends no model turn, so a model drive's gates do not stop it; a refused plan is still reported to
 * the plan, every journey blocked with the reason, so its history records the attempt.
 */
export async function refusedForPlan(
  env: Record<string, string | undefined>,
  options: HarnessAsk,
): Promise<HarnessRefusal | undefined> {
  const planId = options.planId;
  const platform = serverOptionsFromEnv(env);
  if (planId === undefined || platform === undefined) return refusedByPlatform(env, options);
  if (await savedPlanDrivesNothing(platform, planId)) return undefined;
  const refused = await refusedByPlatform(env, options);
  if (refused !== undefined) await reportPlanBlocked(platform, planId, firstLine(refused.text));
  return refused;
}

/** A refusal: the sentence the person or agent reads, and the reason `harness_run` reports. */
export interface HarnessRefusal {
  text: string;
  reason: HarnessRunReason;
}

function refusal(text: string, reason: HarnessRunReason): HarnessRefusal {
  return { text, reason };
}

/** The sentence a refusal leads with, without the prompt that follows it. */
export const firstLine = (text: string): string => text.split('\n')[0] ?? text;
