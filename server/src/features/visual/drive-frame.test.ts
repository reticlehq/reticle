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
  return {
    sessions: sessions as SessionManager,
    pool: { screenshotLease: () => Promise.resolve(options.lease) },
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

  it('is undefined for a web tab with no camera, and never throws for one that left', async () => {
    expect(await driveFrame(deps({}), 's1', 50)).toBeUndefined();
    expect(await driveFrame(deps({ gone: true }), 's1', 50)).toBeUndefined();
  });
});
