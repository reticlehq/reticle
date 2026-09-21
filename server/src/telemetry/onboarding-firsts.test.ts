/**
 * The funnel rungs only the daemon can answer, and the two that were answering the wrong question.
 *
 * `first_act` fired on `reticle_act` alone, while this server's own instructions tell every agent to
 * prefer `reticle_act_and_wait` — so the ONBOARD phase measured a tool we ask agents not to use, and
 * read as "looked, never acted, then produced a verdict from nowhere".
 *
 * `driven` was declared in the closed step list and emitted by no code at all, which renders as a
 * 100% cliff at exactly the rung separating "the install worked" from "they used it".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionType, OnboardingPhase, TelemetryEventKind } from '@reticlehq/core';
import { noteActed, noteDriven, resetOnboardingFirsts } from './onboarding-firsts.js';
import { getTelemetry } from './telemetry.js';

function stepsReported(): () => string[] {
  const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
  return () =>
    emit.mock.calls
      .filter((call) => TelemetryEventKind.ONBOARDING_STEP === call[0])
      .map((call) => (call[1] as { onboarding: { step: string } }).onboarding.step);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetOnboardingFirsts();
});

describe('first_act', () => {
  it('counts any call the dispatcher classed as driving the page, not one tool name', () => {
    // The dispatcher owns the set; a planned sequence with no `action` argument of its own is one
    // of them, and the old name test refused it.
    const seen = stepsReported();
    noteActed({});
    expect(seen()).toContain('first_act');
  });

  it('still ignores a hover, which changes nothing', () => {
    const seen = stepsReported();
    noteActed({ action: ActionType.HOVER });
    expect(seen()).not.toContain('first_act');
  });

  it('reports once however many times the agent acts', () => {
    const seen = stepsReported();
    noteActed({ action: ActionType.CLICK });
    noteActed({ action: ActionType.CLICK });
    expect(seen().filter((step) => 'first_act' === step)).toHaveLength(1);
  });

  it('an action is also a drive — the two rungs are reported from one place', () => {
    const seen = stepsReported();
    noteActed({ action: ActionType.CLICK });
    expect(seen()).toContain('driven');
  });
});

describe('driven', () => {
  it('reports the rung that separates an install that worked from one that was used', () => {
    const seen = stepsReported();
    noteDriven();
    expect(seen()).toContain('driven');
  });

  it('reports it in the phase whose step list declares it', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    noteDriven();
    const payload = emit.mock.calls[0]?.[1] as { onboarding: { phase: string } };
    expect(payload.onboarding.phase).toBe(OnboardingPhase.FIRST_RUN);
  });

  it('reports once per daemon run — a session that drives forty times is not forty installs', () => {
    const seen = stepsReported();
    noteDriven();
    noteDriven();
    expect(seen().filter((step) => 'driven' === step)).toHaveLength(1);
  });
});
