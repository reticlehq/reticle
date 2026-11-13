/**
 * A daemon that fails to start must say why in its own log.
 *
 * #2043: on Windows, through npx, daemons died about 100 ms after they started. Every death sent
 * `daemonDeath_end: "unknown"`, because the log had no heartbeat and no line that a reader could
 * classify. These tests start a real `listen` on a port that is held, and read the log back.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonEnd, DaemonStartupError } from '@reticlehq/core';
import { classifyDaemonLife } from './heartbeat.js';
import { deathCauseFromLog } from './death-cause.js';
import {
  installStartupTrap,
  readDaemonStartupCause,
  recordStartupFailure,
  type StartupTrapTarget,
} from './startup-failure.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readDaemonStartupCause', () => {
  it('returns the startup error recorded by the failed daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-startup-cause-'));
    dirs.push(dir);
    const path = join(dir, 'daemon.log');
    const since = Date.parse('2026-09-06T15:00:00.000Z');
    writeFileSync(
      path,
      [
        JSON.stringify({
          t: '2026-09-06T15:00:00.100Z',
          event: 'reticle_daemon_start_failed',
          error: 'Chromium is not installed for Playwright. Run the pinned install command.',
        }),
        '',
      ].join('\n'),
    );

    expect(readDaemonStartupCause(path, since)).toBe(
      'Chromium is not installed for Playwright. Run the pinned install command.',
    );
  });

  it('does not surface a failure from an earlier daemon attempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-startup-cause-'));
    dirs.push(dir);
    const path = join(dir, 'daemon.log');
    writeFileSync(
      path,
      `${JSON.stringify({
        t: '2026-09-06T14:59:59.999Z',
        event: 'reticle_daemon_start_failed',
        error: 'stale cause',
      })}\n`,
    );

    expect(readDaemonStartupCause(path, Date.parse('2026-09-06T15:00:00.000Z'))).toBeUndefined();
  });
});

const LOOPBACK = '127.0.0.1';

/** Listen on `port`, and resolve with the error of the bind, or undefined when it bound. */
function listenOn(server: Server, port: number): Promise<Error | undefined> {
  return new Promise((resolve) => {
    server.once('error', (error) => resolve(error));
    server.listen(port, LOOPBACK, () => resolve(undefined));
  });
}

function addressPort(server: Server): number {
  const address = server.address();
  if (null === address || 'string' === typeof address) {
    throw new Error('the holder has no port');
  }
  return address.port;
}

interface Line {
  t: string;
  event: string;
  [field: string]: unknown;
}

/** A log that keeps its lines in the shape `log()` writes them. */
function captureLog(): {
  lines: Line[];
  log: (event: string, fields: Record<string, unknown>) => void;
} {
  const lines: Line[] = [];
  return {
    lines,
    log: (event, fields) => {
      lines.push({ t: new Date().toISOString(), event, ...fields });
    },
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('recordStartupFailure', () => {
  it('writes the code of a failed listen, and the log then reads as a failed start, not unknown', async () => {
    const holder = createServer();
    servers.push(holder);
    expect(await listenOn(holder, 0)).toBeUndefined();
    const daemon = createServer();
    servers.push(daemon);
    const error = await listenOn(daemon, addressPort(holder));
    expect(error).toBeDefined();

    const startedMs = Date.now() - 1;
    const { lines, log } = captureLog();
    recordStartupFailure(log, error, DaemonStartupError.START);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'reticle_daemon_start_failed',
      code: 'EADDRINUSE',
      stage: DaemonStartupError.LISTEN,
    });
    const parsed = lines.map((line) => ({ ...line, t: Date.parse(line.t) }));
    expect(classifyDaemonLife(parsed, Date.now()).end).toBe(DaemonEnd.START_FAILED);

    const text = lines.map((line) => JSON.stringify(line)).join('\n');
    expect(deathCauseFromLog(text, startedMs, Date.now() + 1_000)).toEqual({
      end: DaemonEnd.START_FAILED,
      startupError: DaemonStartupError.LISTEN,
      error: 'EADDRINUSE',
    });
  });

  it('keeps the stage the caller gave when the failure is not a listen', () => {
    const { lines, log } = captureLog();
    recordStartupFailure(log, new Error('no browser'), DaemonStartupError.START);
    expect(lines[0]).toMatchObject({ stage: DaemonStartupError.START, error: 'no browser' });
    expect(lines[0]).not.toHaveProperty('code');
  });

  it('writes no code that is not a Node error code', () => {
    const { lines, log } = captureLog();
    const error = Object.assign(new Error('odd'), { code: 'not a code /Users/someone' });
    recordStartupFailure(log, error, DaemonStartupError.START);
    expect(lines[0]).not.toHaveProperty('code');
  });
});

/** A process that keeps its listeners, so a test can fire them in order. */
function fakeProcess(): StartupTrapTarget & {
  fire(event: 'uncaughtException' | 'unhandledRejection', value: unknown): void;
  count(): number;
} {
  const listeners: { event: string; handler: (value: unknown) => void }[] = [];
  return {
    prependListener(event, handler) {
      listeners.unshift({ event, handler });
    },
    off(event, handler) {
      const index = listeners.findIndex((l) => l.event === event && l.handler === handler);
      if (-1 !== index) {
        listeners.splice(index, 1);
      }
    },
    fire(event, value) {
      for (const listener of listeners.filter((l) => l.event === event)) {
        listener.handler(value);
      }
    },
    count: () => listeners.length,
  };
}

describe('installStartupTrap', () => {
  it('writes an uncaught throw during the start to the log, with its code', () => {
    const proc = fakeProcess();
    const { lines, log } = captureLog();
    installStartupTrap(proc, log);
    proc.fire('uncaughtException', Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'reticle_daemon_start_failed',
      stage: DaemonStartupError.UNCAUGHT_EXCEPTION,
      code: 'EACCES',
    });
  });

  it('writes an unhandled rejection during the start, and writes one line for one death', () => {
    const proc = fakeProcess();
    const { lines, log } = captureLog();
    installStartupTrap(proc, log);
    proc.fire('unhandledRejection', new Error('first'));
    proc.fire('uncaughtException', new Error('second'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ stage: DaemonStartupError.UNHANDLED_REJECTION });
  });

  it('removes its listeners when the start is done', () => {
    const proc = fakeProcess();
    const { lines, log } = captureLog();
    const dispose = installStartupTrap(proc, log);
    dispose();
    expect(proc.count()).toBe(0);
    proc.fire('uncaughtException', new Error('later'));
    expect(lines).toHaveLength(0);
  });
});
