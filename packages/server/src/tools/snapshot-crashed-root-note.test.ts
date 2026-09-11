import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventType, SnapshotMode } from '@reticlehq/core';
import { Bridge } from '../bridge/bridge.js';
import type { ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from '../bridge/bridge.test-harness.js';

/**
 * An empty tree with uncaught errors beside it is a crashed app, not one that has not rendered.
 *
 * `nodes: 0` is indistinguishable from "the view has not rendered yet", which is the far more
 * common reading and the wrong one to act on: waiting and retrying will not bring back a root that
 * threw during render and unmounted. Reported from the field — the page went white, the snapshot
 * came back empty, and the five `Uncaught Error` entries that explained it were found about fifteen
 * tool calls later, by reading `reticle_console` on a hunch (#899).
 *
 * `noteHiddenPage` covers the hidden cause. This is the third cause with the same symptom, and the
 * only one that means something is wrong right now.
 */
describe('reticle_snapshot — an empty tree with uncaught errors beside it', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo', true);
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  const emptyTree = { tree: '', status: { route: '/app' }, nodes: 0 };

  async function snapshot(mode: string = SnapshotMode.FULL): Promise<Record<string, unknown>> {
    return (await callTool(deps, ReticleTool.SNAPSHOT, { mode })) as Record<string, unknown>;
  }

  async function throwOnce(message: string): Promise<void> {
    const before = bridge.sessions.resolve().eventsSince(0).length;
    browser.emit(EventType.ERROR_UNCAUGHT, { message, kind: 'error' });
    await waitUntil(() => bridge.sessions.resolve().eventsSince(0).length > before);
  }

  it('says an empty tree with a throw beside it is probably a crash', async () => {
    await throwOnce('Cannot read properties of null (reading "map")');
    browser.snapshotResult = emptyTree;

    const note = String((await snapshot())['note']);

    expect(note).toContain('NOT a page that has not rendered yet');
    expect(note).toContain('reading');
  });

  it('sends the reader to the channel that knows, rather than diagnosing', async () => {
    // The note must not claim to have read the error: it names the channel and says what NOT to do.
    await throwOnce('boom');
    browser.snapshotResult = emptyTree;

    const note = String((await snapshot())['note']);

    expect(note).toContain('reticle_console');
    expect(note).toContain('will not fix');
    expect(note).toContain('probably');
  });

  it('names the most recent throws, not the oldest', async () => {
    // A crash is the most recent thing that happened. Naming the FIRST error would name an
    // unrelated load-time throw on any app that has one, which most do. Two are named, because a
    // crash commonly throws a pair (the error, then the boundary's own failure to recover).
    await throwOnce('OLDEST-marker, from page load');
    await throwOnce('MIDDLE-marker, the throw that unmounted the root');
    await throwOnce('NEWEST-marker, the boundary failing too');
    browser.snapshotResult = emptyTree;

    const note = String((await snapshot())['note']);

    expect(note).toContain('NEWEST-marker');
    expect(note).toContain('MIDDLE-marker');
    expect(note).not.toContain('OLDEST-marker');
  });

  it('truncates a message rather than pasting a stack-sized string into the note', async () => {
    await throwOnce(`x${'y'.repeat(400)}`);
    browser.snapshotResult = emptyTree;

    const note = String((await snapshot())['note']);

    expect(note).toContain('…');
    expect(note.length).toBeLessThan(600);
  });

  it('says nothing about a crash when the tree has nodes in it', async () => {
    await throwOnce('a handled-looking throw on a page that rendered fine');
    browser.snapshotResult = {
      tree: '- button "Pay" (ref=e7)',
      status: { route: '/app' },
      nodes: 1,
    };

    expect((await snapshot())['note']).toBeUndefined();
  });

  it('leaves the hidden-page note alone, because that one explains this tree', async () => {
    // Both causes cannot be true of one tree, and two explanations is worse than the better one.
    await throwOnce('an unrelated throw');
    browser.snapshotResult = { ...emptyTree, hiddenSkipped: 3 };

    const note = String((await snapshot())['note']);

    expect(note).toContain('NOT an empty page');
    expect(note).not.toContain('reticle_console');
  });

  it('leaves a status snapshot alone, which carries no tree to explain', async () => {
    await throwOnce('boom');
    browser.snapshotResult = emptyTree;

    expect((await snapshot(SnapshotMode.STATUS))['note']).toBeUndefined();
  });
});
