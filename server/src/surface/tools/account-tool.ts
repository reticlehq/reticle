/**
 * Where the user stands with Reticle, for the coding agent: signed in or not, whether this project
 * reports to the dashboard, the plan and credits left, whether Reticle Harness is on and unlocked,
 * what a Harness run costs, and the one thing to do next.
 *
 * In 16 real Claude Code and Codex runs, no agent could answer "how many credits do I have" or "can
 * the Harness run" from a tool: those facts lived only in the HUD and the dashboard. This reads the
 * same sources they do (the HUD's snapshot for the account, the platform's model config for the
 * plan, credits and gate), so the agent and the HUD cannot disagree.
 */
import { z } from 'zod';
import { ReticleTool, asRecord, asString } from '@reticlehq/core';
import { creditsUsageText } from '@reticlehq/core/hud';
import { impactSnapshot } from '@/memory/impact/impact-recorder.js';
import { readDashboardUrl } from '@/memory/project/sync-status.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { platformHeaders } from '@/features/harness/platform/server-driver.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';

const CONFIG_PATH = '/v1/model/config';
const CONFIG_TIMEOUT_MS = 3_000;
const UNLOCK_PERCENT = 80;

/** What the agent is told to do next, in plain words: one step, the first one that applies. */
export const ACCOUNT_NEXT = {
  SIGN_IN:
    'The user is not signed in to Reticle. Ask them to run `reticle connect` in the app folder: it signs them in and links this project. A new account gets 10 free credits.',
  LINK: 'This project does not report to the dashboard yet. Ask the user to press "Link this project" on the Harness page of the HUD, or to run `reticle connect` in the app folder.',
  UNREACHABLE:
    'The Reticle platform did not answer, so credits and the Harness are not known now. Local checks still work.',
  NO_CREDITS: (said: string): string =>
    `${said} Reticle Harness cannot run until the user gets more credits on the dashboard's Plan and usage page.`,
  locked: (percent: number, missing: string): string =>
    // The platform's own sentence already names the score and the gaps: said once, not twice.
    `${0 < missing.length ? missing : `Setup score ${String(percent)}%: Reticle Harness needs ${String(UNLOCK_PERCENT)}%.`} Offer to close these gaps, then drive one flow to raise the score.`,
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
  if (null === input.platform) return { ...base, next: ACCOUNT_NEXT.UNREACHABLE };
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
  const lock = asRecord(p['harnessLock']);
  const score = num(p['coverageScore']);
  const percent = score === undefined ? undefined : Math.floor(score * 100 + 1e-9);
  const unlocked = true === p['harnessUnlocked'];
  const provider = str(p['provider']);
  const providerReady =
    provider === undefined ? true : asRecord(p['available'])[provider] !== false;
  const harness = {
    on: true === p['harnessEnabled'],
    unlocked,
    ...(percent === undefined ? {} : { setupScore: percent }),
    ...(str(lock['reason']) === undefined ? {} : { missing: str(lock['reason']) }),
    ...(str(lock['prompt']) === undefined ? {} : { setupPrompt: str(lock['prompt']) }),
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
      : !unlocked
        ? ACCOUNT_NEXT.locked(percent ?? 0, str(lock['reason']) ?? '')
        : !providerReady
          ? ACCOUNT_NEXT.NO_PROVIDER
          : !harness.on
            ? ACCOUNT_NEXT.OFF
            : ACCOUNT_NEXT.ready(typical, max);
  return { ...facts, next };
}

/** The platform's model config with this project's linked key; undefined unlinked, null on no answer. */
async function platformConfig(deps: ToolDeps): Promise<Record<string, unknown> | null | undefined> {
  // The project's own link, not the environment: an agent asks about the project it is in.
  const platform = (await deps.linkedCloud?.()) ?? null;
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
  return accountFacts({
    signedIn: true === account?.signedIn,
    ...(account?.org === undefined ? {} : { workspace: account.org }),
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
    platform: await platformConfig(deps),
  });
}

export const ACCOUNT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.ACCOUNT,
    description:
      'Where the user stands with Reticle: signed in or not, whether this project reports to the dashboard, the plan and credits left, whether Reticle Harness is on and unlocked, the setup score and what is missing, what a Harness run costs, and the one thing to do next. Read it before you tell the user anything about credits, the plan or the Harness.',
    inputSchema: {
      sessionId: z.string().optional().describe('Target a specific tab. Omit unless you mean one.'),
    },
    handler: async (deps, args) => readAccount(deps, asString(args['sessionId'])),
  },
];
