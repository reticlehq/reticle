/**
 * "First" steps used to be first per daemon PROCESS, so a machine reported its first look, first
 * act and first verdict again every time a daemon started, and `verdict_produced` under the
 * first-run phase fired on every verdict there ever was. The funnel then counted restarts and
 * verdicts as people. They are claimed once per machine + project now, on disk.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import {
  FirstEver,
  claimFirstEver,
  setFirstEverDir,
  noteActed,
  noteOnboardingFirst,
  noteVerdictProduced,
  resetOnboardingFirsts,
} from './onboarding-firsts.js';
import {
  markInstrumentationClock,
  reportAppInstrumented,
  resetAppInstrumented,
} from './app-instrumented.js';
import { getTelemetry, type TelemetryExtra } from './telemetry.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reticle-first-ever-'));
  setFirstEverDir(dir, 'project-a');
});
afterEach(() => {
  vi.restoreAllMocks();
  resetOnboardingFirsts();
  resetAppInstrumented();
  setFirstEverDir(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** A state home that cannot be created: its parent is a file. Fails the same way on every OS. */
const unwritable = (): void => {
  const file = join(dir, 'not-a-dir');
  writeFileSync(file, '');
  setFirstEverDir(join(file, 'firsts'), 'project-a');
};

const emitted = () => {
  const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
  return (kind: TelemetryEventKind) =>
    emit.mock.calls.filter((c) => kind === c[0]).map((c): TelemetryExtra => c[1] ?? {});
};

/** A new daemon process: the in-memory flags are gone, the disk is not. */
const restartDaemon = (): void => {
  resetOnboardingFirsts();
  markInstrumentationClock(0);
};

describe('claimFirstEver', () => {
  it('is first once per machine + project, then seen', () => {
    expect(claimFirstEver('first_look')).toBe(FirstEver.FIRST);
    expect(claimFirstEver('first_look')).toBe(FirstEver.SEEN);
    expect(claimFirstEver('first_look', 'project-b')).toBe(FirstEver.FIRST);
  });

  it('says unknown, never first, when the state home cannot be written', () => {
    unwritable();
    expect(claimFirstEver('first_look')).toBe(FirstEver.UNKNOWN);
  });
});

describe('onboarding firsts fire once per machine + project, ever', () => {
  it('first_look and first_act do not re-fire after a daemon restart', () => {
    const of = emitted();
    noteOnboardingFirst('reticle_look');
    noteActed({});
    restartDaemon();
    noteOnboardingFirst('reticle_look');
    noteActed({});
    const steps = of(TelemetryEventKind.ONBOARDING_STEP).map((e) => e.onboarding);
    expect(steps.map((s) => s?.step)).toEqual(['first_look', 'driven', 'first_act']);
    expect(steps.every((s) => true === s?.firstEver)).toBe(true);
  });

  it('verdict_produced fires on the first verdict only, not on every verdict', () => {
    const of = emitted();
    noteVerdictProduced(10);
    noteVerdictProduced(20);
    restartDaemon();
    noteVerdictProduced(30);
    const steps = of(TelemetryEventKind.ONBOARDING_STEP).map((e) => e.onboarding?.step);
    expect(steps.filter((s) => 'verdict_produced' === s)).toHaveLength(1);
  });

  it('still fires per run, without firstEver, when the state home is unwritable', () => {
    unwritable();
    const of = emitted();
    noteActed({});
    const steps = of(TelemetryEventKind.ONBOARDING_STEP).map((e) => e.onboarding);
    const first = steps.find((s) => 'first_act' === s?.step);
    expect(first, 'still reported').toBeDefined();
    expect(first).not.toHaveProperty('firstEver');
  });
});

describe('app_instrumented', () => {
  const facts = { initialized: true, agentAttached: false };

  it('stays once per run (the daemon_started join needs it) but marks only the true first', () => {
    const of = emitted();
    markInstrumentationClock(0);
    reportAppInstrumented(facts, () => 1);
    restartDaemon();
    reportAppInstrumented(facts, () => 1);
    const runs = of(TelemetryEventKind.APP_INSTRUMENTED).map((e) => e.instrumentation);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.firstEver).toBe(true);
    expect(runs[1]).not.toHaveProperty('firstEver');
    const steps = of(TelemetryEventKind.ONBOARDING_STEP).map((e) => e.onboarding?.step);
    expect(
      steps.filter((s) => 'app_connected' === s),
      'the step is once ever',
    ).toHaveLength(1);
  });
});
