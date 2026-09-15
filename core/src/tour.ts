/**
 * The onboarding tour, once, for both surfaces that show it.
 *
 * The CLI prints it at the end of `reticle setup install`; the browser SDK renders it as a carousel
 * over the user's own running app, beside the HUD. Those are two audiences in two media, and the
 * rule that governs them is the one `tutorial.ts` already stated about its own two audiences: what
 * they MUST share is the order and the claims, because two routes through one product is how a
 * support answer stops matching what anybody actually did.
 *
 * So the steps live here, in the package both ends already depend on, and neither renderer owns
 * them. `@reticlehq/server` cannot be imported by the browser and `@reticlehq/browser` cannot be
 * imported by the server; core is the only place a shared sentence can sit without inventing an
 * edge between them.
 *
 * The sequence is not arbitrary. It ends at a VERDICT because a tour that ends at "you can see the
 * page now" has taught the least valuable half: looking is not verifying, and an agent that learns
 * only to look will report that it looked. And it declares the consequence BEFORE acting, because
 * that ordering IS the idea being taught — naming what should happen first is the difference
 * between a check and a rationalisation written afterwards.
 */

/**
 * What a slide points at when the tour is drawn over a real page.
 *
 * Only the HUD is addressable today: it is the one thing Reticle itself put on the page, so it is
 * the one thing a tour can promise is there. Pointing at the user's own markup would be a guess
 * about an app we have never seen.
 */
export const TourAnchor = {
  /** No target: the slide is prose, centred. */
  NONE: 'none',
  /** Reticle's own in-page HUD. */
  HUD: 'hud',
} as const;
export type TourAnchor = (typeof TourAnchor)[keyof typeof TourAnchor];

export interface TourStep {
  id: string;
  /** Three or four words. The carousel shows this; the terminal does not. */
  title: string;
  /** What this step is, in words. Both surfaces show this. */
  say: string;
  /** Why it is worth doing — the half that stops a tour being a list of keystrokes. */
  why: string;
  /** The exact call, for the audience that would otherwise infer it from the prose. */
  call?: string;
  /** What to highlight when drawn over a page. Ignored in a terminal. */
  anchor?: TourAnchor;
}

/**
 * The prompt the last slide hands over.
 *
 * A tour that ends with "now go and try it" ends at the point where somebody has to invent the
 * next move themselves, which is where they stop. This is the move, written out, ready to paste
 * into whichever agent they use — and it names a VERDICT as the finish line rather than a config
 * file, because that distinction is the whole product and it is the one most easily lost.
 */
export const TOUR_HANDOFF_PROMPT =
  'Use Reticle to verify this app actually works. Take a snapshot, pick one real flow a user ' +
  'cares about, decide what should be true after it BEFORE you touch anything, then drive it and ' +
  'report the verdict with the evidence that decided it. Do not tell me it works until Reticle ' +
  'says verified: yes.';

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'connect',
    title: 'It is connected',
    say: 'Check that your app is actually talking to Reticle. One session listed here is the proof; until one appears, nothing else can tell you anything about this app.',
    why: 'Having the tools is not the same as being set up. Every later answer is about a page that must already be connected.',
    call: 'reticle_sessions',
    anchor: TourAnchor.HUD,
  },
  {
    id: 'look',
    title: 'Look, without pixels',
    say: 'Take a semantic snapshot. You get the controls and their refs, not pixels, so you can point at things by name.',
    why: 'A ref is stable across snapshots, which is what lets you plan several steps before spending any of them.',
    call: 'reticle_snapshot { mode: "interactive" }',
    anchor: TourAnchor.NONE,
  },
  {
    id: 'declare',
    title: 'Say it first',
    say: 'Decide what should happen BEFORE you touch anything. "Clicking Pay makes the receipt appear" is a claim that can be wrong.',
    why: 'This is the whole idea. A consequence named first is a check; the same sentence written after the fact is a rationalisation, and it is the difference between a verdict and a story.',
    call: '// choose the consequence you will pass as `until`',
    anchor: TourAnchor.NONE,
  },
  {
    id: 'verdict',
    title: 'Act, and prove it',
    say: 'Act and prove in one call. The answer says verified yes / no / unknown, and `because` names the evidence that decided it.',
    why: 'Only `reticle_act_and_wait` and `reticle_assert` produce a verdict. A drive that ends without one has no result, however many tools it used — and "unknown" is an honest answer, not a pass.',
    call: 'reticle_act_and_wait { ref, action: "click", until: { signal: "order:placed" } }',
    anchor: TourAnchor.HUD,
  },
];
