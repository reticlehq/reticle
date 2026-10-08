/**
 * One malformed frame on a live session must not disconnect the page for good (#1413).
 *
 * Every frame that failed the schema was closed with 1008, the policy code the SDK reads as
 * permanent: it stops reconnecting, so one event kind from a newer SDK ended the session mid-drive
 * and only a manual reload brought it back. After hello the frame is now dropped and logged, and
 * recorded as a transport gap in its window, so a verdict over that window is not a clean pass.
 * Before hello a bad frame is still a terminal refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  EventType,
  LOOPBACK_HOST,
  MessageKind,
  ReticleCommand,
  RETICLE_WS_PATH,
} from '@reticlehq/core';
import { transportGapNote } from '@reticlehq/engine/evidence/blind-spots.js';
import { Bridge } from './bridge.js';
import { FakeBrowser } from './bridge.test-harness.js';

let bridge: Bridge;
let port: number;
const browsers: FakeBrowser[] = [];

beforeEach(async () => {
  bridge = new Bridge({ port: 0 });
  port = await bridge.ready;
});

afterEach(async () => {
  for (const b of browsers.splice(0)) b.close();
  await bridge.close();
});

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function liveSession(): Promise<FakeBrowser> {
  const browser = new FakeBrowser(port, 'tab-1');
  browsers.push(browser);
  await browser.open();
  for (let i = 0; i < 100 && 0 === bridge.sessions.count(); i++) await settle(20);
  return browser;
}

describe('an invalid frame on a live session', () => {
  it('is dropped: the session stays listed and keeps answering commands', async () => {
    const browser = await liveSession();

    browser.emit('not-a-real-type', { anything: true });
    await settle();

    expect(bridge.sessions.count()).toBe(1);
    const session = bridge.sessions.resolve('tab-1');
    await expect(session.command(ReticleCommand.SNAPSHOT, {}, 2000)).resolves.toBeDefined();
  });

  it('leaves a transport gap in its window, so a verdict over it is not clean', async () => {
    const browser = await liveSession();
    const session = bridge.sessions.resolve('tab-1');
    const before = session.elapsed();

    browser.emit('not-a-real-type', {});
    await settle();

    const window = session.eventsSince(before);
    expect(window.some((e) => e.type === EventType.TRANSPORT_OVERFLOW)).toBe(true);
    expect(transportGapNote(window)).toMatch(/could not read/);
  });
});

describe('an invalid frame before hello', () => {
  it('is still closed with 1008', async () => {
    const sock = new WebSocket(`ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
    const code = await new Promise<number>((resolve) => {
      sock.on('open', () =>
        sock.send(JSON.stringify({ kind: MessageKind.EVENT, event: { type: 'x' } })),
      );
      sock.on('close', (c) => resolve(c));
    });
    expect(code).toBe(1008);
  });
});
