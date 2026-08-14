import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../project/fs-port.js';
import { AssertionTiersStore } from './assertion-tiers-store.js';
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
