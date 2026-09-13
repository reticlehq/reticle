/**
 * Record telemetry to a local file instead of sending it anywhere.
 *
 * Two problems it solves at once, and they pull in the same direction:
 *
 *   1. A release sweep drives dozens of real sessions. Every one of those emits `daemon_started`,
 *      `verification_completed`, `bug_found` — indistinguishable, in PostHog, from a user. Test runs
 *      polluting the numbers is the same class of error as counting `cli_command_run { mcp }` as
 *      human intent: the metric stops describing what it claims to.
 *   2. Verifying telemetry has meant standing up an HTTP capture server by hand, every time. Ad-hoc
 *      harnesses are how a check ends up measuring nothing — the two traps already written down are
 *      that telemetry is disabled inside a Reticle checkout, and that a schema addition with no
 *      contract entry passes silently.
 *
 * A file is the whole design. `RETICLE_TELEMETRY_FILE=<path>` writes one JSON object per line and
 * sends NOTHING. It is the same payload that would have gone on the wire — built by the same code
 * path, redacted by the same rules — so what a run records is what a user would have sent.
 */

import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { createTelemetry } from './telemetry.js';

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-sink-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const readLines = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('the local telemetry sink', () => {
  it('writes the event to the file and sends NOTHING', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'events.jsonl');
      let sent = 0;
      const t = createTelemetry({
        version: '9.9.9',
        cwd: dir,
        now: () => 1,
        env: { RETICLE_TELEMETRY_FILE: path, RETICLE_TELEMETRY_KEY: 'k' },
        fetchImpl: (() => {
          sent += 1;
          return Promise.resolve({ ok: true, status: 200 });
        }) as unknown as typeof fetch,
      });
      await t.emit(TelemetryEventKind.DAEMON_STARTED);
      expect(sent, 'a recorded run must not reach the network').toBe(0);
      const lines = readLines(path);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.['event']).toBe(TelemetryEventKind.DAEMON_STARTED);
    });
  });

  it('records what would have been SENT — same shape, same properties', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'events.jsonl');
      const t = createTelemetry({
        version: '9.9.9',
        cwd: dir,
        now: () => 1,
        env: { RETICLE_TELEMETRY_FILE: path, RETICLE_TELEMETRY_KEY: 'k' },
      });
      await t.emit(TelemetryEventKind.VERIFICATION_COMPLETED, {
        verification: {
          via: 'reticle_assert',
          verified: 'yes',
          passed: true,
          falseGreenCaught: false,
        },
      });
      const props = readLines(path)[0]?.['properties'] as Record<string, unknown>;
      // Flattened exactly as the wire flattens it, so a check reading the file checks the real thing.
      expect(props['verification_via']).toBe('reticle_assert');
      expect(props['version']).toBe('9.9.9');
    });
  });

  it('APPENDS, so a whole sweep lands in one file in order', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'events.jsonl');
      const t = createTelemetry({
        version: '1',
        cwd: dir,
        now: () => 1,
        env: { RETICLE_TELEMETRY_FILE: path, RETICLE_TELEMETRY_KEY: 'k' },
      });
      await t.emit(TelemetryEventKind.DAEMON_STARTED);
      await t.emit(TelemetryEventKind.BUG_FOUND);
      expect(readLines(path).map((l) => l['event'])).toEqual([
        TelemetryEventKind.DAEMON_STARTED,
        TelemetryEventKind.BUG_FOUND,
      ]);
    });
  });

  it('reports delivery TRUE — the record landed, which is what `sent` means here', async () => {
    // reticle_feedback shows this to an agent. A recorded report really was captured.
    await withDir(async (dir) => {
      const t = createTelemetry({
        version: '1',
        cwd: dir,
        now: () => 1,
        env: { RETICLE_TELEMETRY_FILE: join(dir, 'e.jsonl'), RETICLE_TELEMETRY_KEY: 'k' },
      });
      await expect(t.emit(TelemetryEventKind.DAEMON_STARTED)).resolves.toBe(true);
    });
  });

  it('stays ENABLED inside a Reticle checkout — that is the point of it', async () => {
    // Telemetry is disabled by cwd in a source checkout, which is exactly where release runs are
    // driven from. A sink that inherited that would record nothing and look like it worked.
    await withDir(async (dir) => {
      const path = join(dir, 'e.jsonl');
      const t = createTelemetry({
        version: '1',
        cwd: process.cwd(), // this repo
        now: () => 1,
        env: { RETICLE_TELEMETRY_FILE: path, RETICLE_TELEMETRY_KEY: 'k' },
      });
      expect(t.enabled).toBe(true);
      await t.emit(TelemetryEventKind.DAEMON_STARTED);
      expect(readLines(path)).toHaveLength(1);
    });
  });

  // POSIX only. `mode: 0o500` does not make a directory unwritable on Windows, so the precondition
  // never holds there and the test asserts nothing — the same reason its twin in ensure-token.test.ts
  // is skipped. Whether the sink degrades safely on a genuinely unwritable Windows path is a real
  // question and needs its own test against ACLs, not a loosened assertion here.
  it.skipIf('win32' === process.platform)(
    'an unwritable path degrades to no-op rather than breaking the daemon',
    async () => {
      await withDir(async (dir) => {
        // Made unwritable, not borrowed from `/proc` — that path does not exist on macOS, so the
        // borrowed form silently tested nothing there. Its twin in the Vite plugin hung the Linux
        // runner for 36 minutes, which is the same non-portability failing the other way.
        const readOnly = join(dir, 'read-only');
        mkdirSync(readOnly, { recursive: true, mode: 0o500 });
        try {
          const t = createTelemetry({
            version: '1',
            cwd: dir,
            now: () => 1,
            env: {
              RETICLE_TELEMETRY_FILE: join(readOnly, 'e.jsonl'),
              RETICLE_TELEMETRY_KEY: 'k',
            },
          });
          await expect(t.emit(TelemetryEventKind.DAEMON_STARTED)).resolves.toBe(false);
        } finally {
          chmodSync(readOnly, 0o700);
        }
      });
    },
  );
});
