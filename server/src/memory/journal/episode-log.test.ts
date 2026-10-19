import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventType, REDACTED_VALUE, ReticleDir, type ReticleEvent } from '@reticlehq/core';
import { episodeStampFor } from '@/hooks/episode-stamp.js';
import {
  EPISODE_FILE_VERSION,
  EpisodeRecordKind,
  MAX_EPISODE_FIELD_CHARS,
  createEpisodeLog,
  episodePath,
  episodesMaySync,
  type GitAtStart,
} from './episode-log.js';

function root(): string {
  const project = mkdtempSync(join(tmpdir(), 'episode-'));
  const reticleRoot = join(project, ReticleDir.ROOT);
  mkdirSync(reticleRoot, { recursive: true });
  return reticleRoot;
}

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const GIT: GitAtStart = {
  head: 'abc123',
  changed: [{ file: 'src/cart.ts', added: 3, removed: 1 }],
};

const event = (t: number, type: EventType, seq: number): ReticleEvent => ({
  t,
  type,
  sessionId: 's1',
  seq,
  data: {},
});

describe('the episode log', () => {
  it('opens with the git state and the request, then keeps each call in full with its effect', async () => {
    const reticleRoot = root();
    writeFileSync(
      join(reticleRoot, ReticleDir.REQUEST_FILE),
      JSON.stringify({ request: 'make promo codes apply', statements: [], at: 5, shared: false }),
    );
    let clock = 1_000;
    const log = createEpisodeLog({
      root: reticleRoot,
      episodeId: 'attach-1',
      now: () => clock,
      git: () => Promise.resolve(GIT),
    });
    log.record({
      tool: 'reticle_act',
      args: { action: 'click', ref: 'e7' },
      startedAt: 1_000,
      endedAt: 1_040,
      result: { ok: true, effect: { settled: true } },
      sessionId: 's1',
      agent: 'claude-code',
      effect: [event(10, EventType.NET_REQUEST, 4), event(11, EventType.ROUTE_CHANGE, 5)],
    });
    clock = 2_000;
    log.record({
      tool: 'reticle_snapshot',
      args: {},
      startedAt: 2_000,
      endedAt: 2_010,
      error: 'no session',
    });
    await log.flush();

    const [start, act, snap] = lines(episodePath(reticleRoot, 'attach-1'));
    expect(start).toMatchObject({
      v: EPISODE_FILE_VERSION,
      kind: EpisodeRecordKind.START,
      episodeId: 'attach-1',
      at: 1_000,
      agent: 'claude-code',
      git: GIT,
      request: { request: 'make promo codes apply' },
    });
    expect(act).toMatchObject({
      kind: EpisodeRecordKind.CALL,
      n: 1,
      tool: 'reticle_act',
      args: { action: 'click', ref: 'e7' },
      result: { ok: true, effect: { settled: true } },
      startedAt: 1_000,
      endedAt: 1_040,
      sessionId: 's1',
      agent: 'claude-code',
      effect: {
        counts: { [EventType.NET_REQUEST]: 1, [EventType.ROUTE_CHANGE]: 1 },
        seqRange: { from: 4, to: 5 },
      },
    });
    expect((act?.['effect'] as { events: unknown[] }).events).toHaveLength(2);
    expect(snap).toMatchObject({ n: 2, tool: 'reticle_snapshot', error: 'no session' });
    expect(snap?.['effect']).toBeUndefined();
    // A run written in this project now names this episode and its HEAD.
    expect(episodeStampFor(reticleRoot, 'attach-1')).toEqual({
      episodeId: 'attach-1',
      head: 'abc123',
    });
  });

  it('never keeps a typed value, the same rule as the journal', async () => {
    const reticleRoot = root();
    const log = createEpisodeLog({
      root: reticleRoot,
      episodeId: 'a',
      now: () => 0,
      git: () => Promise.resolve(GIT),
    });
    log.record({
      tool: 'reticle_act',
      args: { action: 'fill', ref: 'e2', value: 'hunter2' },
      startedAt: 0,
      endedAt: 1,
      result: {},
    });
    await log.flush();
    const [, call] = lines(episodePath(reticleRoot, 'a'));
    expect(call?.['args']).toMatchObject({ action: 'fill', value: REDACTED_VALUE });
    expect(readFileSync(episodePath(reticleRoot, 'a'), 'utf8')).not.toContain('hunter2');
  });

  it('declares what it cut when a result is too large to keep whole', async () => {
    const reticleRoot = root();
    const log = createEpisodeLog({
      root: reticleRoot,
      episodeId: 'big',
      now: () => 0,
      git: () => Promise.resolve(GIT),
    });
    log.record({
      tool: 'reticle_snapshot',
      args: {},
      startedAt: 0,
      endedAt: 1,
      result: { tree: 'x'.repeat(MAX_EPISODE_FIELD_CHARS + 10) },
    });
    await log.flush();
    const [, call] = lines(episodePath(reticleRoot, 'big'));
    expect(call?.['truncated']).toEqual(['result']);
    expect(String((call?.['result'] as { head: string }).head).length).toBe(
      MAX_EPISODE_FIELD_CHARS,
    );
  });

  it('writes the start once, and a git that cannot answer says why', async () => {
    const reticleRoot = root();
    const log = createEpisodeLog({
      root: reticleRoot,
      episodeId: 'nogit',
      now: () => 0,
      git: () => Promise.resolve({ failed: 'not a git repository' }),
    });
    for (const n of [1, 2, 3])
      log.record({ tool: 't', args: { n }, startedAt: n, endedAt: n, result: n });
    await log.flush();
    const all = lines(episodePath(reticleRoot, 'nogit'));
    expect(all.filter((l) => EpisodeRecordKind.START === l['kind'])).toHaveLength(1);
    expect(all[0]?.['git']).toEqual({ failed: 'not a git repository' });
    expect(all.map((l) => l['n'])).toEqual([undefined, 1, 2, 3]);
  });

  it('is never written when the journal is switched off', async () => {
    const reticleRoot = root();
    const log = createEpisodeLog({
      root: reticleRoot,
      episodeId: 'off',
      now: () => 0,
      git: () => Promise.resolve(GIT),
      enabled: false,
    });
    log.record({ tool: 't', args: {}, startedAt: 0, endedAt: 1, result: 1 });
    await log.flush();
    expect(() => readFileSync(episodePath(reticleRoot, 'off'))).toThrow();
  });
});

describe('the episode upload gate', () => {
  const linked = { config: { url: 'https://x', apiKey: 'k' } };
  it('stays local unless the project opted in AND the workspace consented', () => {
    expect(episodesMaySync({ ...linked, policy: { episodes: true } }, true)).toBe(true);
    expect(episodesMaySync({ ...linked, policy: { episodes: true } }, undefined)).toBe(false);
    expect(episodesMaySync({ ...linked, policy: { episodes: true } }, false)).toBe(false);
    expect(episodesMaySync({ ...linked, policy: {} }, true)).toBe(false);
    expect(episodesMaySync({ config: null, policy: { episodes: true } }, true)).toBe(false);
  });
});
