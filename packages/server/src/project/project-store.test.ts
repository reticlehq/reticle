import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_FILE_VERSION,
  PROJECT_RUN_CAP,
  ProjectReadError,
  RunKind,
  RunStatus,
  type RunRecord,
} from '@reticlehq/core';
import { ProjectStore } from './project-store.js';
import { reticleDirPaths } from './reticle-dir.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';

const FROZEN = 1_700_000_000_000;
const frozenClock = { now: (): number => FROZEN };

const RUN: Omit<RunRecord, 'at'> = {
  kind: RunKind.FLOW_REPLAY,
  name: 'checkout',
  status: RunStatus.PASS,
  evidence: { driftSteps: 0 },
};

describe('ProjectStore — temp-dir filesystem, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: ProjectStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-proj-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new ProjectStore(fs, root, frozenClock);
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  // ---- VALID ----

  it('1: recordRun then read round-trips, stamping `at` from the injected clock', async () => {
    await store.recordRun(RUN);
    const r = await store.read();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs).toHaveLength(1);
    expect(r.file.runs[0]).toEqual({ ...RUN, at: FROZEN });
  });

  it('2: project.json is pretty-printed (2-space) + trailing newline', async () => {
    await store.recordRun(RUN);
    const text = await readFile(reticleDirPaths(root).project, 'utf8');
    expect(text).toContain('\n  "version"');
    expect(text.endsWith('}\n')).toBe(true);
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
  });

  it('3: runs stay chronological (append order), never sorted by name', async () => {
    await store.recordRun({ ...RUN, name: 'zeta' });
    await store.recordRun({ ...RUN, name: 'alpha' });
    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs.map((x) => x.name)).toEqual(['zeta', 'alpha']);
  });

  it('4: byte-stability — equal histories serialize identically regardless of build order', async () => {
    const storeB = new ProjectStore(fs, join(root, '..', 'b', '.reticle'), frozenClock);
    await store.recordRun(RUN);
    await store.recordRun({ ...RUN, name: 'other', summary: 's' });
    await storeB.recordRun(RUN);
    await storeB.recordRun({ ...RUN, name: 'other', summary: 's' });
    const a = await readFile(reticleDirPaths(root).project, 'utf8');
    const b = await readFile(reticleDirPaths(join(root, '..', 'b', '.reticle')).project, 'utf8');
    expect(a).toBe(b);
  });

  it('5: lastRun returns the most-recent run for a name', async () => {
    await store.recordRun({ ...RUN, name: 'checkout', status: RunStatus.PASS });
    await store.recordRun({ ...RUN, name: 'login', status: RunStatus.FAIL });
    await store.recordRun({ ...RUN, name: 'checkout', status: RunStatus.DRIFT });
    const last = await store.lastRun('checkout');
    expect(last?.status).toBe(RunStatus.DRIFT);
  });

  // ---- TRUNCATION ----

  // 30s, matching test 7 below, and the reason is worth stating: when this timed out at 5s on the
  // Windows runner it did not merely fail itself — it failed test 7 too, with a baffling
  // "expected 226 to have length 225".
  //
  // `store` is a shared mutable binding and `recordRun` resolves it at CALL time. A timed-out test
  // keeps running its loop, so once beforeEach reassigns `store`, the stray writes land in the NEXT
  // test's store. One surplus iteration, one surplus run, one failure that looks like an off-by-one
  // in production pruning and is nothing of the kind.
  it('6: keeps at most PER_NAME most-recent runs of a single name', async () => {
    for (let i = 0; i < PROJECT_RUN_CAP.PER_NAME + 10; i += 1) {
      await store.recordRun({ ...RUN, name: 'checkout', summary: `r${i}` });
    }
    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs).toHaveLength(PROJECT_RUN_CAP.PER_NAME);
    // The OLDEST were dropped: newest summary survives, oldest does not.
    expect(r.file.runs.at(-1)?.summary).toBe(`r${PROJECT_RUN_CAP.PER_NAME + 9}`);
    expect(r.file.runs.some((x) => 'r0' === x.summary)).toBe(false);
  }, 30_000);

  it('7: keeps every distinct flow last-known-good even past TOTAL (durable local regression memory)', async () => {
    // One run each of many DISTINCT flows: each flow's latest (its only) run is its last-known-good and
    // must never be evicted by the TOTAL cap — that's what lets a fresh session answer "did my last run
    // of flow X pass?" locally, free.
    for (let i = 0; i < PROJECT_RUN_CAP.TOTAL + 25; i += 1) {
      await store.recordRun({ ...RUN, name: `flow-${i}` });
    }
    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs).toHaveLength(PROJECT_RUN_CAP.TOTAL + 25);
    expect(r.file.runs.some((x) => 'flow-0' === x.name)).toBe(true); // the oldest flow's LKG survives
    expect(r.file.runs.at(-1)?.name).toBe(`flow-${PROJECT_RUN_CAP.TOTAL + 24}`);
  }, 30_000);

  it('7b: a rarely-run flow keeps its last-known-good when busy flows fill the cap', async () => {
    await store.recordRun({ ...RUN, name: 'early' });
    // Four busy flows each hitting PER_NAME fills TOTAL with newer runs — under the old cap this evicted
    // `early` entirely; now its last-known-good is reserved first.
    for (const name of ['a', 'b', 'c', 'd']) {
      for (let i = 0; i < PROJECT_RUN_CAP.PER_NAME; i += 1) {
        await store.recordRun({ ...RUN, name });
      }
    }
    expect(await store.lastRun('early')).toBeDefined();
  }, 30_000);

  // ---- EDGE / INVALID ----

  it('8: read on missing file returns MISSING; lastRun returns undefined', async () => {
    const r = await store.read();
    expect(r).toEqual({ ok: false, reason: ProjectReadError.MISSING });
    expect(await store.lastRun('checkout')).toBeUndefined();
  });

  it('9: read on malformed JSON returns MALFORMED (no throw)', async () => {
    await fs.mkdir(root);
    await writeFile(reticleDirPaths(root).project, '{ not json', 'utf8');
    const r = await store.read();
    expect(r).toEqual({ ok: false, reason: ProjectReadError.MALFORMED });
  });

  it('10: recordRun self-heals a MALFORMED file (starts fresh, never wedges)', async () => {
    await fs.mkdir(root);
    await writeFile(reticleDirPaths(root).project, 'totally broken', 'utf8');
    await store.recordRun(RUN);
    const r = await store.read();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs).toHaveLength(1);
    expect(r.file.runs[0]?.name).toBe('checkout');
  });

  it('11: read on valid JSON failing schema returns MALFORMED', async () => {
    await fs.mkdir(root);
    await writeFile(
      reticleDirPaths(root).project,
      '{"version":1,"runs":[{"kind":"flow_replay","name":"x"}]}',
      'utf8',
    );
    const r = await store.read();
    expect(r).toEqual({ ok: false, reason: ProjectReadError.MALFORMED });
  });

  it('12: concurrent recordRun calls all persist — no lost update (parallel flow_verify)', async () => {
    // Before the per-file lock, N concurrent read-append-write calls each read the same base and the
    // last save clobbered the rest, so a parallel suite recorded a fraction of its runs.
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_v, i) => store.recordRun({ ...RUN, name: `flow-${String(i)}` })),
    );
    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs).toHaveLength(N);
    expect(new Set(r.file.runs.map((x) => x.name)).size).toBe(N); // every distinct run survived
  });

  it('13: recordRoutes unions and sorts routes while preserving learned flows and runs', async () => {
    await fs.mkdir(root);
    await writeFile(
      reticleDirPaths(root).project,
      JSON.stringify({
        version: PROJECT_FILE_VERSION,
        learned: { flows: ['checkout'], routes: ['/settings'] },
        runs: [{ ...RUN, at: FROZEN }],
      }),
      'utf8',
    );

    await store.recordRoutes(['/deployments', '/', '/settings']);

    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.learned).toEqual({
      flows: ['checkout'],
      routes: ['/', '/deployments', '/settings'],
    });
    expect(r.file.runs).toEqual([{ ...RUN, at: FROZEN }]);
  });

  it('14: recording no routes keeps learned absent rather than writing routes: []', async () => {
    await store.recordRun(RUN);
    await store.recordRoutes([]);

    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.learned).toBeUndefined();
    expect(await readFile(reticleDirPaths(root).project, 'utf8')).not.toContain('"routes"');
  });

  it('15: concurrent recordRoutes calls union without losing either session', async () => {
    await Promise.all([
      store.recordRoutes(['/compose', '/deployments']),
      store.recordRoutes(['/diagnostics', '/deployments']),
    ]);

    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.learned?.routes).toEqual(['/compose', '/deployments', '/diagnostics']);
  });
});
