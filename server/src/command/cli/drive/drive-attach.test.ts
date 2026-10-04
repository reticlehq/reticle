import { describe, expect, it } from 'vitest';
import { PortPresence, describePresence } from '@/command/daemon/binding/port-presence.js';
import {
  DriveMode,
  attachedApp,
  decideDriveMode,
  describeAttached,
  driveForeignHolder,
  driveHeadlessOnAttach,
  driveRaceLost,
  readAttachResponse,
  requestDriveSession,
} from './drive-attach.js';

/**
 * The defect, twice from the field: `reticle drive` refused with EADDRINUSE because the daemon the
 * agent's own MCP client started already held :4400 — and `reticle stop` then lost a race with the
 * proxy respawning one. Both reports asked for the same thing: drive should ASK the daemon that is
 * already there, not compete with it for the port.
 */
describe('decideDriveMode', () => {
  it('binds the port when nothing is on it', () => {
    expect(decideDriveMode(PortPresence.FREE)).toBe(DriveMode.BIND);
  });

  it('attaches to a healthy daemon rather than competing for its port', () => {
    // The whole fix. A daemon that answers /status can hand out a driveable browser itself, so
    // there is nothing for `drive` to bind and no race with the proxy to lose.
    expect(decideDriveMode(PortPresence.DAEMON)).toBe(DriveMode.ATTACH);
  });

  it('refuses when the port is held by something that cannot serve a drive session', () => {
    expect(decideDriveMode(PortPresence.FOREIGN)).toBe(DriveMode.REFUSE);
  });
});

describe('readAttachResponse', () => {
  const ok = JSON.stringify({ sessionId: 'lease-7', ready: true, expiresInMs: 300000 });

  it('carries the daemon session id back to the caller', () => {
    const result = readAttachResponse(4400, 'http://localhost:5173', { status: 200, body: ok });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.sessionId).toBe('lease-7');
    expect(result.session.ready).toBe(true);
    expect(result.session.expiresInMs).toBe(300000);
  });

  it('reports a tool-level refusal as the reason, naming the url that failed', () => {
    const body = JSON.stringify({
      error: 'could not open http://localhost:5173 — is the app running there?',
    });
    const result = readAttachResponse(4400, 'http://localhost:5173', { status: 200, body });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('is the app running there?');
    expect(result.reason).toContain('http://localhost:5173');
  });

  it('names the daemon as too old when it has no drive endpoint, and says how to replace it', () => {
    // A newer npx CLI against a daemon from an older install is the ordinary upgrade state, and a
    // bare 404 would send the reader looking for a bug in their app.
    const result = readAttachResponse(4400, 'http://localhost:5173', {
      status: 404,
      body: 'not found',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('older');
    expect(result.reason).toContain('reticle stop');
  });

  it('never answers with an unexplained status code alone', () => {
    const result = readAttachResponse(4400, 'http://localhost:5173', { status: 500, body: 'boom' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('4400');
    expect(result.reason).toContain('boom');
  });

  it('treats an unparseable body as a failure rather than a session', () => {
    const result = readAttachResponse(4400, 'http://localhost:5173', {
      status: 200,
      body: '<html>',
    });
    expect(result.ok).toBe(false);
  });
});

describe('requestDriveSession', () => {
  it('posts the url to the daemon and returns the session it handed back', async () => {
    const seen: { path: string; body: string }[] = [];
    const result = await requestDriveSession(4400, 'http://localhost:5173', (port, path, body) => {
      seen.push({ path, body });
      expect(port).toBe(4400);
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({ sessionId: 'lease-9', ready: true }),
      });
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ url: 'http://localhost:5173' });
  });

  it('turns a dead socket into a sentence instead of a raw errno', async () => {
    const result = await requestDriveSession(4400, 'http://localhost:5173', () =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:4400')),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('4400');
  });
});

/**
 * EADDRINUSE must never reach a user. These are the two sentences that replace it.
 */
describe('what the user reads when drive cannot bind', () => {
  it('the attach line names the session and the daemon it lives in', () => {
    const line = describeAttached(4400, 'http://localhost:5173', {
      sessionId: 'lease-7',
      ready: true,
    });
    expect(line).toContain('lease-7');
    expect(line).toContain('4400');
    expect(line).not.toContain('EADDRINUSE');
  });

  it('the attach line warns when the leased tab never connected', () => {
    const line = describeAttached(4400, 'http://localhost:5173', {
      sessionId: 'lease-7',
      ready: false,
    });
    expect(line).toContain('did not connect');
  });

  it('the not-ready line names the SDK package the page has to load', () => {
    const line = describeAttached(4400, 'http://localhost:5173', {
      sessionId: 'lease-7',
      ready: false,
    });
    expect(line).toContain('@reticlehq/browser');
    expect(line).not.toContain('@reticlehq/core');
  });

  it('a lost bind race says a daemon took the port and that re-running attaches to it', () => {
    // The one case the pre-bind probe cannot close: something wins the port between the probe and
    // the listen. It is not a foreign holder and must not be described as one.
    const message = driveRaceLost(4400, 'http://localhost:5173');
    expect(message).toContain('4400');
    expect(message).toContain('reticle drive http://localhost:5173');
    expect(message).not.toContain('EADDRINUSE');
  });

  it('a foreign holder keeps the sentence that already explains one, minus a flag drive rejects', () => {
    const message = driveForeignHolder(describePresence(PortPresence.FOREIGN, 4400));
    expect(message).toContain('4400');
    // `--port` is real for serve/status/doctor and rejected outright by drive, so offering it here
    // is a second dead end at the moment the reader has already hit one.
    expect(message).toContain('RETICLE_PORT');
    expect(message).not.toContain('EADDRINUSE');
  });
});

/**
 * In a monorepo the port you meant for app A can be held by app B, and port, url and session id all
 * look the same either way. The page reports its own project, so the attach line says which one it
 * is and warns when this directory names a different one.
 */
describe('which app drive attached to', () => {
  const url = 'http://localhost:5177';
  const session = { sessionId: 'lease-7', ready: true };
  const status = {
    running: true,
    sessionCount: 2,
    sessions: [
      { sessionId: 'tab-1', url: 'http://localhost:5173/', projectId: 'web' },
      { sessionId: 'lease-7', url: `${url}/`, projectId: 'admin', title: 'Admin console' },
    ],
  };

  it('reads the project and title of the attached session from /status', () => {
    expect(attachedApp(status, 'lease-7', 'admin')).toEqual({
      projectId: 'admin',
      title: 'Admin console',
      expectedProjectId: 'admin',
    });
  });

  it('names the project and title in the attach line', () => {
    const line = describeAttached(4400, url, session, attachedApp(status, 'lease-7', 'admin'));
    expect(line).toContain('admin');
    expect(line).toContain('Admin console');
    expect(line).not.toMatch(/warning/i);
  });

  it("warns when the page is a different project from this directory's .reticle.json", () => {
    const line = describeAttached(4400, url, session, attachedApp(status, 'lease-7', 'web'));
    expect(line).toMatch(/warning/i);
    expect(line).toContain('web');
    expect(line).toContain('admin');
  });

  it('does not warn when there is nothing to compare', () => {
    const noProject = { sessions: [{ sessionId: 'lease-7', url }] };
    expect(
      describeAttached(4400, url, session, attachedApp(noProject, 'lease-7', 'web')),
    ).not.toMatch(/warning/i);
    expect(
      describeAttached(4400, url, session, attachedApp(status, 'lease-7', undefined)),
    ).not.toMatch(/warning/i);
  });

  /** Both come from the page, and the line and the JSON beside it go straight to a terminal. */
  it('prints the project and title inert, so a page cannot write escape codes to the terminal', () => {
    const esc = String.fromCharCode(27);
    const csi = String.fromCharCode(0x9b);
    const hostile = {
      sessions: [
        {
          sessionId: 'lease-7',
          url,
          projectId: `admin${esc}]0;owned${String.fromCharCode(7)}`,
          title: `Admin${esc}[2J${csi}1;1H`,
        },
      ],
    };
    const app = attachedApp(hostile, 'lease-7', 'web');
    // The JSON line logs these fields too, and JSON leaves 0x80 to 0x9f as they are.
    expect(JSON.stringify(app)).not.toContain(csi);
    const line = describeAttached(4400, url, session, app);
    for (const control of [esc, csi, String.fromCharCode(7)]) {
      expect(line).not.toContain(control);
    }
    expect(line).toContain('admin\uFFFD]0;owned\uFFFD');
  });

  it('says nothing about a project when /status did not answer', () => {
    expect(attachedApp(undefined, 'lease-7', 'web')).toEqual({ expectedProjectId: 'web' });
  });
});

/**
 * `drive` promises a window and the attach path cannot give one: the daemon's pool was launched
 * headless at boot, and the request carries a url and nothing else. The lie is what the field report
 * opened with ("the app starts to run headlessly"), so the line has to name the constraint AND the
 * way to see the run anyway.
 */
describe('driveHeadlessOnAttach', () => {
  it('says there is no window, and where the run can be watched instead', () => {
    const line = driveHeadlessOnAttach(4400, 'http://localhost:3000');
    expect(line).toContain('headless');
    expect(line).toContain('http://localhost:3000');
    expect(line).toContain('4400');
  });
});
