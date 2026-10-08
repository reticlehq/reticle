/**
 * Two defects in the record start/stop pair (#1411).
 *
 * A journey recorded on `/products?scope=TOPWEAR` saved `startPath: "/products"`, so replay started
 * on the unfiltered page. And a recording that crossed a full-page load reported a negative
 * `window_ms` and an empty span, because the reconnected page is a new Session whose clock
 * restarts below the cursor stored at start.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  RETICLE_URL_PARAM,
  ReticleTool,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import type { ToolDeps } from './tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { startPathMismatchHint } from '@/language/flows/flow-replay-run.js';

const tool = (name: string) => {
  const t = READ_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no ${name}`);
  return t;
};

const LEASED = `http://localhost:3000/products?scope=TOPWEAR&${RETICLE_URL_PARAM.SESSION}=lease-1`;

function deps(session: Partial<Session>, recordings = new RecordingStore()): ToolDeps {
  return {
    sessions: { resolve: () => session as Session } as unknown as SessionManager,
    recordings,
  } as unknown as ToolDeps;
}

describe('a recording keeps the query it started on', () => {
  it("saves the app's query, without Reticle's own params", async () => {
    const recordings = new RecordingStore();
    const session = { id: 's1', url: LEASED, elapsed: () => 100, eventsSince: () => [] };
    await tool(ReticleTool.RECORD_START).handler(deps(session, recordings), {
      recordingName: 'trip',
    });
    const out = (await tool(ReticleTool.RECORD_STOP).handler(deps(session, recordings), {
      recordingName: 'trip',
    })) as { program: { startPath?: string } };

    expect(out.program.startPath).toBe('/products?scope=TOPWEAR');
  });

  it('is already there on a leased tab carrying the same query, so replay does not re-navigate', () => {
    const flow: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: 'trip',
      createdAt: 1,
      steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'pay' } }],
      startPath: '/products?scope=TOPWEAR',
    };
    const onLease = { url: LEASED, eventsSince: (): ReticleEvent[] => [] };
    expect(startPathMismatchHint(flow, onLease)).toBeUndefined();
    const elsewhere = {
      url: 'http://localhost:3000/products',
      eventsSince: (): ReticleEvent[] => [],
    };
    expect(startPathMismatchHint(flow, elsewhere)).toContain('/products?scope=TOPWEAR');
  });
});

describe('a recording that crossed a full-page load', () => {
  it('never reports a negative window, and says the span crossed a reload', async () => {
    const recordings = new RecordingStore();
    // Started at t=9000 on the first document's session.
    recordings.start('trip', 9_000, '/products', 'doc-1');
    // Stopped on the successor: a new session whose clock is at 1500.
    const successorEvents: ReticleEvent[] = [
      { t: 200, type: EventType.DOM_ADDED, sessionId: 'doc-2', data: { path: 'main > h1' } },
    ];
    const successor = {
      id: 'doc-2',
      url: 'http://localhost:3000/checkout',
      elapsed: () => 1_500,
      eventsSince: (since: number) => successorEvents.filter((e) => e.t >= since),
    };

    const out = (await tool(ReticleTool.RECORD_STOP).handler(deps(successor, recordings), {
      recordingName: 'trip',
    })) as { warning?: string; window_ms?: number; counts?: Record<string, number> };

    expect(out.warning).toMatch(/crossed a full-page load/);
    expect(JSON.stringify(out)).not.toMatch(/"window_ms":-/);
    expect(out.window_ms ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('says nothing about a reload when the span stayed on one page', async () => {
    const recordings = new RecordingStore();
    recordings.start('trip', 100, '/products', 'doc-1');
    const same = {
      id: 'doc-1',
      url: 'http://localhost:3000/products',
      elapsed: () => 900,
      eventsSince: () => [],
    };
    const out = (await tool(ReticleTool.RECORD_STOP).handler(deps(same, recordings), {
      recordingName: 'trip',
    })) as { warning?: string };
    expect(out.warning ?? '').not.toMatch(/full-page load/);
  });
});
