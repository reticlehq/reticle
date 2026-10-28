/**
 * Each stop on the path to a first verdict records one name from core's closed `OnboardingStop`.
 *
 * Before this, a stop had no name, or a free string, or a counter in a session summary that no
 * funnel query read. "The biggest reason people stop" could not be answered, and the share of
 * stops with no reason could not be measured. Each test drives one detection point and reads the
 * row that leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserLaunchKind,
  ConnectFailure,
  OnboardingStepStatus,
  OnboardingStop,
  TelemetryEventKind,
  type OnboardingStep,
} from '@reticlehq/core/telemetry';
import { InitFailure } from '@reticlehq/init';
import { getTelemetry } from './telemetry.js';
import { resetOnboardingStops } from './onboarding-funnel.js';
import { drainInstallTrace } from './install-trace.js';
import { reportInitOutcome } from './init-telemetry.js';
import { getSessionMetrics, resetSessionMetrics } from './session-metrics.js';

function stopRows(): () => OnboardingStep[] {
  const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
  return () =>
    emit.mock.calls
      .filter((call) => call[0] === TelemetryEventKind.ONBOARDING_STEP)
      .flatMap((call) => call[1]?.onboarding ?? [])
      .filter((step) => step.stop !== undefined);
}

beforeEach(() => {
  resetOnboardingStops();
  resetSessionMetrics();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetOnboardingStops();
});

describe('the installer stops carry a stop name', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-stop-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['runtime_ready', 'no_node', OnboardingStop.NO_NODE],
    ['runtime_ready', 'node_too_old', OnboardingStop.NODE_TOO_OLD],
    ['cli_installed', 'no_npm', OnboardingStop.CLI_INSTALL_FAILED],
    ['cli_installed', 'npm_install', OnboardingStop.CLI_INSTALL_FAILED],
    ['cli_installed', 'not_on_path', OnboardingStop.CLI_INSTALL_FAILED],
  ])('%s failed with %s is the stop %s', (step, reason, stop) => {
    const rows = stopRows();
    writeFileSync(
      join(dir, 'install-trace.jsonl'),
      JSON.stringify({ phase: 'install', step, status: 'failed', reason }),
    );
    drainInstallTrace(dir);
    expect(rows()).toEqual([{ phase: 'install', step, status: 'failed', reason, stop }]);
  });

  it('names no stop for a reason the installer does not write', () => {
    const rows = stopRows();
    writeFileSync(
      join(dir, 'install-trace.jsonl'),
      '{"phase":"install","step":"runtime_ready","status":"failed","reason":"weird"}',
    );
    drainInstallTrace(dir);
    expect(rows()).toEqual([]);
  });
});

describe('a failed init records one stop', () => {
  it.each([
    [InitFailure.NO_PACKAGE_JSON, OnboardingStop.NO_WEB_APP],
    [InitFailure.MALFORMED_PACKAGE_JSON, OnboardingStop.SETUP_FAILED],
    [InitFailure.PREFLIGHT, OnboardingStop.SETUP_FAILED],
    [InitFailure.DEPENDENCY_INSTALL, OnboardingStop.SETUP_FAILED],
    [InitFailure.BRIDGE_OCCUPIED, OnboardingStop.SETUP_FAILED],
    [InitFailure.MCP_REGISTRATION, OnboardingStop.MCP_NOT_REGISTERED],
    [InitFailure.DEV_SERVER, OnboardingStop.DEV_SERVER_FAILED],
    [InitFailure.APP_CONNECTION, OnboardingStop.APP_NOT_CONNECTED],
    [InitFailure.INTERRUPTED, OnboardingStop.INTERRUPTED],
    [InitFailure.RUNTIME_ERROR, OnboardingStop.UNCLASSIFIED],
    [InitFailure.OTHER, OnboardingStop.UNCLASSIFIED],
  ])('%s is the stop %s', (reason, stop) => {
    const rows = stopRows();
    reportInitOutcome({ ok: false, reason, stack: 'vite' });
    expect(rows()).toEqual([
      expect.objectContaining({ status: OnboardingStepStatus.FAILED, reason, stop, stack: 'vite' }),
    ]);
  });

  it('records no stop when init worked', () => {
    const rows = stopRows();
    reportInitOutcome({ ok: true, stack: 'vite' });
    expect(rows()).toEqual([]);
  });

  it('records a failure with no reason as unclassified, not as nothing', () => {
    const rows = stopRows();
    reportInitOutcome({ ok: false });
    expect(rows().map((r) => r.stop)).toEqual([OnboardingStop.UNCLASSIFIED]);
  });
});

describe('a browser that cannot launch is a stop', () => {
  it.each([ConnectFailure.CHROMIUM_MISSING, ConnectFailure.PLAYWRIGHT_MISSING])(
    '%s is chromium_unavailable, once for each process',
    (failure) => {
      const rows = stopRows();
      getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.POOLED)(failure);
      getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.LAUNCHED)(failure);
      expect(rows()).toEqual([
        expect.objectContaining({
          step: 'driven',
          status: OnboardingStepStatus.FAILED,
          reason: failure,
          stop: OnboardingStop.CHROMIUM_UNAVAILABLE,
        }),
      ]);
    },
  );

  it('does not call a refused CDP endpoint or a success a stop', () => {
    const rows = stopRows();
    getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.ATTACHED)(
      ConnectFailure.CDP_UNREACHABLE,
    );
    getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.POOLED)();
    expect(rows()).toEqual([]);
  });
});
