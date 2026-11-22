import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GLIDE_LONGEST, GLIDE_SHORTEST, glideMs, macHud } from './mac-hud.js';

/** A real program starts and writes files: a generous ceiling, not a duration under test. */
const HUD_PROGRAM_TIMEOUT_MS = 20_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/** A program that ends at once the first time, and after that keeps each line it is sent. */
function program(): { path: string; starts: () => number; lines: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-hud-'));
  dirs.push(dir);
  const path = join(dir, 'hud');
  writeFileSync(
    path,
    `#!/bin/sh
echo x >> "${dir}/starts"
[ "$(wc -l < "${dir}/starts")" -eq 1 ] && exit 0
exec cat >> "${dir}/lines"
`,
  );
  chmodSync(path, 0o755);
  const read = (name: string): string[] => {
    try {
      return readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { path, starts: () => read('starts').length, lines: () => read('lines') };
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !ok(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// The pointer is the program's window. A program that ended took the pointer with it for the rest
// of the session: nothing started it again, and the person saw the agent act with no pointer.
describe('the HUD program', () => {
  it(
    'is started again when it ends, and is told the application again',
    async () => {
      const hud = program();
      const port = macHud(hud.path);
      port.app('Notes');
      await until(() => hud.starts() >= 2);
      await port.move(10, 20);
      await until(() => hud.lines().length >= 2);
      port.close();
      expect(hud.starts()).toBe(2);
      expect(hud.lines().map((l) => JSON.parse(l) as { t: string })).toEqual([
        { t: 'app', name: 'Notes' },
        { t: 'move', x: 10, y: 20, ms: 0 },
      ]);
    },
    HUD_PROGRAM_TIMEOUT_MS,
  );

  it(
    'is not started again after it was closed',
    async () => {
      const hud = program();
      const port = macHud(hud.path);
      port.close();
      await until(() => hud.starts() >= 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(hud.starts()).toBe(1);
    },
    HUD_PROGRAM_TIMEOUT_MS,
  );
});

// A hand takes longer to cross the screen than to go to the next button. The pointer took the
// same 0.12 s for both, and the realm did not wait for it, so a press came before the pointer.
describe('the glide of the pointer', () => {
  it('takes longer for a longer way, within bounds', () => {
    expect(glideMs([5, 5], [5, 5])).toBe(GLIDE_SHORTEST);
    expect(glideMs([0, 0], [600, 800])).toBeGreaterThan(glideMs([0, 0], [300, 400]));
    expect(glideMs([0, 0], [3000, 4000])).toBe(GLIDE_LONGEST);
    expect(glideMs(undefined, [500, 500])).toBe(0);
  });

  it(
    'is sent with each move, and the move ends when the pointer is there',
    async () => {
      const hud = program();
      const port = macHud(hud.path);
      await until(() => hud.starts() >= 2);
      await port.move(0, 0);
      await port.move(300, 400);
      await until(() => hud.lines().length >= 2);
      port.close();
      expect(hud.lines().map((l) => JSON.parse(l) as unknown)).toEqual([
        { t: 'move', x: 0, y: 0, ms: 0 },
        { t: 'move', x: 300, y: 400, ms: glideMs([0, 0], [300, 400]) },
      ]);
    },
    HUD_PROGRAM_TIMEOUT_MS,
  );
});
