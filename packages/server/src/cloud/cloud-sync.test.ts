import { describe, expect, it, vi } from 'vitest';
import { AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import {
  CloudEnv,
  resolveCloudConfig,
  SyncOutcome,
  syncFlowToCloud,
  type FetchLike,
} from './cloud-sync.js';

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'add-task',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'task-input' } }],
};

describe('resolveCloudConfig', () => {
  it('returns null (sync disabled) unless BOTH env vars are set', () => {
    expect(resolveCloudConfig({})).toBeNull();
    expect(resolveCloudConfig({ [CloudEnv.URL]: 'https://cloud.test' })).toBeNull();
    expect(resolveCloudConfig({ [CloudEnv.KEY]: 'rk_live_x' })).toBeNull();
  });

  it('resolves + trims a trailing slash when both are set (logged in)', () => {
    const cfg = resolveCloudConfig({
      [CloudEnv.URL]: 'https://cloud.test/',
      [CloudEnv.KEY]: 'rk_live_x',
    });
    expect(cfg).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_x' });
  });
});

describe('syncFlowToCloud', () => {
  it('skips when not logged in (no config) — nothing leaves the machine', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const res = await syncFlowToCloud(flow, null, 'proj-1', fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.SKIPPED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the flow with the API key + projectId when logged in', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ ok: true, status: 201 });
    const res = await syncFlowToCloud(
      flow,
      { url: 'https://cloud.test', apiKey: 'rk_live_x' },
      'proj-1',
      fetchImpl,
    );
    expect(res.outcome).toBe(SyncOutcome.SYNCED);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.test/v1/flows');
    expect(init?.headers.authorization).toBe('Bearer rk_live_x');
    expect(JSON.parse(init?.body ?? '{}')).toEqual({ flow, projectId: 'proj-1' });
  });

  it('reports FAILED (never throws) on a non-ok response or a network error', async () => {
    const bad = vi.fn<FetchLike>().mockResolvedValue({ ok: false, status: 401 });
    expect(
      (await syncFlowToCloud(flow, { url: 'https://c', apiKey: 'k' }, undefined, bad)).outcome,
    ).toBe(SyncOutcome.FAILED);
    const throwing = vi.fn<FetchLike>().mockRejectedValue(new Error('offline'));
    const res = await syncFlowToCloud(flow, { url: 'https://c', apiKey: 'k' }, undefined, throwing);
    expect(res.outcome).toBe(SyncOutcome.FAILED);
    expect(res.error).toBe('offline');
  });
});
