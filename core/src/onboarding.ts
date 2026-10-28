import * as z from 'zod';

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
    /**
     * The first session call in an unwired project named a next step (`offered`) and changed no
     * file. Reported `started` when it is offered, and `completed` on the agent's next call, with
     * `nextFollowed`.
     */
    'next_step_offered',
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
 * The next step that the first session call in an unwired project offers. `lease` checks the
 * running app now and installs nothing. `init_consent` asks the user to agree to wire the app,
 * when no app is up to lease.
 */
export const NextStepOffered = {
  LEASE: 'lease',
  INIT_CONSENT: 'init_consent',
} as const;
export type NextStepOffered = (typeof NextStepOffered)[keyof typeof NextStepOffered];

/**
 * Why the path to a first verdict stopped. One name for each stop, from a closed list.
 *
 * Each member has one detection point in the code. A stop that no code can detect is not on the
 * list: a guessed reason is worse than no reason. `unclassified` is a stop that was seen and could
 * not be named, so the unknown bucket can be measured.
 */
export const OnboardingStop = {
  /** The installer found no `node`. */
  NO_NODE: 'no_node',
  /** The installer found a `node` older than the minimum. */
  NODE_TOO_OLD: 'node_too_old',
  /** The installer could not install the CLI or put it on PATH. */
  CLI_INSTALL_FAILED: 'cli_install_failed',
  /** No detected coding agent got the MCP server. */
  MCP_NOT_REGISTERED: 'mcp_not_registered',
  /** `init` found no `package.json`, so no web app. */
  NO_WEB_APP: 'no_web_app',
  /** `init` could not write the setup: a bad manifest, a preflight refusal, a failed install, a busy bridge port. */
  SETUP_FAILED: 'setup_failed',
  /** `init` could not start the dev server or get a URL from it. */
  DEV_SERVER_FAILED: 'dev_server_failed',
  /** The page was served and no session dialled the daemon. */
  APP_NOT_CONNECTED: 'app_not_connected',
  /** The person stopped `init` with Ctrl-C. */
  INTERRUPTED: 'interrupted',
  /** The agent that ran `init` must restart before it has the `reticle_*` tools. */
  AGENT_NOT_RESTARTED: 'agent_not_restarted',
  /** Reticle could not launch Chromium: the browser or Playwright is not installed. */
  CHROMIUM_UNAVAILABLE: 'chromium_unavailable',
  /** A stop was seen and no rule named it. */
  UNCLASSIFIED: 'unclassified',
} as const;
export type OnboardingStop = (typeof OnboardingStop)[keyof typeof OnboardingStop];

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
  /**
   * The first time this machine + project crossed this step, ever. The daemon's "first" steps are
   * claimed on disk and fire once; absent on a step that is not a first, and on one reported from a
   * home that could not be written (which fires once per process instead).
   */
  firstEver: z.boolean().optional(),
  /** Only on `next_step_offered`: the step the first session call offered. */
  offered: z.nativeEnum(NextStepOffered).optional(),
  /** Only on a `completed` `next_step_offered`: the agent's next call did the offered step. */
  nextFollowed: z.boolean().optional(),
  /** Only on a `failed` row: why the path to a first verdict stopped here. */
  stop: z.nativeEnum(OnboardingStop).optional(),
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;
