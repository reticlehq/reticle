import { describe, it, expect } from 'vitest';
import { EventType, ReticleTool, type ReticleEvent } from '@reticlehq/core';
import { OBSERVE_TOOLS } from './observe-tools.js';
import type { ToolDeps } from './tools.js';
import type { Session } from '../../portal/session/session.js';
import type { SessionManager } from '../../portal/session/session-manager.js';

/**
 * The token saving on `reticle_network` actually happens, and says so.
 *
 * Both halves of it — bodies kept only where they could decide a verdict, and the dev server's own
 * asset traffic folded away — were shipped with unit tests on the two PURE functions and nothing at
 * all on the handler that calls them. Proved by mutation: reverting both defaults to the
 * pre-change behaviour (`'auto'` back to `'all'`, `folding` forced false) left **6075 of 6075 tests
 * passing**. The feature could stop saving anything, silently, forever.
 *
 * Worse in the other direction: the same absence means a future edit could start dropping a body
 * that WAS evidence and no test would notice. That is the trade CLAUDE.md forbids — a token
 * optimisation ships only with a correctness measurement beside it — and the correctness half was
 * the part missing.
 *
 * So these assert the three fields the feature is FOR, at the handler, where a caller sees them.
 */
function ev(data: Record<string, unknown>, t = 1): ReticleEvent {
  return { t, type: EventType.NET_REQUEST, sessionId: 's', data };
}

function netDeps(events: ReticleEvent[]): ToolDeps {
  const session = {
    queryEvents: () => Promise.resolve(events),
    bufferHealth: () => ({ total: events.length, dropped: 0 }),
  } as unknown as Session;
  return {
    sessions: { resolve: () => session } as unknown as SessionManager,
  } as unknown as ToolDeps;
}

function networkTool() {
  const t = OBSERVE_TOOLS.find((x) => x.name === ReticleTool.NETWORK);
  if (t === undefined) throw new Error('no reticle_network tool');
  return t;
}

type NetResult = {
  calls: Array<Record<string, unknown>>;
  assetsFolded?: { count: number; bytes: number; sample: string[]; how: string };
  bodiesWithheld?: { count: number; why: string; how: string };
};

const ASSET = ev({
  method: 'GET',
  url: 'http://localhost:4312/src/main.tsx',
  status: 200,
  durationMs: 3,
});
const API_OK = ev({
  method: 'GET',
  url: 'http://localhost:4312/api/feed',
  status: 200,
  durationMs: 5,
  responseBody: '{"items":[]}',
});
const API_FAIL = ev({
  method: 'POST',
  url: 'http://localhost:4312/api/pay',
  status: 500,
  durationMs: 9,
  responseBody: '{"error":"declined"}',
});

describe('reticle_network defaults', () => {
  it('FOLDS the dev server’s own asset traffic by default, and says what it folded', async () => {
    const res = (await networkTool().handler(netDeps([ASSET, API_OK]), {})) as NetResult;
    expect(res.calls.map((c) => c['url'])).toEqual(['http://localhost:4312/api/feed']);
    expect(res.assetsFolded?.count, 'the fold must be reported, never silent').toBe(1);
    expect(res.assetsFolded?.sample).toContain('http://localhost:4312/src/main.tsx');
    expect(res.assetsFolded?.how, 'the reader must be told how to get them back').toMatch(/assets/);
  });

  it('folds NOTHING when the caller asks for assets', async () => {
    const res = (await networkTool().handler(netDeps([ASSET, API_OK]), {
      assets: true,
    })) as NetResult;
    expect(res.calls).toHaveLength(2);
    expect(res.assetsFolded).toBeUndefined();
  });

  it('folds NOTHING once a filter names what the caller means', async () => {
    // Answering a narrowed question with a summary is refusing it.
    const res = (await networkTool().handler(netDeps([ASSET, API_OK]), {
      urlContains: 'main.tsx',
    })) as NetResult;
    expect(res.calls).toHaveLength(1);
    expect(res.assetsFolded).toBeUndefined();
  });

  it('KEEPS the body of a failure, and withholds a plain success’s, reporting the difference', async () => {
    const res = (await networkTool().handler(netDeps([API_FAIL, API_OK]), {})) as NetResult;
    const failed = res.calls.find((c) => 500 === c['status']);
    expect(failed?.['responseBody'], 'a failure’s body is where the reason lives').toBe(
      '{"error":"declined"}',
    );
    // The successful GET of JSON is kept too — it is data the app exchanged. Nothing is withheld
    // here, and the field must be ABSENT rather than zero when nothing was.
    expect(res.bodiesWithheld).toBeUndefined();
  });

  it('reports bodiesWithheld when it withholds one, naming how to get it', async () => {
    const quietAsset = ev({
      method: 'GET',
      url: 'http://localhost:4312/assets/app-1a2b.css',
      status: 200,
      durationMs: 2,
      responseBody: 'body{}',
    });
    // `assets: true` lists it, so the body decision is the only thing under test.
    const res = (await networkTool().handler(netDeps([quietAsset]), {
      assets: true,
    })) as NetResult;
    expect(res.calls[0]?.['responseBody']).toBeUndefined();
    expect(res.bodiesWithheld?.count).toBe(1);
    expect(res.bodiesWithheld?.how).toMatch(/bodies\s*:\s*true/);
  });

  it('bodies:true still returns every body — the old behaviour is reachable', async () => {
    const res = (await networkTool().handler(netDeps([API_OK]), { bodies: true })) as NetResult;
    expect(res.calls[0]?.['responseBody']).toBe('{"items":[]}');
    expect(res.bodiesWithheld).toBeUndefined();
  });
});
