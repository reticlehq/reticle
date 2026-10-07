import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { RETICLE_CAPTURE_FILE_PREFIX, ReticleCommand } from '@reticlehq/core';
import { removeTempDir } from '@/machine/temp-dir.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { driveFrame } from './visual-tools.js';

/**
 * A drive the platform's chat asked for showed its steps and never a picture. Its frames came only
 * from a browser context this daemon launched, and a desktop window is never one: it connects through
 * the SDK, and its pixels come from the shell's own capture, which `reticle_screenshot` already used.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => removeTempDir(d)));
});

function png(): Uint8Array {
  return new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })));
}

/** Where a desktop shell writes a capture: its own private directory under the system temp dir. */
async function writtenCapture(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), RETICLE_CAPTURE_FILE_PREFIX));
  dirs.push(dir);
  const path = join(dir, `${RETICLE_CAPTURE_FILE_PREFIX}1.png`);
  await writeFile(path, bytes);
  return path;
}

function deps(options: {
  lease?: Uint8Array;
  capture?: () => Promise<unknown>;
  gone?: boolean;
  /** The browser `reticle drive` launched in a window: its own page, and the options it was asked for. */
  window?: { shot: Uint8Array; asked: unknown[] };
}): ToolDeps {
  const session = {
    id: 's1',
    url: 'http://localhost:5175/',
    command: (name: string) =>
      name === ReticleCommand.CAPTURE && options.capture !== undefined
        ? options.capture()
        : Promise.resolve({ ok: false }),
  } as unknown as Session;
  const sessions: Partial<SessionManager> = {
    resolve: () => {
      if (true === options.gone) throw new Error('no connected session');
      return session;
    },
  };
  const window = options.window;
  return {
    sessions: sessions as SessionManager,
    pool: { screenshotLease: () => Promise.resolve(options.lease) },
    ...(window === undefined
      ? {}
      : {
          realInput: {
            isAvailableFor: (url: string) => Promise.resolve(url === session.url),
            screenshot: (_url: string, opts: unknown) => {
              window.asked.push(opts);
              return Promise.resolve(window.shot);
            },
          },
        }),
  } as unknown as ToolDeps;
}

describe('the picture of a chat-requested drive', () => {
  it('uses the leased browser when this daemon launched the tab', async () => {
    const leased = png();
    expect(await driveFrame(deps({ lease: leased }), 's1', 50)).toBe(leased);
  });

  it("falls back to the desktop window's own capture", async () => {
    const shot = png();
    const path = await writtenCapture(shot);
    const frame = await driveFrame(
      deps({ capture: () => Promise.resolve({ ok: true, result: { ok: true, path } }) }),
      's1',
      50,
    );
    expect(frame).toEqual(shot);
  });

  /**
   * Found driving the chat from a headed window: `reticle drive` launched the browser itself, which
   * is neither a pool lease nor a desktop shell, so the chat said "not filmed" beside a window the
   * daemon could see all along. A live picture asks for a plain JPEG, so the window does not flicker.
   */
  it('films the window `reticle drive` opened, as a plain JPEG', async () => {
    const window = { shot: png(), asked: [] as unknown[] };
    expect(await driveFrame(deps({ window }), 's1', 50)).toBe(window.shot);
    expect(window.asked).toEqual([{ jpegQuality: 50 }]);
  });

  it('is undefined for a web tab with no camera, and never throws for one that left', async () => {
    expect(await driveFrame(deps({}), 's1', 50)).toBeUndefined();
    expect(await driveFrame(deps({ gone: true }), 's1', 50)).toBeUndefined();
  });
});
