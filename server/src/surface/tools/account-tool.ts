/**
 * Where the user stands with Reticle, for the coding agent: signed in or not, whether this project
 * reports to the dashboard, the plan and credits left, whether Reticle Harness is on,
 * what a Harness run costs, and the one thing to do next.
 *
 * In 16 real Claude Code and Codex runs, no agent could answer "how many credits do I have" or "can
 * the Harness run" from a tool: those facts lived only in the HUD and the dashboard. This reads the
 * same sources they do (the HUD's snapshot for the account, the platform's model config for the
 * plan and credits), so the agent and the HUD cannot disagree. No setup score gates the Harness.
 */
import { z } from 'zod';
import { CONNECT_COMMAND, ReticleTool, asRecord, asString } from '@reticlehq/core';
import { creditsUsageText } from '@reticlehq/core/hud';
import { impactSnapshot } from '@/memory/impact/impact-recorder.js';
import { readDashboardUrl } from '@/memory/project/sync-status.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { platformHeaders } from '@/features/harness/platform/server-driver.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';

const CONFIG_PATH = '/v1/model/config';
const CONFIG_TIMEOUT_MS = 3_000;

/** What the agent is told to do next, in plain words: one step, the first one that applies. */
export const ACCOUNT_NEXT = {
  SIGN_IN: `The user is not signed in to Reticle. Ask them to run \`${CONNECT_COMMAND}\` in the app folder: it signs them in and links this project.`,
  LINK: `This project does not report to the dashboard yet. Ask the user to press "Link this project" on the Harness page of the HUD, or to run \`${CONNECT_COMMAND}\` in the app folder.`,
  unreachable: (url: string | undefined): string =>
    `Reticle Cloud${url === undefined ? '' : ` at ${url}`} did not answer, so credits and the Harness are not known now. ` +
    'The project is still linked: ask the user to check the connection, then read the account again. Local checks still work.',
  NO_CREDITS: (said: string): string =>
    `${said} Reticle Harness cannot run until the user gets more credits on the dashboard's Plan and usage page.`,
  OFF: 'Reticle Harness is off for this project. The user can switch it on in the HUD (the Harness row at the foot of the Agent Log) or on the dashboard.',
  NO_PROVIDER:
    'The platform has no model provider set, so Reticle Harness cannot run now. Tell the user; it is not on their side.',
  ready: (typical: number | undefined, max: number | undefined): string =>
    'Reticle Harness is on and ready: reticle_verify { action: "explore", persona: "<the journey, with the text the page must show at the end in quotes>" }' +
    (typical === undefined
      ? '.'
      : `. A run costs about ${String(typical)} credits${max === undefined ? '' : `, at most ${String(max)}`}.`),
} as const;

export interface AccountInput {
  signedIn: boolean;
  workspace?: string;
  dashboardUrl?: string;
  /** The platform's `/v1/model/config` answer; undefined when unlinked, null when it did not answer. */
  platform: Record<string, unknown> | null | undefined;
  /** Where the linked cloud is, said when it does not answer. */
  cloudUrl?: string;
}

const num = (v: unknown): number | undefined => ('number' === typeof v ? v : undefined);
const str = (v: unknown): string | undefined => ('string' === typeof v ? v : undefined);

/** The facts and the next step. Pure: the tool's I/O is in `readAccount`. */
export function accountFacts(input: AccountInput): Record<string, unknown> {
  const base = {
    signedIn: input.signedIn,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    linked: input.platform !== undefined,
    ...(input.dashboardUrl === undefined ? {} : { dashboardUrl: input.dashboardUrl }),
  };
  if (!input.signedIn) return { ...base, next: ACCOUNT_NEXT.SIGN_IN };
  if (input.platform === undefined) return { ...base, next: ACCOUNT_NEXT.LINK };
  if (null === input.platform) return { ...base, next: ACCOUNT_NEXT.unreachable(input.cloudUrl) };
  const p = input.platform;
  const rawCredits = asRecord(p['credits']);
  const used = num(rawCredits['used']);
  const limit = num(rawCredits['limit']);
  const plan = asRecord(p['plan']);
  const daysLeft = num(plan['daysLeft']);
  const kind = str(rawCredits['kind']);
  const credits =
    used === undefined || limit === undefined
      ? undefined
      : {
          used,
          limit,
          left: Math.max(0, limit - used),
          ...(kind === undefined ? {} : { kind }),
          said: creditsUsageText({
            used,
            limit,
            ...('free' === kind || 'trial' === kind || 'paid' === kind ? { kind } : {}),
            ...(daysLeft === undefined ? {} : { daysLeft }),
          }),
        };
  const runCost = asRecord(p['harnessRunCredits']);
  const typical = num(runCost['typical']);
  const max = num(runCost['max']);
  const provider = str(p['provider']);
  const providerReady =
    provider === undefined ? true : asRecord(p['available'])[provider] !== false;
  const harness = {
    on: true === p['harnessEnabled'],
    ...(typical === undefined
      ? {}
      : { runCredits: { typical, ...(max === undefined ? {} : { max }) } }),
  };
  const facts = {
    ...base,
    ...(0 === Object.keys(plan).length ? {} : { plan }),
    ...(credits === undefined ? {} : { credits }),
    harness,
  };
  const next =
    credits !== undefined && 0 === credits.left
      ? ACCOUNT_NEXT.NO_CREDITS(credits.said)
      : !providerReady
        ? ACCOUNT_NEXT.NO_PROVIDER
        : !harness.on
          ? ACCOUNT_NEXT.OFF
          : ACCOUNT_NEXT.ready(typical, max);
  return { ...facts, next };
}

/** The platform's model config with this project's linked key; undefined unlinked, null on no answer. */
async function platformConfig(
  platform: { url: string; apiKey: string } | null,
): Promise<Record<string, unknown> | null | undefined> {
  if (null === platform) return undefined;
  try {
    const res = await fetch(`${platform.url.replace(/\/+$/, '')}${CONFIG_PATH}`, {
      method: 'GET',
      headers: platformHeaders(platform),
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return asRecord(JSON.parse(await res.text()) as unknown);
  } catch {
    return null;
  }
}

async function readAccount(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<Record<string, unknown>> {
  let root: string | undefined;
  try {
    root = sessionRoot(deps, sessionId);
  } catch {
    root = undefined; // no tab: the account still answers, without a project
  }
  const snapshot = impactSnapshot(root);
  const account = snapshot?.account;
  const dashboardUrl = root === undefined ? undefined : readDashboardUrl(root);
  // The tab's own project's link, as the Harness reads it: the daemon's own folder may be unlinked
  // (or another project) while the tab's is linked, and the answer was "press Link this project".
  const platform = (await deps.linkedCloud?.(root).catch(() => null)) ?? null;
  return accountFacts({
    signedIn: true === account?.signedIn,
    ...(account?.org === undefined ? {} : { workspace: account.org }),
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
    platform: await platformConfig(platform),
    ...(null === platform ? {} : { cloudUrl: platform.url }),
  });
}

export const ACCOUNT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.ACCOUNT,
    description:
      'Where the user stands with Reticle: signed in or not, whether this project reports to the dashboard, the plan and credits left, whether Reticle Harness is on, what a Harness run costs, and the one thing to do next. Read it before you tell the user anything about credits, the plan or the Harness.',
    inputSchema: {
      sessionId: z.string().optional().describe('Target a specific tab. Omit unless you mean one.'),
    },
    handler: async (deps, args) => readAccount(deps, asString(args['sessionId'])),
  },
];
