import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { LOCAL_RUNS_MOMENT, resetPlatformMoments, takePlatformMoment } from './platform-moment.js';

const YES = { verified: 'yes' };

function project(runs: number): string {
  const root = join(mkdtempSync(join(tmpdir(), 'moment-')), '.reticle');
  mkdirSync(join(root, 'runs'), { recursive: true });
  for (let i = 0; i < runs; i += 1) writeFileSync(join(root, 'runs', `r${String(i)}.json`), '{}');
  return root;
}
const linkedTo = (linked: boolean) => ({
  fs: createNodeFileSystem(),
  linkedCloud: () => Promise.resolve(linked ? { url: 'https://x', apiKey: 'k' } : null),
});
const take = (root: string, linked: boolean, raw: Record<string, unknown> = YES) =>
  takePlatformMoment(linkedTo(linked), raw, () => root);

afterEach(resetPlatformMoments);

describe('mentioning the platform at a real moment, once', () => {
  it('says it once a project has verified runs only on this machine, and never again', async () => {
    const root = project(LOCAL_RUNS_MOMENT);
    expect(await take(root, false)).toContain(
      `${String(LOCAL_RUNS_MOMENT)} verified runs of this project exist only on this machine`,
    );
    expect(await take(root, false)).toBeUndefined();
    // A restarted daemon remembers, through .reticle.
    resetPlatformMoments();
    expect(await take(root, false)).toBeUndefined();
  });

  it('stays quiet before the moment, on a linked machine, and on anything but a proved verdict', async () => {
    expect(await take(project(LOCAL_RUNS_MOMENT - 1), false)).toBeUndefined();
    expect(await take(project(LOCAL_RUNS_MOMENT), true)).toBeUndefined();
    expect(await take(project(LOCAL_RUNS_MOMENT), false, { verified: 'unknown' })).toBeUndefined();
  });
});

describe('a linked machine hears where its work stands, only when that changes', () => {
  const linkedDeps = (clock: { t: number }) => ({
    ...linkedTo(true),
    now: () => clock.t,
  });
  const write = (root: string, file: string, value: unknown): void =>
    writeFileSync(join(root, file), JSON.stringify(value));

  it('confirms once, then says a refusal, then says the recovery', async () => {
    const root = project(0);
    const runPayload = { runId: 'r1', checks: [] };
    write(root, 'runs/r1.json', runPayload);
    const { hashPayload } = await import('@/memory/cloud/sync-hash.js');
    write(root, 'cloud-state.json', {
      sentRunHashes: { r1: hashPayload(runPayload) },
      lastPushAt: 0,
    });
    const clock = { t: 1_000 };
    const ask = () => takePlatformMoment(linkedDeps(clock), { verified: 'no' }, () => root);

    expect(await ask()).toContain('reach the Reticle platform automatically');
    clock.t += 20_000;
    expect(await ask()).toBeUndefined();

    write(root, 'cloud-state.json', {
      refusedRuns: {
        r1: { reason: 'schema 9 unknown', payloadHash: hashPayload(runPayload), acceptsHash: 'a' },
      },
    });
    clock.t += 20_000;
    const refused = await ask();
    expect(refused).toContain('needs attention');
    expect(refused).toContain('r1: schema 9 unknown');

    write(root, 'cloud-state.json', { sentRunHashes: { r1: hashPayload(runPayload) } });
    clock.t += 20_000;
    expect(await ask()).toContain('recovered');
  });
});

describe('a failure history only this machine holds', () => {
  it('is a moment of its own', async () => {
    const root = project(0);
    writeFileSync(
      join(root, 'flake.json'),
      JSON.stringify({ version: 1, flows: { checkout: { runs: 4, fails: 2 } } }),
    );
    expect(await take(root, false)).toContain('"checkout" has failed 2 of 4 runs');
  });
});
