import { describe, expect, it, vi } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { createTelemetry } from './telemetry.js';

/**
 * Feedback filed from a Reticle source checkout must still be sent.
 *
 * The source-checkout guard exists so a fresh clone does not phone home on a contributor's first
 * `reticle serve` — a rule about PASSIVE collection. Feedback is never passive; somebody typed it.
 * Applying the guard to it meant anyone dogfooding from their own checkout filed nothing and was
 * told "not sent, unknown reason", silently losing every report from exactly the people most likely
 * to write good ones. Reported from the field by someone who escaped it only by running from a
 * different repo.
 *
 * Metrics stay off, and every EXPLICIT opt-out still applies.
 */
describe('a source checkout silences metrics, not feedback', () => {
  const inCheckout = () => {
    const sent: string[] = [];
    const fetchImpl = vi.fn((_url: string, init?: { body?: unknown }) => {
      sent.push(String((init as { body?: string } | undefined)?.body ?? ''));
      return Promise.resolve({ ok: true } as Response);
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  };

  it('sends FEEDBACK_SUBMITTED from the reticle repo itself', async () => {
    const { sent, fetchImpl } = inCheckout();
    const telemetry = createTelemetry({
      version: '0.0.0',
      env: {},
      cwd: process.cwd(), // this test runs inside the reticle checkout
      fetchImpl,
    });
    await telemetry.emit(TelemetryEventKind.FEEDBACK_SUBMITTED, {
      feedback: { kind: 'bug', text: 'x' },
    } as never);
    expect(sent.length, 'feedback from a checkout must reach the collector').toBe(1);
  });

  it('still drops an ordinary metric from the same checkout', async () => {
    const { sent, fetchImpl } = inCheckout();
    const telemetry = createTelemetry({
      version: '0.0.0',
      env: {},
      cwd: process.cwd(),
      fetchImpl,
    });
    await telemetry.emit(TelemetryEventKind.DAEMON_STARTED);
    expect(sent, 'a contributor clone must not report usage').toEqual([]);
  });

  it('honours an EXPLICIT opt-out even for feedback', async () => {
    const { sent, fetchImpl } = inCheckout();
    const telemetry = createTelemetry({
      version: '0.0.0',
      env: { RETICLE_TELEMETRY: '0' },
      cwd: process.cwd(),
      fetchImpl,
    });
    await telemetry.emit(TelemetryEventKind.FEEDBACK_SUBMITTED, {
      feedback: { kind: 'bug', text: 'x' },
    } as never);
    expect(sent).toEqual([]);
  });
});
