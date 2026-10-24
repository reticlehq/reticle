/**
 * The first session call in an unwired project offers a next step and changes no file. These
 * events say which step it offered and whether the agent's next call did it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NextStepOffered,
  OnboardingStepStatus,
  ReticleTool,
  TelemetryEventKind,
} from '@reticlehq/core';
import { noteNextCall, noteNextStepOffered, resetNextStepOffered } from './onboarding-firsts.js';
import { getTelemetry } from './telemetry.js';

afterEach(() => {
  vi.restoreAllMocks();
  resetNextStepOffered();
});

const steps = () => {
  const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
  return () =>
    emit.mock.calls
      .filter((c) => TelemetryEventKind.ONBOARDING_STEP === c[0])
      .map((c) => c[1]?.onboarding);
};

describe('the next step a first session call offered', () => {
  it('reports the offer, then whether the next call acquired the lease', () => {
    const read = steps();
    noteNextStepOffered(NextStepOffered.LEASE, () => false);
    noteNextCall(ReticleTool.LEASE, { action: 'acquire', url: 'http://localhost:5173' });
    expect(read()).toEqual([
      expect.objectContaining({
        step: 'next_step_offered',
        status: OnboardingStepStatus.STARTED,
        offered: NextStepOffered.LEASE,
      }),
      expect.objectContaining({
        status: OnboardingStepStatus.COMPLETED,
        offered: NextStepOffered.LEASE,
        nextFollowed: true,
      }),
    ]);
  });

  it('says not followed when the next call did something else, and closes the offer once', () => {
    const read = steps();
    noteNextStepOffered(NextStepOffered.LEASE, () => false);
    noteNextCall(ReticleTool.SNAPSHOT, {});
    noteNextCall(ReticleTool.LEASE_ACQUIRE, {});
    const completed = read().filter((s) => OnboardingStepStatus.COMPLETED === s?.status);
    expect(completed).toEqual([expect.objectContaining({ nextFollowed: false })]);
  });

  it('counts the consent step as followed when the project is wired by the next call', () => {
    const read = steps();
    let wired = false;
    noteNextStepOffered(NextStepOffered.INIT_CONSENT, () => wired);
    wired = true;
    noteNextCall(ReticleTool.SESSIONS, {});
    expect(read().at(-1)).toMatchObject({
      offered: NextStepOffered.INIT_CONSENT,
      nextFollowed: true,
    });
  });
});
