import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { flowPath, reticleDirPaths } from '../project/reticle-dir.js';
import { FlowStore } from './flows.js';

const clock = { now: (): number => 1234 };

/** A minimal schema-valid flow: one testid-anchored step. `startTestid` distinguishes copies. */
const flow = (name: string, startTestid = 'a'): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 1234,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: startTestid } }],
});

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
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('nests a saved flow under its projectId and stamps the file', async () => {
    await store.saveFlow(flow('login'), 'app-a');
    expect(await fs.exists(flowPath(root, 'login', 'app-a'))).toBe(true);
    expect(await fs.exists(flowPath(root, 'login'))).toBe(false); // NOT at the flat path
    const loaded = await store.load('login', 'app-a');
    expect(loaded.ok && loaded.value.projectId).toBe('app-a');
  });

  it('two apps saving the same flow name do NOT clobber each other', async () => {
    await store.saveFlow(flow('login', 'a-input'), 'app-a');
    await store.saveFlow(flow('login', 'b-input'), 'app-b');
    const a = await store.load('login', 'app-a');
    const b = await store.load('login', 'app-b');
    expect(a.ok && a.value.steps[0]?.anchor).toMatchObject({ value: 'a-input' });
    expect(b.ok && b.value.steps[0]?.anchor).toMatchObject({ value: 'b-input' });
  });

  it('one app cannot load another app’s flow by name', async () => {
    await store.saveFlow(flow('secret'), 'app-a');
    expect((await store.load('secret', 'app-b')).ok).toBe(false); // scoped miss
    expect((await store.load('secret', 'app-a')).ok).toBe(true);
  });

  it('falls back to a legacy flat (untagged) flow of the same name', async () => {
    // A pre-existing flow written before per-project storage: flat, no projectId.
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(flowPath(root, 'legacy'), `${JSON.stringify(flow('legacy'))}\n`);
    const loaded = await store.load('legacy', 'app-a'); // scoped read, no nested copy
    expect(loaded.ok).toBe(true);
  });

  it('scoped list = this project + legacy flat, never another project', async () => {
    await store.saveFlow(flow('a-only'), 'app-a');
    await store.saveFlow(flow('b-only'), 'app-b');
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(flowPath(root, 'shared-legacy'), `${JSON.stringify(flow('shared-legacy'))}\n`);
    expect(await store.list('app-a')).toEqual(['a-only', 'shared-legacy']);
    expect(await store.list('app-b')).toEqual(['b-only', 'shared-legacy']);
  });

  it('unscoped list (CLI/CI) returns every flow across all projects + flat', async () => {
    await store.saveFlow(flow('a-only'), 'app-a');
    await store.saveFlow(flow('b-only'), 'app-b');
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(flowPath(root, 'flat-one'), `${JSON.stringify(flow('flat-one'))}\n`);
    expect(await store.list()).toEqual(['a-only', 'b-only', 'flat-one']);
  });

  it('heal rewrites the nested file in place, never forking a flat copy', async () => {
    await store.saveFlow(flow('h', 'old-testid'), 'app-a');
    const healed = await store.heal(
      'h',
      [{ step: 0, from: 'old-testid', to: 'new-testid' }],
      'app-a',
    );
    expect(healed.ok).toBe(true);
    expect(await fs.exists(flowPath(root, 'h'))).toBe(false); // no stray flat copy
    const loaded = await store.load('h', 'app-a');
    expect(loaded.ok && loaded.value.steps[0]?.anchor).toMatchObject({ value: 'new-testid' });
  });
});
