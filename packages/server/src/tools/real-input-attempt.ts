/**
 * The native-input attempt — everything that decides whether a pointer action is driven through a
 * real input provider or falls back to the occlusion-honest synthetic path, and WHY.
 *
 * Split out of act-tools.ts along its natural seam: the act tools care only about the outcome
 * (`result` defined = it went native), never about provider availability, box resolution,
 * drag-target inspection or the reason taxonomy.
 *
 * Also hosts `rewriteUploadArgs` — the daemon-side path that lets an agent name a file on disk
 * and have its REAL bytes reach the browser's `<input type="file">`. The browser SDK cannot read
 * the filesystem; the daemon can. The rewrite happens here, before the ACT command crosses the
 * bridge, so the browser side sees a normal `{ content, name, type }` call and `assertUploadArgs`
 * keeps its invariant (no fabricated bytes, no silently-dropped keys).
 */
import { ActionType, InputModeReason, ReticleCommand } from '@reticlehq/core';
import type { Session } from '../session/session.js';
import type { ElementBox, RealInputArgs } from '../input/real-input.js';
import { isPointerAction } from '../input/real-input.js';
import { assertDragNotDestructive, assertNotDestructive } from './act-danger.js';
import { NATIVE_INPUT_ARG } from '@reticlehq/core';
import { asString, asRecord } from './tools-helpers.js';
import { type ToolDeps, commandOrThrow } from './tool-kit.js';
import { asBox } from './act-helpers.js';
import { isAbsolute, join, resolve, relative, extname } from 'node:path';

/**
 * Minimal extension → MIME-type table for the file types agents most commonly upload.
 * Falls back to `application/octet-stream` for anything not listed here — the browser and
 * the receiving server both sniff the real type from the bytes anyway.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maximum file size the daemon will read and forward over the bridge (10 MiB).
 *
 * The bridge serialises the bytes as a base-64 string inside a JSON command frame. Larger files
 * would stall the WebSocket and the browser's DataTransfer, so we refuse rather than guess.
 * The stated cap is the whole point: `assertUploadArgs` exists to prevent substituted content;
 * a size limit exists to prevent an unbounded read on an agent's say-so.
 */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Resolve a caller-supplied path to an absolute path that is still within the project root (cwd).
 *
 * The trust-boundary decision the issue asks for: scoped to `process.cwd()` — the directory the
 * daemon was started in, the same implicit root that gates flows, baselines, and recordings. An
 * absolute path outside that tree, or a relative path that escapes it via `../`, is refused here
 * with a clear error, never silently substituted with fabricated bytes.
 *
 * Throws on any violation so the caller surface stays simple: resolve → read → forward.
 */
function resolveUploadPath(rawPath: string, cwd: string): string {
  const abs = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
  const norm = resolve(abs);
  const rel = relative(cwd, norm);
  // relative() returns a path starting with '..' when norm escapes cwd.
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `upload path '${rawPath}' is outside the project root '${cwd}' — ` +
        'only files within the directory the daemon was started in may be read. ' +
        'Use a path relative to the project root, or an absolute path inside it.',
    );
  }
  return norm;
}

/**
 * If the action is `upload` AND the inner args carry `path`, read the file from disk and rewrite
 * the args to `{ content, name, type }` before the ACT command reaches the browser.
 *
 * Returns the (possibly rewritten) args object. All other actions are returned unchanged.
 *
 * Design intent: the browser side is unchanged — it still sees `{ content, name, type }` and
 * `assertUploadArgs` still enforces "no fabricated bytes". The daemon is the only party that can
 * cross the filesystem→browser boundary; this is that crossing, done safely.
 */
export async function rewriteUploadArgs(
  deps: ToolDeps,
  action: string,
  innerArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (action !== ActionType.UPLOAD) return innerArgs;
  const rawPath = asString(innerArgs['path']);
  if (rawPath === undefined) return innerArgs; // no path → let assertUploadArgs handle it normally

  // Project root: one level above reticleRoot (.reticle/ lives inside it).
  const cwd = join(deps.reticleRoot, '..');
  const absPath = resolveUploadPath(rawPath, cwd);

  const bytes = await deps.fs.readFileBytes(absPath).catch(() => {
    throw new Error(
      `upload path '${rawPath}' could not be read: file not found or not accessible.`,
    );
  });

  if (bytes.byteLength > UPLOAD_MAX_BYTES) {
    throw new Error(
      `upload path '${rawPath}' is ${bytes.byteLength} bytes, which exceeds the ` +
        `${UPLOAD_MAX_BYTES / (1024 * 1024)} MiB limit. ` +
        'Split the file or pass its bytes as args.content directly.',
    );
  }

  // Encode as base-64 so the bytes survive JSON serialisation across the bridge.
  const content = Buffer.from(bytes).toString('base64');

  // Infer MIME type from the file extension; fall back to octet-stream if unknown.
  const callerType = asString(innerArgs['type']);
  const type = callerType ?? mimeFromPath(absPath);

  // Caller may override the filename; default to the basename of the path.
  const callerName = asString(innerArgs['name']);
  const name = callerName ?? absPath.split('/').pop() ?? absPath.split('\\').pop() ?? 'file';

  // Strip 'path' from the forwarded args; the browser does not know it and assertUploadArgs
  // would refuse it as an unrecognised key. Carry any other caller-supplied keys through.
  // __base64: true tells the browser-side dispatch to decode `content` from base64 before
  // constructing the File — JSON can only carry strings, not binary, across the bridge.
  const { path: _dropped, name: _n, type: _t, ...rest } = innerArgs;
  return { ...rest, content, name, type, __base64: true };
}

interface RealActResult {
  /** Defined only on a successful native action; `undefined` means the synthetic path runs. */
  result: unknown;
  settled: boolean;
  /** Set when a provider was available but threw — surfaces the fallback to the agent. */
  fellBack?: boolean;
  /** Why we went synthetic despite a configured provider (field bug #2: never a silent fallback). */
  reason?: InputModeReason;
}

/** Synthetic outcome with a diagnostic reason (provider configured but native input skipped). */
function synthetic(reason?: InputModeReason): RealActResult {
  return reason === undefined
    ? { result: undefined, settled: false }
    : { result: undefined, settled: false, reason };
}

/**
 * Attempt to drive a pointer action via native input. Returns a synthetic outcome (with a
 * `reason` when a provider is configured) whenever the synthetic path should run — no matching
 * page, unresolvable box, declined, etc. A throw inside the provider becomes a synthetic fallback
 * flagged with `fellBack`. `result` is defined only on a real success.
 */
export async function tryRealInput(
  deps: ToolDeps,
  session: Session,
  ref: string,
  action: ActionType,
  args: Record<string, unknown>,
): Promise<RealActResult> {
  const provider = deps.realInput;
  const inner = asRecord(args['args']);
  const askedForNative = true === inner[NATIVE_INPUT_ARG];
  if (provider === undefined) {
    // Silent by default: with no provider EVERY action is synthetic, and a reason on all of them is
    // noise on the most-used tool in the product. But an agent that passed native:true asked a
    // question and got the opposite answer — reported from the field as a silent downgrade that cost
    // real debugging time, because the tool description promises a reason is "never silent".
    return askedForNative ? synthetic(InputModeReason.NOT_CONFIGURED) : synthetic();
  }
  if (!isPointerAction(action)) return synthetic(InputModeReason.NOT_POINTER); // fill/type stay synthetic

  // "Don't click, run the code": a click/dblclick runs the occlusion-honest SYNTHETIC path by default
  // even with a provider configured — no coordinate gesture to be intercepted by the HUD or missed
  // off-screen. Opt into a trusted native click with args.native:true (file pickers, clipboard,
  // isTrusted-gated handlers). hover/drag genuinely need native pointer state, so they stay real.
  if ((action === ActionType.CLICK || action === ActionType.DBLCLICK) && !askedForNative) {
    return synthetic(InputModeReason.SYNTHETIC_CLICK_PREFERRED);
  }

  if (!(await provider.isAvailableFor(session.url)))
    return synthetic(InputModeReason.PAGE_NOT_CORRELATED);

  const inspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, { ref });
  assertNotDestructive(action, inner, inspected);
  const box = asBox(inspected);
  if (box === undefined) return synthetic(InputModeReason.ELEMENT_NOT_LOCATABLE);

  let toBox: ElementBox | undefined;
  if (action === ActionType.DRAG) {
    const toRef = asString(inner['toRef']);
    if (toRef === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
    const targetInspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, {
      ref: toRef,
    });
    // A drag is judged on BOTH ends: dropping onto "Trash" is destructive however innocent the
    // thing being dragged looks.
    assertDragNotDestructive(inner, inspected, targetInspected);
    toBox = asBox(targetInspected);
    if (toBox === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
  }

  const performArgs: RealInputArgs = {};
  const value = asString(inner['value']);
  if (value !== undefined) performArgs.value = value;
  const text = asString(inner['text']);
  if (text !== undefined) performArgs.text = text;
  if (toBox !== undefined) performArgs.toBox = toBox;

  try {
    const performed = await provider.perform(session.url, action, box, performArgs);
    if (!performed.performed) return synthetic(InputModeReason.PROVIDER_DECLINED);
    return { result: { performed: true, center: performed.center, action }, settled: true };
  } catch {
    return {
      result: undefined,
      settled: false,
      fellBack: true,
      reason: InputModeReason.PROVIDER_ERROR,
    };
  }
}
