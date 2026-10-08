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
  if (linked) {
    for (const run of runs) {
      const hash = hashPayload(run.payload);
      const refusal = state.refusedRuns?.[run.runId];
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
  };
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
  if (summary.lastError !== undefined) parts.push(`the last push failed: ${summary.lastError}`);
  return `${parts.join('; ')} (${ago}).`;
}
