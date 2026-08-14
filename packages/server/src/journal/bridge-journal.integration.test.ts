import { removeTempDir } from '../temp-dir.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type JournalAction, type ReticleEvent } from '@reticlehq/core';
import { Bridge } from '../bridge/bridge.js';
import { ReticleTool } from '../tools/tool-names.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import type { ToolDeps } from '../tools/tools.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from '../bridge/bridge.test-harness.js';
import { makeJournalAttach } from './attach-journal.js';

/**
 * The one path unit tests can't reach: a real WebSocket browser → bridge → Session → durable journal on
 * disk. Proves end-to-end — events stream to events.jsonl and an act mints an action in actions.jsonl.
 */
describe('durable journal over a live bridge session', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;
  let dir: string;
  let root: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-bridge-journal-'));
    root = join(dir, '.reticle');
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    // Attach the journal exactly as index.ts does, before any browser connects.
    bridge.attachSessionCreate(
      makeJournalAttach({ fs: createNodeFileSystem(), reticleRoot: root, enabled: true }),
    );
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo', true);
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
    await removeTempDir(dir);
  });

  it('journals streamed events and a minted act to disk', async () => {
    browser.emit(EventType.NET_REQUEST, {
      id: 'r1',
      method: 'GET',
      url: '/api/x',
      status: 200,
      ok: true,
      durationMs: 5,
      initiator: 'fetch',
    });
    await waitUntil(() => (bridge.sessions.get('demo')?.eventsSince(0).length ?? 0) >= 1);

    await callTool(deps, ReticleTool.ACT, { ref: 'e1', action: 'click' });

    const session = bridge.sessions.get('demo');
    expect(session).toBeDefined();
    await session?.flushJournal();

    const eventsText = await readFile(join(root, 'sessions', 'demo', 'events.jsonl'), 'utf8');
    const events = eventsText
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as ReticleEvent);
    expect(events.some((e) => e.type === EventType.NET_REQUEST)).toBe(true);

    const actionsText = await readFile(join(root, 'sessions', 'demo', 'actions.jsonl'), 'utf8');
    const actions = actionsText
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as JournalAction);
    expect(actions.some((a) => a.tool === ReticleTool.ACT && true === a.settled)).toBe(true);
  });
});
