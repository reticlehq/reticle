/**
 * Where daemon state lives, and what happens when it cannot be written.
 *
 * From the only rated feedback Reticle has received — 2/5, a human on Windows, 2026-08-06:
 * "starting `reticle serve` from a sandboxed agent failed because it writes daemon state under
 * [redacted]\.reticle instead of staying project-local".
 *
 * `spawnDaemon` opens with an UNGUARDED `mkdirSync(deps.home)`. When $HOME is read-only — a sandbox,
 * a locked-down Windows profile, a container with no writable home — that throws and takes the whole
 * spawn path down. The very next call, opening the log file, is carefully guarded and returns false;
 * the mkdir above it was not, so the one failure a sandboxed agent actually hits is the one that
 * escapes as a raw EACCES/EPERM with nothing naming the directory or a way out.
 *
 * Two things follow. The location has to be overridable, so a sandbox can point state somewhere
 * writable without anybody rearchitecting where state lives. And an unwritable state directory must
 * be a refusal that SAYS so, not an exception.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { reticleStateHome, spawnDaemon, STATE_DIR_ENV } from './daemon/daemon.js';

const created: string[] = [];
afterEach(() => {
  delete process.env[STATE_DIR_ENV];
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('reticleStateHome', () => {
  it('defaults to ~/.reticle — unchanged for everyone who has a writable home', () => {
    delete process.env[STATE_DIR_ENV];
    expect(reticleStateHome()).toBe(join(homedir(), '.reticle'));
  });

  it('honours the override, so a sandbox can put state somewhere it may write', () => {
    process.env[STATE_DIR_ENV] = '/tmp/reticle-sandbox-state';
    expect(reticleStateHome()).toBe('/tmp/reticle-sandbox-state');
  });

  it('ignores an empty override rather than resolving to nothing', () => {
    process.env[STATE_DIR_ENV] = '';
    expect(reticleStateHome()).toBe(join(homedir(), '.reticle'));
  });
});

describe('spawnDaemon with an unwritable state directory', () => {
  it('returns false instead of throwing', () => {
    // A FILE where the state directory should be: mkdir fails with ENOTDIR, the same shape as the
    // permission failure a sandboxed agent hits, without needing to be root to set one up.
    const base = mkdtempSync(join(tmpdir(), 'reticle-state-'));
    created.push(base);
    const blocker = join(base, 'blocked');
    writeFileSync(blocker, 'not a directory');

    let threw: unknown;
    let result: boolean | undefined;
    try {
      result = spawnDaemon('node', '/nonexistent/cli.js', ['_daemon'], 4400, {
        home: join(blocker, '.reticle'),
        openFile: () => 3,
        closeFile: () => undefined,
        fileSize: () => 0,
        renameFile: () => undefined,
        pidAlive: () => false,
        spawnChild: () => ({ unref: () => undefined }) as never,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw, 'an unwritable state directory must not escape as an exception').toBeUndefined();
    expect(result).toBe(false);
  });
});
