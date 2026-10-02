/**
 * The same failure, captured a hundred times, is one capsule with a count on it.
 *
 * A capsule is written on every failed assert, and an agent retrying the same broken step writes an
 * identical one each time. Measured in this repo's own workspace: of 113 capsules, 67 were distinct
 * and one group of 37 were byte-identical — the same failed `login-submit` click, captured 37 times.
 *
 * That directory is committed to the user's repository by design, so the duplicates are not merely
 * disk. They are 37 files in a diff, and none of them says the thing that is actually interesting
 * about a repeated failure, which is that it repeated.
 *
 * So: the CONTENT decides identity. The fingerprint covers what makes two captures the same
 * failure — the flow, why it was captured, the consequence expected, what was observed, and the
 * steps to reproduce — and excludes `createdAt`, which is what made every retry a new file.
 *
 * `seen` and `lastSeenAt` carry what the dropped copies said. "This failed 37 times, most recently
 * at T" is strictly more than 37 files holding one timestamp each, so deduplicating here ADDS
 * information rather than discarding it.
 *
 * The fingerprint rides in the filename so the check is a directory listing and not 113 file reads
 * — and the timestamp stays in front of it, because ids are sorted to give `list()` newest-first
 * for free and that property is load-bearing elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  CAPSULE_VERSION,
  CapsuleStore,
  capsuleFingerprint,
  capsuleId,
  type Capsule,
} from './capsule-store.js';

let root = '';
let fs: FileSystemPort;
let store: CapsuleStore;

function capsule(at: number, observed: string): Capsule {
  const body = {
    version: CAPSULE_VERSION as typeof CAPSULE_VERSION,
    flow: 'checkout',
    createdAt: at,
    origin: 'failed-assert',
    expected: 'state view',
    observed,
    steps: [],
  };
  return { ...body, id: capsuleId(at, 'login-submit', capsuleFingerprint(body)) };
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reticle-caps-'));
  root = join(dir, '.reticle');
  fs = createNodeFileSystem();
  store = new CapsuleStore(fs, root);
});
afterEach(async () => {
  await removeTempDir(join(root, '..'));
});

describe('capturing the same failure twice', () => {
  it('writes ONE file, not two', async () => {
    await store.save(capsule(1000, 'never changed'));
    await store.save(capsule(2000, 'never changed'));
    expect((await store.list()).length).toBe(1);
  });

  it('counts the repeat instead of losing it', async () => {
    await store.save(capsule(1000, 'never changed'));
    await store.save(capsule(2000, 'never changed'));
    await store.save(capsule(3000, 'never changed'));
    const [only] = await store.all();
    expect(only?.seen).toBe(3);
  });

  it('remembers when it last happened', async () => {
    await store.save(capsule(1000, 'never changed'));
    await store.save(capsule(9000, 'never changed'));
    const [only] = await store.all();
    expect(only?.lastSeenAt).toBe(9000);
  });

  it('keeps the FIRST sighting as createdAt — the repeat is not a new failure', async () => {
    await store.save(capsule(1000, 'never changed'));
    await store.save(capsule(9000, 'never changed'));
    const [only] = await store.all();
    expect(only?.createdAt).toBe(1000);
  });

  /** The control that matters: a genuinely different failure is still its own capsule. */
  it('keeps a different observation as a separate capsule', async () => {
    await store.save(capsule(1000, 'never changed'));
    await store.save(capsule(2000, 'changed to the wrong value'));
    expect((await store.list()).length).toBe(2);
  });

  it('gives a single capture a seen count of one', async () => {
    await store.save(capsule(1000, 'never changed'));
    const [only] = await store.all();
    expect(only?.seen).toBe(1);
  });
});

describe('the fingerprint', () => {
  it('ignores when it happened, which is what made every retry a new file', () => {
    // Two captures of one failure, an hour apart. `createdAt` is not an input at all — the type
    // excludes it — so this asserts the property the type is there to enforce.
    expect(capsuleFingerprint(capsule(1000, 'x'))).toBe(capsuleFingerprint(capsule(9999, 'x')));
  });

  it('separates two different flows that fail the same way', () => {
    const a = capsuleFingerprint({ ...capsule(1, 'x'), flow: 'checkout' });
    const b = capsuleFingerprint({ ...capsule(1, 'x'), flow: 'signup' });
    expect(a).not.toBe(b);
  });

  it('rides in the id, so dedup is a listing rather than a hundred reads', () => {
    const c = capsule(1000, 'never changed');
    expect(c.id.endsWith(capsuleFingerprint(c))).toBe(true);
  });

  it('keeps the timestamp in front, so ids still sort newest-first', () => {
    expect(capsule(2000, 'x').id > capsule(1000, 'x').id).toBe(true);
  });
});
