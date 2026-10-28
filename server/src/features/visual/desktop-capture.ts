/**
 * The desktop shell's photograph of its own window, read from the file the shell wrote.
 *
 * Shared by `reticle_screenshot`, the drive frames and the step shots. The step shots use it only
 * for a page SDK before 3.7, which has no `render` command and declares `capture` instead.
 */
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import {
  asRecord,
  asString,
  ReticleCommand,
  RETICLE_CAPTURE_FILE_PREFIX,
  RETICLE_TAURI_INERT_MARKER,
  TAURI_INERT_RECOMMENDATION,
  VisualReason,
} from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { trackCaptureDirectory } from './capture-cleanup.js';

/**
 * Ask the desktop shell to photograph its own window.
 *
 * Returns undefined for a plain web page (no capture helper) and for a desktop app that did not
 * install `@reticlehq/electron/main`. Deliberately NOT a screen-region capture: photographing
 * the glass returns whatever window is on top, which would save a picture of the user's editor as a
 * visual baseline — the exact false green Reticle exists to eliminate.
 */
export async function desktopCapture(
  deps: ToolDeps,
  sessionId: string | undefined,
  fullPage: boolean,
): Promise<{ png?: Uint8Array; reason?: VisualReason; recommendation?: string }> {
  const session = deps.sessions.resolve(sessionId);
  // A session that cannot take commands (no live browser behind it) simply has no pixels to give.
  if (typeof session.command !== 'function') {
    return {};
  }
  const res = await session.command(ReticleCommand.CAPTURE, { fullPage });
  if (!res.ok) {
    return {};
  }
  const r = asRecord(res.result);
  if (r['ok'] !== true) {
    // The shell refused a full-page capture it cannot do. That is a different answer from "capture
    // broke", and the caller has to hear it — otherwise they read `fullPage` as honoured.
    if (r['reason'] === VisualReason.FULL_PAGE_UNSUPPORTED) {
      return { reason: VisualReason.FULL_PAGE_UNSUPPORTED };
    }
    // A Tauri release build with the capture compiled out: say that, never the web answer.
    return true === asString(r['reason'])?.includes(RETICLE_TAURI_INERT_MARKER)
      ? { reason: VisualReason.NO_PROVIDER, recommendation: TAURI_INERT_RECOMMENDATION }
      : {};
  }
  const path = asString(r['path']);
  if (path === undefined || !isCapturePath(path)) {
    return {};
  }
  try {
    const bytes = await readFile(path);
    await unlink(path).catch(() => undefined);
    trackCaptureDirectory(path);
    return isCompletePng(bytes) ? { png: new Uint8Array(bytes) } : {};
  } catch {
    return {};
  }
}

/**
 * Only read a capture the shell wrote. The path arrives from the PAGE, and the daemon must not
 * become a file-read oracle for whatever a compromised renderer names.
 *
 * Two layouts are accepted, and the pair is the whole subtlety:
 *
 * - `<tmp>/<prefix><dir>/<prefix><n>.png` — the shell's own PRIVATE capture directory, created 0700
 *   so no other local user can read the screenshot or pre-place a symlink at the path we write.
 * - `<tmp>/<prefix><pid>-<n>.png` — the legacy flat layout. Kept because the shell ships as a
 *   SEPARATE package on the user's own upgrade schedule: an app still on the older
 *   `@reticlehq/electron` talking to a newer daemon must keep getting screenshots, not silently
 *   start returning no image. It grants the daemon nothing it did not already have.
 *
 * Every comparison is an exact match against an UNRESOLVED path, which is what refuses traversal:
 * `<tmp>/<prefix>x/../../etc/<prefix>passwd.png` has a grandparent of `<tmp>/<prefix>x/..`, not
 * `<tmp>`. Exactly one directory level is allowed, so a deeper nesting is refused too.
 */
export function isCapturePath(path: string): boolean {
  if (!basename(path).startsWith(RETICLE_CAPTURE_FILE_PREFIX)) {
    return false;
  }
  const parent = dirname(path);
  if (parent === tmpdir()) {
    return true;
  }
  return dirname(parent) === tmpdir() && basename(parent).startsWith(RETICLE_CAPTURE_FILE_PREFIX);
}

/**
 * A PNG is complete only if it ends with IEND. This check exists because a truncated image once
 * sailed through as a saved baseline: the tool answered `saved: true` with a path, and the file was
 * undecodable. A screenshot that cannot be read must fail loudly, never bank a corrupt baseline that
 * a later visual_diff will compare against.
 */
function isCompletePng(bytes: Buffer): boolean {
  if (bytes.byteLength < 12) {
    return false;
  }
  return 'IEND' === bytes.subarray(bytes.byteLength - 8, bytes.byteLength - 4).toString('ascii');
}
