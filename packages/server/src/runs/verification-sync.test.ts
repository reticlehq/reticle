import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayStatus, type FlowReplayResult } from '@reticlehq/core';
import { persistAndSyncVerificationRun, type TimedReplay } from './verification-sync.js';
import { RunStore } from './run-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import type { RunId } from '@reticlehq/core';
import type { ToolDeps } from '../tools/tools.js';

const timed = (name: string, status: ReplayStatus): TimedReplay => ({
  replay: { name, status, steps: [] } satisfies FlowReplayResult,
  durationMs: 50,
});

/** Install a fake global fetch that records calls and returns (or rejects) a response. */
type FetchInit = { method: string; headers: Record<string, string>; body: string };
type FetchArgs = [string, FetchInit];
const stubFetch = (mode: 'ok' | 'fail' | 'throw'): { calls: FetchArgs[] } => {
  const calls: FetchArgs[] = [];
  globalThis.fetch = ((url: string, init: FetchInit) => {
    calls.push([url, init]);
    if (mode === 'throw') return Promise.reject(new Error('network down'));
    return Promise.resolve({ ok: mode === 'ok', status: mode === 'ok' ? 201 : 500 } as Response);
  }) as unknown as typeof fetch;
  return { calls };
};

const URL_ENV = 'RETICLE_CLOUD_URL';
const KEY_ENV = 'RETICLE_CLOUD_KEY';

describe('persistAndSyncVerificationRun — MCP verification → Runs-tab artifact', () => {
  let root: string;
  let fs: FileSystemPort;
  let deps: ToolDeps;
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-vsync-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    // Only fs, reticleRoot, now are touched by the helper.
    deps = { fs, reticleRoot: root, now: () => 1000 } as unknown as ToolDeps;
    delete process.env[URL_ENV];
    delete process.env[KEY_ENV];
  });
  afterEach(async () => {
    globalThis.fetch = origFetch;
    delete process.env[URL_ENV];
    delete process.env[KEY_ENV];
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('writes the run artifact to disk even when not logged in (no phone-home)', async () => {
    const { calls } = stubFetch('ok');

    const runId = await persistAndSyncVerificationRun(
      deps,
      [timed('checkout', ReplayStatus.OK)],
      'shop',
    );

    expect(runId).toBeDefined();
    expect(calls).toHaveLength(0); // no creds → nothing leaves the machine
    const stored = await new RunStore(fs, root).read(runId as RunId);
    expect(stored.ok).toBe(true);
  });

  it('pushes the artifact to POST /v1/runs when cloud creds are set', async () => {
    process.env[URL_ENV] = 'https://cloud.test';
    process.env[KEY_ENV] = 'rk_live_abc';
    const { calls } = stubFetch('ok');

    const runId = await persistAndSyncVerificationRun(
      deps,
      [timed('checkout', ReplayStatus.OK), timed('signup', ReplayStatus.DRIFT)],
      'shop',
    );

    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [url, init] = first;
    expect(url).toBe('https://cloud.test/v1/runs');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as {
      runId: string;
      flows: unknown[];
      verdict: { status: string };
    };
    expect(body.runId).toBe(runId);
    expect(body.flows).toHaveLength(2);
    // a drift flow collapses to a fail; one pass + one fail = a mixed 'partial' verdict (never a false green).
    expect(body.verdict.status).toBe('partial');
  });

  it('never throws on a cloud failure and returns the runId (verdict unaffected)', async () => {
    process.env[URL_ENV] = 'https://cloud.test';
    process.env[KEY_ENV] = 'rk_live_abc';
    stubFetch('throw');

    const runId = await persistAndSyncVerificationRun(
      deps,
      [timed('checkout', ReplayStatus.OK)],
      'shop',
    );
    expect(runId).toBeDefined(); // swallowed; local artifact still written
  });

  it('is a no-op for an empty suite (nothing to verify)', async () => {
    const runId = await persistAndSyncVerificationRun(deps, [], 'shop');
    expect(runId).toBeUndefined();
  });
});
