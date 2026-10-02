import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFillValues } from './fill-value-store.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';

/**
 * A generated field value is a FIXTURE, not a model's opinion to be re-asked every run: the same
 * label on the same app wants the same value tomorrow, and a replay must send exactly what the
 * recording sent or it is not a replay. So it is written to the project, in git, next to the flows
 * that use it -- which also means a human who dislikes one can edit a file instead of arguing with
 * a model.
 */

const root = (): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'fills-')), '.reticle');
  mkdirSync(dir, { recursive: true });
  return dir;
};
const fs = createNodeFileSystem();

describe('the values a project has already paid for', () => {
  it('answers nothing for a project that has never generated one', async () => {
    const store = await openFillValues(fs, root());
    expect(store.get('Business name')).toBeUndefined();
  });

  it('keeps what a drive learned, for the next drive', async () => {
    const dir = root();
    const first = await openFillValues(fs, dir);
    first.set('Business name', 'Northwind Trading Co.');
    await first.flush();

    const second = await openFillValues(fs, dir);
    expect(second.get('Business name')).toBe('Northwind Trading Co.');
  });

  /** A drive that filled nothing new must not rewrite the file it read. */
  it('writes nothing when a drive learned nothing', async () => {
    const dir = root();
    const store = await openFillValues(fs, dir);
    store.get('Business name');
    await store.flush();
    expect(() => readFileSync(join(dir, 'fill-values.json'), 'utf8')).toThrow();
  });

  it('is editable by hand, and the hand wins', async () => {
    const dir = root();
    writeFileSync(
      join(dir, 'fill-values.json'),
      JSON.stringify({ version: 1, values: { 'Business name': 'The Real One' } }),
    );
    const store = await openFillValues(fs, dir);
    expect(store.get('Business name')).toBe('The Real One');
  });

  /** A fixtures file is a convenience. A broken one costs a regeneration, never a drive. */
  it('reads a corrupt file as an empty one', async () => {
    const dir = root();
    writeFileSync(join(dir, 'fill-values.json'), '{ not json');
    const store = await openFillValues(fs, dir);
    expect(store.get('anything')).toBeUndefined();
    store.set('Business name', 'Northwind');
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it('ignores entries that are not strings', async () => {
    const dir = root();
    writeFileSync(
      join(dir, 'fill-values.json'),
      JSON.stringify({ version: 1, values: { good: 'yes', bad: 42, empty: '' } }),
    );
    const store = await openFillValues(fs, dir);
    expect(store.get('good')).toBe('yes');
    expect(store.get('bad')).toBeUndefined();
    expect(store.get('empty')).toBeUndefined();
  });

  it('stamps a version, so a later format change can tell old from broken', async () => {
    const dir = root();
    const store = await openFillValues(fs, dir);
    store.set('a', 'b');
    await store.flush();
    const written: unknown = JSON.parse(readFileSync(join(dir, 'fill-values.json'), 'utf8'));
    expect((written as { version: number }).version).toBe(1);
  });
});
