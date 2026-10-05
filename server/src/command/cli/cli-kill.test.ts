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

import { describe, expect, it, vi } from 'vitest';
import { KillAction, planKill, runKill } from './cli-kill.js';

vi.mock('@/command/daemon/daemon.js', () => ({
  isAlive: () => true,
  readPid: () => null,
  removePid: () => undefined,
}));

vi.mock('@/command/daemon/binding/port-presence.js', () => ({
  PortPresence: {
    DAEMON: 'daemon',
    FOREIGN: 'foreign',
    FREE: 'free',
  },
  probePresence: vi.fn(),
  probePresenceWithStatus: vi.fn(),
}));

vi.mock('@/command/daemon/binding/daemon-status-probe.js', () => ({
  fetchStatus: vi.fn(),
}));

vi.mock('@/surface/mcp/mcp-proxy.js', () => ({
  probeDaemon: vi.fn(),
}));

vi.mock('./ports/port-holder.js', () => ({
  captureLookup: vi.fn(),
  findPortHolder: vi.fn(),
}));

vi.mock('@/log.js', () => ({
  log: vi.fn(),
}));

import {
  probePresence,
  probePresenceWithStatus,
  PortPresence,
} from '@/command/daemon/binding/port-presence.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { findPortHolder } from './ports/port-holder.js';

const DAEMON_PID = 70244;
const STRANGER_PID = 99001;

describe('planKill', () => {
  it('has nothing to do when no listener, no recorded pid, and no daemon status', () => {
    expect(
      planKill({
        listener: null,
        recordedPid: null,
        answersStatus: false,
        force: false,
      }).action,
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

  it('refuses when /status identifies a daemon but no listener or recorded pid is available', () => {
    const plan = planKill({
      listener: null,
      recordedPid: null,
      answersStatus: true,
      force: false,
    });

    expect(plan.action).toBe(KillAction.REFUSE);
    expect(plan.pid).toBeUndefined();
  });

  it('does not report success when the killed process exits but the port is still occupied', async () => {
    vi.mocked(probePresenceWithStatus).mockResolvedValueOnce({
      presence: PortPresence.DAEMON,
      status: { running: true, pid: DAEMON_PID },
    });

    vi.mocked(probePresence).mockResolvedValueOnce(PortPresence.FOREIGN);

    vi.mocked(findPortHolder).mockReturnValue({
      pid: DAEMON_PID,
      command: 'node',
    });

    vi.mocked(fetchStatus).mockResolvedValue({ running: true, pid: DAEMON_PID });

    const terminateProcess = vi.fn().mockResolvedValue({
      gone: true,
      escalated: false,
    });

    const result = await runKill(4400, false, terminateProcess);

    expect(terminateProcess).toHaveBeenCalledWith(DAEMON_PID);
    expect(probePresenceWithStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledTimes(0);
    expect(probePresence).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });
});
