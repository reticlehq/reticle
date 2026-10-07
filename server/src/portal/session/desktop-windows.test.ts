import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  RETICLE_PROTOCOL_VERSION,
  MessageKind,
  EventType,
  ReticleTool,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { Session } from './session.js';
import { SessionManager } from './session-manager.js';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

/**
 * Reported from a Tauri app with three windows on one dev-server origin: `main` (visible, the
 * product), and `setup` + `coach` (hidden, whose static pages the dev server answered with 404 — and
 * the 404 page still mounted the SDK). The listing could not say which window was which, and
 * auto-selection handed the agent a hidden 404 page.
 */

const fakeSocket = { send: (): void => {}, close: (): void => {} } as unknown as WebSocket;

function windowSession(
  id: string,
  path: string,
  page: { windowLabel: string; documentStatus: number; hidden: boolean },
): Session {
  const hello: HelloMessage = {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: id,
    url: `http://127.0.0.1:3100${path}`,
    title: id,
    adapters: [],
    hasCapabilities: false,
  };
  const session = new Session(hello, fakeSocket, () => 0);
  session.pushEvent({
    type: EventType.PAGE_HEALTH,
    data: {
      hidden: page.hidden,
      focused: !page.hidden,
      runtime: 'tauri',
      windowLabel: page.windowLabel,
      documentStatus: page.documentStatus,
    },
  } as unknown as ReticleEvent);
  return session;
}

describe('a desktop app with several windows', () => {
  it('lists each window by its label, and names a 404 document as one', () => {
    const setup = windowSession('s-setup', '/setup.html', {
      windowLabel: 'setup',
      documentStatus: 404,
      hidden: true,
    });
    const main = windowSession('s-main', '/', {
      windowLabel: 'main',
      documentStatus: 200,
      hidden: false,
    });
    expect(setup.info()).toMatchObject({ window: 'setup', documentStatus: 404, hidden: true });
    // A healthy document says nothing about its status: absence means it was not an error.
    expect(main.info().window).toBe('main');
    expect(main.info().documentStatus).toBeUndefined();
  });

  it('auto-selects the app window over a visible 404 page', () => {
    const sessions = new SessionManager();
    sessions.add(
      windowSession('s-coach', '/coach.html', {
        windowLabel: 'coach',
        documentStatus: 404,
        hidden: false,
      }),
    );
    sessions.add(
      windowSession('s-main', '/', { windowLabel: 'main', documentStatus: 200, hidden: true }),
    );
    expect(sessions.resolve().id).toBe('s-main');
  });

  it('a parked window is refused when it reconnects under the same id', () => {
    const sessions = new SessionManager();
    const coach = windowSession('s-coach', '/coach.html', {
      windowLabel: 'coach',
      documentStatus: 404,
      hidden: true,
    });
    sessions.add(coach);
    sessions.park(coach);
    expect(sessions.get('s-coach')).toBeUndefined();
    // A reload keeps its id (sessionStorage), so the id is what stays parked.
    expect(sessions.isParked('s-coach')).toBe(true);
    expect(sessions.isParked('s-main')).toBe(false);
  });

  it('never detaches a window it had to guess — disconnect needs a named session', () => {
    const sessions = new SessionManager();
    sessions.add(
      windowSession('s-main', '/', { windowLabel: 'main', documentStatus: 200, hidden: false }),
    );
    const end = LIVE_CONTROL_TOOLS.find((t) => t.name === ReticleTool.END_SESSION);
    const deps = { sessions } as unknown as ToolDeps;
    expect(() => end?.handler(deps, { disconnect: true })).toThrow(/sessionId/);
    expect(sessions.get('s-main')).toBeDefined();
  });
});
