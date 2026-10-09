/**
 * A saved flow wakes cloud sync, the way a persisted run does.
 *
 * Every flow writer reached the disk and stopped there, so a flow saved with no run behind it — the
 * Harness's own recording, `flow_save`, a drive saved at teardown — waited for the sync timer, and a
 * daemon that exited first sent it never. `RunStore` has said "a run landed" through `onWrote` since
 * the dashboard first lagged a verdict; the flow store had no way to say the same.
 */
import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PredicateKind, QueryBy, ReticleTool, type FlowFile } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from './flows.js';

const step = {
  tool: ReticleTool.ACT,
  args: { by: QueryBy.TESTID, value: 'save', action: 'click', args: {} },
  stable: true,
  expect: { kind: PredicateKind.SIGNAL, name: 'saved' },
};

describe('a flow save', () => {
  let dir: string;
  let wrote: number;
  let store: FlowStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-flow-nudge-'));
    wrote = 0;
    store = new FlowStore(
      createNodeFileSystem(),
      join(dir, '.reticle'),
      { now: () => 1 },
      { onWrote: () => (wrote += 1) },
    );
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('says so after a compiled recording is saved', async () => {
    await store.save({ name: 'checkout', version: 1, steps: [step] });
    expect(wrote).toBe(1);
  });

  it('says so after a driven journey is saved', async () => {
    await store.saveJourney(
      { name: 'drive-checkout', version: 1, steps: [step] },
      undefined,
      'drive-',
    );
    expect(wrote).toBe(1);
  });

  it('says so after an in-page flow is saved', async () => {
    const saved = await store.save({ name: 'base', version: 1, steps: [step] });
    expect(saved.ok).toBe(true);
    const loaded = await store.load('base');
    if (!loaded.ok) throw new Error('base did not load');
    const flow: FlowFile = { ...loaded.value, name: 'copy' };
    await store.saveFlow(flow);
    expect(wrote).toBe(2);
  });

  it('says nothing when the name is refused and nothing is written', async () => {
    await store.save({ name: '../escape', version: 1, steps: [step] });
    expect(wrote).toBe(0);
  });
});
