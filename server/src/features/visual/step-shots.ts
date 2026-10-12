/**
 * A screenshot after every step: every page-touching action, every assert, every replayed step.
 *
 * The agent gets a PATH, never the image: reading it is the agent's choice, and an image forced
 * into every result would cost more than every other field together. The path is named the moment
 * the step's outcome is decided and the file lands right after, so a capture never holds a verdict
 * back. The capture itself STARTS before this returns, which is what makes it a picture of the
 * moment the verdict was decided rather than of whatever the next call did.
 *
 * Two sources, best first. `browser` is a real screenshot of a page this daemon drives (a leased
 * tab, or the CDP provider). `rendered` is the page drawn by the SDK in-page — approximate, and
 * labelled so. Which one the result names is a prediction from what worked last on this tab; the
 * run's own record (`shots.jsonl`) says what actually happened. When the last attempt produced
 * nothing at all, the next one is awaited, so the agent is told `{ error }` instead of a path to a
 * file that will never exist.
 *
 * ponytail: the desktop shell's own window capture is not a source here. It returns a device-pixel
 * PNG, and the daemon ships no JPEG encoder to shrink it to the step format; an Electron renderer
 * draws itself fine in-page. Add it when the shells can hand back a JPEG.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  asRecord,
  ReticleCommand,
  ScreenshotSource,
  STEP_SCREENSHOT,
  ReticleTool,
  type FlowStepResult,
  type RunScreenshot,
} from '@reticlehq/core';
import { runIdOfCall } from '@/judgement/runs/drive-run.js';
import { noteLanding } from '@/judgement/runs/artifact/run-store.js';
import { isValidRunId, stepShotDir } from '@/memory/project/dir/reticle-dir.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { UPLOAD_TEXT_MAX } from '@reticlehq/core/artifacts';

/** The connected tab, as the tool layer hands it out. */
type Session = ReturnType<ToolDeps['sessions']['resolve']>;

export interface ShotOptions {
  step?: string;
  verdict?: boolean;
}

/** What a tool result carries: where the picture is and how it was taken, or why there is none. */
export type ScreenshotField = { path: string; source: ScreenshotSource } | { error: string };

const JPEG_EXT = '.jpg';
const TOOL_PREFIX = /^reticle_/;
const SEQ_WIDTH = 4;
/** A prior capture on this tab produced nothing — see the header. */
const NOTHING = 'none';
/** CDP's quality scale is 0–100. */
const CDP_QUALITY = Math.round(STEP_SCREENSHOT.JPEG_QUALITY * 100);

/** What worked last on each tab: the next result names that source. */
const lastSource = new Map<string, ScreenshotSource | typeof NOTHING>();
/** The next sequence number per run directory, read from its record the first time. */
const nextSeq = new Map<string, Promise<{ n: number }>>();

interface Pixels {
  bytes: Uint8Array;
  source: ScreenshotSource;
  width: number;
  height: number;
}

/**
 * Width and height from a JPEG's frame header, or undefined when the bytes are not a JPEG.
 * Read rather than trusted: the run record and the upload both state the size.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || 0xff !== bytes[0] || 0xd8 !== bytes[1]) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (0xff !== bytes[i]) return undefined;
    const marker = bytes[i + 1] ?? 0;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    // The start-of-frame markers carry the size; 0xC4, 0xC8 and 0xCC share the range and are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    i += 2 + length;
  }
  return undefined;
}

/** A real screenshot of a page this daemon drives, or undefined when it drives none for this tab. */
async function browserPixels(deps: ToolDeps, session: Session): Promise<Uint8Array | undefined> {
  const opts = { jpegQuality: CDP_QUALITY, cssScale: true };
  const leased = await deps.pool?.screenshotLease(session.id, opts);
  if (leased !== undefined) return leased;
  // Only a provider driving THIS tab: a launched provider photographs the one page it owns whatever
  // url it is handed, which is how a screenshot of one tab was once filed under another (#1407).
  if (true !== (await deps.realInput?.isAvailableFor(session.url))) return undefined;
  return deps.realInput?.screenshot?.(session.url, opts);
}

/** The page drawn by the SDK. The answer is base64 in chunks — see `ReticleCommand.RENDER`. */
async function renderedPixels(session: Session): Promise<Uint8Array | string> {
  const res = await session.command(ReticleCommand.RENDER, {});
  if (!res.ok) return res.error ?? 'the page did not answer';
  const r = asRecord(res.result);
  if (true !== r['ok']) return 'string' === typeof r['reason'] ? r['reason'] : 'render failed';
  const chunks = Array.isArray(r['chunks']) ? r['chunks'] : [];
  return new Uint8Array(
    Buffer.from(chunks.filter((c) => 'string' === typeof c).join(''), 'base64'),
  );
}

/** Best source first; the first that yields a readable JPEG wins. Never throws. */
async function capture(deps: ToolDeps, session: Session): Promise<Pixels | string> {
  const reasons: string[] = [];
  try {
    const real = await browserPixels(deps, session);
    const size = real === undefined ? undefined : jpegSize(real);
    if (real !== undefined && size !== undefined)
      return { bytes: real, source: ScreenshotSource.BROWSER, ...size };
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const drawn = await renderedPixels(session);
    if ('string' === typeof drawn) reasons.push(`the page could not draw itself: ${drawn}`);
    else {
      const size = jpegSize(drawn);
      if (size !== undefined) return { bytes: drawn, source: ScreenshotSource.RENDERED, ...size };
      reasons.push('the page drew something that is not a JPEG');
    }
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  return `no screenshot: ${reasons.join('; ')}`;
}

/** Which source this tab's next result names, or undefined when the last capture got nothing. */
async function predict(deps: ToolDeps, session: Session): Promise<ScreenshotSource | undefined> {
  const last = lastSource.get(session.id);
  if (NOTHING === last) return undefined;
  if (last !== undefined) return last;
  if (true === deps.pool?.leasedSessionIds().includes(session.id)) return ScreenshotSource.BROWSER;
  const driven =
    deps.realInput?.screenshot !== undefined &&
    true === (await deps.realInput.isAvailableFor(session.url));
  return driven ? ScreenshotSource.BROWSER : ScreenshotSource.RENDERED;
}

/** Highest sequence number this run has used, from its record — files can outlive a restart. */
async function allocate(fs: FileSystemPort, dir: string): Promise<number> {
  let held = nextSeq.get(dir);
  if (held === undefined) {
    held = fs
      .readFile(join(dir, STEP_SCREENSHOT.MANIFEST_FILE))
      .then((text) => {
        const seqs = text.split('\n').map((line) => {
          try {
            const seq: unknown = asRecord(JSON.parse(line))['seq'];
            return 'number' === typeof seq ? seq : 0;
          } catch {
            return 0;
          }
        });
        return { n: Math.max(0, ...seqs) };
      })
      .catch(() => ({ n: 0 }));
    nextSeq.set(dir, held);
  }
  const counter = await held;
  counter.n += 1;
  return counter.n;
}

/**
 * Photograph the tab a step just ran on. Returns the result field; never throws, because a
 * screenshot is evidence about a step and must never be the reason the step's answer is lost.
 *
 * `step` names the flow step a replay was on, as `<flow>#<index>`, so the run can pin the picture
 * to it; `verdict` says the call produced a verdict, so the run can pair the picture with its check.
 */
export async function takeStepShot(
  deps: ToolDeps,
  sessionId: string,
  tool: string,
  opts: ShotOptions = {},
): Promise<ScreenshotField> {
  try {
    return await shoot(deps, deps.sessions.resolve(sessionId), tool, opts);
  } catch (error) {
    return { error: `no screenshot: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function shoot(
  deps: ToolDeps,
  session: Session,
  tool: string,
  { step, verdict }: ShotOptions,
): Promise<ScreenshotField> {
  const root = session.artifactRoot ?? deps.reticleRoot;
  // Read before anything is awaited: the action this call's verdict was recorded on.
  const actionId = true === verdict ? session.lastActionId : undefined;
  const runId = runIdOfCall(session.id);
  if (!isValidRunId(runId)) return { error: `no screenshot: unusable run id ${runId}` };
  const dir = stepShotDir(root, runId);
  const seq = await allocate(deps.fs, dir);
  if (seq > STEP_SCREENSHOT.MAX_PER_RUN) {
    return {
      error: `no screenshot: this run already holds ${String(STEP_SCREENSHOT.MAX_PER_RUN)}, the most one run keeps`,
    };
  }
  // The first capture of a tab is one nothing has vouched for yet (the in-page renderer loads on
  // first use): it is tried again once and waited for, so its answer is a path that landed or the
  // reason. A first act was handed a path whose file never landed.
  const fresh = !lastSource.has(session.id);
  // Started before anything else is awaited: the picture is of THIS moment.
  const taken = capture(deps, session).then((pixels) =>
    fresh && 'string' === typeof pixels ? capture(deps, session) : pixels,
  );
  const predicted = fresh ? undefined : await predict(deps, session);
  const file = `${String(seq).padStart(SEQ_WIDTH, '0')}-${tool.replace(TOOL_PREFIX, '')}${JPEG_EXT}`;
  const path = join(dir, file);
  const land = taken.then(async (pixels) => {
    if ('string' === typeof pixels) {
      lastSource.set(session.id, NOTHING);
      return;
    }
    lastSource.set(session.id, pixels.source);
    try {
      await deps.fs.mkdir(dir);
      await deps.fs.writeFileBytes(path, pixels.bytes);
      const record: RunScreenshot = {
        seq,
        file,
        tool,
        ...(step === undefined ? {} : { step: step.slice(0, UPLOAD_TEXT_MAX) }),
        ...(true === verdict ? { verdict } : {}),
        ...(actionId === undefined ? {} : { actionId }),
        source: pixels.source,
        width: pixels.width,
        height: pixels.height,
        sha256: createHash('sha256').update(pixels.bytes).digest('hex'),
      };
      await deps.fs.appendFile(
        join(dir, STEP_SCREENSHOT.MANIFEST_FILE),
        `${JSON.stringify(record)}\n`,
      );
    } catch {
      // A disk that cannot take the file loses one picture, never the step.
    }
  });
  noteLanding(dir, land);
  if (predicted !== undefined) return { path, source: predicted };
  // Nothing worked last time: wait, and tell the truth either way.
  const pixels = await taken;
  await land;
  return 'string' === typeof pixels ? { error: pixels } : { path, source: pixels.source };
}

/** The replay hook that gives every reported flow step its screenshot, filed as `<flow>#<step>`. */
export function replayStepShooter(
  deps: ToolDeps,
  sessionId: string,
): (result: FlowStepResult, flow: string) => Promise<void> {
  return async (result, flow) => {
    result.screenshot = await takeStepShot(deps, sessionId, ReticleTool.REPLAY, {
      step: `${flow}#${String(result.step)}`,
    });
  };
}
