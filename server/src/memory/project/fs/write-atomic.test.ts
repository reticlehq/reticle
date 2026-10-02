/**
 * Two daemons on one repository must not race on the same temporary file.
 *
 * Five stores wrote `${path}.tmp`, a FIXED name, then renamed it into place. Two of the seven
 * atomic writers in this package already pid-suffixed theirs and the other five did not, which is
 * the ordinary shape of this defect: the fix was known, applied twice, and the remaining copies
 * were never found because nothing was looking for them.
 *
 * Two daemons on one repo is not exotic. It is what running parallel agent sessions does, and the
 * repo's own notes record peer sessions sharing a checkout. When both flush the same ledger, they
 * write the same temp path: one truncates the other's half-written file and then renames it over
 * the real one, so the survivor is a file neither of them produced.
 *
 * So the temp name belongs to the WRITER, not to the destination. That is the whole fix, and it is
 * why this is one helper rather than five edits: a sixth store added next month gets it for free,
 * and cannot get it wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';
import { tempNameFor, writeFileAtomic } from './write-atomic.js';

let dir = '';
let fs: FileSystemPort;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reticle-atomic-'));
  fs = createNodeFileSystem();
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('an atomic write', () => {
  it('lands the content at the destination', async () => {
    const path = join(dir, 'ledger.json');
    await writeFileAtomic(fs, path, '{"a":1}\n');
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n');
  });

  it('leaves no temporary file behind', async () => {
    const path = join(dir, 'ledger.json');
    await writeFileAtomic(fs, path, '{"a":1}\n');
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('names the temp file after the WRITER, so two processes cannot collide', () => {
    const a = tempNameFor('/w/ledger.json', 111, 1);
    const b = tempNameFor('/w/ledger.json', 222, 1);
    expect(a).not.toBe(b);
  });

  /**
   * And unique per WRITE, because a pid does not separate two concurrent writes inside ONE process.
   * The first version of this helper was pid-only and the concurrency test below caught it.
   */
  it('gives two writes in the same process different temp names', () => {
    expect(tempNameFor('/w/ledger.json')).not.toBe(tempNameFor('/w/ledger.json'));
  });

  it('keeps the temp file beside its destination, so the rename stays on one filesystem', () => {
    // A rename across devices is not atomic — and `/tmp` is routinely a different device.
    expect(tempNameFor('/w/ledger.json', 111, 1).startsWith('/w/')).toBe(true);
  });

  /**
   * The real property: a concurrent writer must never produce a file neither writer wrote. With a
   * shared temp name this fails — one truncates the other mid-write and renames the remains over
   * the destination.
   */
  it('never leaves a mixture of two concurrent writes', async () => {
    const path = join(dir, 'ledger.json');
    const alpha = `${'a'.repeat(20_000)}\n`;
    const beta = `${'b'.repeat(20_000)}\n`;
    await Promise.all([
      writeFileAtomic(fs, path, alpha),
      writeFileAtomic(fs, path, beta),
      writeFileAtomic(fs, path, alpha),
      writeFileAtomic(fs, path, beta),
    ]);
    const landed = await readFile(path, 'utf8');
    expect([alpha, beta]).toContain(landed);
  });

  it('cleans up after concurrent writers too', async () => {
    const path = join(dir, 'ledger.json');
    await Promise.all([writeFileAtomic(fs, path, 'one\n'), writeFileAtomic(fs, path, 'two\n')]);
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  // Windows CI, 2026-09-26: two writers renaming onto one path, and the second rename failed
  // EPERM because the first was still replacing the file. POSIX never refuses; Windows does,
  // briefly, and the writer has to wait it out rather than fail the save.
  it('waits out a rename Windows refuses while another writer holds the file', async () => {
    const path = join(dir, 'ledger.json');
    let refusals = 2;
    const flaky: FileSystemPort = {
      ...fs,
      rename: async (from, to) => {
        if (refusals > 0) {
          refusals -= 1;
          throw Object.assign(new Error('EPERM: operation not permitted, rename'), {
            code: 'EPERM',
          });
        }
        await fs.rename(from, to);
      },
    };
    await writeFileAtomic(flaky, path, 'kept\n');
    expect(await readFile(path, 'utf8')).toBe('kept\n');
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('leaves no temp file behind when the rename never succeeds', async () => {
    const path = join(dir, 'ledger.json');
    const stuck: FileSystemPort = {
      ...fs,
      rename: () =>
        Promise.reject(
          Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
        ),
    };
    await expect(writeFileAtomic(stuck, path, 'lost\n')).rejects.toThrow('EPERM');
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
