import {
  type Capability,
  type ActionReceipt,
  type Action,
  type Window,
  CloseCondition,
  RefusalReason,
} from '../vocabulary/realm-surface.js';
import { type ChannelDescriptor, type ChannelId } from '../vocabulary/channel.js';
import { type Coverage, type Observation } from '../vocabulary/evidence.js';
import { type SubjectRef } from '../vocabulary/subject.js';

/**
 * What you extend to make a new kind of environment verifiable.
 *
 * This is the service-provider interface for the Reality Plane. It exists because the alternative
 * -- a document describing four verbs and wishing you luck -- puts every invariant in this
 * specification at the mercy of an implementer's memory. The rules that make a verdict worth
 * anything are the easiest to leave out, because leaving them out produces a system that works
 * beautifully and is wrong.
 *
 * So the shape is deliberate: the questions only you can answer are ABSTRACT, and the rules
 * everybody must obey are IMPLEMENTED HERE AND SEALED. You cannot forget to refuse an undeclared
 * capability, because refusing is not your code. You cannot return a verdict, because there is no
 * method that returns one. You cannot emit an observation outside a window, because the only way
 * to get one is through a window you opened.
 *
 * ## What you must answer
 *
 * | Method       | The question |
 * | ------------ | ------------ |
 * | `identity`   | What is this, and what invalidates it? |
 * | `channels`   | What can you actually see, and is any of it independent of the action? |
 * | `capabilities` | What may an actor ask for here? |
 * | `describe`   | What is here right now, as structure rather than an image? |
 * | `perform`    | Do one thing, and report that you did it -- never that it worked. |
 * | `openWindow` | When does "done" happen in your world? |
 * | `observe`    | What was seen in that window? |
 * | `coverage`   | What could you not see? |
 *
 * ## What you must not do
 *
 * Return a verdict. There is no method for it, and that is not an oversight. A realm that could
 * decide whether an action succeeded would be the thing under test grading its own work, and
 * every honest property of this protocol descends from the fact that it cannot.
 *
 * ## The one method most implementations get wrong
 *
 * `openWindow`. It is tempting to inherit somebody else's answer -- wait until it goes quiet --
 * and quiescence is a web answer. A game never goes quiet. A service's truth arrives after the
 * acknowledgement. If your realm's "done" is not quiescence and you say it is, every asynchronous
 * claim in your domain will be reported `unknown` forever and it will look like a limitation of
 * the protocol.
 */
export abstract class Realm {
  // ── The questions only this realm can answer ────────────────────────────────────────────────

  /** What is running, and what would invalidate evidence about it. See `SubjectRef`. */
  abstract identity(): SubjectRef;

  /**
   * What this build can observe.
   *
   * Declared once, at connect time, and it is the first assertion this implementation makes. A
   * claim reading a channel that is not here is `unknown` immediately, rather than after the
   * action has been spent and the moment has passed.
   *
   * Declaring a channel you cannot actually observe is the one lie the conformance suite is built
   * to catch, because it produces a verifier that is scored on evidence it never had.
   */
  abstract channels(): readonly ChannelDescriptor[];

  /** What an actor may ask for. Anything not here is refused by `perform`, not by you. */
  abstract capabilities(): readonly Capability[];

  /** What is here right now, as a structure something can reason about rather than an image. */
  abstract describe(query?: unknown): Promise<unknown>;

  /**
   * Perform one action and report that it was delivered.
   *
   * Return `dispatched: true` when the realm accepted it. That is all this means. Whether anything
   * HAPPENED is decided elsewhere, from evidence on a channel other than the one that acted.
   */
  protected abstract dispatch(action: Action): Promise<ActionReceipt>;

  /**
   * Open a window and say what will close it.
   *
   * The close condition is yours. See the note above; this is the method that decides whether your
   * domain is really supported or only appears to be.
   */
  abstract openWindow(budgetMs: number): Window;

  /** Everything seen in that window, on the channels you declared. */
  abstract observe(window: Window): Promise<readonly Observation[]>;

  /**
   * What you could not see while that window was open.
   *
   * Returning an empty `blindSpots` array is a positive claim that nothing was hidden. If you
   * cannot enumerate them, say so by marking the channel unobserved rather than by returning
   * nothing -- a silent `[]` is the most expensive value in this interface.
   */
  abstract coverage(window: Window): Promise<Coverage>;

  /** Pixels, when this realm has them. Optional: a service has nothing to photograph. */
  photograph?(window: Window): Promise<Uint8Array>;

  // ── The rules, implemented once, for everybody ──────────────────────────────────────────────

  /**
   * Perform an action, or refuse it.
   *
   * Sealed. This is the method an actor calls, and the reason it is not `dispatch` is that the
   * refusal must not be optional. An implementation that quietly does something adjacent to what
   * was asked produces a result that looks like evidence and is not, and the only reliable defence
   * is that the check is not in the implementer's hands.
   */
  async perform(action: Action): Promise<ActionReceipt> {
    const known = this.capabilities().some((c) => c.name === action.capability);
    if (!known) {
      return this.refuse(
        action,
        RefusalReason.UNDECLARED,
        `this realm did not declare the capability "${action.capability}"; declared: ` +
          this.capabilities()
            .map((c) => c.name)
            .join(', '),
      );
    }
    return this.dispatch(action);
  }

  /** Build a refusal receipt. Sealed so that a refusal always carries a reason and a subject. */
  protected refuse(action: Action, reason: RefusalReason, detail: string): ActionReceipt {
    return {
      action: action.id,
      dispatched: false,
      refused: { reason, detail },
      subject: this.identity(),
      at: action.at,
    };
  }

  /** Can this realm see this channel? The question the adjudicator asks before spending an action. */
  observes(channel: ChannelId): boolean {
    return this.channels().some((c) => c.id === channel);
  }

  /** Channels a claim needs that this realm did not declare. Empty means the claim is answerable. */
  unobserved(needs: readonly ChannelId[]): readonly ChannelId[] {
    return needs.filter((channel) => !this.observes(channel));
  }

  /**
   * Has this realm got any independent channel at all?
   *
   * An implementation for which this is false can still be useful and still be conformant -- it
   * can describe, act and report presence. It can never prove anything, and it should know that
   * about itself at startup rather than discovering it one `unknown` at a time.
   */
  canProveAnything(): boolean {
    return this.channels().some((c) => c.independence === 'independent');
  }

  /** Whether a window ended the way it meant to. A budget-exhausted close cannot support a proof. */
  protected closedCleanly(window: Window): boolean {
    return (
      window.closedAt !== undefined &&
      window.closedBy !== undefined &&
      window.closedBy !== CloseCondition.BUDGET_EXHAUSTED
    );
  }
}
