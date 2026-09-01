/**
 * The four cases get four different actions, and none of them invents a command.
 *
 * The prose diagnosis already tells them apart. What it cannot do is be executed, and the guard that
 * matters most is the negative one: a start-the-dev-server command handed back while a dev server is
 * already up starts a SECOND one on a second port, which is the failure the whole probe exists to
 * prevent.
 */

import { describe, it, expect } from 'vitest';
import { NoSessionAction } from '@reticlehq/core';
import { nextActionFor, renderNextAction } from './no-session-next-action.js';

const DEV = { command: 'pnpm run dev', script: 'dev' } as const;

describe('nextActionFor', () => {
  it('nothing listening: hand back the project’s own dev command', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [],
      dev: DEV,
    });
    expect(next.action).toBe(NoSessionAction.START_DEV_SERVER);
    expect(next.command).toBe('pnpm run dev');
  });

  it('nothing listening and no dev script: says so, and returns NO command', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [],
      dev: undefined,
    });
    expect(next.action).toBe(NoSessionAction.START_DEV_SERVER);
    expect(next.command).toBeUndefined();
    expect(next.reason).toContain('no dev script');
  });

  it('carries the port the dev script pins, so the agent knows where the app will be', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [],
      dev: { command: 'npm run dev', script: 'dev', port: 4311 },
    });
    expect(next.port).toBe(4311);
  });

  it('something listening but the project is not wired: run init, NOT the dev server', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: [5173],
      dev: DEV,
    });
    expect(next.action).toBe(NoSessionAction.RUN_INIT);
    expect(next.command).toBe('reticle init');
    expect(next.command).not.toContain('run dev');
  });

  it('a config found in another app directory is a scope problem, never an init problem', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: [5173],
      dev: DEV,
      configsElsewhere: [{ directory: '/repo/apps/client', projectId: 'client-1' }],
    });
    expect(next.action).toBe(NoSessionAction.OPEN_APP);
    expect(next.command).not.toBe('reticle init');
    expect(next.reason).toContain('/repo/apps/client');
    expect(next.reason).toContain('client-1');
    expect(next.reason).toMatch(/scope|directory/i);
    expect(next.reason).toContain('reticle_lease');
  });

  it('a wired app is listening: open it — never a second dev server', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [5173],
      dev: DEV,
    });
    expect(next.action).toBe(NoSessionAction.OPEN_APP);
    expect(next.command).toBe('reticle open http://localhost:5173');
    expect(next.port).toBe(5173);
  });

  it('never returns a start command while ANYTHING is listening', () => {
    for (const initialized of [true, false]) {
      const next = nextActionFor({
        everConnected: false,
        initialized,
        listening: [5173],
        dev: DEV,
      });
      expect(next.action).not.toBe(NoSessionAction.START_DEV_SERVER);
      expect(next.command ?? '').not.toContain(DEV.command);
    }
  });

  it('several listeners: no command, because none of them can be attributed to this project', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [5173, 8080],
      dev: DEV,
    });
    expect(next.action).toBe(NoSessionAction.OPEN_APP);
    expect(next.command).toBeUndefined();
    expect(next.reason).toContain('5173, 8080');
  });

  it('a session was here and went away: reopen, whatever the ports say', () => {
    const next = nextActionFor({
      everConnected: true,
      initialized: true,
      listening: [],
      dev: DEV,
    });
    expect(next.action).toBe(NoSessionAction.REOPEN_APP);
    expect(next.command).toBeUndefined();
  });

  it('a session was here AND a port is bound: say so, so nobody starts a second stack', () => {
    const next = nextActionFor({
      everConnected: true,
      initialized: true,
      listening: [5173],
      dev: DEV,
    });
    expect(next.action).toBe(NoSessionAction.REOPEN_APP);
    expect(next.reason).toContain('5173');
    expect(next.reason).toMatch(/already listening/i);
    expect(next.reason).toMatch(/do not start a second/i);
    expect(next.command).toBe('reticle open http://localhost:5173');
    expect(next.port).toBe(5173);
  });
});

describe('renderNextAction', () => {
  it('puts the literal command in the prose, in backticks', () => {
    const line = renderNextAction(
      nextActionFor({ everConnected: false, initialized: true, listening: [], dev: DEV }),
    );
    expect(line).toContain('`pnpm run dev`');
  });

  it('renders the reason alone when there is no command to name', () => {
    const line = renderNextAction(
      nextActionFor({ everConnected: false, initialized: true, listening: [], dev: undefined }),
    );
    expect(line).not.toContain('``');
    expect(line).toContain('no dev script');
  });
});

describe('the scan is narrow, and the reason must say so in both branches', () => {
  /**
   * The same function states the same fact at two confidence levels. The branch with no dev script
   * says the app is "probably not running"; the branch that HANDS OVER A COMMAND says flatly that
   * it "is not running" — and that is the branch where being wrong costs something, because the
   * agent then starts a second dev server on a second port. The comment ten lines below calls that
   * "the exact confusion the probe exists to prevent".
   *
   * It is also contradicted inside its own payload: the paragraph above it says the scan is narrow,
   * that a server on any other port is invisible to it, and that the app being up should be checked
   * rather than assumed. Measured on this machine, three dev servers were running on ports the scan
   * does not cover while it reported the app was not running.
   */
  it('does not assert the app is down when the scan cannot see every port', () => {
    const withScript = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [],
      dev: DEV,
    });
    expect(withScript.reason).not.toMatch(/so the app is not running/);
    expect(withScript.reason).toMatch(/probably|may not/i);
  });

  it('still hands over the command, because starting it is usually right', () => {
    const withScript = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [],
      dev: DEV,
    });
    expect(withScript.command).toBe('pnpm run dev');
  });

  it('names the other possibility, so a running app on an unscanned port is not started twice', () => {
    const withScript = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: [],
      dev: DEV,
    });
    expect(withScript.reason).toMatch(/URL|another port|different port/i);
  });
});
