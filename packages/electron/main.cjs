'use strict';
/**
 * Reticle's Electron MAIN-process helper — the screenshot half of desktop support.
 *
 *     const { installReticleCapture } = require('@reticlehq/electron/main');
 *     const win = new BrowserWindow({ ... });
 *     installReticleCapture(win);
 *
 * ...and `reticle_screenshot` / `reticle_visual_diff` work on your app.
 *
 * Why the main process: `webContents.capturePage()` reads the window's own BACKING STORE. That makes
 * it correct while the window is behind your editor, correct while it is backgrounded, and free of
 * any screen-recording permission. Capturing a screen region instead was tried and rejected — it
 * photographs whatever is on top, which would quietly save a picture of your editor as a visual
 * baseline. Renderer-side capture is not an option either: the renderer has no access to the pixels.
 *
 * Dev-only, like the rest of Reticle. Gate the require behind your dev check so it never ships.
 */
const { ipcMain } = require('electron');
const { writeFile, readdir, stat, unlink, mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
// Generated from @reticlehq/core's TypeScript source, so the main process, the preload and the
// daemon agree by construction rather than by three people copying the same string.
const {
  RETICLE_CAPTURE_CHANNEL,
  RETICLE_CAPTURE_FILE_PREFIX,
  RETICLE_FULL_PAGE_UNSUPPORTED,
} = require('@reticlehq/core/desktop-contract');

let captureSeq = 0;
/** One ipcMain handler serves every window — the channel is global, so registration is once-only. */
let registered = false;
/** Windows this app registered, so a capture survives its requester being destroyed. */
const windows = new Set();

/**
 * The webContents to photograph: the requester if it is alive, else the ONE remaining window.
 *
 * The fallback exists for a window that closed mid-command — answering "no image" there reports a
 * capture failure with no cause. But it only applies when exactly one window is left, because with
 * two the choice is a guess: picking "any" window silently returns a picture of a DIFFERENT window
 * and reports it as a successful capture of the one that was asked for, which is the same
 * photographed-the-wrong-thing failure that ruled out capturing a screen region in the first place.
 * Ambiguous means no image, and no image is a result the caller can act on.
 */
function usableContents(sender) {
  if (sender !== null && sender !== undefined && !sender.isDestroyed()) return sender;
  const alive = [...windows]
    .map((win) => win?.webContents)
    .filter((contents) => contents !== undefined && contents !== null && !contents.isDestroyed());
  return alive.length === 1 ? alive[0] : null;
}

/**
 * Delete this process's earlier captures before writing a new one.
 *
 * The daemon unlinks a capture after reading it, but only if it ever reads: a session that died, a
 * command that timed out, or a path the daemon rejected all leave a ~300KB PNG in the temp directory
 * forever. Sweeping our own prefix on each capture bounds that to one file at a time, and the daemon
 * removes this empty private directory in its existing shutdown path. Best-effort — a failed sweep
 * must never fail a capture.
 *
 * Only files older than STALE_CAPTURE_MS are swept. Deleting every sibling unconditionally raced
 * with CONCURRENT captures: with two screenshots in flight, the second one's sweep unlinked the
 * first one's PNG before the daemon had read it, and the daemon then answered `no-visual-provider`
 * — which reads as "this app installed no capture helper" when the helper is installed and working.
 */
const STALE_CAPTURE_MS = 60_000;

/**
 * This process's own capture directory, created 0700 — made once, on the first capture.
 *
 * A screenshot of your app window can hold customer records, a token on screen, an authenticated
 * session. Written straight into the SHARED temp dir under a guessable name — a constant prefix, a
 * readable pid and a counter from 0 — it is readable by any other local user for as long as it
 * sits there, and a symlink pre-placed at that name would have `writeFile` follow it and write
 * through with this app's privileges.
 *
 * `mkdtemp` closes both at once, and it is the DIRECTORY that does it rather than a less guessable
 * filename: the OS creates it 0700 with a random suffix, so another user cannot enter it to read a
 * capture, and cannot pre-create anything inside a directory that did not exist until this process
 * made it. Guessing is not the property that matters; the shared parent was.
 *
 * Memoised as the PROMISE, not the resolved path, so two captures racing on the first screenshot
 * await one `mkdtemp` instead of creating two directories and leaking one.
 */
let capturesDirPromise;

function capturesDir() {
  capturesDirPromise ??= mkdtemp(join(tmpdir(), RETICLE_CAPTURE_FILE_PREFIX));
  return capturesDirPromise;
}

async function sweepOldCaptures(dir, keepFile) {
  const cutoff = Date.now() - STALE_CAPTURE_MS;
  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((name) => join(dir, name) !== keepFile)
        .map(async (name) => {
          const file = join(dir, name);
          const info = await stat(file).catch(() => undefined);
          if (info !== undefined && info.mtimeMs < cutoff)
            await unlink(file).catch(() => undefined);
        }),
    );
  } catch {
    /* the capture directory is unreadable; a capture is still worth attempting */
  }
}

/**
 * Let Reticle screenshot this window. Safe to call for several windows; the handler is registered
 * once and answers for whichever window asked, so a multi-window app needs no extra wiring.
 */
function installReticleCapture(win) {
  if (win === null || win === undefined) return;
  // Remembered so a capture can still resolve if the requesting webContents has gone (a window
  // closing mid-command), rather than returning null and reporting an unexplained capture failure.
  windows.add(win);
  win.on?.('closed', () => windows.delete(win));

  if (!registered) {
    ipcMain.handle(RETICLE_CAPTURE_CHANNEL, async (event, options) => {
      // `capturePage()` reads the composited window, so there is no full-document render to ask for.
      // Saying so beats handing back a viewport the caller thinks covers the whole scroll height.
      if (options && options.fullPage === true) throw new Error(RETICLE_FULL_PAGE_UNSUPPORTED);
      const contents = usableContents(event.sender);
      if (contents === null) return null;
      try {
        const image = await contents.capturePage();
        // An empty image means the window had nothing to compose yet; report it as no-image rather
        // than handing back a 0-byte PNG that a diff would treat as a real, blank baseline.
        if (image.isEmpty()) return null;
        // Write to a temp FILE and return its path, rather than base64 over the bridge. The SDK's
        // transport sanitizer caps every string at 64KB, so a real screenshot came back silently
        // truncated — an invalid PNG that still reported `saved: true`. The daemon and the app are
        // always on the same machine here (the bridge is loopback), so a path is the honest channel:
        // no size cap, no chunking, and nothing large on the event wire.
        captureSeq += 1;
        // Inside this process's own 0700 directory. A failure to create it throws to the catch
        // below and answers no-image; it deliberately does NOT fall back to the shared temp dir,
        // because that fallback is the very exposure this directory exists to remove.
        const dir = await capturesDir();
        const file = join(dir, `${RETICLE_CAPTURE_FILE_PREFIX}${String(captureSeq)}.png`);
        // `wx` is O_CREAT|O_EXCL: it REFUSES an existing path instead of writing through it, and
        // O_EXCL does not follow a final symlink. The 0700 directory already stops an attacker
        // getting a symlink here, so this is the second lock on the same door — and the one that
        // still holds if a later change moves this write back out into the shared temp dir. The
        // sequence only ever climbs within a fresh per-process directory, so it never collides
        // with a capture of our own.
        await writeFile(file, image.toPNG(), { flag: 'wx' });
        await sweepOldCaptures(dir, file);
        return file;
      } catch {
        return null;
      }
    });
    registered = true;
  }
}

module.exports = { installReticleCapture };
