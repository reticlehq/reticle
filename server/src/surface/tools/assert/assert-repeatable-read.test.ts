/**
 * `reticle_assert` hands a net clause's `repeatable: true` to the duplicate rule (#1353).
 *
 * Driven through a real bridge and the real tool, so the declaration has to survive the whole path
 * from the predicate to the verdict: two identical reads of a declared read endpoint stay `yes`, and
 * the same pair without the declaration is still `duplicate-request`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  ContradictionKind,
  MessageKind,
  REQUEST_SHAPE_FIELD,
  RETICLE_WS_PATH,
  ReticleTool,
} from '@reticlehq/core';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { Bridge } from '@/portal/bridge/bridge.js';

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const b of bridges.splice(0)) await b.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A tab that posted the same GraphQL query twice, as StrictMode's double effect does. */
async function readTwice(): Promise<Bridge> {
  const bridge = new Bridge({ port: 0 });
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
  const send = (message: Record<string, unknown>): void => socket.send(JSON.stringify(message));
  send({
    kind: MessageKind.HELLO,
    protocolVersion: 1,
    sessionId: 'reads',
    url: 'http://localhost:3000/',
    title: 'reads',
    adapters: [],
    hasCapabilities: false,
  });
  for (let i = 0; i < 100 && 0 === bridge.sessions.count(); i += 1) await sleep(10);
  for (const [t, id] of [
    [10, 'r1'],
    [50, 'r2'],
  ] as const) {
    send({
      kind: MessageKind.EVENT,
      event: {
        t,
        type: 'net.request',
        sessionId: 'reads',
        data: {
          id,
          method: 'POST',
          url: 'http://localhost:3000/graphql',
          status: 200,
          ok: true,
          [REQUEST_SHAPE_FIELD]: 'q1q2q3q4',
        },
      },
    });
  }
  send({
    kind: MessageKind.EVENT,
    event: { t: 60, type: 'dom.added', sessionId: 'reads', data: { path: 'main > ul' } },
  });
  for (let i = 0; i < 100; i += 1) {
    if (2 <= (bridge.sessions.get('reads')?.eventsSince(0).length ?? 0)) break;
    await sleep(10);
  }
  await sleep(50);
  // The click that fired them: the duplicate rule judges the writes an act caused.
  bridge.sessions.get('reads')?.lastAct.markActed(0, 'click', undefined);
  return bridge;
}

async function assertNet(bridge: Bridge, net: Record<string, unknown>) {
  const deps = {
    sessions: bridge.sessions,
    recordings: new RecordingStore(),
    now: () => 0,
  } as unknown as ToolDeps;
  const tool = TOOLS.find((t) => t.name === ReticleTool.ASSERT);
  if (tool === undefined) throw new Error('no assert tool');
  return (await tool.handler(deps, {
    predicate: { kind: 'net', urlContains: '/graphql', ...net },
    since: 0,
    sessionId: 'reads',
  })) as { verified?: string; contradictions?: { kind: string }[] };
}

describe('a read over POST declared as one', () => {
  it('stays yes with no duplicate-request', async () => {
    const out = await assertNet(await readTwice(), { repeatable: true });
    expect(out.contradictions?.map((c) => c.kind) ?? []).not.toContain(
      ContradictionKind.DUPLICATE_REQUEST,
    );
    expect(out.verified).toBe('yes');
  });

  it('is still a duplicate-request without the declaration', async () => {
    const out = await assertNet(await readTwice(), {});
    expect(out.contradictions?.map((c) => c.kind) ?? []).toContain(
      ContradictionKind.DUPLICATE_REQUEST,
    );
    expect(out.verified).not.toBe('yes');
  });
});
