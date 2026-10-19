/**
 * The same flow edited on two machines. The platform kept the last save and the other machine kept a
 * copy that no longer matched, with nobody told. Now each push names the version it was based on; a
 * stale one comes back as a conflict carrying the platform's version, and this machine keeps its edit
 * as a named copy beside the flow, takes the platform's, and says so.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import {
  FLOW_CONFLICT_CODE,
  runSyncCycle,
  type CloudSyncState,
  type SyncSink,
} from './sync-cycle.js';
import { describeSync } from './sync-describe.js';
import { diskSink, diskSource } from './sync-disk.js';
import { hashPayload } from './sync-hash.js';

const mine = { version: 2, name: 'checkout', steps: [{ tool: 'reticle_act', mine: true }] };
const theirs = { version: 2, name: 'checkout', steps: [{ tool: 'reticle_act', theirs: true }] };

type Answer = (body: Record<string, unknown>) => unknown;

async function cycle(
  flows: readonly unknown[],
  answer: Answer,
  state: CloudSyncState,
  sink?: SyncSink,
) {
  const posts: Array<Record<string, unknown>> = [];
  const written: { state?: CloudSyncState } = {};
  const report = await runSyncCycle({
    config: { url: 'https://cloud.test', apiKey: 'rk_test' },
    projectId: 'p',
    source: { runs: () => [], flows: () => flows, capsules: () => [], derived: () => undefined },
    sink: {
      writeIssues: () => undefined,
      ...sink,
      writeState: (s) => {
        written.state = s;
      },
    },
    state,
    now: () => 1_700_000_000_000,
    request: (url, init) => {
      if (url.includes('/v1/sync/status')) return Promise.resolve({ status: 200, text: '{}' });
      if (url.includes('/v1/sync/pull')) return Promise.resolve({ status: 200, text: '{}' });
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      posts.push(body);
      return Promise.resolve({ status: 200, text: JSON.stringify(answer(body)) });
    },
  });
  return { report, posts, state: written.state ?? {} };
}

const accept: Answer = (body) => ({
  flows: {
    accepted: (body['flows'] as unknown[]).length,
    rejected: [],
    versions: Object.fromEntries(
      (body['flows'] as Array<{ name: string }>).map((f) => [f.name, `v-${hashPayload(f)}`]),
    ),
  },
});

describe('a flow push names the version it was based on', () => {
  it('names null for a flow this machine never sent, then the version the platform answered', async () => {
    const first = await cycle([mine], accept, {});
    expect(first.posts[0]?.['flowBases']).toEqual({ checkout: null });
    const edited = { ...mine, steps: [] };
    const second = await cycle([edited], accept, first.state);
    expect(second.posts[0]?.['flowBases']).toEqual({ checkout: `v-${hashPayload(mine)}` });
  });

  it('names no base for a flow an older client sent: unconditional, as it was', async () => {
    const { posts } = await cycle([{ ...mine, steps: [] }], accept, {
      sentFlowHashes: { checkout: hashPayload(mine) },
    });
    expect(posts[0]?.['flowBases']).toEqual({});
  });
});

describe('a conflict', () => {
  const conflict: Answer = () => ({
    flows: {
      accepted: 0,
      rejected: [
        {
          index: 0,
          reason: 'saved elsewhere',
          code: FLOW_CONFLICT_CODE,
          current: { version: 'v-theirs', flow: theirs },
        },
      ],
      versions: {},
    },
  });

  it('keeps this edit as a named copy, takes the platform version, and says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reticle-conflict-'));
    const dir = join(root, ReticleDir.FLOWS_SUBDIR, 'p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkout.json'), JSON.stringify(mine));
    const { report, state } = await cycle(diskSource(root).flows(), conflict, {}, diskSink(root));
    const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    expect(read('checkout.json')).toEqual(theirs);
    expect(read('checkout-conflict-1.json')).toEqual({ ...mine, name: 'checkout-conflict-1' });
    expect(report.flowConflicts).toEqual(['checkout-conflict-1']);
    expect(report.refused).toEqual([]);
    expect(describeSync(report)).toContain('1 flow conflict');
    // The platform's version is now this machine's: not sent back, and the next edit is based on it.
    expect(state.flowVersions?.['checkout']).toBe('v-theirs');
    expect(state.sentFlowHashes?.['checkout']).toBe(hashPayload(theirs));
    const next = await cycle(diskSource(root).flows(), accept, state, diskSink(root));
    expect(next.posts[0]?.['flows']).toEqual([{ ...mine, name: 'checkout-conflict-1' }]);
    expect(next.report.flowConflicts).toEqual(['checkout-conflict-1']);
  });

  it('is reported as refused where nothing can write the copy (a dry run)', async () => {
    const { report } = await cycle([mine], conflict, {});
    expect(report.flowConflicts ?? []).toEqual([]);
    expect(report.refused).toHaveLength(1);
  });
});
