/**
 * The byte budget must actually run, and nothing was running it.
 *
 * `pruneEvidenceBudget` was written, tested, and had ZERO non-test callers. The daemon wired only
 * the three COUNT bounds, and the budget's own header says why that is not enough: "twenty session
 * directories is twenty UNBOUNDED directories", with a field report of a `.reticle/sessions` in the
 * multi-gigabyte range while all three counts were being honoured the whole time.
 *
 * That gap is also the CAUSE behind the daemon crash fixed in `fs-port.ts`: a journal only reaches
 * a length `fs.read` cannot take if nothing ever bounded it. That fix stops the daemon dying; this
 * stops the file existing, and they are not substitutes.
 *
 * Tested through a real temp directory rather than a source grep. A grep for the call would pass on
 * a comment that happens to quote it — this repo has had exactly that happen — and the property
 * worth holding is not "the line is present" but "an over-budget tier gets smaller".
 *
 * The budget is INJECTED so the test states its own bound instead of writing 512 MB to disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { ReticleDir } from '@reticlehq/core';
import { pruneWorkspace } from './startup-maintenance.js';

/**
 * A BOUND, not a measurement. `seedSessions` writes three journals through the real filesystem in a
 * loop and staggers mtimes with a 5 ms sleep, which is milliseconds here and much slower on a
 * Windows runner — so vitest's 5 s default would be a statement about the machine, the exact shape
 * CLAUDE.md forbids. A generous ceiling cannot make a broken test pass; the eviction assertions
 * still have to hold.
 */
const MAINTENANCE_TIMEOUT_MS = 30_000;

let root = '';
let fs: FileSystemPort;

/** Three session dirs, oldest first, each carrying a journal of `bytes`. */
async function seedSessions(bytes: number): Promise<void> {
  for (const id of ['s1', 's2', 's3']) {
    const dir = join(root, ReticleDir.SESSIONS_SUBDIR, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'events.jsonl'), 'x'.repeat(bytes), 'utf8');
    await new Promise((r) => setTimeout(r, 5)); // stagger mtimes; oldest-first is the eviction order
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reticle-startup-maint-'));
  fs = createNodeFileSystem();
});

afterEach(async () => {
  await removeTempDir(root);
});

describe('maintenance over one .reticle workspace', () => {
  it(
    'evicts an over-budget evidence tier',
    async () => {
      await seedSessions(1_000);
      await pruneWorkspace(fs, root, new Set(), { budgetBytes: 1_500 });
      const left = await readdir(join(root, ReticleDir.SESSIONS_SUBDIR));
      expect(left.length).toBeLessThan(3);
    },
    MAINTENANCE_TIMEOUT_MS,
  );

  it(
    'evicts oldest-first, so the newest session survives',
    async () => {
      await seedSessions(1_000);
      await pruneWorkspace(fs, root, new Set(), { budgetBytes: 1_500 });
      const left = await readdir(join(root, ReticleDir.SESSIONS_SUBDIR));
      expect(left).toContain('s3');
    },
    MAINTENANCE_TIMEOUT_MS,
  );

  it(
    'never evicts a LIVE session, however far over budget',
    async () => {
      await seedSessions(1_000);
      await pruneWorkspace(fs, root, new Set(['s1']), { budgetBytes: 1 });
      const left = await readdir(join(root, ReticleDir.SESSIONS_SUBDIR));
      expect(left).toContain('s1');
    },
    MAINTENANCE_TIMEOUT_MS,
  );

  it(
    'leaves a tier that fits alone',
    async () => {
      await seedSessions(10);
      await pruneWorkspace(fs, root, new Set(), { budgetBytes: 10_000 });
      const left = await readdir(join(root, ReticleDir.SESSIONS_SUBDIR));
      expect(left).toHaveLength(3);
    },
    MAINTENANCE_TIMEOUT_MS,
  );

  /**
   * Maintenance must never be the reason a daemon fails to come up. Every prune it calls already
   * swallows its own errors; this asserts the composition does too.
   */
  it('does not throw when the workspace does not exist', async () => {
    await expect(
      pruneWorkspace(fs, join(root, 'nope'), new Set(), { budgetBytes: 1 }),
    ).resolves.toBeUndefined();
  });
});

/*
 * The budget walk is the expensive half of maintenance — it stats every entry in every evidence
 * directory — and it ran twice on every single session teardown.
 *
 * `pruneSessions` swept the tier total itself, from the days when it was the one sweep called on
 * both the daemon start path and session end. `pruneWorkspace` then became that one place and calls
 * the budget itself, LAST, with its own header explaining why last is right: "the counts are cheap
 * and bounded; the budget walks and sizes what the counts leave behind, so running it second means
 * it sizes less." The leftover call inside `pruneSessions` ran it FIRST as well, against everything
 * the counts were about to delete anyway.
 *
 * Counted rather than timed. How long two walks take is a statement about the machine; how many
 * times the tier is walked is the actual property.
 */
describe('maintenance does not repeat itself', () => {
  it(
    'walks the evidence tier exactly once',
    async () => {
      await seedSessions(3);
      let walks = 0;
      const counting: FileSystemPort = {
        ...fs,
        readdir: (path: string) => {
          if (path === join(root, ReticleDir.RUNS_SUBDIR)) walks += 1;
          return fs.readdir(path);
        },
      };
      await pruneWorkspace(counting, root, new Set(), { budgetBytes: 1 });
      expect(walks).toBe(1);
    },
    MAINTENANCE_TIMEOUT_MS,
  );
});
