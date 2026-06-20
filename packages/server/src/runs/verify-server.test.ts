import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { ReplayStatus, type FlowReplayResult } from '@syrin/iris-protocol';
import { IrisRunner, type RunnerPort } from './iris-runner.js';
import { startVerifyServer, TOKEN_HEADER } from './verify-server.js';
import { VERIFY_PATH } from './verify-http.js';

function fakePort(): RunnerPort {
  let t = 0;
  let n = 0;
  return {
    listFlows: () => Promise.resolve(['login']),
    replayFlow: (name): Promise<FlowReplayResult> =>
      Promise.resolve({ name, status: ReplayStatus.OK, steps: [] }),
    now: () => (t += 1),
    newRunId: () => `run-${(n += 1)}`,
  };
}

describe('startVerifyServer (real socket, localhost)', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function start(token: string) {
    const started = await startVerifyServer({ runner: new IrisRunner(fakePort()), token }, 0);
    server = started.server;
    return `http://127.0.0.1:${started.port}`;
  }

  it('POST /verify returns a 200 verdict over HTTP', async () => {
    const base = await start('');
    const res = await fetch(`${base}${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: { name: 'demo' } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run: { verdict: { status: string } } };
    expect(json.run.verdict.status).toBe('pass');
  });

  it('rejects a request with the wrong token (401)', async () => {
    const base = await start('secret');
    const res = await fetch(`${base}${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: 'wrong' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts the right token and 404s an unknown path', async () => {
    const base = await start('secret');
    const ok = await fetch(`${base}${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: 'secret' },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    const missing = await fetch(`${base}/nope`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: 'secret' },
      body: '{}',
    });
    expect(missing.status).toBe(404);
  });
});
