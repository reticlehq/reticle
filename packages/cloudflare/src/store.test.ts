import { AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import { describe, expect, it, vi } from 'vitest';
import {
  flowKey,
  getFlow,
  projectRegression,
  retainNewest,
  type RegressionReport,
} from './store.js';

function jsonObject(value: unknown): R2ObjectBody {
  return { json: () => Promise.resolve(value) } as unknown as R2ObjectBody;
}

describe('Cloudflare object storage', () => {
  it('isolates equal flow names by project while preserving the legacy default key', () => {
    expect(flowKey('checkout')).toBe('flows/checkout.json');
    expect(flowKey('checkout', 'shop-a')).toBe('flows/shop-a/checkout.json');
    expect(flowKey('checkout', 'shop-b')).toBe('flows/shop-b/checkout.json');
  });

  it('falls back to an existing legacy flow during project-key migration', async () => {
    const flow: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: 'checkout',
      createdAt: 1,
      steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'buy' } }],
    };
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(jsonObject(flow));
    const bucket = { get } as unknown as R2Bucket;

    await expect(getFlow(bucket, 'checkout', 'default')).resolves.toEqual(flow);
    expect(get).toHaveBeenNthCalledWith(1, 'flows/default/checkout.json');
    expect(get).toHaveBeenNthCalledWith(2, 'flows/checkout.json');
  });

  it('does not fall through to a different project legacy flow', async () => {
    const get = vi.fn(() => Promise.resolve(null));
    const bucket = { get } as unknown as R2Bucket;

    await expect(getFlow(bucket, 'checkout', 'shop', 'default')).resolves.toBeNull();
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('flows/shop/checkout.json');
  });

  it('reads every cursor page for a project regression report', async () => {
    const rows = new Map<string, RegressionReport['latest'][number]>([
      [
        'project-runs/shop/1-a.json',
        { flowName: 'checkout', status: 'pass', kind: 'verify', at: 1, projectId: 'shop' },
      ],
      [
        'project-runs/shop/2-b.json',
        { flowName: 'settings', status: 'fail', kind: 'verify', at: 2, projectId: 'shop' },
      ],
    ]);
    let page = 0;
    const list = vi.fn(() => {
      page += 1;
      return Promise.resolve(
        1 === page
          ? {
              objects: [{ key: 'project-runs/shop/1-a.json' }],
              truncated: true,
              cursor: 'next',
            }
          : { objects: [{ key: 'project-runs/shop/2-b.json' }], truncated: false },
      );
    });
    const bucket = {
      list,
      get: vi.fn((key: string) => Promise.resolve(jsonObject(rows.get(key)))),
    } as unknown as R2Bucket;

    const report = await projectRegression(bucket, 'shop');

    expect(list).toHaveBeenCalledTimes(2);
    expect(report.runs).toBe(2);
    expect(report.latest.map((row) => row.flowName).sort()).toEqual(['checkout', 'settings']);
  });

  it('deletes only the oldest objects above the retention bound', async () => {
    const remove = vi.fn(() => Promise.resolve());
    const bucket = {
      list: vi.fn(() =>
        Promise.resolve({
          objects: [
            { key: 'runs/old.json', uploaded: new Date(1) },
            { key: 'runs/new.json', uploaded: new Date(3) },
            { key: 'runs/middle.json', uploaded: new Date(2) },
          ],
          truncated: false,
        }),
      ),
      delete: remove,
    } as unknown as R2Bucket;

    await retainNewest(bucket, 'runs/', 2);

    expect(remove).toHaveBeenCalledWith(['runs/old.json']);
  });
});
