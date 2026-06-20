import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, type RunningServer } from '../index.js';

/**
 * End-to-end wiring test for `iris serve --http`: start the daemon with the verify endpoint enabled
 * (ephemeral ports), POST /verify over real HTTP, and confirm a verdict comes back AND a run artifact
 * is persisted to .iris/runs/. No browser/flows needed — an empty suite verifies to PASS, which is
 * enough to prove the CLI→startDaemon→IrisRunner→RunStore wiring end to end.
 */
describe('iris serve --http (daemon wiring)', () => {
  let server: RunningServer | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (root !== undefined) await rm(join(root, '..'), { recursive: true, force: true });
    root = undefined;
  });

  it('starts the verify endpoint, returns a verdict, and persists the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iris-daemon-'));
    root = join(dir, '.iris');
    server = await startDaemon({
      port: 0,
      httpVerify: true,
      httpVerifyPort: 0,
      httpVerifyToken: 'sek',
      irisRoot: root,
      now: () => 1_700_000_000_000,
    });

    expect(server.verifyPort).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${server.verifyPort}`;

    const unauthorized = await fetch(`${base}/verify`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);

    const res = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-iris-token': 'sek' },
      body: JSON.stringify({ project: { name: 'demo', framework: 'react' } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run: { verdict: { status: string }; runId: string } };
    expect(json.run.verdict.status).toBe('pass');

    const runFiles = await readdir(join(root, 'runs'));
    expect(runFiles).toContain(`${json.run.runId}.json`);
  });
});
