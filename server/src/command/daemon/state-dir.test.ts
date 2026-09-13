/**
 * A daemon that cannot write its own state directory must SAY so.
 *
 * Found by stress-testing 2.6.0: `chmod 555 ~/.reticle` and `reticle serve` fails correctly (exit
 * 1, no false claim of a spawn — that part works) but reports:
 *
 *   the daemon did not come up on :4415 — nothing is listening on :4415 — no daemon is running
 *   see /…/.reticle/daemon-4415.log
 *
 * Both halves are unhelpful. "Nothing is listening" is the SYMPTOM restated; the cause is that the
 * daemon could not write the directory it needs. And the log it points at lives INSIDE that
 * unwritable directory, so it cannot exist — the one diagnostic offered is a dead end by
 * construction.
 *
 * This is a first-run failure mode with no diagnosis at all: a locked-down home directory, a
 * container with a read-only mount, a corporate-managed profile.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDirProblem } from './state-dir.js';

/**
 * `chmod 555` does not make a directory unwritable on Windows — Node's chmod there only toggles the
 * read-only attribute, which does not stop files being created inside. The two cases below cannot be
 * SET UP on Windows, so they are skipped there.
 *
 * This skips the test, not the behaviour: `stateDirProblem` probes by writing precisely because the
 * permission bits lie, and a real Windows denial (an ACL, a read-only mount) fails that write and is
 * reported the same as anywhere else. What is missing on Windows is a way to manufacture the denial
 * in a unit test, not the coverage of what happens when it occurs.
 */
const unwritableDirs = it.skipIf('win32' === process.platform);

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reticle-statedir-'));
});
afterEach(() => {
  try {
    chmodSync(join(home, '.reticle'), 0o755);
  } catch {
    /* already writable, or never created */
  }
  rmSync(home, { recursive: true, force: true });
});

describe('stateDirProblem', () => {
  it('says nothing when the directory is writable — the common case stays silent', () => {
    const dir = join(home, '.reticle');
    mkdirSync(dir, { recursive: true });
    expect(stateDirProblem(dir)).toBeUndefined();
  });

  it('says nothing when the directory does not exist yet — it will be created', () => {
    expect(stateDirProblem(join(home, '.reticle'))).toBeUndefined();
  });

  unwritableDirs('names the directory and the cause when it cannot be written', () => {
    const dir = join(home, '.reticle');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);

    const problem = stateDirProblem(dir);
    expect(problem, 'this is the whole point — it was silent before').toBeDefined();
    expect(problem).toContain(dir);
    expect(problem, 'name the cause, not the symptom').toMatch(/writ/i);
  });

  unwritableDirs(
    'does not tell the reader to open a log inside a directory that cannot hold one',
    () => {
      const dir = join(home, '.reticle');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o555);
      expect(stateDirProblem(dir)).not.toContain('.log');
    },
  );

  it('leaves no probe file behind when the directory IS writable', () => {
    const dir = join(home, '.reticle');
    mkdirSync(dir, { recursive: true });
    stateDirProblem(dir);
    // A diagnostic that litters the directory it is checking is its own bug.
    expect(readdirSync(dir)).toEqual([]);
  });
});
