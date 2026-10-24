/**
 * `kill` has to hit the listener and nothing else.
 *
 * The command everyone reaches for to free the bridge port is `lsof -ti tcp:4400 | xargs kill -9`,
 * and it takes down the agent's own `reticle mcp` proxy along with the daemon, because the proxy
 * holds a CLIENT socket on that port and `-ti` does not filter. After that the agent's tool calls
 * get no reply at all — not an error, not a timeout — and nothing is written to the proxy log,
 * because the process that writes it is the one that died. That is the mechanism behind most
 * "my MCP disconnected" reports, and we effectively recommended it (#114, #110).
 *
 * So the plan is decided from a LISTENER lookup only, and it is pure here so the rule is tested on
 * every platform while the signalling stays at the call site.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SHUTDOWN_PATH } from '@reticlehq/core';
import { KillAction, planKill, requestShutdown } from './cli-kill.js';

const DAEMON_PID = 70244;
const STRANGER_PID = 99001;

describe('planKill', () => {
  it('has nothing to do when no listener and no live recorded pid', () => {
    expect(
      planKill({ listener: null, recordedPid: null, answersStatus: false, force: false }).action,
    ).toBe(KillAction.NOTHING);
  });

  it('kills the listener when it is the pid we recorded for the port', () => {
    const plan = planKill({
      listener: { pid: DAEMON_PID, command: 'node' },
      recordedPid: DAEMON_PID,
      answersStatus: false,
      force: false,
    });
    expect(plan.action).toBe(KillAction.KILL);
    expect(plan.pid).toBe(DAEMON_PID);
  });

  /**
   * A daemon from another checkout owns the port and our pid file knows nothing about it. It answers
   * `/status`, which is the only evidence that matters: it is a Reticle daemon, so it is ours to
   * stop. Refusing here would leave the port held by the exact process this command exists to clear.
   */
  it('kills a listener that answers /status even when our pid file disagrees', () => {
    const plan = planKill({
      listener: { pid: STRANGER_PID, command: 'node' },
      recordedPid: DAEMON_PID,
      answersStatus: true,
      force: false,
    });
    expect(plan.action).toBe(KillAction.KILL);
    expect(plan.pid).toBe(STRANGER_PID);
  });

  it('refuses a listener that is neither ours nor a daemon, and names it', () => {
    const plan = planKill({
      listener: { pid: STRANGER_PID, command: 'Docker' },
      recordedPid: null,
      answersStatus: false,
      force: false,
    });
    expect(plan.action).toBe(KillAction.REFUSE);
    expect(plan.reason).toContain('Docker');
    expect(plan.reason).toContain(String(STRANGER_PID));
    expect(plan.reason).toContain('--force');
    // `stop --force` reaches this refusal too (it is `kill` without the override), so "run it again
    // with --force" told a user who had just passed --force to repeat the call that refused them.
    expect(plan.reason).toContain('restart --force');
    expect(plan.reason).not.toContain('Run it again with');
  });

  it('kills it anyway under --force, and says the choice was forced', () => {
    const plan = planKill({
      listener: { pid: STRANGER_PID, command: 'Docker' },
      recordedPid: null,
      answersStatus: false,
      force: true,
    });
    expect(plan.action).toBe(KillAction.KILL);
    expect(plan.pid).toBe(STRANGER_PID);
    expect(plan.forced).toBe(true);
  });

  /**
   * Windows has no `lsof`, and neither does a slim container. Falling back to the recorded pid is
   * what keeps the command usable there; claiming we identified the listener would not be.
   */
  it('falls back to the recorded pid when the listener lookup cannot run, and says so', () => {
    const plan = planKill({
      listener: null,
      recordedPid: DAEMON_PID,
      answersStatus: true,
      force: false,
    });
    expect(plan.action).toBe(KillAction.KILL);
    expect(plan.pid).toBe(DAEMON_PID);
    expect(plan.identifiedListener).toBe(false);
  });

  it('never plans to kill without a pid', () => {
    for (const force of [false, true]) {
      const plan = planKill({ listener: null, recordedPid: null, answersStatus: true, force });
      expect(plan.action).not.toBe(KillAction.KILL);
    }
  });
});

/**
 * `stop` and `kill` ask the daemon over loopback before they send a signal. On Windows a signal ends
 * the process at once, so the daemon never ran its shutdown path and sent no stop event.
 */
describe('requestShutdown', () => {
  const TOKEN = 'a-secret-pairing-token';
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
  });

  function daemon(answer: (req: http.IncomingMessage) => number): Promise<number> {
    server = http.createServer((req, res) => {
      res.writeHead(answer(req)).end();
    });
    const listening = server;
    return new Promise((resolve) => {
      listening.listen(0, '127.0.0.1', () => {
        resolve((listening.address() as AddressInfo).port);
      });
    });
  }

  it('sends the pairing token and says yes when the daemon accepts', async () => {
    const port = await daemon((req) =>
      'POST' === req.method &&
      SHUTDOWN_PATH === req.url &&
      `Bearer ${TOKEN}` === req.headers.authorization
        ? 202
        : 401,
    );
    expect(await requestShutdown(port, TOKEN)).toBe(true);
  });

  it('says no for an older daemon without the route, so the caller sends the signal', async () => {
    const port = await daemon(() => 404);
    expect(await requestShutdown(port, TOKEN)).toBe(false);
  });

  it('says no with no token to send, and does not ask', async () => {
    let asked = false;
    const port = await daemon(() => {
      asked = true;
      return 202;
    });
    expect(await requestShutdown(port, undefined)).toBe(false);
    expect(asked).toBe(false);
  });

  it('says no when nothing listens', async () => {
    const port = await daemon(() => 202);
    await new Promise<void>((done) => server?.close(() => done()));
    server = undefined;
    expect(await requestShutdown(port, TOKEN)).toBe(false);
  });
});
