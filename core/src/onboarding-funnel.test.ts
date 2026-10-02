import { describe, expect, it } from 'vitest';
import {
  OnboardingPhase,
  OnboardingSteps,
  OnboardingStepSchema,
  OnboardingStepStatus,
} from './telemetry.js';

/**
 * The funnel has to be answerable as ONE question: where do people stop.
 *
 * Prior measurement put the break at instrumentation — strong user retention, far weaker
 * verification retention — and no event marks it. `init_completed` fires when the files are written,
 * and the story continues for minutes after that: the app still has to load, dial the bridge, be
 * driven, and produce a verdict. Four places to lose somebody, none of them visible.
 */
describe('the onboarding funnel is one ordered vocabulary', () => {
  it('covers every phase, in the order they happen', () => {
    expect(Object.keys(OnboardingSteps)).toEqual([
      OnboardingPhase.INSTALL,
      OnboardingPhase.ONBOARD,
      OnboardingPhase.FIRST_RUN,
    ]);
  });

  it('ends at a VERDICT, because everything before it proved nothing', () => {
    const firstRun = OnboardingSteps[OnboardingPhase.FIRST_RUN];
    expect(firstRun.at(-1)).toBe('verdict_produced');
    // And the tour ends at one too: a tour that ends at "you can see the page" teaches the least
    // valuable half, and an agent that learns only to look will report that it looked.
    expect(OnboardingSteps[OnboardingPhase.ONBOARD].at(-1)).toBe('first_verdict');
  });

  it('names app_connected separately from instrumented, which is the whole point', () => {
    const firstRun: readonly string[] = OnboardingSteps[OnboardingPhase.FIRST_RUN];
    // Files written is not the same as a page that dialled the bridge. Every install bug worth
    // catching so far has been silent precisely in the gap between these two.
    expect(firstRun.indexOf('instrumented')).toBeLessThan(firstRun.indexOf('app_connected'));
  });

  it('every step name is short enough for the event schema that carries it', () => {
    for (const steps of Object.values(OnboardingSteps)) {
      for (const step of steps) {
        expect(
          OnboardingStepSchema.safeParse({
            phase: OnboardingPhase.INSTALL,
            step,
            status: OnboardingStepStatus.COMPLETED,
          }).success,
          step,
        ).toBe(true);
      }
    }
  });

  it('has no duplicate step name across phases, so a GROUP BY cannot collide', () => {
    const all = Object.values(OnboardingSteps).flatMap((s) => [...s]);
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * `step` was `z.string().max(48)` with a comment promising it was never user text. A cap is not a
   * promise: `/Users/someone/secret/project` is 28 characters and validated cleanly — a rule-3 leak
   * from the one payload a person can edit, the installer's breadcrumb file in their own home
   * directory. It is a closed set now, so the promise is the schema rather than a comment above it.
   */
  it.each([
    ['a path', '/Users/someone/secret/project'],
    ['an error message', 'ENOENT: no such file'],
    ['a plausible invention', 'install_finished'],
    ['something far too long', 'a'.repeat(49)],
  ])('refuses %s as a step name', (_label, step) => {
    expect(
      OnboardingStepSchema.safeParse({
        phase: OnboardingPhase.INSTALL,
        step,
        status: OnboardingStepStatus.FAILED,
      }).success,
    ).toBe(false);
  });

  it('accepts every name the funnel itself declares', () => {
    for (const [phase, steps] of Object.entries(OnboardingSteps)) {
      for (const step of steps) {
        expect(
          OnboardingStepSchema.safeParse({
            phase,
            step,
            status: OnboardingStepStatus.COMPLETED,
          }).success,
          `${phase}/${step}`,
        ).toBe(true);
      }
    }
  });

  it('distinguishes ABANDONED from FAILED, which are not our problem in the same way', () => {
    // A step someone walked away from and a step that broke both read as "we never got there" in a
    // funnel that has only one losing status, and only one of them is our bug.
    expect(OnboardingStepStatus.ABANDONED).not.toBe(OnboardingStepStatus.FAILED);
  });
});
