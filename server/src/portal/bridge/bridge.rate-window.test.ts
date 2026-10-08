/**
 * One early burst must not make every later verdict on the tab `unclean_capture` (#1414).
 *
 * The bridge samples above its per-second cap and records how many it dropped. That count is a
 * running total for the connection, and the verdict paths read it as a gap in their own window, so a
 * quiet window long after the burst came back `unknown`. Drops are now kept by when they happened;
 * only the ones inside a verdict's window impeach it, and the session-wide count stays a coverage
 * note.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  BlindSpotKind,
  MessageKind,
  RETICLE_WS_PATH,
  ReticleTool,
  VerifiedReason,
} from '@reticlehq/core';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { Bridge } from './bridge.js';

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const b of bridges.splice(0)) await b.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function burstThenQuiet(): Promise<Bridge> {
  const bridge = new Bridge({ port: 0, maxMessagesPerSecond: 2 });
  bridges.push(bridge);
  const port = await bridge.ready;
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
    sockets.push(s);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      kind: MessageKind.HELLO,
      protocolVersion: 1,
      sessionId: 'burst',
      url: 'http://localhost:3000/',
      title: 'burst',
      adapters: [],
      hasCapabilities: false,
    }),
  );
  for (let i = 0; i < 100 && 0 === bridge.sessions.count(); i += 1) await sleep(10);
  // A DOM storm far past the cap, as a live chart produces.
  for (let i = 0; i < 40; i += 1) {
    socket.send(
      JSON.stringify({
        kind: MessageKind.EVENT,
        event: { t: i, type: 'dom.added', sessionId: 'burst' },
      }),
    );
  }
  for (let i = 0; i < 100; i += 1) {
    if ((bridge.sessions.get('burst')?.blindSpots()[BlindSpotKind.RATE_LIMITED] ?? 0) > 0) break;
    await sleep(10);
  }
  return bridge;
}

async function assertQuiet(bridge: Bridge, since: number): Promise<Record<string, unknown>> {
  const deps = {
    sessions: bridge.sessions,
    recordings: new RecordingStore(),
    now: () => 0,
  } as unknown as ToolDeps;
  const tool = TOOLS.find((t) => t.name === ReticleTool.ASSERT);
  if (tool === undefined) throw new Error('no assert tool');
  return (await tool.handler(deps, {
    predicate: { kind: 'console', level: 'error', absent: true },
    since,
    sessionId: 'burst',
  })) as Record<string, unknown>;
}

describe('bridge sampling impeaches only the window it happened in', () => {
  it('does not impeach a later window with no drops in it', async () => {
    const bridge = await burstThenQuiet();
    const session = bridge.sessions.get('burst');
    expect(session?.blindSpots()[BlindSpotKind.RATE_LIMITED] ?? 0).toBeGreaterThan(0);
    // Past the second the burst landed in.
    await sleep(1_100);

    const out = await assertQuiet(bridge, session?.elapsed() ?? 0);

    expect(out['verifiedReason']).not.toBe(VerifiedReason.UNCLEAN_CAPTURE);
    // The session still says sampling happened: a coverage fact, not this verdict's gap.
    const note = JSON.stringify(out['coverage']);
    expect(note).toContain('rate cap');
    // ...without telling the reader to repeat a check whose own capture was whole.
    expect(note).toContain('none in this window');
    expect(note).not.toContain('SAMPLED');
  });

  it('still impeaches a window that contains the drops', async () => {
    const bridge = await burstThenQuiet();

    const out = await assertQuiet(bridge, 0);

    expect(out['verifiedReason']).toBe(VerifiedReason.UNCLEAN_CAPTURE);
    expect(JSON.stringify(out['coverage'])).toContain('this window is SAMPLED');
  });
});
