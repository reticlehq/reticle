/**
 * What a realm has to be able to do.
 *
 * A realm is the place an app runs and, more usefully, the layer that lets Reticle interact with it.
 * A browser tab, an Electron window, a Tauri window: different ways to press a button, to ask what is
 * on screen, to take a picture, to be told when something changed.
 *
 * This describes the four things every realm must answer. It is written from what the web realm
 * already does rather than designed in advance -- each verb below names the function that performs it
 * today, so the shape is a description of the code rather than a wish about it.
 *
 * WHY IT IS FOUR AND NOT ONE. It is tempting to fold "look" and "photograph" together, since both
 * answer "what is there". They are separate because their implementations diverge completely per
 * realm and one of them was got wrong: a browser tab is photographed through the debugging protocol,
 * a desktop window has no such endpoint, and capturing a screen region instead photographs the glass
 * -- so a window behind the editor yields a picture of the editor, saved as a baseline a later
 * comparison would trust. Reading the window's own backing store is the only correct answer, and it
 * exists only in the shell. A realm that could not describe capture separately would have no way to
 * say that.
 *
 * WHAT IS NOT HERE. Whether an interaction PROVED anything. A realm reports what it did and what it
 * saw; whether the declared consequence held is decided elsewhere, from evidence on a channel other
 * than the one that acted. That separation is the product, and a realm that could return a verdict
 * would be a verdict supplied by the thing being verified.
 */

/** One thing a realm must be able to do, and where the web realm does it today. */
export interface RealmCapabilityDescription {
  /** Short name, stable enough to look up. */
  readonly verb: string;
  /** What it means, for somebody deciding whether their environment can offer it. */
  readonly meaning: string;
  /** Where the web realm implements it, so a new realm has something to read. */
  readonly webImplementation: string;
}

/**
 * The four verbs, in the order a drive uses them: look, act, watch, photograph.
 *
 * Listed as data rather than as an interface with four methods, because no realm implements them as
 * one object yet. The web realm spreads them across three directories and the desktop realms add a
 * fourth from the shell side. Naming them is the step that makes gathering them possible; pretending
 * they are already gathered would be a shape nothing conforms to.
 */
export const REALM_VERBS: readonly RealmCapabilityDescription[] = [
  {
    verb: 'describe',
    meaning:
      'say what is on screen right now, as a structure something can reason about rather than an ' +
      'image. This is what an agent reads before deciding what to do.',
    webImplementation: 'buildSnapshot / describe, in the browser SDK',
  },
  {
    verb: 'act',
    meaning:
      'perform one interaction -- press, type, choose, drag -- and report what was done. Reporting ' +
      'that it was done is not the same as reporting that it worked, and only the first belongs here.',
    webImplementation: 'executeAction / executeSequence, in the browser SDK',
  },
  {
    verb: 'watch',
    meaning:
      'emit an event whenever something changes: a request, a console line, a route, a piece of ' +
      'state. This is the evidence a verdict is later decided from, which is why it must not be ' +
      'produced by whatever performed the action.',
    webImplementation: 'the observers, in the browser SDK',
  },
  {
    verb: 'photograph',
    meaning:
      'produce pixels of what is on screen. Separate from describing it because the two are ' +
      'implemented completely differently per realm, and because getting it wrong produces a picture ' +
      'of the wrong window rather than an error.',
    webImplementation: 'the debugging protocol for a tab; the shell for a desktop window',
  },
];
