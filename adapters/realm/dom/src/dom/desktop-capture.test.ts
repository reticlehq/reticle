import { afterEach, describe, expect, it, vi } from 'vitest';
import { RETICLE_IPC_GLOBAL, RETICLE_TAURI_CAPTURE_COMMAND, VisualReason } from '@reticlehq/core';
import { captureDesktopWindow } from './desktop-capture.js';

const TAURI_INTERNALS = '__TAURI_INTERNALS__';
const PNG_PATH = '/var/folders/tmp/reticle-capture-1.png';

afterEach(() => {
  Reflect.deleteProperty(window, RETICLE_IPC_GLOBAL);
  Reflect.deleteProperty(window, TAURI_INTERNALS);
});

describe('desktop capture — Electron, through the preload-installed channel', () => {
  it('returns the path the shell wrote', async () => {
    Reflect.set(window, RETICLE_IPC_GLOBAL, { capture: () => Promise.resolve(PNG_PATH) });
    await expect(captureDesktopWindow()).resolves.toEqual({ ok: true, path: PNG_PATH });
  });

  it('reports a failing helper instead of throwing into the SDK', async () => {
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () => Promise.reject(new Error('window is gone')),
    });
    await expect(captureDesktopWindow()).resolves.toMatchObject({
      ok: false,
      reason: 'window is gone',
    });
  });
});

describe("Reticle's own UI is not banked into the baseline", () => {
  /** The presenter panel renders live session state — an event tally, a log tail, a run badge. */
  function mountPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.setAttribute('data-reticle-overlay', '');
    document.body.append(panel);
    return panel;
  }

  afterEach(() => {
    document.querySelectorAll('[data-reticle-overlay],[data-reticle-mark]').forEach((el) => {
      el.remove();
    });
  });

  it("hides the annotator's button too, not just the presenter panel", async () => {
    // The annotator mounts by DEFAULT alongside the presenter, and it leaked into snapshots once
    // already for exactly this reason. Both are covered by the one selector the snapshot layer uses.
    const mark = document.createElement('div');
    mark.setAttribute('data-reticle-mark', '');
    document.body.append(mark);
    let visibilityDuringCapture = '';
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () => {
        visibilityDuringCapture = mark.style.visibility;
        return Promise.resolve(PNG_PATH);
      },
    });

    await expect(captureDesktopWindow()).resolves.toEqual({ ok: true, path: PNG_PATH });
    expect(visibilityDuringCapture).toBe('hidden');
    mark.remove();
  });

  it('hides Reticle-owned roots while the shell photographs the window', async () => {
    const panel = mountPanel();
    let visibilityDuringCapture = '';
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () => {
        visibilityDuringCapture = panel.style.visibility;
        return Promise.resolve(PNG_PATH);
      },
    });

    await expect(captureDesktopWindow()).resolves.toEqual({ ok: true, path: PNG_PATH });
    // Banked with the panel visible, every later visual_diff reports a change that belongs to the
    // observer, not the app — the instrument measuring itself.
    expect(visibilityDuringCapture).toBe('hidden');
  });

  it('puts the panel back even when the capture fails', async () => {
    const panel = mountPanel();
    panel.style.visibility = 'visible';
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () => Promise.reject(new Error('window is gone')),
    });

    await expect(captureDesktopWindow()).resolves.toMatchObject({ ok: false });
    expect(panel.style.visibility).toBe('visible');
  });
});

describe('desktop capture — Tauri, through its own invoke', () => {
  /**
   * Electron installs the capture global from a preload, which runs before app code. Tauri has NO
   * preload stage, so requiring the same global would put a hand-written shim in every Tauri app —
   * and a forgotten shim reads as "this app has no screenshots" rather than as a setup mistake.
   */
  it('invokes the capture command when no preload channel exists', async () => {
    const invoke = vi.fn().mockResolvedValue(PNG_PATH);
    Reflect.set(window, TAURI_INTERNALS, { invoke });

    await expect(captureDesktopWindow()).resolves.toEqual({ ok: true, path: PNG_PATH });
    expect(invoke).toHaveBeenCalledWith(RETICLE_TAURI_CAPTURE_COMMAND, { fullPage: false });
  });

  it('reports no-provider when the app never registered the command', async () => {
    Reflect.set(window, TAURI_INTERNALS, {
      invoke: () => Promise.reject(new Error('Command reticle_capture not found')),
    });
    await expect(captureDesktopWindow()).resolves.toMatchObject({ ok: false });
  });

  it('prefers an explicitly installed channel over the invoke fallback', async () => {
    const invoke = vi.fn().mockResolvedValue('/tmp/reticle-capture-tauri.png');
    Reflect.set(window, TAURI_INTERNALS, { invoke });
    Reflect.set(window, RETICLE_IPC_GLOBAL, { capture: () => Promise.resolve(PNG_PATH) });

    await expect(captureDesktopWindow()).resolves.toEqual({ ok: true, path: PNG_PATH });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('treats a non-string invoke result as no image rather than a path', async () => {
    Reflect.set(window, TAURI_INTERNALS, { invoke: () => Promise.resolve(null) });
    await expect(captureDesktopWindow()).resolves.toMatchObject({ ok: false });
  });
});

describe('full-page capture is refused, never silently downgraded', () => {
  /**
   * The failure this prevents: a caller asks for the whole scroll height, the shell can only give
   * the composited viewport, and an image WITHOUT the content below the fold gets banked as a
   * baseline. Every later diff of that baseline is green about a region it never captured.
   */
  it('surfaces a shell refusal as the full-page reason, not as a generic error', async () => {
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () =>
        Promise.reject(
          new Error(`Error invoking remote method: ${VisualReason.FULL_PAGE_UNSUPPORTED}`),
        ),
    });
    await expect(captureDesktopWindow(true)).resolves.toEqual({
      ok: false,
      reason: VisualReason.FULL_PAGE_UNSUPPORTED,
    });
  });

  it('asks the shell for a full page only when the caller did', async () => {
    const capture = vi.fn().mockResolvedValue(PNG_PATH);
    Reflect.set(window, RETICLE_IPC_GLOBAL, { capture });

    await captureDesktopWindow();
    expect(capture).toHaveBeenLastCalledWith(false);
    await captureDesktopWindow(true);
    expect(capture).toHaveBeenLastCalledWith(true);
  });

  it('passes the flag to Tauri as a command argument', async () => {
    const invoke = vi.fn().mockResolvedValue(PNG_PATH);
    Reflect.set(window, TAURI_INTERNALS, { invoke });

    await captureDesktopWindow(true);
    expect(invoke).toHaveBeenCalledWith(RETICLE_TAURI_CAPTURE_COMMAND, { fullPage: true });
  });

  it('keeps an ordinary failure as itself rather than reading it as a refusal', async () => {
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () => Promise.reject(new Error('window is gone')),
    });
    await expect(captureDesktopWindow(true)).resolves.toMatchObject({ reason: 'window is gone' });
  });
});

describe('desktop capture — a plain web page', () => {
  it('reports no provider, so the tool never guesses at pixels', async () => {
    await expect(captureDesktopWindow()).resolves.toMatchObject({
      ok: false,
      reason: 'no desktop capture helper installed',
    });
  });
});

/**
 * "Nothing came back" is three different problems, and they were one string.
 *
 * Electron's main-process handler answered a bare `null` for all of: the window had no composited
 * frame yet, the requesting webContents was gone, and anything at all threw. The SDK turned every
 * one of those into `capture returned no image`, so the tool reported `saved: false` with no bytes
 * and no reason.
 *
 * It cost a CI investigation. `desktop-e2e` went red on a commit that changed no production code,
 * with `shot.saved` false and `shot.bytes` undefined and nothing to say which of the three had
 * happened — and a gate whose red result cannot be read is a gate people learn to re-run. The
 * likeliest cause is the first case: under Xvfb there is no compositor guarantee, and a window that
 * has not painted yet returns an EMPTY image rather than an error.
 *
 * A user hitting the same thing gets the same silence, which is why this is worth separating even
 * with the flake set aside. See https://github.com/reticlehq/reticle/issues/257.
 */
describe('an empty capture and a failed capture are different answers', () => {
  it('names a window that had no frame to photograph', async () => {
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () => Promise.reject(new Error(VisualReason.NOT_COMPOSITED)),
    });
    await expect(captureDesktopWindow()).resolves.toEqual({
      ok: false,
      reason: VisualReason.NOT_COMPOSITED,
    });
  });

  it('does not dress a genuine failure up as an uncomposited window', async () => {
    // The direction that matters more. If a real error were mapped to NOT_COMPOSITED, the reader
    // would be sent to look at window timing for a problem that is not about timing at all.
    Reflect.set(window, RETICLE_IPC_GLOBAL, {
      capture: () => Promise.reject(new Error('EACCES writing the capture file')),
    });
    await expect(captureDesktopWindow()).resolves.toMatchObject({
      ok: false,
      reason: 'EACCES writing the capture file',
    });
  });

  it('still reports a plain no-image when the shell answers null', async () => {
    // A shell too old to send a reason, or one that genuinely has nothing to say. The vaguer message
    // stays for that case rather than being upgraded into a claim about compositing.
    Reflect.set(window, RETICLE_IPC_GLOBAL, { capture: () => Promise.resolve(null) });
    await expect(captureDesktopWindow()).resolves.toMatchObject({
      ok: false,
      reason: 'capture returned no image',
    });
  });
});
