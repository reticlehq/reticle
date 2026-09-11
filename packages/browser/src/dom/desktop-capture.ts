/**
 * Desktop screenshots, asked of the runtime that owns the window.
 *
 * A browser tab is captured through CDP. A desktop webview has no CDP endpoint, so the pixels have
 * to come from the shell — and the shell is the only party that can produce them CORRECTLY.
 *
 * Capturing a screen *region* instead was tried and rejected: it photographs the glass, so an app
 * window sitting behind the editor yields a picture of the editor, saved as a visual baseline that a
 * later diff would trust. A screenshot tool that can silently return another window's pixels is
 * worse than one that returns nothing — it manufactures exactly the false green Reticle exists to
 * eliminate. Electron's `webContents.capturePage()` reads the window's own backing store instead:
 * correct while occluded, correct while backgrounded, and needing no screen-recording permission.
 *
 * Both desktop runtimes can do this, each through its own shell API — `webContents.capturePage()` on
 * Electron, and on Tauri the platform's own webview snapshot (`WKWebView.takeSnapshot`, WebView2
 * `CapturePreview`, or WebKitGTK's snapshot). None of them reads the screen, so all stay correct with
 * the window occluded, hidden, or running headless with nothing on screen at all.
 *
 * The app opts in with one line in its main process (`@reticlehq/electron/main`) or one Rust command
 * (`reticle-tauri`). Absent that, this returns `{ ok: false }` and the tool reports no-provider
 * rather than guessing.
 */

import { RETICLE_IPC_GLOBAL, RETICLE_TAURI_CAPTURE_COMMAND, VisualReason } from '@reticlehq/core';
import { nativeFrame } from '../timers/native-timers.js';
import { RETICLE_OVERLAY } from './dom-ignore.js';

interface CaptureChannel {
  capture?: (fullPage?: boolean) => Promise<string | null>;
}

/**
 * What a shell returns when it can photograph the viewport but not the whole scroll height.
 *
 * Only WebKitGTK can render a full document offscreen; `capturePage()` and `takeSnapshot` both give
 * what is composited. Downgrading silently would be the worst option available: the caller asked for
 * the content below the fold, would get an image without it, and would bank it as a baseline that a
 * later diff reports as matching. So the shells say so, and the tool reports the reason.
 */
const FULL_PAGE_UNSUPPORTED_MARKER = VisualReason.FULL_PAGE_UNSUPPORTED;

/**
 * Reasons a shell can name, in the order they are matched.
 *
 * The shell throws one of these rather than answering a bare null, because "nothing came back" was
 * covering three different problems at once: a window with no composited frame yet, a webContents
 * that had gone away, and any error at all. They need different responses from the reader, and the
 * tool reported them identically.
 */
const RECOGNISED_MARKERS: readonly string[] = [
  FULL_PAGE_UNSUPPORTED_MARKER,
  VisualReason.NOT_COMPOSITED,
];

/** Tauri's own bridge object. The SDK reads `invoke` off it; it never patches it (it is read-only). */
interface TauriInternals {
  invoke?: (command: string, args?: unknown) => Promise<unknown>;
}

const TAURI_INTERNALS_GLOBAL = '__TAURI_INTERNALS__';

/**
 * Tauri's capture path, used when no preload-installed channel exists.
 *
 * Electron can install `RETICLE_IPC_GLOBAL` from its preload, which runs before app code. Tauri has
 * no preload stage at all, so requiring the same global would mean every Tauri app hand-writing a
 * frontend shim — a setup step that silently yields "no screenshots" when forgotten. Invoking the
 * command directly removes the JavaScript side entirely: the app registers one Rust command and the
 * SDK finds it. Absent that command the invoke rejects, and this reports no-provider like any other.
 */
function tauriCapture(): (() => Promise<string | null>) | undefined {
  const internals = (window as unknown as Record<string, unknown>)[TAURI_INTERNALS_GLOBAL] as
    TauriInternals | undefined;
  if (typeof internals?.invoke !== 'function') return undefined;
  const invoke = internals.invoke.bind(internals);
  return async (fullPage?: boolean) => {
    const path = await invoke(RETICLE_TAURI_CAPTURE_COMMAND, { fullPage: true === fullPage });
    return 'string' === typeof path ? path : null;
  };
}

interface CaptureResult {
  ok: boolean;
  /**
   * Filesystem path of the captured PNG, written by the desktop shell.
   *
   * A path, not the image bytes: the SDK's transport sanitizer caps every string at 64KB, so a
   * base64 PNG came back SILENTLY TRUNCATED and was saved as a "successful" screenshot that no
   * decoder could read. The daemon and the app always share a machine here (the bridge is loopback),
   * so handing over a path keeps the image off the event wire entirely.
   */
  path?: string;
  reason?: string;
}

/**
 * Take Reticle's own UI out of the shot, then put it back.
 *
 * The shell photographs the composited window, so anything Reticle mounted is IN the picture — and
 * the presenter panel is the worst possible thing to bank into a visual baseline, because it renders
 * live session state: an event tally, a log tail, a run badge. A baseline captured with it is a
 * baseline of Reticle's own UI as much as the app's, and the next `reticle_visual_diff` reports a
 * change that belongs entirely to the observer. That is measuring the instrument.
 *
 * Two frames, not one: the first lets the style change apply, the second lets the compositor present
 * it — capture before that and the shell photographs the pre-hide window anyway. Both are BOUNDED
 * frames, which is load-bearing rather than defensive: a headless Tauri window is hidden, and a
 * hidden webview never fires `requestAnimationFrame` at all, so a raw double-rAF here deadlocked
 * every capture until the command timed out at 8s. Restoration runs in a `finally`, so a capture
 * that throws still leaves the panel on screen for the human watching.
 */
async function withReticleUiHidden<T>(capture: () => Promise<T>): Promise<T> {
  // The SAME selector the snapshot layer already uses to keep Reticle's own DOM out of what the
  // agent reads — the presenter panel, the cursor, the glow, and the annotator's "flag a bug"
  // button. One definition: a root that leaked into snapshots once would otherwise leak into
  // baselines the second time someone added one.
  const roots = [...document.querySelectorAll<HTMLElement>(RETICLE_OVERLAY)];
  const previous = roots.map((el) => el.style.visibility);
  // `visibility`, not `display`: it keeps the element's box, so hiding cannot reflow the app
  // underneath and change the very layout the screenshot is meant to record.
  for (const el of roots) el.style.visibility = 'hidden';
  try {
    if (roots.length > 0) {
      await nativeFrame();
      await nativeFrame();
    }
    return await capture();
  } finally {
    roots.forEach((el, i) => {
      el.style.visibility = previous[i] ?? '';
    });
  }
}

export async function captureDesktopWindow(fullPage = false): Promise<CaptureResult> {
  const channel = (window as unknown as Record<string, unknown>)[RETICLE_IPC_GLOBAL] as
    CaptureChannel | undefined;
  const capture = 'function' === typeof channel?.capture ? channel.capture : tauriCapture();
  if (capture === undefined) {
    return { ok: false, reason: 'no desktop capture helper installed' };
  }
  try {
    const path = await withReticleUiHidden(() => capture(fullPage));
    return 'string' === typeof path && path.length > 0
      ? { ok: true, path }
      : { ok: false, reason: 'capture returned no image' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Recognised markers are reported as the reason ITSELF, so the tool can branch on a closed
    // vocabulary rather than on prose. Everything else keeps its own message: dressing an unknown
    // failure up as a known one would send the reader to the wrong place entirely.
    for (const marker of RECOGNISED_MARKERS) {
      if (reason.includes(marker)) return { ok: false, reason: marker };
    }
    return { ok: false, reason };
  }
}
