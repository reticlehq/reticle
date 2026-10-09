/**
 * The two platform calls a drive needs outside its own turns: the grant that pays for a drive, and
 * the run the platform kept once the local record is gone.
 *
 * Both answer with a value and never throw: an unreachable platform is a sentence to show, not a
 * crash in the CLI or in the HUD's button handler.
 */

const FREE_DRIVE_PATH = '/v1/harness/free-drive';
const RUNS_PATH = '/v1/runs';
const NEEDS_CARD = 'needs_card';
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_NOT_FOUND = 404;
/** Where a workspace starts its trial: the dashboard's billing settings, at its origin. */
const PLAN_PATH = '/settings?group=billing';

/** What the grant is for: `reticle try`'s one drive, or a drive started from the HUD or an agent. */
export const FreeDriveKind = { TRY: 'try', EXPLORE: 'explore' } as const;
export type FreeDriveKind = (typeof FreeDriveKind)[keyof typeof FreeDriveKind];

/** One HTTP request, narrowed so a test answers it without a network. */
export type PlatformFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** The drive the platform granted, or why it would not. */
export type FreeDrive =
  | { granted: true; driveId: string }
  | { granted: false; needsCard: boolean; message: string; hint?: string };

interface Platform {
  url: string;
  apiKey: string;
}

const defaultFetch: PlatformFetch = (url, init) => fetch(url, init);
const base = (platform: Platform): string => platform.url.replace(/\/+$/, '');
const headers = (platform: Platform): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${platform.apiKey}`,
});

function record(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return 'object' === typeof parsed && null !== parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | undefined => ('string' === typeof value ? value : undefined);

/** The dashboard page where a trial starts, at the origin of whatever link the platform gave. */
export function planUrl(dashboard: string): string {
  try {
    return `${new URL(dashboard).origin}${PLAN_PATH}`;
  } catch {
    return `${dashboard.replace(/\/+$/, '')}${PLAN_PATH}`;
  }
}

/** Ask the platform for a drive it will pay for. Every failure is an answer, never a throw. */
export async function requestFreeDrive(
  platform: Platform,
  kind: FreeDriveKind,
  doFetch: PlatformFetch = defaultFetch,
): Promise<FreeDrive> {
  try {
    const res = await doFetch(`${base(platform)}${FREE_DRIVE_PATH}`, {
      method: 'POST',
      headers: headers(platform),
      body: JSON.stringify({ kind }),
    });
    const body = record(await res.text());
    const driveId = str(body['driveId']);
    if (true === body['granted'] && driveId !== undefined) return { granted: true, driveId };
    const message =
      str(body['message']) ??
      `The Reticle platform did not grant a drive (it answered ${String(res.status)}).`;
    const hint = str(body['hint']);
    return {
      granted: false,
      needsCard: HTTP_PAYMENT_REQUIRED === res.status || NEEDS_CARD === body['error'],
      message,
      ...(hint === undefined ? {} : { hint }),
    };
  } catch (error) {
    return {
      granted: false,
      needsCard: false,
      message: `Could not reach the Reticle platform: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const DRIVE_DONE = 'done';
const msgFromDashboard = (verdict: string | undefined, checks: number): string =>
  `From the dashboard (the drive itself is no longer on this machine): ${
    verdict === undefined ? 'no verdict recorded' : `verdict ${verdict}`
  }, ${String(checks)} check${1 === checks ? '' : 's'}.`;

/**
 * A synced run as the explore poll answers it, in the poll's own fields.
 *
 * The platform serves the run file under `run` with the authoritative verdict (a review overturn
 * wins) beside it — the dashboard's shape. The poll's agent needs the outcome and where it came from,
 * not the whole file; `reticle runs <id>` prints the full answer for anyone who wants it.
 */
export function platformRunAnswer(
  runId: string,
  body: Record<string, unknown>,
): { status: string; runId: string; summary: string } {
  const run = body['run'];
  const checks =
    'object' === typeof run &&
    null !== run &&
    Array.isArray((run as Record<string, unknown>)['checks'])
      ? ((run as Record<string, unknown>)['checks'] as unknown[]).length
      : 0;
  return { status: DRIVE_DONE, runId, summary: msgFromDashboard(str(body['verdict']), checks) };
}

/** Said when the platform has no such run: it may simply not have synced yet. */
export const msgRunNotOnPlatform = (runId: string): string =>
  `Run ${runId} is not on the Reticle platform: not synced yet, or not found.`;

/** The platform's answer for one run (`{ run, verdict, grade, projectName, … }`), or why not. */
export async function fetchPlatformRun(
  platform: Platform,
  runId: string,
  doFetch: PlatformFetch = defaultFetch,
): Promise<{ run: Record<string, unknown> } | { error: string }> {
  try {
    const res = await doFetch(`${base(platform)}${RUNS_PATH}/${encodeURIComponent(runId)}`, {
      method: 'GET',
      headers: headers(platform),
    });
    if (HTTP_NOT_FOUND === res.status) return { error: msgRunNotOnPlatform(runId) };
    const body = record(await res.text());
    if (200 > res.status || 300 <= res.status)
      return {
        error:
          str(body['message']) ??
          `The Reticle platform answered ${String(res.status)} for ${runId}.`,
      };
    return { run: body };
  } catch (error) {
    return {
      error: `Could not reach the Reticle platform: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
