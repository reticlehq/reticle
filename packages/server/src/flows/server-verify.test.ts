import { describe, it, expect } from 'vitest';
import { submitServerVerification, type FetchPostJsonLike } from '../cloud/cloud-sync.js';
import { toSuiteVerdict } from './server-verify.js';

/** A FetchPostJsonLike that returns a canned server report (or a non-ok status). */
function stubFetch(report: unknown, ok = true): FetchPostJsonLike {
  return () => Promise.resolve({ ok, status: ok ? 201 : 502, json: () => Promise.resolve(report) });
}

const CONFIG = { url: 'https://cloud.test', apiKey: 'rk_live_x' };

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
