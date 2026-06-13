import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_RUN_CAP,
  ProjectReadError,
  RunKind,
  RunStatus,
  type RunRecord,
} from '@syrin/iris-protocol';
import { ProjectStore } from './project-store.js';
import { irisDirPaths } from './iris-dir.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';

const FROZEN = 1_700_000_000_000;
const frozenClock = { now: (): number => FROZEN };

const RUN: Omit<RunRecord, 'at'> = {
  kind: RunKind.FLOW_REPLAY,
  name: 'checkout',
  status: RunStatus.PASS,
  evidence: { driftSteps: 0 },
};

describe('ProjectStore (0.3.7 RUNHISTORY) — temp-dir filesystem, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: ProjectStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iris-proj-'));
    root = join(dir, '.iris');
    fs = createNodeFileSystem();
    store = new ProjectStore(fs, root, frozenClock);
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
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
    const text = await readFile(irisDirPaths(root).project, 'utf8');
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
    const storeB = new ProjectStore(fs, join(root, '..', 'b', '.iris'), frozenClock);
    await store.recordRun(RUN);
    await store.recordRun({ ...RUN, name: 'other', summary: 's' });
    await storeB.recordRun(RUN);
    await storeB.recordRun({ ...RUN, name: 'other', summary: 's' });
    const a = await readFile(irisDirPaths(root).project, 'utf8');
    const b = await readFile(irisDirPaths(join(root, '..', 'b', '.iris')).project, 'utf8');
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

  it('6: keeps at most PER_NAME most-recent runs of a single name', async () => {
    for (let i = 0; i < PROJECT_RUN_CAP.PER_NAME + 10; i += 1) {
      await store.recordRun({ ...RUN, name: 'checkout', summary: `r${i}` });
    }
    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs).toHaveLength(PROJECT_RUN_CAP.PER_NAME);
    // The OLDEST were dropped: newest summary survives, oldest does not.
    expect(r.file.runs.at(-1)?.summary).toBe(`r${PROJECT_RUN_CAP.PER_NAME + 9}`);
    expect(r.file.runs.some((x) => x.summary === 'r0')).toBe(false);
  });

  it('7: caps the whole list to TOTAL most-recent overall across names', async () => {
    // Use unique names so PER_NAME never trims first; only the TOTAL cap applies.
    for (let i = 0; i < PROJECT_RUN_CAP.TOTAL + 25; i += 1) {
      await store.recordRun({ ...RUN, name: `flow-${i}` });
    }
    const r = await store.read();
    if (!r.ok) throw new Error('expected ok');
    expect(r.file.runs).toHaveLength(PROJECT_RUN_CAP.TOTAL);
    expect(r.file.runs.at(-1)?.name).toBe(`flow-${PROJECT_RUN_CAP.TOTAL + 24}`);
  });

  // ---- EDGE / INVALID ----

  it('8: read on missing file returns MISSING; lastRun returns undefined', async () => {
    const r = await store.read();
    expect(r).toEqual({ ok: false, reason: ProjectReadError.MISSING });
    expect(await store.lastRun('checkout')).toBeUndefined();
  });

  it('9: read on malformed JSON returns MALFORMED (no throw)', async () => {
    await fs.mkdir(root);
    await writeFile(irisDirPaths(root).project, '{ not json', 'utf8');
    const r = await store.read();
    expect(r).toEqual({ ok: false, reason: ProjectReadError.MALFORMED });
  });

  it('10: recordRun self-heals a MALFORMED file (starts fresh, never wedges)', async () => {
    await fs.mkdir(root);
    await writeFile(irisDirPaths(root).project, 'totally broken', 'utf8');
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
      irisDirPaths(root).project,
      '{"version":1,"runs":[{"kind":"flow_replay","name":"x"}]}',
      'utf8',
    );
    const r = await store.read();
    expect(r).toEqual({ ok: false, reason: ProjectReadError.MALFORMED });
  });
});
