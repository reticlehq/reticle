import { describe, expect, it, vi } from 'vitest';
import { installDaemonTelemetry } from './daemon-telemetry.js';
import { resetSessionMetrics } from './session-metrics.js';

/**
 * The daemon summary is the single richest event Reticle sends — a whole session in one row — and it
 * is emitted on the shutdown path, microseconds before `process.exit(0)`.
 *
 * It was fire-and-forget at first, and a capture server proved the event was lost EVERY time: exit
 * kills the in-flight POST. These tests pin the fix, because the failure is invisible from inside the
 * process (nothing throws; the event simply never arrives) and would silently return the moment
 * someone "tidied" the await away.
 */
describe('daemon telemetry shutdown', () => {
  it('returns a promise the daemon can await before it exits', () => {
    resetSessionMetrics();
    const telemetry = installDaemonTelemetry(process.cwd(), () => 0);
    const result = telemetry.shutdown();
    expect(result).toBeInstanceOf(Promise);
    return expect(result).resolves.toBeUndefined();
  });

  it('emits the summary at most once, however many shutdown paths fire', async () => {
    resetSessionMetrics();
    const telemetry = installDaemonTelemetry(process.cwd(), () => 0);
    // Both SIGTERM and the idle-shutdown timer call this; a duplicate would double-count the session.
    const first = telemetry.shutdown();
    const second = telemetry.shutdown();
    expect(second).toBe(first);
    await Promise.all([first, second]);
  });

  it('resolves even when the send fails — telemetry must never block a daemon exit', async () => {
    resetSessionMetrics();
    vi.useFakeTimers();
    try {
      const telemetry = installDaemonTelemetry('/nonexistent-project-path', () => 0);
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
