/**
 * The daemon decides "has this project been through `reticle init`" ONCE, at boot — and the ordinary
 * first-install order is the other way round: the daemon is already up (something started it), then
 * `init` writes `.reticle.json`, then the app is wired. Reported from the field: `reticle status`
 * answered "this project has not been through `reticle init`" while the config file sat there with a
 * framework and a projectId in it and the Vite plugin was wired. The real cause was a dev server
 * started before the plugin existed — and the one sentence the reader was most likely to act on sent
 * them to re-run an install that was already done.
 *
 * The projectPort read in this file already carries this reasoning ("`.reticle.json` can be written
 * by init after this daemon started"); `initialized` simply never got it.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNoSessionWatch } from './no-session-watch.js';
import type { SessionManager } from './session-manager.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectDir(config: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-watch-'));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, '.reticle.json'), config, 'utf8');
  return dir;
}

/** The few things the watch asks of a SessionManager, and nothing else. */
function stubSessions(): { manager: SessionManager; hint: () => string } {
  let installed: (() => string | undefined) | undefined;
  const manager = {
    count: () => 0,
    everConnected: () => false,
    setNoSessionHint: (hint: (() => string | undefined) | undefined) => {
      installed = hint;
    },
    setNoSessionNextAction: () => undefined,
    setConnectionRecorder: () => undefined,
  } as unknown as SessionManager;
  return { manager, hint: () => installed?.() ?? '' };
}

describe('sibling daemon probe reaches the diagnosis output', () => {
  it('a port returned by siblingProbe appears in noSessionHint', () => {
    const dir = projectDir(undefined);
    const { manager, hint } = stubSessions();
    const stop = startNoSessionWatch({
      sessions: manager,
      port: 4400,
      initialized: false,
      directory: dir,
      probe: () => Promise.resolve([]),
      siblingProbe: () => [4460],
    });
    const message = hint();
    stop();
    expect(message).toContain('4460');
  });
});

describe('the no-session diagnosis and a config written after boot', () => {
  it('reads `.reticle.json` when the question is asked, not when the daemon booted', async () => {
    const dir = projectDir(JSON.stringify({ framework: 'vite', projectId: 'app-1' }));
    const { manager, hint } = stubSessions();
    // `initialized: false` is what the daemon computed at boot, before the file existed.
    const stop = startNoSessionWatch({
      sessions: manager,
      port: 4400,
      initialized: false,
      directory: dir,
      probe: () => Promise.resolve([5173]),
    });
    // Let the port scan settle — the dev server IS up, which is the stale-process shape.
    await Promise.resolve();
    await Promise.resolve();
    const message = hint();
    stop();
    expect(message).not.toMatch(/no `\.reticle\.json`/);
    // The stale-process case is what is left once the config is accounted for, and it has an action.
    expect(message).toMatch(/restart the dev server/i);
  });

  it('still reports a genuinely unwired directory as unwired', () => {
    const dir = projectDir(undefined);
    const { manager, hint } = stubSessions();
    const stop = startNoSessionWatch({
      sessions: manager,
      port: 4400,
      initialized: false,
      directory: dir,
      probe: () => Promise.resolve([5173]),
    });
    const message = hint();
    stop();
    expect(message).toMatch(/no `\.reticle\.json`/);
  });
});
