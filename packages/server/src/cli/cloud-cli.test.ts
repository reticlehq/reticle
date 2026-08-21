import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushSavedFlows, runCloudCommand } from './cloud-cli.js';
import { AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import type { FlowStore } from '../flows/flows.js';
import type { FetchLike } from '../cloud/cloud-sync.js';

describe('cloud-cli api() JSON parse guard', () => {
  const origFetch = globalThis.fetch;
  const origStderr = process.stderr.write.bind(process.stderr);
  let stderrBuf: string;

  beforeEach(() => {
    stderrBuf = '';
    process.stderr.write = (chunk: unknown) => {
      stderrBuf += String(chunk);
      return true;
    };
    process.env['RETICLE_CLOUD_KEY'] = 'test-key';
    process.env['RETICLE_CLOUD_URL'] = 'http://localhost:9999';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    process.stderr.write = origStderr;
    delete process.env['RETICLE_CLOUD_KEY'];
    delete process.env['RETICLE_CLOUD_URL'];
  });

  it('surfaces an actionable error when the response is not JSON (proxy HTML)', async () => {
    const html = '<html><body>Login Required</body></html>';
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(html),
      })) as unknown as typeof fetch;

    const code = await runCloudCommand(['project', 'ls']);
    expect(code).toBe(1);
    expect(stderrBuf).toContain('expected JSON');
    expect(stderrBuf).toContain('GET');
    expect(stderrBuf).toContain('Login Required');
  });
});

describe('reticle push existing flows', () => {
  it('uploads every saved flow so linking an established project is complete immediately', async () => {
    const flows: FlowFile[] = ['checkout', 'settings'].map((name) => ({
      version: FLOW_FILE_VERSION,
      name,
      createdAt: 1,
      steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'save' } }],
    }));
    const store = {
      list: () => Promise.resolve(flows.map((flow) => flow.name)),
      load: (name: string) => {
        const flow = flows.find((candidate) => candidate.name === name);
        if (flow === undefined) throw new Error(`missing test flow ${name}`);
        return Promise.resolve({ ok: true as const, value: flow });
      },
    } as Pick<FlowStore, 'list' | 'load'>;
    const posted: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      posted.push(`${url}:${(JSON.parse(init.body) as { flow: FlowFile }).flow.name}`);
      return Promise.resolve({ ok: true, status: 201 });
    };

    const result = await pushSavedFlows(
      store,
      { url: 'https://cloud.test', apiKey: 'secret' },
      'project-1',
      fetchImpl,
    );

    expect(result).toEqual({ pushed: 2, failed: 0, total: 2 });
    expect(posted).toEqual([
      'https://cloud.test/v1/flows:checkout',
      'https://cloud.test/v1/flows:settings',
    ]);
  });
});
