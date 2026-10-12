/**
 * Where this project's work stands with the Reticle platform, run by run.
 *
 * Read from the sync cycle's own record (`.reticle/cloud-state.json`): the content hash of every run
 * the platform ACCEPTED, and the reason for every run it REFUSED. A run whose current content matches
 * an accepted hash is on the platform; one whose current content was refused is refused, with the
 * platform's own sentence; anything else is waiting for the next cycle. On a machine that is not
 * linked, everything is local only.
 *
 * Nothing here talks to the network. It answers "did my work go up?" from what the machine already
 * knows, so it can ride on every verdict without costing a request.
 */
import { diskSource, readCloudState } from '@/memory/cloud/sync-disk.js';
import { hashPayload } from '@/memory/cloud/sync-hash.js';
import type { CloudSyncState } from '@/memory/cloud/sync-cycle.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import { unmatchedRoots, unsyncedRoots, type UnsyncedRoot } from '@/memory/cloud/unsynced-roots.js';
import type { FileSystemPort } from './fs/fs-port.js';
import { knownProjectCandidates } from './artifact-root-resolver.js';

export const SyncStatus = {
  ON_PLATFORM: 'on-platform',
  PENDING: 'pending',
  REFUSED: 'refused',
  LOCAL_ONLY: 'local-only',
} as const;
export type SyncStatus = (typeof SyncStatus)[keyof typeof SyncStatus];

/** How many refusals a summary names before it only counts them. */
const MAX_NAMED_REFUSALS = 3;

export interface SyncSummary {
  linked: boolean;
  /** Runs on this machine. */
  runs: number;
  onPlatform: number;
  pending: number;
  /** The runs the platform refused in their current form, with its reason. */
  refused: { runId: string; reason: string }[];
  /** Refusals beyond the ones named. */
  refusedMore: number;
  lastPushAt?: number;
  /** Why the last cycle failed, when it did. */
  lastError?: string;
  /** The newest run the platform holds in its current form: what "see it in your dashboard" opens. */
  latestOnPlatform?: string;
}

export function summarizeSync(input: {
  linked: boolean;
  runs: readonly { runId: string; payload: unknown }[];
  state: CloudSyncState;
}): SyncSummary {
  const { linked, runs, state } = input;
  let onPlatform = 0;
  let pending = 0;
  const refused: { runId: string; reason: string }[] = [];
  let latest: { runId: string; at: number } | undefined;
  if (linked) {
    for (const run of runs) {
      const hash = hashPayload(run.payload);
      const refusal = state.refusedRuns?.[run.runId];
      const at = createdAtOf(run.payload);
      if (state.sentRunHashes?.[run.runId] === hash && (latest === undefined || at > latest.at))
        latest = { runId: run.runId, at };
      if (state.sentRunHashes?.[run.runId] === hash) onPlatform += 1;
      else if (refusal !== undefined && refusal.payloadHash === hash)
        refused.push({ runId: run.runId, reason: refusal.reason });
      else pending += 1;
    }
  }
  return {
    linked,
    runs: runs.length,
    onPlatform,
    pending,
    refused: refused.slice(0, MAX_NAMED_REFUSALS),
    refusedMore: Math.max(0, refused.length - MAX_NAMED_REFUSALS),
    ...(state.lastPushAt === undefined ? {} : { lastPushAt: state.lastPushAt }),
    ...(state.lastError === undefined || 0 === state.lastError.length
      ? {}
      : { lastError: state.lastError }),
    ...(latest === undefined ? {} : { latestOnPlatform: latest.runId }),
  };
}

/** A run artifact's `createdAt`, or 0 when it has none. */
function createdAtOf(payload: unknown): number {
  const at =
    'object' === typeof payload && null !== payload
      ? (payload as Record<string, unknown>)['createdAt']
      : undefined;
  return 'number' === typeof at ? at : 0;
}

/**
 * Where this project's dashboard lives, if `reticle link` recorded one.
 *
 * Read from the link file rather than derived from the API url, because the API origin and the
 * console origin are different hosts in every deployment that is not a laptop. Synchronous and
 * best-effort, like every other read in this file: a missing or malformed link file means no link
 * in the HUD, never a failed tool call.
 */
export function readDashboardUrl(reticleRoot: string): string | undefined {
  return linkField(reticleRoot, 'dashboardUrl');
}

/** The platform project this folder is linked to, from the same link file. */
export function readLinkedProjectId(reticleRoot: string): string | undefined {
  return linkField(reticleRoot, 'projectId');
}

function linkField(reticleRoot: string, field: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(reticleRoot, ReticleDir.CLOUD_LINK_FILE), 'utf8'),
    );
    if ('object' !== typeof raw || null === raw) return undefined;
    const value = (raw as Record<string, unknown>)[field];
    return 'string' === typeof value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** How the sync loop records a refused credential in its state. */
const REFUSED_SYNC = /^status 40[13]\b/;
/** What precedes the answer's body in that record: `status 401: `. */
const REFUSED_PREFIX = /^status \d+: /;

/** The refused credential, in words: what a person has to act on. */
export const KEY_REFUSED =
  "the platform refused this project's API key: it was revoked, or its owner no longer has access to the workspace";

/** The refusals the platform explains in its own words (its `error.code`). */
const EXPLAINED_REFUSALS: ReadonlySet<string> = new Set([
  'removed_from_workspace',
  'key_lost_access',
]);

/**
 * Why a credential was refused: the platform's own sentence when it names the reason ("You were
 * removed from Acme.", a key whose owner lost the project), else ours. Reads an answer body.
 */
export function refusalSaid(body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: { code?: unknown; message?: unknown } } | null)
      ?.error;
    if (
      'string' === typeof error?.code &&
      EXPLAINED_REFUSALS.has(error.code) &&
      'string' === typeof error.message &&
      0 < error.message.length
    )
      return error.message;
  } catch {
    // Not the platform's JSON: our own sentence stands.
  }
  return KEY_REFUSED;
}

/** Why the platform refused this project's key at the last sync, or undefined. Never throws. */
export function keyRefusalAtLastSync(reticleRoot: string): string | undefined {
  return keyRefusalIn(readCloudState(reticleRoot).lastError);
}

/** The refusal a recorded sync error carries, in words, or undefined when it is another failure. */
function keyRefusalIn(error: unknown): string | undefined {
  if ('string' !== typeof error || !REFUSED_SYNC.test(error)) return undefined;
  return refusalSaid(error.replace(REFUSED_PREFIX, ''));
}

/** Whether the platform refused this project's key at the last sync. Never throws. */
export function keyRefusedAtLastSync(reticleRoot: string): boolean {
  return keyRefusalAtLastSync(reticleRoot) !== undefined;
}

/** The dashboard's page for one run: the console's `/runs/:runId` route, at the dashboard's origin. */
export const DASHBOARD_RUN_PATH = '/runs/';
export const DASHBOARD_PLAN_PATH = '/plans/';

export function dashboardRunUrl(dashboardUrl: string, runId: string): string {
  return `${dashboardOrigin(dashboardUrl)}${DASHBOARD_RUN_PATH}${encodeURIComponent(runId)}`;
}

function dashboardOrigin(dashboardUrl: string): string {
  try {
    return new URL(dashboardUrl).origin;
  } catch {
    return dashboardUrl.replace(/\/+$/, ''); // not a url: use it as given
  }
}

/** The line a command prints once its run reached the platform. */
export function seeRunLine(dashboardUrl: string, runId: string): string {
  return `See it in your dashboard: ${dashboardRunUrl(dashboardUrl, runId)}`;
}

/**
 * A saved Harness plan's page on the dashboard, beside its runs, under its project: opened under
 * another project's sticky scope the page answered "We could not find that plan" to its owner.
 */
export function dashboardPlanUrl(dashboardUrl: string, planId: string, projectId?: string): string {
  const page = `${dashboardOrigin(dashboardUrl)}${DASHBOARD_PLAN_PATH}${encodeURIComponent(planId)}`;
  return projectId === undefined ? page : `${page}?project=${encodeURIComponent(projectId)}`;
}

/** This project's summary, read from its `.reticle`. Never throws: an unreadable record is empty. */
export function readSyncSummary(reticleRoot: string, linked: boolean): SyncSummary {
  let runs: readonly { runId: string; payload: unknown }[] = [];
  try {
    runs = diskSource(reticleRoot).runs();
  } catch {
    runs = [];
  }
  return summarizeSync({ linked, runs, state: readCloudState(reticleRoot) });
}

/** One status for the whole project: the worst thing true of it. */
export function overallStatus(summary: SyncSummary): SyncStatus {
  if (!summary.linked) return SyncStatus.LOCAL_ONLY;
  if (0 < summary.refused.length) return SyncStatus.REFUSED;
  if (0 < summary.pending || summary.lastError !== undefined) return SyncStatus.PENDING;
  return SyncStatus.ON_PLATFORM;
}

/** The summary in one sentence an agent can repeat to a person. */
export function describeSync(summary: SyncSummary, now: number): string {
  if (!summary.linked)
    return `${String(summary.runs)} run(s) exist only on this machine; nothing is synced until the project is linked (npx @reticlehq/server connect).`;
  const ago =
    summary.lastPushAt === undefined
      ? 'nothing pushed yet'
      : `last push ${String(Math.max(0, Math.round((now - summary.lastPushAt) / 1000)))}s ago`;
  const parts = [`${String(summary.onPlatform)} of ${String(summary.runs)} run(s) on the platform`];
  if (0 < summary.pending) parts.push(`${String(summary.pending)} waiting for the next push`);
  const named = summary.refused.map((r) => `${r.runId}: ${r.reason}`);
  if (0 < named.length)
    parts.push(
      `refused by the platform: ${named.join('; ')}${0 < summary.refusedMore ? ` (+${String(summary.refusedMore)} more)` : ''}`,
    );
  const refusal = keyRefusalIn(summary.lastError);
  if (refusal !== undefined) parts.push(`the last push was refused: ${refusal}`);
  else if (summary.lastError !== undefined)
    parts.push(`the last push failed: ${summary.lastError}`);
  return `${parts.join('; ')} (${ago}).`;
}

/**
 * Every project folder this machine knows with runs or flows the platform never got, linked by its OWN link
 * file or not. `reticle sync` and `doctor` print these; a daemon tracks the same through its cycle.
 */
export async function machineUnsyncedRoots(
  fs: FileSystemPort,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<UnsyncedRoot[]> {
  const roots = [
    ...knownProjectCandidates().map((c) => join(c.directory, ReticleDir.ROOT)),
    // And what no project claimed: nothing sends it, and nothing named it after the first warning.
    ...unmatchedRoots(home),
  ];
  const cloudOf = (root: string) => resolveProjectCloud(fs, root, home, env);
  return unsyncedRoots(
    roots,
    async (root) => {
      const cloud = await cloudOf(root);
      return null !== cloud.config && null !== cloud.projectId;
    },
    async (root) => (await cloudOf(root)).policy.flows,
  );
}
