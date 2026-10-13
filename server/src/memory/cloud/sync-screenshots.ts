/**
 * The step screenshots of each run the platform has accepted, sent once each.
 *
 * A run goes up first, through the sync; its screenshots follow, one request per image, to
 * `POST /v1/runs/:runId/screenshots` — only once the platform holds the run, because the endpoint
 * answers 404 for a run it does not. What was sent is remembered by `seq:sha256`, like runs by hash,
 * so a quiet cycle sends nothing.
 *
 * An OLDER platform has no such endpoint and answers 404 or 405. That run's screenshots stay on
 * this machine and are not offered again: the alternative is one refused request per image on every
 * cycle, forever. A newer platform picks up the next run's. Anything else that failed (the network,
 * a 5xx) is simply retried next cycle.
 */
import { createHash } from 'node:crypto';
import { RunScreenshotSchema, STEP_SCREENSHOT, type RunScreenshot } from '@reticlehq/core';
import type { ScreenshotUpload } from '@reticlehq/core/artifacts';

const SCREENSHOTS_PATH = (runId: string): string =>
  `/v1/runs/${encodeURIComponent(runId)}/screenshots`;

const HTTP_CREATED = 201;
const HTTP_OK = 200;
/** An older platform: no route (404), or a route that takes no POST (405). */
const NOT_THERE = new Set([404, 405]);
/** Refused for good: too large (413), too many for one run (409). Retrying cannot change it. */
const REFUSED_FOR_GOOD = new Set([409, 413]);

/** This machine's record of what went up, kept in `.reticle/cloud-state.json`. */
export interface ScreenshotSyncState {
  /** Per run, `seq:sha256` of every screenshot the platform holds or refused for good. */
  sentScreenshots?: Record<string, string[]>;
  /** Runs whose screenshots an older platform could not take. Kept local, never offered again. */
  screenshotsHeldLocal?: string[];
}

export interface ScreenshotSyncDeps {
  /** Every run on disk, with the payload the sync just sent. */
  runs: ReadonlyArray<{ runId: string; payload: unknown }>;
  /** Whether the platform holds this run now. */
  accepted: (runId: string) => boolean;
  /** One image from the run's directory, or undefined when it is gone. */
  readImage: (runId: string, file: string) => Uint8Array | undefined;
  state: ScreenshotSyncState;
  /** POST a JSON body to a path on the platform, with the sync's own credentials. */
  post: (path: string, body: string) => Promise<{ status: number; text: string }>;
}

export interface ScreenshotSyncResult {
  sent: number;
  state: ScreenshotSyncState;
  /** Why this cycle stopped early, when it did. Kept local; the next cycle tries again. */
  error?: string;
}

/** The screenshots a run artifact lists, read defensively: a malformed entry is skipped. */
function listed(payload: unknown): RunScreenshot[] {
  const raw =
    'object' === typeof payload && null !== payload
      ? (payload as Record<string, unknown>)['screenshots']
      : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = RunScreenshotSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const keyOf = (shot: RunScreenshot): string => `${String(shot.seq)}:${shot.sha256}`;

/** The upload body for one screenshot — the shape `ScreenshotUploadSchema` reads. */
function bodyOf(shot: RunScreenshot, image: Uint8Array): ScreenshotUpload {
  return {
    seq: shot.seq,
    file: shot.file,
    ...(shot.step === undefined ? {} : { step: shot.step }),
    tool: shot.tool,
    ...(shot.checkId === undefined ? {} : { checkId: shot.checkId }),
    source: shot.source,
    width: shot.width,
    height: shot.height,
    sha256: shot.sha256,
    jpeg: Buffer.from(image).toString('base64'),
  };
}

/** Send what is owed. Never throws; the record is bounded by the runs still on disk. */
export async function syncScreenshots(deps: ScreenshotSyncDeps): Promise<ScreenshotSyncResult> {
  const onDisk = new Set(deps.runs.map((run) => run.runId));
  const sent: Record<string, string[]> = {};
  for (const [runId, keys] of Object.entries(deps.state.sentScreenshots ?? {}))
    if (onDisk.has(runId) && Array.isArray(keys))
      sent[runId] = keys.filter((k) => 'string' === typeof k);
  const heldLocal = new Set((deps.state.screenshotsHeldLocal ?? []).filter((id) => onDisk.has(id)));
  const finish = (count: number, error?: string): ScreenshotSyncResult => ({
    sent: count,
    state: { sentScreenshots: sent, screenshotsHeldLocal: [...heldLocal] },
    ...(error === undefined ? {} : { error }),
  });
  let count = 0;
  try {
    for (const run of deps.runs) {
      if (heldLocal.has(run.runId) || !deps.accepted(run.runId)) continue;
      const done = new Set(sent[run.runId] ?? []);
      for (const shot of listed(run.payload)) {
        if (done.has(keyOf(shot))) continue;
        const image = deps.readImage(run.runId, shot.file);
        // Gone (retention took it) or changed under its name: nothing true is left to send.
        if (image === undefined || createHash('sha256').update(image).digest('hex') !== shot.sha256)
          continue;
        const markDone = (): void => {
          done.add(keyOf(shot));
          sent[run.runId] = [...done];
        };
        if (image.byteLength > STEP_SCREENSHOT.MAX_BYTES) {
          markDone();
          continue;
        }
        const res = await deps.post(
          SCREENSHOTS_PATH(run.runId),
          JSON.stringify(bodyOf(shot, image)),
        );
        if (HTTP_CREATED === res.status || HTTP_OK === res.status) {
          markDone();
          count += 1;
        } else if (NOT_THERE.has(res.status)) {
          heldLocal.add(run.runId);
          return finish(
            count,
            `screenshots ${String(res.status)}: this platform does not take screenshots yet, so run ${run.runId}'s stay on this machine`,
          );
        } else if (REFUSED_FOR_GOOD.has(res.status)) markDone();
        else return finish(count, `screenshots ${String(res.status)}: ${res.text.slice(0, 200)}`);
      }
    }
  } catch (error) {
    return finish(count, error instanceof Error ? error.message : String(error));
  }
  return finish(count);
}
