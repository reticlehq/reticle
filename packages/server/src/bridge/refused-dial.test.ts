/**
 * A refused handshake left no trace anywhere, which closed a loop nobody could get out of.
 *
 * When the SDK dials and is turned away at the origin gate, the reason existed only in the page
 * console — which is unreadable without a session, which is exactly what the refusal prevents. The
 * daemon log recorded only SUCCESSFUL `session_connected` events, `doctor` reported every check
 * green, and the lease hint offered the generic port-mismatch differential. One reporter recovered
 * the real rule by grepping our compiled `dist` inside their own `node_modules`.
 *
 * Two things have to be true for that loop to open:
 *   1. the daemon REMEMBERS the refusal, with its reason
 *   2. the no-session diagnosis says so INSTEAD OF, and as well as, its generic differential —
 *      the rich hint used to be discarded entirely the moment a closure existed
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RETICLE_WS_PATH } from '@reticlehq/core';
import { Bridge } from './bridge.js';
import { SessionManager } from '../session/session-manager.js';

const bridges: Bridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

function dial(port: number, origin: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${RETICLE_WS_PATH}`, { origin });
    socket.once('error', () => {
      resolve();
    });
    socket.once('open', () => {
      socket.terminate();
      resolve();
    });
  });
}

describe('a dial refused at the origin gate is remembered', () => {
  it('records the refusal so something other than the page console can name it', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const { sessions } = bridge;
    const port = await bridge.ready;

    await dial(port, 'https://evil.example');

    const closure = sessions.lastClosure();
    expect(closure).toBeDefined();
    expect(closure?.reason ?? '').toMatch(/origin/i);
  });

  it('names the origin that was turned away, since that IS the thing to fix', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const { sessions } = bridge;
    const port = await bridge.ready;

    await dial(port, 'http://tenant.myapp.test');

    expect(sessions.lastClosure()?.reason ?? '').toContain('tenant.myapp.test');
  });

  it('prints the exact origin to add, so the fix is copy-pasteable', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const { sessions } = bridge;
    const port = await bridge.ready;

    await dial(port, 'https://tenant.myapp.test');

    expect(sessions.lastClosure()?.reason ?? '').toContain(
      'add this exact origin to RETICLE_ALLOWED_ORIGINS: "https://tenant.myapp.test"',
    );
  });

  it('offers no allow-list entry for an opaque origin, where the token is the gate', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const { sessions } = bridge;
    const port = await bridge.ready;

    await dial(port, 'tauri://localhost');

    expect(sessions.lastClosure()?.reason ?? '').not.toContain('add this exact origin');
  });

  it('records nothing for an origin that is allowed', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const { sessions } = bridge;
    const port = await bridge.ready;

    await dial(port, 'http://localhost');

    expect(sessions.lastClosure()).toBeUndefined();
  });
});

describe('the refusal reaches the agent instead of replacing the diagnosis', () => {
  it('keeps the full diagnosis AND names the refusal', () => {
    const sessions = new SessionManager();
    sessions.setNoSessionHint(() => 'THE FULL DIAGNOSIS, which took a port scan to produce.');
    sessions.noteClosure('refused: origin https://evil.example is not allowed', 1000);

    let message = '';
    try {
      sessions.resolve();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('THE FULL DIAGNOSIS');
    expect(message).toContain('evil.example');
  });
});
