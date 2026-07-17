import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonRegistryFileName, type DaemonRegistryEntry } from '@reticlehq/core';
import { discoverDaemonPort } from './discover-port.js';

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

  it('returns undefined when ~/.reticle does not exist', () => {
    expect(discoverDaemonPort('my-app', join(home, 'nope'), alive)).toBeUndefined();
  });
});
