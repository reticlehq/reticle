import { describe, expect, it, vi } from 'vitest';
import { asRunId, ReplayStatus, VerdictStatus, type FlowReplayResult } from '@reticlehq/core';
import { ReticleRunner, type RunnerPort } from './reticle-runner.js';
import { handleVerifyRequest, tokenOk, VERIFY_PATH } from './verify-http.js';

function fakePort(): RunnerPort {
  const okReplay = (name: string): FlowReplayResult => ({
    name,
    status: ReplayStatus.OK,
    steps: [],
  });
  let t = 0;
  let n = 0;
  return {
    listFlows: () => Promise.resolve(['login']),
    replayFlow: (name) => Promise.resolve(okReplay(name)),
    now: () => (t += 1),
    newRunId: () => asRunId(`run-${(n += 1)}`),
  };
}

const runner = (): ReticleRunner => new ReticleRunner(fakePort());
const post = (
  overrides: Partial<{ token: string; body: unknown; method: string; path: string }> = {},
) => ({
  method: overrides.method ?? 'POST',
  path: overrides.path ?? VERIFY_PATH,
  body: overrides.body ?? {},
  ...(overrides.token !== undefined ? { token: overrides.token } : {}),
});

describe('tokenOk', () => {
  it('open when no token configured; constant-time match otherwise', () => {
    expect(tokenOk(undefined, '')).toBe(true);
    expect(tokenOk('secret', 'secret')).toBe(true);
    expect(tokenOk('wrong', 'secret')).toBe(false);
    expect(tokenOk(undefined, 'secret')).toBe(false);
  });
});

describe('handleVerifyRequest', () => {
  it('404 for the wrong path', async () => {
    const res = await handleVerifyRequest({ ...post(), path: '/nope' }, runner(), '');
    expect(res.status).toBe(404);
  });

  it('405 for a non-POST method', async () => {
    const res = await handleVerifyRequest({ ...post(), method: 'GET' }, runner(), '');
    expect(res.status).toBe(405);
  });

  it('401 when the token is wrong or missing', async () => {
    expect((await handleVerifyRequest(post({ token: 'bad' }), runner(), 'secret')).status).toBe(
      401,
    );
    expect((await handleVerifyRequest(post(), runner(), 'secret')).status).toBe(401);
  });

  it('400 for an invalid body', async () => {
    const res = await handleVerifyRequest(post({ body: { names: 'not-an-array' } }), runner(), '');
    expect(res.status).toBe(400);
  });

  it('200 with a verdict, and persists the run, on a valid request', async () => {
    const persist = vi.fn<(run: unknown) => Promise<void>>(() => Promise.resolve());
    const res = await handleVerifyRequest(
      post({ token: 'secret', body: { project: { name: 'demo' } } }),
      runner(),
      'secret',
      persist,
    );
    expect(res.status).toBe(200);
    expect('run' in res.body).toBe(true);
    if ('run' in res.body) expect(res.body.run.verdict.status).toBe(VerdictStatus.PASS);
    expect(persist).toHaveBeenCalledOnce();
  });
});
