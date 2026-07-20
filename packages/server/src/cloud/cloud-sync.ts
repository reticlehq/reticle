/**
 * Optional cloud sync for saved flows. "Logged in" here means the two cloud env vars are set (written by
 * `reticle login` later; settable by hand today): the hosted URL and an API key from the Reticle Cloud
 * dashboard. When present, a freshly-saved flow is pushed to `POST /v1/flows` so the team's regression
 * suite lives in the cloud — surviving refactors and runnable in CI. When absent, sync is a no-op and
 * everything stays 100% local (the "no phone-home" default: nothing leaves the machine unless you opt in).
 *
 * Sync is best-effort: a network failure NEVER fails the local save. The flow is already on disk; the
 * cloud copy is an enhancement, so a push error is logged and swallowed.
 */
import { z } from 'zod';
import type { FlowFile, ReticleVerificationRun, RunRecord } from '@reticlehq/core';

/** Env var names — the presence of BOTH is what "logged in" means for cloud sync. */
export const CloudEnv = {
  URL: 'RETICLE_CLOUD_URL',
  KEY: 'RETICLE_CLOUD_KEY',
} as const;

/** Paths the OSS server pushes to (match the cloud app's contract). */
export const CLOUD_FLOWS_PATH = '/v1/flows';
export const CLOUD_RUNS_PATH = '/v1/runs';
export const CLOUD_PROJECT_RUNS_PATH = '/v1/project/runs';
export const CLOUD_PROJECT_REGRESSION_PATH = '/v1/project/regression';
export const CLOUD_VERIFICATIONS_PATH = '/v1/verifications';

export interface CloudConfig {
  url: string;
  apiKey: string;
}

/** Resolve cloud credentials from the environment, or null when not logged in (sync disabled). */
export function resolveCloudConfig(env: NodeJS.ProcessEnv): CloudConfig | null {
  const url = env[CloudEnv.URL];
  const apiKey = env[CloudEnv.KEY];
  if (typeof url !== 'string' || url.length === 0) return null;
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

export const SyncOutcome = {
  SYNCED: 'synced',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const;
export type SyncOutcome = (typeof SyncOutcome)[keyof typeof SyncOutcome];

export interface SyncResult {
  outcome: SyncOutcome;
  status?: number;
  error?: string;
}

/** A fetch-shaped function, injected so the sync is testable without a real network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/** GET-shaped fetch (no body, reads back JSON), injected so the read is testable without a network. */
export type FetchGetLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Push one flow to the cloud. `projectId` scopes it to this app. Returns a structured outcome; never
 * throws — a failure is reported, not propagated, so the local save is authoritative.
 */
export async function syncFlowToCloud(
  flow: FlowFile,
  config: CloudConfig | null,
  projectId: string | undefined,
  fetchImpl: FetchLike,
): Promise<SyncResult> {
  if (config === null) return { outcome: SyncOutcome.SKIPPED };
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_FLOWS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(projectId === undefined ? { flow } : { flow, projectId }),
    });
    return res.ok
      ? { outcome: SyncOutcome.SYNCED, status: res.status }
      : { outcome: SyncOutcome.FAILED, status: res.status };
  } catch (err) {
    return { outcome: SyncOutcome.FAILED, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push one verification-run artifact to the cloud. This is what makes "runs recorded on the dashboard"
 * real once a user shifts to the server: after `reticle verify` produces a run, it lands in the team's
 * hosted history with its verdict. Same opt-in creds as flow sync — absent → no-op (stays local). The
 * cloud's `POST /v1/runs` ingests the RAW artifact (validated by the same `@reticlehq/core` schema that
 * built it), so the body is the run itself, not a wrapper. Best-effort: never throws, never blocks exit.
 */
export async function syncRunToCloud(
  run: ReticleVerificationRun,
  config: CloudConfig | null,
  fetchImpl: FetchLike,
): Promise<SyncResult> {
  if (config === null) return { outcome: SyncOutcome.SKIPPED };
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_RUNS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(run),
    });
    return res.ok
      ? { outcome: SyncOutcome.SYNCED, status: res.status }
      : { outcome: SyncOutcome.FAILED, status: res.status };
  } catch (err) {
    return { outcome: SyncOutcome.FAILED, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push one project-memory RunRecord (a flow replay/verify outcome) to the cloud so the team's server-side
 * regression history stays current: "did this development break a previously-passing flow?" is answered
 * from these. Same opt-in creds as the others — absent → no-op (project.json stays the local source of
 * truth). `projectId` scopes an org's multiple suites. Best-effort: never throws, never blocks the tool.
 */
export async function syncRunRecordToCloud(
  record: RunRecord,
  projectId: string | undefined,
  config: CloudConfig | null,
  fetchImpl: FetchLike,
): Promise<SyncResult> {
  if (config === null) return { outcome: SyncOutcome.SKIPPED };
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_PROJECT_RUNS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        flowName: record.name,
        status: record.status,
        kind: record.kind,
        summary: record.summary,
        at: record.at,
        ...(projectId === undefined ? {} : { projectId }),
      }),
    });
    return res.ok
      ? { outcome: SyncOutcome.SYNCED, status: res.status }
      : { outcome: SyncOutcome.FAILED, status: res.status };
  } catch (err) {
    return { outcome: SyncOutcome.FAILED, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read the team's server-side regression report back down to the agent. This is the half that makes the
 * system "agent-friendly across context loss": a fresh agent (new session, CI box, teammate's machine)
 * whose local .reticle/project.json is empty can still ask the ONE tool it knows — reticle_project — and
 * get the durable cloud memory of what's broken vs before. Returns the raw report (shape owned by the
 * cloud), or null when not logged in / unreachable — so the caller degrades to local-only, never fails.
 */
export async function fetchProjectRegressionFromCloud(
  config: CloudConfig | null,
  projectId: string | undefined,
  fetchImpl: FetchGetLike,
): Promise<unknown> {
  if (config === null) return null;
  try {
    const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`;
    const res = await fetchImpl(`${config.url}${CLOUD_PROJECT_REGRESSION_PATH}${query}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** POST-that-reads-JSON fetch shape (injected so the server-verify submit is testable without a network). */
export type FetchPostJsonLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The hosted runner's report, validated at the boundary (the full shape is owned by the cloud app). */
const ServerVerificationSchema = z.object({
  verificationId: z.string(),
  verdict: z.string().nullable(),
  flows: z.array(z.object({ name: z.string(), status: z.string() })),
  summary: z.string(),
});
export type ServerVerification = z.infer<typeof ServerVerificationSchema>;

/**
 * Delegate a verification to the hosted runner: submit the preview URL + flow names to `POST
 * /v1/verifications` and read back the report. This is the `verify: 'server'` half of the per-project
 * config — the WORK runs on the server (real browser pool, later), not the local machine. The server
 * records the verification itself, so there is no separate run-push. Returns null when not attached or the
 * submit fails, so the caller falls back to a local replay. Never throws.
 */
export async function submitServerVerification(
  body: { previewUrl: string; flows: string[]; source: string },
  config: CloudConfig | null,
  fetchImpl: FetchPostJsonLike,
): Promise<ServerVerification | null> {
  if (config === null) return null;
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_VERIFICATIONS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const parsed = ServerVerificationSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
