import { removeTempDir } from '../../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../project/fs-port.js';
import { ASSERTION_TIERS_VERSION, AssertionTiersStore } from './assertion-tiers-store.js';
import { detectDowngrades } from './assertion-integrity.js';

describe('AssertionTiersStore (anti-downgrade baseline)', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-tiers-'));
    root = join(dir, '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('records a passing flow’s assertion shape and reads it back', async () => {
    const store = new AssertionTiersStore(fs, root);
    await store.recordPassing('checkout', [{ step: 0, expect: { signal: 'order:placed' } }]);
    expect(await store.load()).toEqual({
      checkout: { steps: [{ step: 0, expect: { signal: 'order:placed' } }], sources: [] },
    });
  });

  it('feeds detectDowngrades: consequence → presence-only is caught across a save/load round-trip', async () => {
    const store = new AssertionTiersStore(fs, root);
    // Last PASSING run asserted a real consequence…
    await store.recordPassing('checkout', [{ step: 0, expect: { signal: 'order:placed' } }]);
    const before = (await store.load())['checkout']?.steps ?? [];
    // …and the flow has since been weakened to a fakeable presence check.
    const after = [{ step: 0, expect: { element: { testid: 'thanks' } } }];
    expect(detectDowngrades(before, after)).toEqual([{ step: 0 }]);
  });

  it('reports no downgrade when the assertion is unchanged or strengthened', async () => {
    const store = new AssertionTiersStore(fs, root);
    await store.recordPassing('checkout', [{ step: 0, expect: { element: { testid: 'thanks' } } }]);
    const before = (await store.load())['checkout']?.steps ?? [];
    expect(detectDowngrades(before, before)).toEqual([]);
    expect(detectDowngrades(before, [{ step: 0, expect: { signal: 'order:placed' } }])).toEqual([]);
  });

  it('a missing ledger means NO baseline — no downgrade can be claimed (fails open)', async () => {
    expect(await new AssertionTiersStore(fs, root).load()).toEqual({});
  });

  it('a corrupt ledger degrades to no baseline instead of throwing', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'assertion-tiers.json'), '{not json', 'utf8');
    expect(await new AssertionTiersStore(fs, root).load()).toEqual({});
  });
});

describe('the stored format version is a tripwire, not a free knob', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-tiers-version-'));
    root = join(dir, '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  /**
   * Why this test exists.
   *
   * This file is how the gate notices that a flow's assertions got WEAKER. When the file cannot be
   * read, the store returns an empty baseline on purpose: accusing somebody of gaming the gate
   * because a file was corrupt would be worse than missing one downgrade. That is a good rule for
   * one broken file on one machine, and it stays.
   *
   * It is a bad rule for a version change. Bumping `version` makes every existing baseline
   * everywhere fail to parse at the same moment, so the anti-gaming check quietly stops checking
   * anything and nothing goes red to say so. That is not one missed downgrade, it is all of them.
   *
   * So the number is pinned here. If you are changing it on purpose you also need a way to handle
   * the old file — convert it on load, or tell the user their baseline was reset. Do that first,
   * then change this test in the same commit.
   */
  it('is still version 1 — change it only together with a way to read older files', () => {
    expect(ASSERTION_TIERS_VERSION).toBe(1);
  });

  it('a file written by a future version reads as "no baseline", which is why the pin matters', async () => {
    const store = new AssertionTiersStore(fs, root);
    await store.recordPassing('checkout', [{ step: 0, expect: { signal: 'order:placed' } }]);
    expect(Object.keys(await store.load())).toEqual(['checkout']);

    // Simulate what a version bump does to every baseline already on disk.
    const path = join(root, 'assertion-tiers.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { version: number };
    await writeFile(path, JSON.stringify({ ...raw, version: raw.version + 1 }));

    // Silently empty. No error, no warning — the downgrade check now has nothing to compare against.
    expect(await store.load()).toEqual({});
  });
});
