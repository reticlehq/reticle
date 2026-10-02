import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOPBACK_HOST } from '@reticlehq/core';
import { expect, it, vi } from 'vitest';
import { handleStatus } from '@/command/cli.js';
import { STATE_DIR_ENV, writePid } from '@/command/daemon/daemon.js';
import { handleDoctor } from './cli-doctor.js';

async function reserveThenReleasePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (null === address || 'string' === typeof address) throw new Error('TCP port was not assigned');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (undefined === error ? resolve() : reject(error)));
  });
  return address.port;
}

it('doctor and status both report stopped when a live recorded pid has no daemon port', async () => {
  const port = await reserveThenReleasePort();
  const stateHome = mkdtempSync(join(tmpdir(), 'reticle-health-parity-'));
  const previousStateHome = process.env[STATE_DIR_ENV];
  let doctorOutput = '';
  let statusOutput = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    doctorOutput += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    statusOutput += String(chunk);
    return true;
  });

  try {
    process.env[STATE_DIR_ENV] = stateHome;
    writePid(port); // Records this still-live Vitest process: the exact shortcut that made status lie.

    await handleStatus(port, true);
    // Then again in its default shape, which is what a person actually reads. Both, because the
    // parity that matters is no longer only between two payloads: doctor and status now print the
    // same daemon row, and a reader comparing them must not be told two different things.
    const jsonOnly = statusOutput;
    await handleStatus(port);
    await handleDoctor(port);

    const statusLine = jsonOnly
      .split('\n')
      .find((line) => line.includes('"event":"reticle_status"'));
    expect(statusLine).toBeDefined();
    expect(JSON.parse(statusLine ?? '{}')).toMatchObject({
      event: 'reticle_status',
      port,
      running: false,
      presence: 'free',
    });
    const notRunning = new RegExp(`daemon\\s+✗ not running on :${String(port)}`);
    expect(doctorOutput).toMatch(notRunning);
    // `handleStatus`'s block goes to stdout, which this spy is also collecting.
    expect(doctorOutput).toMatch(new RegExp(`${notRunning.source}[\\s\\S]*${notRunning.source}`));
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    if (undefined === previousStateHome) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = previousStateHome;
    rmSync(stateHome, { recursive: true, force: true });
  }
});
