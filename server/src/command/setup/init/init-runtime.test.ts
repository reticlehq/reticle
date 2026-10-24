import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMUNITY_HINT, type InitResult } from '@reticlehq/init';
import { continueAfterInit, htmlCarriesSdk } from './init-runtime.js';
import { registerOtherAgents, runSetupCommand } from '../setup-command.js';
import { LicenseWrite, writeLicenseKey } from '../license-key.js';
import { SetupPhase } from '../run-setup.js';
import { bridgeOccupied } from '../bringup/bridge-port.js';
import { reportInitOutcome } from '@/telemetry/init-telemetry.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { PortPresence, probePresence } from '@/command/daemon/binding/port-presence.js';

vi.mock('../setup-command.js', () => ({
  registerOtherAgents: vi.fn(),
  runSetupCommand: vi.fn(),
}));
vi.mock('@/command/daemon/binding/port-presence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/command/daemon/binding/port-presence.js')>()),
  probePresence: vi.fn(),
}));
vi.mock('../bringup/bridge-port.js', () => ({ bridgeOccupied: vi.fn(), freePortAfter: vi.fn() }));
vi.mock('@/telemetry/init-telemetry.js', () => ({ reportInitOutcome: vi.fn() }));
vi.mock('@/command/daemon/binding/daemon-status-probe.js', () => ({ fetchStatus: vi.fn() }));
vi.mock('../license-key.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../license-key.js')>()),
  writeLicenseKey: vi.fn(),
}));

const RESULT: InitResult = {
  ok: true,
  applied: 1,
  manual: 0,
  outcome: { ok: true, stack: 'vite', mcpRegistered: true },
  context: { appDir: '/app', framework: 'vite', packageManager: 'npm' },
};
const ARGS = { port: 4400, dryRun: false, mcp: false };
const IO = { print: vi.fn() };
const SUCCESS = {
  ok: true,
  flowSaved: false,
  fallback: [],
  notes: [],
  reachedPhase: SetupPhase.CONNECT,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runSetupCommand).mockResolvedValue(SUCCESS);
  vi.mocked(bridgeOccupied).mockReturnValue(undefined);
  vi.mocked(probePresence).mockResolvedValue(PortPresence.FREE);
  vi.mocked(writeLicenseKey).mockReturnValue({
    action: LicenseWrite.WRITTEN,
    gitignoreUpdated: true,
    message: 'license key written',
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('init reports its deferred outcome once, after runtime setup', () => {
  it('does not register agents when dry-run and files-only are combined', async () => {
    await continueAfterInit(
      { ...ARGS, dryRun: true, filesOnly: true, mcp: true },
      { ok: true, applied: 0, manual: 0 },
      IO,
      '/app',
    );
    expect(registerOtherAgents).not.toHaveBeenCalled();
    expect(runSetupCommand).not.toHaveBeenCalled();
    expect(reportInitOutcome).not.toHaveBeenCalled();
  });

  it('does not persist a license during a dry run', async () => {
    await continueAfterInit(
      { ...ARGS, dryRun: true, licenseKey: 'synthetic-experiment-license' },
      { ok: true, applied: 0, manual: 0 },
      IO,
      '/app',
    );
    expect(writeLicenseKey).not.toHaveBeenCalled();
  });

  it('still registers agents and saves a license on a real files-only run', async () => {
    await continueAfterInit(
      { ...ARGS, filesOnly: true, mcp: true, licenseKey: 'synthetic-experiment-license' },
      { ok: true, applied: 1, manual: 0 },
      IO,
      '/app',
    );
    expect(registerOtherAgents).toHaveBeenCalledOnce();
    expect(writeLicenseKey).toHaveBeenCalledExactlyOnceWith(
      '/app',
      'synthetic-experiment-license',
      expect.any(Object),
    );
  });

  it('tells an agent with no Reticle tools attached to restart, after the app connects', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.mocked(fetchStatus).mockResolvedValue({ running: true, version: '3.7.0', sessions: [] });
    const print = vi.fn();
    await continueAfterInit(ARGS, RESULT, { print }, '/app');
    vi.unstubAllEnvs();
    expect(print.mock.calls.flat().join('\n')).toContain('Restart your coding agent now');
  });

  it('does not tell an agent that has the tools to restart', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.mocked(fetchStatus).mockResolvedValue({ running: true, sessions: [], mcpPeers: ['3.7.0'] });
    const print = vi.fn();
    await continueAfterInit(ARGS, RESULT, { print }, '/app');
    vi.unstubAllEnvs();
    expect(print.mock.calls.flat().join('\n')).not.toContain('Restart your coding agent');
  });

  it('ends a connected setup with the community line', async () => {
    const print = vi.fn();
    await continueAfterInit(ARGS, RESULT, { print }, '/app');
    expect(print.mock.calls.at(-1)).toEqual([COMMUNITY_HINT]);
  });

  it('does not print the community line when setup did not finish', async () => {
    vi.mocked(runSetupCommand).mockResolvedValue({ ...SUCCESS, ok: false });
    const print = vi.fn();
    await expect(continueAfterInit(ARGS, RESULT, { print }, '/app')).rejects.toThrow('exit');
    expect(print.mock.calls.flat()).not.toContain(COMMUNITY_HINT);
  });

  it('records a connected app after the default continuation', async () => {
    await continueAfterInit(ARGS, RESULT, IO, '/app');
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      confirmation: 'connected',
    });
  });

  it.each([
    [SetupPhase.DEV_SERVER, 'dev_server'],
    [SetupPhase.CONNECT, 'app_connection'],
  ])('classifies failure in %s before exiting', async (reachedPhase, reason) => {
    vi.mocked(runSetupCommand).mockResolvedValue({ ...SUCCESS, ok: false, reachedPhase });
    await expect(continueAfterInit(ARGS, RESULT, IO, '/app')).rejects.toThrow('exit');
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      ok: false,
      reason,
    });
  });

  it('carries the step setup stopped at, so the failure says which one', async () => {
    vi.mocked(runSetupCommand).mockResolvedValue({
      ...SUCCESS,
      ok: false,
      reachedPhase: SetupPhase.DEV_SERVER,
      stop: 'port_busy',
    });
    await expect(continueAfterInit(ARGS, RESULT, IO, '/app')).rejects.toThrow('exit');
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      ok: false,
      reason: 'dev_server',
      stop: 'port_busy',
    });
  });

  it('reports a bridge collision without starting the app', async () => {
    vi.mocked(bridgeOccupied).mockReturnValue('port occupied');
    await expect(continueAfterInit(ARGS, RESULT, IO, '/app')).rejects.toThrow('exit');
    expect(runSetupCommand).not.toHaveBeenCalled();
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      ok: false,
      reason: 'bridge_occupied',
    });
  });

  it('reports an unexpected bridge probe failure', async () => {
    vi.mocked(probePresence).mockRejectedValue(new Error('probe failed'));
    await expect(continueAfterInit(ARGS, RESULT, IO, '/app')).rejects.toThrow('probe failed');
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      ok: false,
      reason: 'runtime_error',
    });
  });

  it('clears a provisional failure after the app actually connects', async () => {
    await continueAfterInit(
      ARGS,
      {
        ...RESULT,
        ok: false,
        outcome: { ...RESULT.outcome, ok: false, reason: 'other' },
      },
      IO,
      '/app',
    );
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      confirmation: 'connected',
    });
  });

  it('classifies runtime exceptions without sending their message', async () => {
    vi.mocked(runSetupCommand).mockRejectedValue(new Error('private path /users/alice/app'));
    await expect(continueAfterInit(ARGS, RESULT, IO, '/app')).rejects.toThrow('private path');
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      ok: false,
      reason: 'runtime_error',
    });
  });

  it('reports in JSON mode too', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await continueAfterInit({ ...ARGS, json: true }, RESULT, IO, '/app');
    expect(reportInitOutcome).toHaveBeenCalledTimes(1);
  });

  it('returns a JSON result for a files-only failure', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await expect(
      continueAfterInit(
        { ...ARGS, json: true, filesOnly: true },
        {
          ok: false,
          applied: 0,
          manual: 0,
        },
        IO,
        '/app',
      ),
    ).rejects.toThrow('exit');
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"ok": false'));
  });

  it('returns a JSON result when init has no runtime context', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await expect(
      continueAfterInit(
        { ...ARGS, json: true },
        {
          ok: false,
          applied: 0,
          manual: 0,
        },
        IO,
        '/app',
      ),
    ).rejects.toThrow('exit');
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"ok": false'));
  });

  it('does not duplicate an early failure already reported by init', async () => {
    await expect(
      continueAfterInit(ARGS, { ok: false, applied: 0, manual: 0 }, IO, '/app'),
    ).rejects.toThrow('exit');
    expect(reportInitOutcome).not.toHaveBeenCalled();
  });

  it('passes an explicit timeout to both startup and connection', async () => {
    await continueAfterInit({ ...ARGS, timeoutSeconds: 3 }, RESULT, IO, '/app');
    expect(runSetupCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        startupBudgetMs: 3_000,
        connectBudgetMs: 3_000,
      }),
      expect.any(Function),
    );
  });
});

describe('htmlCarriesSdk — when a page without the SDK means a stale dev server', () => {
  it('is true for a Next App Router project: its flight data names reticle-dev', () => {
    expect(htmlCarriesSdk('next', (p) => 'app/reticle-dev.tsx' === p)).toBe(true);
    expect(htmlCarriesSdk('next', (p) => 'src/app/reticle-dev.jsx' === p)).toBe(true);
  });

  it('stays false for the Pages Router, whose HTML names chunks rather than modules', () => {
    expect(htmlCarriesSdk('next', () => false)).toBe(false);
  });

  it('keeps Vite and plain HTML as they were', () => {
    expect(htmlCarriesSdk('vite', () => false)).toBe(true);
    expect(htmlCarriesSdk('html', () => false)).toBe(true);
  });
});

/**
 * `reticle connect` runs init first on a fresh project, and init exiting on a ⚠ ended connect
 * before it signed in: the person was never told to run it again, and a second identical run is what
 * worked. Under connect, a setup that did not finish is reported and the run carries on.
 */
describe('init run as the first half of connect', () => {
  it('reports the unfinished setup and returns instead of exiting', async () => {
    vi.mocked(runSetupCommand).mockResolvedValue({
      ...SUCCESS,
      ok: false,
      fallback: ['add the snippet'],
    });
    const before = process.exitCode;
    // Resolving at all is the claim: the mocked exit throws.
    await expect(
      continueAfterInit({ ...ARGS, keepGoing: true }, RESULT, IO, '/app'),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  });

  it('still exits on its own, as before, when init is the whole command', async () => {
    vi.mocked(runSetupCommand).mockResolvedValue({ ...SUCCESS, ok: false });
    await expect(continueAfterInit(ARGS, RESULT, IO, '/app')).rejects.toThrow('exit');
  });
});

/**
 * `init` defers its outcome to this phase on every run, so every exit from here has to report it.
 * Three did not: a run with nothing to continue (the dependency install failed), a runtime phase
 * that threw, and a Ctrl-C during the wait. Each left a machine that ran init with no
 * `init_completed` at all.
 */
describe('every exit reports init_completed, once', () => {
  it('reports when there is nothing to continue with', async () => {
    const { context: _dropped, ...noContext } = RESULT;
    const failed = {
      ...noContext,
      ok: false,
      outcome: { ok: false, reason: 'dependency_install' },
    };
    await expect(continueAfterInit(ARGS, failed, IO, '/app')).rejects.toThrow('exit');
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith(failed.outcome);
  });

  it('reports a runtime phase that threw', async () => {
    vi.mocked(runSetupCommand).mockRejectedValue(new Error('boom'));
    await expect(continueAfterInit(ARGS, RESULT, IO, '/app')).rejects.toThrow('boom');
    expect(reportInitOutcome).toHaveBeenCalledExactlyOnceWith({
      ...RESULT.outcome,
      ok: false,
      reason: 'runtime_error',
    });
  });

  it('reports an interrupt during the runtime phase, before the process goes', async () => {
    let interrupt: (() => void) | undefined;
    // The handler exits when it is the only listener; here the process must survive to be asserted.
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(runSetupCommand).mockImplementation(() => {
      interrupt = process.listeners('SIGINT').at(-1) as (() => void) | undefined;
      interrupt?.();
      return Promise.resolve(SUCCESS);
    });
    await continueAfterInit(ARGS, RESULT, IO, '/app');
    expect(interrupt, 'no interrupt handler was installed').toBeDefined();
    expect(reportInitOutcome).toHaveBeenNthCalledWith(1, {
      ...RESULT.outcome,
      ok: false,
      reason: 'interrupted',
    });
    expect(reportInitOutcome, 'reported once, not again on the way out').toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).not.toContain(interrupt);
  });
});
