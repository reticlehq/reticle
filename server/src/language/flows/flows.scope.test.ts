import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asProjectId,
  asFlowName,
  AnchorKind,
  FLOW_FILE_VERSION,
  type FlowFile,
} from '@reticlehq/core';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { flowPath, reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { FlowStore } from './flows.js';

const clock = { now: (): number => 1234 };

/** A minimal schema-valid flow: one testid-anchored step. `startTestid` distinguishes copies. */
const flow = (name: string, startTestid = 'a'): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 1234,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: startTestid } }],
});

const APP_A = asProjectId('app-a');
const APP_B = asProjectId('app-b');

describe('FlowStore — per-project storage (shared-daemon isolation)', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: FlowStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-flow-scope-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new FlowStore(fs, root, clock);
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('nests a saved flow under its projectId and stamps the file', async () => {
    await store.saveFlow(flow('login'), APP_A);
    expect(await fs.exists(flowPath(root, asFlowName('login'), APP_A))).toBe(true);
    expect(await fs.exists(flowPath(root, asFlowName('login')))).toBe(false); // NOT at the flat path
    const loaded = await store.load('login', APP_A);
    expect(loaded.ok && loaded.value.projectId).toBe(APP_A);
  });

  it('two apps saving the same flow name do NOT clobber each other', async () => {
    await store.saveFlow(flow('login', 'a-input'), APP_A);
    await store.saveFlow(flow('login', 'b-input'), APP_B);
    const a = await store.load('login', APP_A);
    const b = await store.load('login', APP_B);
    expect(a.ok && a.value.steps[0]?.anchor).toMatchObject({ value: 'a-input' });
    expect(b.ok && b.value.steps[0]?.anchor).toMatchObject({ value: 'b-input' });
  });

  it('one app cannot load another app’s flow by name', async () => {
    await store.saveFlow(flow('secret'), APP_A);
    expect((await store.load('secret', APP_B)).ok).toBe(false); // scoped miss
    expect((await store.load('secret', APP_A)).ok).toBe(true);
  });

  it('falls back to a legacy flat (untagged) flow of the same name', async () => {
    // A pre-existing flow written before per-project storage: flat, no projectId.
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(flowPath(root, asFlowName('legacy')), `${JSON.stringify(flow('legacy'))}\n`);
    const loaded = await store.load('legacy', APP_A); // scoped read, no nested copy
    expect(loaded.ok).toBe(true);
  });

  it('scoped list = this project + legacy flat, never another project', async () => {
    await store.saveFlow(flow('a-only'), APP_A);
    await store.saveFlow(flow('b-only'), APP_B);
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(
      flowPath(root, asFlowName('shared-legacy')),
      `${JSON.stringify(flow('shared-legacy'))}\n`,
    );
    expect(await store.list(APP_A)).toEqual(['a-only', 'shared-legacy']);
    expect(await store.list(APP_B)).toEqual(['b-only', 'shared-legacy']);
  });

  it('unscoped list (CLI/CI) returns every flow across all projects + flat', async () => {
    await store.saveFlow(flow('a-only'), APP_A);
    await store.saveFlow(flow('b-only'), APP_B);
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(
      flowPath(root, asFlowName('flat-one')),
      `${JSON.stringify(flow('flat-one'))}\n`,
    );
    expect(await store.list()).toEqual(['a-only', 'b-only', 'flat-one']);
  });

  it('unscoped load (CLI/CI, e.g. reticle_domain) resolves a per-project flow — not just lists it', async () => {
    // The bug: list unioned the subdirs but load's resolveReadPath did not, so an unscoped
    // caller listed a nested flow then silently dropped it on `if (loaded.ok)` (flowCount:0).
    await store.saveFlow(flow('nested-only'), APP_A);
    expect(await store.list()).toContain('nested-only'); // listed
    const loaded = await store.load('nested-only'); // and now loadable with no projectId
    expect(loaded.ok).toBe(true);
    expect(loaded.ok && loaded.value.projectId).toBe(APP_A);
  });

  it('remove deletes a per-project flow (and a second remove is NOT_FOUND, not a silent pass)', async () => {
    await store.saveFlow(flow('stale'), APP_A);
    expect(await fs.exists(flowPath(root, asFlowName('stale'), APP_A))).toBe(true);
    expect((await store.remove('stale', APP_A)).ok).toBe(true);
    expect(await fs.exists(flowPath(root, asFlowName('stale'), APP_A))).toBe(false);
    expect(await store.list(APP_A)).not.toContain('stale');
    expect((await store.remove('stale', APP_A)).ok).toBe(false); // gone → NOT_FOUND
  });

  it('remove resolves a nested flow with no projectId (mirrors load)', async () => {
    await store.saveFlow(flow('nested'), APP_A);
    expect((await store.remove('nested')).ok).toBe(true);
    expect(await fs.exists(flowPath(root, asFlowName('nested'), APP_A))).toBe(false);
  });

  it('heal rewrites the nested file in place, never forking a flat copy', async () => {
    await store.saveFlow(flow('h', 'old-testid'), APP_A);
    const healed = await store.heal(
      'h',
      [{ step: 0, from: 'old-testid', to: 'new-testid' }],
      APP_A,
    );
    expect(healed.ok).toBe(true);
    expect(await fs.exists(flowPath(root, asFlowName('h')))).toBe(false); // no stray flat copy
    const loaded = await store.load('h', APP_A);
    expect(loaded.ok && loaded.value.steps[0]?.anchor).toMatchObject({ value: 'new-testid' });
  });
});
