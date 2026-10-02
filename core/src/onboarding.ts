import { z } from 'zod';

/**
 * The three phases between "never heard of Reticle" and "it produced a verdict on my app".
 *
 * Named as one vocabulary because the question they exist to answer is one question: WHERE do people
 * stop. Prior measurement put the break at instrumentation — user retention strong, verification
 * retention far weaker — and `init_completed` cannot see that, because it fires when the files are
 * written and the story continues for minutes afterwards.
 */
export const OnboardingPhase = {
  /** Getting the CLI onto the machine and the MCP registered with the agents that are there. */
  INSTALL: 'install',
  /** Being shown what Reticle is and how it is driven, before being asked to drive anything. */
  ONBOARD: 'onboard',
  /** Instrumenting a real project and driving it until something is actually proved. */
  FIRST_RUN: 'first_run',
} as const;
export type OnboardingPhase = (typeof OnboardingPhase)[keyof typeof OnboardingPhase];

/**
 * What became of one step.
 *
 * `ABANDONED` is the one that earns its place: a step that is STARTED and never resolved is
 * indistinguishable from one that was never reached, and both read as "we never got there" in a
 * funnel. Saying a person walked away from a step we know they began is a different fact from
 * saying the step failed, and only one of them is our bug.
 */
export const OnboardingStepStatus = {
  STARTED: 'started',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
  /** Nothing to do — already installed, already instrumented. Not a loss, and not a win either. */
  SKIPPED: 'skipped',
} as const;
export type OnboardingStepStatus = (typeof OnboardingStepStatus)[keyof typeof OnboardingStepStatus];

/**
 * The steps, per phase, as ONE table.
 *
 * Written down here rather than as string literals at each emit site, for the reason rule 4 exists:
 * a vocabulary copied into the place that uses it drifts from the place that reads it, and the
 * reader is a dashboard nobody re-checks. A step that is renamed here is renamed everywhere or it
 * does not compile.
 *
 * The ORDER matters and is the funnel: each phase's steps are listed in the sequence they occur, so
 * a drop-off curve is this array with counts against it.
 */
export const OnboardingSteps = {
  [OnboardingPhase.INSTALL]: [
    /** The one-line installer ran at all — the first thing we can possibly know about someone. */
    'script_started',
    /** A usable runtime was found or provisioned. The commonest reason an install dies on a clean box. */
    'runtime_ready',
    'cli_installed',
    /** Which coding agents are on this machine. Zero is a real answer and not a failure. */
    'agents_detected',
    /** The MCP server registered with them. The step most likely to fail silently — see InitOutcome. */
    'mcp_registered',
  ],
  [OnboardingPhase.ONBOARD]: [
    'tour_started',
    /** Shown what Reticle is FOR, before being asked to run anything. */
    'concept_shown',
    /** The first look at a real page. */
    'first_look',
    /** The first action driven through Reticle. */
    'first_act',
    /**
     * The first VERDICT. The tour ends here on purpose: a tour that ends at "you can see the page"
     * has taught the least valuable half, and an agent that learns only to look reports that it
     * looked. Same reasoning as `tutorial.ts`, which already ends here.
     */
    'first_verdict',
  ],
  [OnboardingPhase.FIRST_RUN]: [
    'project_detected',
    /** The SDK is in the bundle. Files written is NOT this — see `app_instrumented`. */
    'instrumented',
    /** A page loaded and the SDK dialled the bridge. The half of the install nothing else can see. */
    'app_connected',
    /** Something was driven. */
    'driven',
    /** A flow was recorded from that drive, which is what makes the SECOND run cheap. */
    'flow_recorded',
    /**
     * A verdict was produced on the user's own app. THE conversion event.
     *
     * Everything before this is setup that proved nothing. Prior measurement put the break here —
     * strong user retention, far weaker verification retention — and no existing event marks it,
     * because `init_completed` fires when files are written and this is minutes later.
     */
    'verdict_produced',
  ],
} as const;

/**
 * ONE event for every step of every phase, rather than an event name per step.
 *
 * The kinds list is already at the size where a reader has to scan it, and a name per step would
 * mean every funnel query naming the steps it spans — so moving, renaming or inserting a step
 * silently breaks the queries that were watching it. A phase + step pair keeps the funnel a GROUP BY
 * instead of a union, and a new step arrives in the existing chart rather than beside it.
 *
 * `step` is one of our own names and never a path, a URL or anything the user typed — rule 3. The
 * schema caps it for the same reason every other free-ish field here is capped.
 */
/**
 * Every step name, flattened — the closed set `step` is allowed to be.
 *
 * Derived from `OnboardingSteps` rather than retyped, so a step added there is accepted here on the
 * same edit and a step renamed cannot be accepted under both spellings.
 */
const ALL_ONBOARDING_STEPS = Object.values(OnboardingSteps).flatMap((steps) => [...steps]) as [
  string,
  ...string[],
];

export const OnboardingStepSchema = z.object({
  phase: z.nativeEnum(OnboardingPhase),
  /**
   * Our name for the step, and ONLY one of ours.
   *
   * This was `z.string().max(48)`, with a comment promising it was never user text — and a cap is
   * not a promise. `/Users/someone/secret/project` is 28 characters and validated cleanly, which is
   * a rule-3 leak (names, never values) reaching the wire from the one payload a person can edit:
   * the installer's breadcrumb file, on disk, in their own home directory.
   *
   * A closed set makes the promise enforceable instead of aspirational. Found by the test written
   * for that file, not by reading this line.
   */
  step: z.enum(ALL_ONBOARDING_STEPS),
  status: z.nativeEnum(OnboardingStepStatus),
  /**
   * Milliseconds this step took. Absent when the step is instantaneous or not timed — absent means
   * NOT MEASURED, never zero, because a zero would pull every average toward a duration nobody had.
   */
  elapsedMs: z.number().int().nonnegative().optional(),
  /** Classified cause when it failed — our vocabulary, never a raw error or a path. */
  reason: z.string().max(64).optional(),
  /** The stack it was detected on, so a phase that only fails on one framework is visible. */
  stack: z.string().max(64).optional(),
  /**
   * True when nobody was asked anything — the zero-human-input path an agent takes from a link.
   *
   * Recorded because the two audiences fail differently and a funnel that mixes them explains
   * neither: a human abandons a step, an agent's run exits.
   */
  unattended: z.boolean().optional(),
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;
