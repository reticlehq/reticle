/**
 * The tutorial: one sequence, two audiences.
 *
 * A human wants to know what to do next and why it is worth doing. An agent wants the exact call and
 * the exact shape of the answer, because prose it has to interpret is a turn it has to spend. Write
 * for one and hope the other copes, and you get a page agents skip and humans skim.
 *
 * What both MUST share is the order. Two audiences taking different routes through one product is
 * how a support answer stops matching what anybody actually did.
 *
 * The sequence is not arbitrary either. It ends at a VERDICT because a tour that ends at "you can see
 * the page now" has taught the least valuable half: looking is not verifying, and an agent that
 * learns only to look will report that it looked. And it declares the consequence BEFORE acting,
 * because that ordering IS the idea — naming what should happen first is the difference between a
 * check and a rationalisation written afterwards.
 */

export const TutorialAudience = {
  /** Prose, and a reason per step. */
  HUMAN: 'human',
  /** The call, and what comes back. */
  AGENT: 'agent',
} as const;
export type TutorialAudience = (typeof TutorialAudience)[keyof typeof TutorialAudience];

export interface TutorialStep {
  id: string;
  /** What this step is, in words. Always present: an agent reading only calls learns the what, not the why. */
  say: string;
  /** Why it is worth doing. The half that stops a tutorial being a list of keystrokes. */
  why: string;
  /** The exact call, for the audience that would otherwise have to infer it from the prose. */
  call?: string;
}

const STEPS: readonly TutorialStep[] = [
  {
    id: 'connect',
    say: 'Check that your app is actually talking to Reticle. One session listed here is the proof; until one appears, nothing else can tell you anything about this app.',
    why: 'Having the tools is not the same as being set up. Every later answer is about a page that must already be connected.',
    call: 'reticle_sessions',
  },
  {
    id: 'look',
    say: 'Take a semantic snapshot. You get the controls and their refs, not pixels, so you can point at things by name.',
    why: 'A ref is stable across snapshots, which is what lets you plan several steps before spending any of them.',
    call: 'reticle_snapshot { mode: "interactive" }',
  },
  {
    id: 'declare',
    say: 'Decide what should happen BEFORE you touch anything. "Clicking Pay makes the receipt appear" is a claim that can be wrong.',
    why: 'This is the whole idea. A consequence named first is a check; the same sentence written after the fact is a rationalisation, and it is the difference between a verdict and a story.',
    call: '// choose the consequence you will pass as `until`',
  },
  {
    id: 'verdict',
    say: 'Act and prove in one call. The answer says verified yes / no / unknown, and `because` names the evidence that decided it.',
    why: 'Only `reticle_act_and_wait` and `reticle_assert` produce a verdict. A drive that ends without one has no result, however many tools it used — and "unknown" is an honest answer, not a pass.',
    call: 'reticle_act_and_wait { ref, action: "click", until: { signal: "order:placed" } }',
  },
];

/**
 * The same steps, shaped for who is reading.
 *
 * The agent form keeps the prose as well as the call. An agent that has only the call learns what to
 * type and not what it means, which is exactly the reader that later reports a green it cannot
 * explain.
 */
export function tutorialScript(audience: TutorialAudience): TutorialStep[] {
  return STEPS.map((step) =>
    TutorialAudience.AGENT === audience
      ? { ...step, call: step.call ?? '' }
      : // A human is not handed a raw call to paste without understanding it; the prose carries it.
        { id: step.id, say: step.say, why: step.why },
  );
}

/**
 * The script as text for whoever asked.
 *
 * A human gets the reason on its own line, because the reason is what makes the step worth doing and
 * a list of commands without them is a keystroke tour. An agent gets the call, because prose it has
 * to interpret is a turn it has to spend — and it gets the prose too, since an agent that has only
 * the call learns what to type and not what it means, which is the reader that later reports a green
 * it cannot explain.
 */
export function renderTutorial(audience: TutorialAudience): string {
  return tutorialScript(audience)
    .map((step, index) => {
      const head = `${String(index + 1)}. ${step.say}`;
      const why = `   why: ${step.why}`;
      return step.call === undefined || 0 === step.call.length
        ? `${head}\n${why}`
        : `${head}\n${why}\n   ${step.call}`;
    })
    .join('\n\n');
}

/**
 * Names that must never be demonstrated on.
 *
 * Deliberately broad, and deliberately matched on the NAME a user reads rather than on anything
 * structural. A demo runs unattended against an app whose author has never seen this code, so the
 * cost of being wrong is asymmetric: refusing a harmless button wastes a demo, clicking a harmful
 * one costs somebody their data. When those are the two errors available, take the first one every
 * time.
 *
 * `cancel` is here for the case that reads backwards: "Cancel subscription" is destructive, and a
 * word-boundary match on a dismissive "Cancel" would be a false refusal — which is the cheap error.
 */
const UNSAFE_TO_DEMO =
  /delete|remove|deploy|publish|pay|purchase|buy|checkout|cancel|revoke|archive|reset|destroy|drop|send|submit|confirm/i;

export type DemoPlan =
  { ok: true; ref: string; name: string; call: string } | { ok: false; because: string };

/**
 * Pick something safe on THIS page, and build the call that proves it moved.
 *
 * The sequence is the tutorial's; what this adds is a target from the app actually in front of the
 * user, because a walkthrough against a fixture teaches the fixture. The consequence is declared in
 * the call rather than checked afterwards — a demo that ends without a verdict would teach the exact
 * habit the tutorial exists to correct.
 *
 * Refusing is a real outcome. A page with nothing safe on it gets told so, because demonstrating on
 * "Delete account" to avoid an awkward message is not a trade anybody would make deliberately.
 */
export function demoPlan(
  controls: readonly { ref: string; name: string; role?: string }[],
): DemoPlan {
  const safe = controls.find((c) => !UNSAFE_TO_DEMO.test(c.name));
  if (safe === undefined) {
    return {
      ok: false,
      because:
        0 === controls.length
          ? 'nothing interactive is on this page yet — load the app and try again'
          : 'no control here is safe to demonstrate on: every one reads as something that commits. ' +
            'Drive it yourself with a consequence you choose.',
    };
  }
  return {
    ok: true,
    ref: safe.ref,
    name: safe.name,
    call: `reticle_act_and_wait { ref: "${safe.ref}", action: "click", until: { element: { testid: "<what should appear>" } } }`,
  };
}
