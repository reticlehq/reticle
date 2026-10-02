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
 * The HUD is addressable because Reticle put it there, and so is every control inside it. The APP is
 * addressable only as a WHOLE — "here is the thing being snapshotted" — which needs a region, not a
 * control. The line is about authorship rather than size: a tour may ring any control it rendered
 * itself, and may never ring a button in the app, because that would be a guess about unseen markup.
 *
 * It matters that the tour points at the app at least once. The pitch is verifying YOUR RUNNING
 * APP from the inside, and a tour drawn entirely over a dimmed page reads as a modal that happens
 * to sit on top of one.
 */
export const TourAnchor = {
  /** No target: the slide is prose, centred. */
  NONE: 'none',
  /** Reticle's own in-page HUD. */
  HUD: 'hud',
  /** The app's own content region — `<main>`, else the framework's mount node. */
  APP: 'app',
  /** One control in the HUD's toolbar. Ours, so naming it is not a guess. */
  HUD_CHAT: 'hud-chat',
  HUD_ANNOTATE: 'hud-annotate',
  HUD_IMPACT: 'hud-impact',
  HUD_SETTINGS: 'hud-settings',
} as const;
export type TourAnchor = (typeof TourAnchor)[keyof typeof TourAnchor];

/** Anything the carousel can draw: a shared step, or one of the browser's own cards. */
export interface TourCard {
  id: string;
  /** Three or four words. The carousel shows this; the terminal does not. */
  title: string;
  /** What this step is, in words. Both surfaces show this. */
  say: string;
  /**
   * Why it is worth doing. Printed by the CLI tutorial; the carousel does not show it.
   *
   * The card is six slides read standing up, and a second paragraph on every one of them is the
   * text people stop reading tours over. A terminal has neither a ring nor a button beside the
   * words, so there the reason is the only thing that makes a step more than a keystroke.
   */
  why?: string;
  /** The exact call, for the audience that would otherwise infer it from the prose. */
  call?: string;
  /** What to highlight when drawn over a page. Ignored in a terminal. */
  anchor?: TourAnchor;
  /**
   * The invitation to actually use the thing being pointed at, when the tour can let the click
   * through to it.
   *
   * Only ever set on an anchor that is Reticle's own chrome: a tour may invite a click on a control
   * it rendered and never one on the app's own markup. Reading a slide about a button teaches
   * strictly less than pressing it, which is the difference between a carousel somebody clicks Next
   * through and a tour they have already used the product during.
   */
  tryIt?: string;
}

/**
 * A step BOTH surfaces show, which is why its reason is not optional.
 *
 * A card can lean on the ring beside it and the button under it. A terminal has neither, so a step
 * printed there with no reason is a keystroke with nothing to hang it on.
 */
export interface TourStep extends TourCard {
  why: string;
}

/** One ready-to-paste prompt on the handoff slide. */
export interface TourPrompt {
  /** What this prompt is for, in three or four words. */
  readonly label: string;
  /** The text itself, as somebody would actually type it. */
  readonly text: string;
}

/**
 * The prompts the last slide hands over.
 *
 * A tour that ends with "now go and try it" ends at the point where somebody has to invent the
 * next move themselves, which is where they stop. These are the moves, written out, ready to paste
 * into whichever agent they use.
 *
 * THREE rather than one, and short rather than thorough. The single prompt this replaced was a
 * paragraph that named a verdict as the finish line — correct, and not a sentence anybody types
 * twice. What people actually send an agent is one line, so a handoff written in a register they
 * will never reuse teaches the register as much as the task. Each of these is a line somebody
 * would plausibly type on their own the second time, which is the only version of this slide that
 * survives contact with the week after the install.
 *
 * Every one of them names something the product does: driving one flow to a verdict, the `/reticle`
 * command `init` writes into the project, and the autonomous crawl. The flows they name — login,
 * checkout — are examples of the SHAPE, since this tour runs over an unknown app; the
 * capability behind each is real, which is the part a tour must not get wrong.
 */
export const TOUR_HANDOFF_PROMPTS: readonly TourPrompt[] = [
  {
    label: 'Verify one flow',
    text: 'verify the login flow with Reticle, and tell me the verdict',
  },
  {
    label: 'Check what is proved',
    text: '/reticle',
  },
  {
    label: 'Let it loose',
    text: 'monkey-test the checkout flow with Reticle and tell me what breaks',
  },
];

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'connect',
    title: 'Yayyy! It is connected',
    // The ring points at the HUD, so the prose has to make the HUD the evidence: it is mounted only
    // on a connected session and never appears without one. Naming the call's output as the proof
    // instead sends a reader to the panel for a claim the panel does not make.
    say: 'That panel is Reticle. Seeing it is your proof the SDK is connected to your app.',
    why: 'It only mounts on a connected session, so it cannot show up without one. Having the tools is not the same as being set up.',
    // The merged surface has no `reticle_sessions`. It answers -32602 and names the replacement, so
    // a reader who pasted the old name lost a round trip to a tour that was teaching a dead call.
    call: 'reticle_session { action: "list" }',
    anchor: TourAnchor.HUD,
  },
  {
    id: 'look',
    title: 'Look, without pixels',
    say: 'Take a semantic snapshot. You get the controls and their refs, not pixels, so you can point at things by name.',
    why: 'A ref is stable across snapshots, which is what lets you plan several steps before spending any of them.',
    // Likewise merged: `reticle_snapshot` is now `reticle_look { action: "page" }`.
    call: 'reticle_look { action: "page" }',
    // The one slide that points at the app itself, and the only one where that is the subject: a
    // snapshot is OF this region. Without it the tour never once directs attention at the thing it
    // spends five slides talking about.
    anchor: TourAnchor.APP,
  },
  {
    id: 'declare',
    title: 'Say it first',
    say: 'Decide what should happen BEFORE you touch anything. "Clicking Pay makes the receipt appear" is a claim that can be wrong.',
    why: 'This is the whole idea. A consequence named first is a check; the same sentence written after the fact is a rationalisation, and it is the difference between a verdict and a story.',
    // Every other slide's block is something you can run; this one was a comment — a placeholder on
    // the most important screen in the tour. It now shows the distinction it is teaching, because
    // "name the consequence" means nothing until you see one next to a wait that proves nothing.
    call: 'until: { signal: "order:placed" }   // a consequence — not until: { ms: 500 }',
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

/**
 * The HUD's own controls, one card each, in the order somebody meets them.
 *
 * Browser-only. The CLI renders the shared steps into a terminal, where "click the Impact button" is
 * an instruction nobody can follow, so a card about a control in a panel cannot sit in the list both
 * surfaces print. The same reasoning already keeps the handoff out of `TOUR_STEPS`.
 *
 * They carry no `why`. A terminal step needs one because it has nothing beside it; these have a ring
 * on the button they describe and an invitation to press it, and a second paragraph explaining a
 * button somebody is about to click is the kind of text people stop reading tours over.
 */
export const TOUR_HUD_STEPS: readonly TourCard[] = [
  {
    id: 'hud-chat',
    title: 'Activity Panel',
    say: 'Watch what your agent is doing in your app, as it happens.',
    anchor: TourAnchor.HUD_CHAT,
    tryIt: 'Open it.',
  },
  {
    id: 'hud-annotate',
    title: 'Annotate',
    say: 'Click anywhere in your app to drop a numbered pin with a note. Hand the pins to your agent and it fixes them.',
    anchor: TourAnchor.HUD_ANNOTATE,
    tryIt: 'Turn it on, then click something in your app.',
  },
  {
    id: 'hud-impact',
    title: "What's the impact?",
    say: 'Everything Reticle has done here. Every bug it caught, every metric.',
    anchor: TourAnchor.HUD_IMPACT,
    tryIt: 'Take a look.',
  },
  {
    id: 'hud-settings',
    title: 'Make it yours',
    say: 'Change how Reticle looks and behaves.',
    anchor: TourAnchor.HUD_SETTINGS,
    tryIt: 'Open it.',
  },
];
