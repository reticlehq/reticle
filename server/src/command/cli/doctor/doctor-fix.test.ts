/**
 * `reticle doctor --fix` repairs a half-done install, and a second run does nothing.
 *
 * Each repair is tested with its facts injected. The runner is tested with fake repairs and a fake
 * doctor, so no test here touches the home directory, a port or the network.
 */
import { describe, expect, it } from 'vitest';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { parseCliArgs } from '../cli-parse.js';
import { PortPresence } from '@/command/daemon/binding/port-presence.js';
import { DoctorRow, doctorRow } from './doctor-rows.js';
import { fixFooter, runDoctorFix, type DoctorRepair } from './doctor-fix.js';
import {
  chromiumRepair,
  mcpRegistrationRow,
  mcpRepair,
  stalePidRepair,
  wedgedDaemonRepair,
} from '../doctor-repairs.js';

/** A repair whose state is one flag: `broken` until `apply` runs, if `takes`. */
function fakeRepair(
  row: DoctorRepair['row'],
  state: { broken: boolean; takes: boolean; applied: number },
): DoctorRepair {
  return {
    row,
    what: row,
    step: `manual step for ${row}`,
    needed: () => Promise.resolve(state.broken),
    apply: () => {
      state.applied++;
      if (state.takes) {
        state.broken = false;
      }
      return Promise.resolve();
    },
  };
}

/** A doctor that prints a ✗ row for each broken repair, plus `extra`. */
function fakeDoctor(
  states: readonly { row: DoctorRepair['row']; state: { broken: boolean } }[],
  extra: readonly string[] = [],
): () => Promise<string[]> {
  return () =>
    Promise.resolve([
      'reticle doctor',
      ...states.map(({ row, state }) => doctorRow(row, state.broken ? '✗ broken' : '✓ fine')),
      ...extra,
    ]);
}

async function run(
  repairs: readonly DoctorRepair[],
  doctor: () => Promise<string[]>,
): Promise<{ green: boolean; out: string[] }> {
  const out: string[] = [];
  const green = await runDoctorFix({ doctor, repairs, print: (line: string) => out.push(line) });
  return { green, out };
}

describe('runDoctorFix', () => {
  it('applies each needed repair, says fixed, and is green when no row fails after', async () => {
    const chromium = { broken: true, takes: true, applied: 0 };
    const mcp = { broken: false, takes: true, applied: 0 };
    const { green, out } = await run(
      [fakeRepair(DoctorRow.CHROMIUM, chromium), fakeRepair(DoctorRow.MCP, mcp)],
      fakeDoctor([
        { row: DoctorRow.CHROMIUM, state: chromium },
        { row: DoctorRow.MCP, state: mcp },
      ]),
    );
    expect(chromium.applied).toBe(1);
    expect(mcp.applied).toBe(0);
    expect(out).toContain(doctorRow(DoctorRow.CHROMIUM, 'chromium: fixed'));
    expect(out).toContain(doctorRow(DoctorRow.MCP, 'mcp: nothing to do'));
    expect(green).toBe(true);
  });

  it('runs the repairs in the order given', async () => {
    const order: string[] = [];
    const repair = (row: DoctorRepair['row']): DoctorRepair => ({
      row,
      what: row,
      step: row,
      needed: () => Promise.resolve(!order.includes(row)),
      apply: () => {
        order.push(row);
        return Promise.resolve();
      },
    });
    await run(
      [repair(DoctorRow.DAEMON), repair(DoctorRow.CHROMIUM), repair(DoctorRow.MCP)],
      fakeDoctor([]),
    );
    expect(order).toEqual([DoctorRow.DAEMON, DoctorRow.CHROMIUM, DoctorRow.MCP]);
  });

  it('is idempotent: a second run applies nothing and says nothing to do', async () => {
    const chromium = { broken: true, takes: true, applied: 0 };
    const repairs = [fakeRepair(DoctorRow.CHROMIUM, chromium)];
    const doctor = fakeDoctor([{ row: DoctorRow.CHROMIUM, state: chromium }]);
    await run(repairs, doctor);
    const second = await run(repairs, doctor);
    expect(chromium.applied).toBe(1);
    expect(second.out).toContain(doctorRow(DoctorRow.CHROMIUM, 'chromium: nothing to do'));
    expect(second.out.some((l) => l.includes('fixed'))).toBe(false);
    expect(second.green).toBe(true);
  });

  it('a repair that does not take prints its manual step, once, and is not green', async () => {
    const chromium = { broken: true, takes: false, applied: 0 };
    const { green, out } = await run(
      [fakeRepair(DoctorRow.CHROMIUM, chromium)],
      fakeDoctor([{ row: DoctorRow.CHROMIUM, state: chromium }]),
    );
    expect(out).toContain(
      doctorRow(DoctorRow.CHROMIUM, 'chromium: still needs: manual step for chromium'),
    );
    expect(out.filter((l) => l.includes('chromium')).length).toBe(1);
    expect(green).toBe(false);
  });

  it('a failing row with no safe repair prints its own step and is never changed', async () => {
    const sessions = doctorRow(DoctorRow.SESSIONS, '✗ no page has connected to this daemon');
    const { green, out } = await run([], fakeDoctor([], [sessions]));
    expect(out).toContain(`  still needs: ${sessions.trim()}`);
    expect(green).toBe(false);
  });

  it('a repair that throws is reported as still needed, and the next repair still runs', async () => {
    const mcp = { broken: true, takes: true, applied: 0 };
    const throwing: DoctorRepair = {
      row: DoctorRow.CHROMIUM,
      what: 'browser',
      step: 'install it',
      needed: () => Promise.resolve(true),
      apply: () => Promise.reject(new Error('offline')),
    };
    const { out } = await run([throwing, fakeRepair(DoctorRow.MCP, mcp)], fakeDoctor([]));
    expect(out).toContain(doctorRow(DoctorRow.CHROMIUM, 'browser: still needs: install it'));
    expect(mcp.applied).toBe(1);
  });
});

describe('fixFooter', () => {
  it('names the count when a safe repair is possible', () => {
    expect(fixFooter(2)).toBe('Run `reticle doctor --fix` to repair 2 of these.');
  });
  it('says nothing when there is nothing to repair', () => {
    expect(fixFooter(0)).toBeUndefined();
  });
});

describe('stalePidRepair', () => {
  it('removes the pid file of a daemon that is not running', async () => {
    let pid: number | null = 4242;
    const repair = stalePidRepair({
      readPid: () => pid,
      isAlive: () => false,
      removePid: () => {
        pid = null;
      },
    });
    expect(await repair.needed()).toBe(true);
    await repair.apply();
    expect(await repair.needed()).toBe(false);
  });
  it('never touches the pid file of a live process', async () => {
    const repair = stalePidRepair({
      readPid: () => 4242,
      isAlive: () => true,
      removePid: () => {},
    });
    expect(await repair.needed()).toBe(false);
  });
});

describe('wedgedDaemonRepair', () => {
  it('stops a Reticle daemon that holds the port and does not answer', async () => {
    let stopped = 0;
    const repair = wedgedDaemonRepair(4400, {
      presence: () => Promise.resolve(PortPresence.FOREIGN),
      holder: () => ({ pid: 9, command: 'node reticle.js _daemon', reticleDaemon: true }),
      stop: () => {
        stopped++;
        return Promise.resolve(true);
      },
    });
    expect(await repair.needed()).toBe(true);
    await repair.apply();
    expect(stopped).toBe(1);
  });
  it('never stops a process it cannot prove is a Reticle daemon', async () => {
    const repair = wedgedDaemonRepair(4400, {
      presence: () => Promise.resolve(PortPresence.FOREIGN),
      holder: () => ({ pid: 9, command: 'python -m http.server' }),
      stop: () => Promise.resolve(true),
    });
    expect(await repair.needed()).toBe(false);
    expect(repair.step).toContain('reticle restart --port 4400');
  });
  it('leaves a daemon that answers alone', async () => {
    const repair = wedgedDaemonRepair(4400, {
      presence: () => Promise.resolve(PortPresence.DAEMON),
      holder: () => ({ pid: 9, command: 'node reticle.js _daemon', reticleDaemon: true }),
      stop: () => Promise.resolve(true),
    });
    expect(await repair.needed()).toBe(false);
  });
});

describe('chromiumRepair', () => {
  const MISSING = {
    exists: false,
    executablePath: '/b/chromium-1/chrome',
    playwrightVersion: '1.2.3',
  };
  it("installs Playwright's own Chromium when no browser can launch", async () => {
    let installed = 0;
    const repair = chromiumRepair({
      probe: () => Promise.resolve(installed > 0 ? { ...MISSING, exists: true } : MISSING),
      install: () => {
        installed++;
        return Promise.resolve();
      },
      playwrightVersion: '1.2.3',
    });
    expect(await repair.needed()).toBe(true);
    await repair.apply();
    expect(installed).toBe(1);
    expect(await repair.needed()).toBe(false);
    expect(repair.step).toContain('playwright@1.2.3 install chromium');
  });
  it('does not install when an installed Chrome stands in', async () => {
    const repair = chromiumRepair({
      probe: () => Promise.resolve({ ...MISSING, fallback: 'Google Chrome' }),
      install: () => Promise.resolve(),
      playwrightVersion: undefined,
    });
    expect(await repair.needed()).toBe(false);
  });
  it('never replaces a RETICLE_CHROMIUM_PATH the user set', async () => {
    const repair = chromiumRepair({
      probe: () => Promise.resolve({ ...MISSING, configured: true }),
      install: () => Promise.resolve(),
      playwrightVersion: undefined,
    });
    expect(await repair.needed()).toBe(false);
  });
  it('does not try when the playwright package itself is absent', async () => {
    const repair = chromiumRepair({
      probe: () => Promise.resolve({ exists: false }),
      install: () => Promise.resolve(),
      playwrightVersion: undefined,
    });
    expect(await repair.needed()).toBe(false);
  });
});

describe('mcpRepair', () => {
  it('registers Reticle with the agents that do not have it', async () => {
    let gaps = ['cursor'];
    let registered = 0;
    const repair = mcpRepair({
      gaps: () => gaps,
      register: () => {
        registered++;
        gaps = [];
      },
    });
    expect(await repair.needed()).toBe(true);
    await repair.apply();
    expect(registered).toBe(1);
    expect(await repair.needed()).toBe(false);
    expect(repair.step).toContain('reticle setup mcp');
  });
});

describe('mcpRegistrationRow', () => {
  it('fails and names each agent without Reticle', () => {
    expect(mcpRegistrationRow({ missing: ['cursor', 'windsurf'], present: ['claude-code'] })).toBe(
      doctorRow(
        DoctorRow.MCP,
        '✗ not registered with cursor, windsurf; run `reticle setup mcp` (registered with claude-code)',
      ),
    );
  });
  it('passes when every agent found has Reticle', () => {
    expect(mcpRegistrationRow({ missing: [], present: ['cursor'] })).toBe(
      doctorRow(DoctorRow.MCP, '✓ registered with cursor'),
    );
  });
  it('does not fail a machine with no agent it knows', () => {
    const row = mcpRegistrationRow({ missing: [], present: [] });
    expect(row).not.toContain('✗');
    expect(row).toContain('reticle setup mcp');
  });
});

describe('reticle doctor --fix', () => {
  it('parses the flag, and a plain doctor stays a report', () => {
    expect(parseCliArgs(['doctor', '--fix'], RETICLE_DEFAULT_PORT)).toMatchObject({
      kind: 'doctor',
      fix: true,
    });
    expect(parseCliArgs(['doctor'], RETICLE_DEFAULT_PORT)).toMatchObject({
      kind: 'doctor',
      fix: false,
    });
  });
});
