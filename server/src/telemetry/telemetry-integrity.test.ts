/**
 * What the emitter stamps on, and refuses to send, at the one place every event passes through.
 *
 * - `internal`: team dogfooding was indistinguishable from users, so a dev machine was the single
 *   biggest "user" in the data.
 * - `idEphemeral`: a read-only home minted a new id per process, and each one read as a new user.
 * - validation: the wire schema's caps were never applied, so they were decorative.
 * - the detached send put the whole event body in argv, readable by anyone running `ps`.
 * - a source checkout in feedback-only mode minted the machine id and spent its `firstRun`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { createTelemetry, droppedInvalidEvents, INTERNAL_MARKER_FILE } from './telemetry.js';

const TEST_ENV = {
  RETICLE_TELEMETRY_KEY: 'phc_test',
  RETICLE_TELEMETRY_URL: 'http://example.test',
};
const USER_PROJECT = '/tmp/some-user-app';

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-integrity-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const capture = () => {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = ((_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as {
      batch: Array<{ properties: Record<string, unknown> }>;
    };
    sent.push(body.batch[0]?.properties ?? {});
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
};

const emitOne = async (
  env: NodeJS.ProcessEnv,
  reticleDir: string,
): Promise<Record<string, unknown> | undefined> => {
  const { sent, fetchImpl } = capture();
  const t = createTelemetry({ version: '1', env, cwd: USER_PROJECT, fetchImpl, reticleDir });
  await t.emit(TelemetryEventKind.DAEMON_STARTED);
  return sent[0];
};

describe('internal runs are marked, not counted as users', () => {
  it('stamps internal: true under RETICLE_INTERNAL=1', async () => {
    const p = await emitOne({ ...TEST_ENV, RETICLE_INTERNAL: '1' }, freshDir());
    expect(p?.['internal']).toBe(true);
  });

  it('stamps it when the machine carries the internal marker file', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, INTERNAL_MARKER_FILE), '1');
    expect((await emitOne(TEST_ENV, dir))?.['internal']).toBe(true);
  });

  it('is absent for everybody else', async () => {
    expect(await emitOne(TEST_ENV, freshDir())).not.toHaveProperty('internal');
  });
});

describe('an id that could not be persisted says so', () => {
  it('stamps idEphemeral when the home cannot be written', async () => {
    // Its parent is a file, so it can never be created: fails the same way on every OS.
    const file = join(freshDir(), 'not-a-dir');
    writeFileSync(file, '');
    expect((await emitOne(TEST_ENV, join(file, 'home')))?.['idEphemeral']).toBe(true);
  });

  it('is absent when the id persisted', async () => {
    expect(await emitOne(TEST_ENV, freshDir())).not.toHaveProperty('idEphemeral');
  });
});

describe('an event that fails the wire schema is dropped, never sent', () => {
  it('drops it and counts the drop', async () => {
    const { sent, fetchImpl } = capture();
    const t = createTelemetry({
      version: '1',
      env: TEST_ENV,
      cwd: USER_PROJECT,
      fetchImpl,
      reticleDir: freshDir(),
    });
    const before = droppedInvalidEvents();
    const delivered = await t.emit(TelemetryEventKind.CLI_COMMAND_RUN, {
      command: 'x'.repeat(500),
    });
    expect(delivered).toBe(false);
    expect(sent).toHaveLength(0);
    expect(droppedInvalidEvents()).toBe(before + 1);
  });
});

describe('the detached send keeps the body out of argv', () => {
  it('hands the body to the sender outside argv', async () => {
    const spawns: Array<{ args: string[]; input: string }> = [];
    const t = createTelemetry({
      cwd: USER_PROJECT,
      version: '1',
      env: TEST_ENV,
      reticleDir: freshDir(),
      spawnImpl: (_command, args, input) => spawns.push({ args, input }),
    });
    await t.emit(TelemetryEventKind.CLI_COMMAND_RUN, { detach: true });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.join(' ')).not.toContain('phc_test');
    expect(JSON.parse(spawns[0]?.input ?? '{}')).toHaveProperty('api_key', 'phc_test');
  });
});

describe('feedback-only mode in a source checkout', () => {
  it('neither mints the machine id nor spends firstRun', () => {
    const dir = freshDir();
    const t = createTelemetry({ version: '1', env: TEST_ENV, cwd: process.cwd(), reticleDir: dir });
    expect(t.firstRun).toBe(false);
    expect(existsSync(join(dir, 'telemetry-id'))).toBe(false);
  });
});
