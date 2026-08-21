import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitServerVerification, type FetchPostJsonLike } from '../cloud/cloud-sync.js';
import { VerifyMode, type ProjectCloud } from '../cloud/cloud-config.js';
import type { ToolDeps } from '../tools/tools.js';
import { runServerVerify, toSuiteVerdict } from './server-verify.js';

/** A FetchPostJsonLike that returns a canned server report (or a non-ok status). */
function stubFetch(report: unknown, ok = true): FetchPostJsonLike {
  return () => Promise.resolve({ ok, status: ok ? 201 : 502, json: () => Promise.resolve(report) });
}

const CONFIG = { url: 'https://cloud.test', apiKey: 'rk_live_x' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submitServerVerification', () => {
  it('returns null when not attached (no config) — caller falls back to local', async () => {
    const out = await submitServerVerification(
      { previewUrl: 'https://app.test', flows: ['a'], source: 's' },
      null,
      stubFetch({}),
    );
    expect(out).toBeNull();
  });

  it('parses a valid hosted-runner report', async () => {
    const report = {
      verificationId: 'ver_1',
      verdict: 'pass',
      flows: [{ name: 'checkout', status: 'pass' }],
      summary: 'Verified 1 flow (server).',
    };
    const out = await submitServerVerification(
      { previewUrl: 'https://app.test', flows: ['checkout'], source: 's' },
      CONFIG,
      stubFetch(report),
    );
    expect(out?.verificationId).toBe('ver_1');
    expect(out?.flows).toHaveLength(1);
  });

  it('forwards bounded parallel intent to the hosted runner', async () => {
    let posted: unknown;
    const fetchImpl: FetchPostJsonLike = (_url, init) => {
      posted = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            verificationId: 'ver_parallel',
            verdict: 'pass',
            flows: [{ name: 'checkout', status: 'pass' }],
            summary: 'ok',
          }),
      });
    };
    await submitServerVerification(
      {
        previewUrl: 'https://app.test',
        flows: ['checkout'],
        source: 's',
        parallel: 6,
        projectId: 'shop',
      },
      CONFIG,
      fetchImpl,
    );
    expect(posted).toMatchObject({ parallel: 6, projectId: 'shop' });
  });

  it('scopes flow lookup to the linked cloud project', async () => {
    let posted: unknown;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      if ('string' !== typeof init.body) throw new Error('expected a JSON string body');
      posted = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            verificationId: 'ver_project',
            verdict: 'pass',
            flows: [{ name: 'checkout', status: 'pass' }],
            summary: 'ok',
          }),
      });
    });
    const deps = {
      sessions: { resolve: () => ({ url: 'https://preview.test' }) },
    } as unknown as ToolDeps;
    const cloud: ProjectCloud = {
      config: CONFIG,
      policy: { runs: true, memory: true, flows: true },
      verify: VerifyMode.SERVER,
      projectId: 'shop',
    };

    await runServerVerify(deps, cloud, undefined, ['checkout'], 2);

    expect(posted).toMatchObject({ projectId: 'shop', flows: ['checkout'] });
  });

  it('returns null on a non-ok response (best-effort, never throws)', async () => {
    const out = await submitServerVerification(
      { previewUrl: 'https://app.test', flows: [], source: 's' },
      CONFIG,
      stubFetch({}, false),
    );
    expect(out).toBeNull();
  });

  it('returns null when the response shape is unexpected (boundary-validated)', async () => {
    const out = await submitServerVerification(
      { previewUrl: 'https://app.test', flows: [], source: 's' },
      CONFIG,
      stubFetch({ nope: true }),
    );
    expect(out).toBeNull();
  });
});

describe('toSuiteVerdict (hosted report → local suite shape)', () => {
  it('all-pass → pass, no failures', () => {
    const v = toSuiteVerdict({
      verificationId: 'ver_1',
      verdict: 'pass',
      flows: [
        { name: 'a', status: 'pass' },
        { name: 'b', status: 'pass' },
      ],
      summary: 'ok',
    });
    expect(v).toMatchObject({ status: 'pass', total: 2, passed: 2, failed: 0 });
    expect(v.failures).toHaveLength(0);
  });

  it('a failing flow → fail, only the failure carries detail', () => {
    const v = toSuiteVerdict({
      verificationId: 'ver_2',
      verdict: 'fail',
      flows: [
        { name: 'a', status: 'pass' },
        { name: 'b', status: 'fail' },
      ],
      summary: '1/2',
    });
    expect(v).toMatchObject({ status: 'fail', total: 2, passed: 1, failed: 1 });
    expect(v.failures).toEqual([
      { flow: 'b', verdict: 'fail', nextAction: 'verified on the server — see report ver_2' },
    ]);
  });
});
