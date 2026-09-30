import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonRegistryFileName, type DaemonRegistryEntry } from '@reticlehq/core';
import { chooseDaemonPort, discoverDaemonPort } from './discover-port.js';

const alive = (): boolean => true;

describe('discoverDaemonPort — build-time daemon discovery by projectId', () => {
  let home: string;

  const drop = async (e: Partial<DaemonRegistryEntry> & { port: number }): Promise<void> => {
    const entry: DaemonRegistryEntry = { pid: 1, cwd: '/app', startedAt: 1, ...e };
    await writeFile(join(home, daemonRegistryFileName(e.port)), JSON.stringify(entry));
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'reticle-discover-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('finds the daemon whose projectId matches the app', async () => {
    await drop({ port: 4400, projectId: 'other-app' });
    await drop({ port: 4460, projectId: 'my-app' });
    expect(discoverDaemonPort('my-app', home, alive)).toBe(4460);
  });

  it('returns undefined when no daemon serves this project (caller uses the default port)', async () => {
    await drop({ port: 4400, projectId: 'other-app' });
    expect(discoverDaemonPort('my-app', home, alive)).toBeUndefined();
  });

  it('skips a corrupt registry file instead of throwing', async () => {
    await writeFile(join(home, daemonRegistryFileName(4400)), '{ not json');
    await drop({ port: 4460, projectId: 'my-app' });
    expect(discoverDaemonPort('my-app', home, alive)).toBe(4460);
  });

  // `init --port 4460` over a project whose daemon was on 4400: both are alive and both are this
  // project's. The page dialled the lower one and init, waiting on 4460, exited 1.
  it('dials the configured port when a live daemon is registered there', async () => {
    await drop({ port: 4400, pid: 1, projectId: 'my-app' });
    await drop({ port: 4460, pid: 2, projectId: 'my-app' });
    expect(discoverDaemonPort('my-app', home, alive, 4460)).toBe(4460);
    expect(discoverDaemonPort('my-app', home, (pid) => 2 !== pid, 4460)).toBe(4400);
  });

  it('returns undefined when ~/.reticle does not exist', () => {
    expect(discoverDaemonPort('my-app', join(home, 'nope'), alive)).toBeUndefined();
  });
});

/**
 * Where the page dials, when the three places a port can come from disagree.
 *
 * The case that shipped: a user edited `port` in .reticle.json. The daemon and the CLI moved with
 * it; the page kept dialling the literal `reticle({ port })` that init had written, so it knocked on
 * a port nothing listened on and init reported "never dialled the bridge".
 */
describe('chooseDaemonPort — dial where the daemon for this project actually is', () => {
  it('prefers a live daemon registered for this project over everything written down', () => {
    expect(chooseDaemonPort({ discovered: 4460, configured: 4471, explicit: 4480 }).port).toBe(
      4460,
    );
  });

  it('follows .reticle.json over the literal option when no daemon is registered', () => {
    expect(chooseDaemonPort({ discovered: undefined, configured: 4471, explicit: 4480 }).port).toBe(
      4471,
    );
  });

  it('uses the option when it is the only statement, and the default when there is none', () => {
    expect(
      chooseDaemonPort({ discovered: undefined, configured: undefined, explicit: 4480 }),
    ).toEqual({ port: 4480, warning: undefined });
    expect(
      chooseDaemonPort({ discovered: undefined, configured: undefined, explicit: undefined }).port,
    ).toBeUndefined();
  });

  it('names both values and the one it used when the option and .reticle.json disagree', () => {
    const { warning } = chooseDaemonPort({
      discovered: undefined,
      configured: 4471,
      explicit: 4480,
    });
    expect(warning).toContain('4480');
    expect(warning).toContain('4471');
    expect(warning).toContain('.reticle.json');
    expect(warning).toMatch(/connecting to 4471/);
  });

  it('says nothing when they agree, or when only one of them is set', () => {
    expect(
      chooseDaemonPort({ discovered: undefined, configured: 4471, explicit: 4471 }).warning,
    ).toBeUndefined();
    expect(
      chooseDaemonPort({ discovered: 4460, configured: 4471, explicit: undefined }).warning,
    ).toBeUndefined();
  });
});
