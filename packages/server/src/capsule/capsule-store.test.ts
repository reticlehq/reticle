import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType, AnchorKind, type FlowStep } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import {
  CapsuleStore,
  capsuleId,
  isValidCapsuleId,
  minimalSteps,
  type Capsule,
} from './capsule-store.js';

const step = (value: string): FlowStep => ({
  tool: ReticleTool.ACT,
  anchor: { kind: AnchorKind.TESTID, value },
  action: ActionType.CLICK,
});

const capsule = (id: string): Capsule => ({
  version: 1,
  id,
  createdAt: 1,
  origin: 'failed-assert',
  expected: 'signal order:placed',
  observed: 'no signal matched',
  steps: [step('buy')],
});

describe('CapsuleStore (fail-to-pass bug capsules)', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-capsule-'));
    root = join(dir, '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('saves a capsule and reads it back', async () => {
    const store = new CapsuleStore(fs, root);
    expect(await store.save(capsule('100-buy'))).toBe(true);
    expect((await store.read('100-buy'))?.expected).toBe('signal order:placed');
  });

  it('lists newest-first (ids are time-ordered)', async () => {
    const store = new CapsuleStore(fs, root);
    await store.save(capsule('100-a'));
    await store.save(capsule('300-c'));
    await store.save(capsule('200-b'));
    expect(await store.list()).toEqual(['300-c', '200-b', '100-a']);
  });

  it('an empty/absent capsules dir lists as empty (never throws)', async () => {
    expect(await new CapsuleStore(fs, root).list()).toEqual([]);
  });

  it('a malformed capsule reads as undefined and is skipped by all()', async () => {
    const store = new CapsuleStore(fs, root);
    await store.save(capsule('100-ok'));
    await mkdir(join(root, 'capsules'), { recursive: true });
    await writeFile(join(root, 'capsules', '200-bad.json'), '{not json', 'utf8');
    expect(await store.read('200-bad')).toBeUndefined();
    expect((await store.all()).map((c) => c.id)).toEqual(['100-ok']);
  });

  it('refuses a path-traversal id rather than writing outside the capsules dir', async () => {
    expect(isValidCapsuleId('../../etc/passwd')).toBe(false);
    expect(await new CapsuleStore(fs, root).save(capsule('../escape'))).toBe(false);
    expect(await new CapsuleStore(fs, root).read('../escape')).toBeUndefined();
  });
});

describe('capsuleId / minimalSteps', () => {
  it('produces a path-safe, time-ordered id', () => {
    const id = capsuleId(1730000000000, 'checkout flow/step 2');
    expect(isValidCapsuleId(id)).toBe(true);
    expect(id.startsWith('1730000000000-')).toBe(true);
  });

  it('trims the reproduction to the failing step (everything after it is noise)', () => {
    const steps = [step('a'), step('b'), step('c')];
    expect(minimalSteps(steps, 1).map((s) => s.anchor)).toEqual([
      steps[0]?.anchor,
      steps[1]?.anchor,
    ]);
  });

  it('keeps every step when the failing index is unknown', () => {
    const steps = [step('a'), step('b')];
    expect(minimalSteps(steps, -1)).toHaveLength(2);
  });
});
