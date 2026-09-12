import {
  type Handle,
  type Capability,
  type ActionReceipt,
  type Action,
  type Window,
  CloseCondition,
  RefusalReason,
} from '../vocabulary/realm-surface.js';
import { type ChannelId } from '../vocabulary/channel.js';
import { Witness } from './witness.js';
import type { FixtureRef } from '../vocabulary/fixture.js';
import type { Reversal } from '../vocabulary/mutation.js';
import type { DeterminismProfile } from '../vocabulary/determinism.js';
import { type Observation } from '../vocabulary/evidence.js';
import type { Anomaly } from '../vocabulary/verdict.js';

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
export abstract class Realm extends Witness {
  // ── The questions only this realm can answer ────────────────────────────────────────────────

  /*
   * `identity`, `channels`, `openWindow`, `observe` and `coverage` are inherited from `Witness`.
   *
   * That is the honest direction of the relationship: OBSERVING is the base and ACTING is the
   * addition. A realm is a witness that can also touch the subject — and a witness is not a realm
   * with its action methods left unimplemented, which is the modelling that would let a vantage
   * point quietly acquire the ability to cause what it reports.
   */

  /**
   * How this subject may be DRIVEN — the five properties that decide resume, reset and safety.
   *
   * Abstract on purpose, and it is the one place this specification asks a question a browser never
   * has to. Everything else here is about what a realm can SEE; this is about what it can be put
   * through, and the rest of the protocol had quietly inherited a web page's answer: "resume is
   * nearly free, re-drive the prefix". On a service a POST is not idempotent. On hardware it moves
   * a physical arm.
   *
   * A default would have been the mistake either way. `free` would be the protocol telling a payment
   * service it is a browser; `unsafe` would silently downgrade every realm that is honestly cheap to
   * re-drive. So every realm says, the same way it says what it can observe — and declaring a
   * property you do not have is the lie the conformance suite exists to catch. This is the more
   * expensive half of that rule: a channel you cannot observe costs a wrong verdict, a
   * `replayPrefix` you do not have costs a re-sent payment.
   *
   * Callers derive the strategy with `resumeStrategy`; they never read `replayPrefix` themselves.
   */
  abstract determinism(): DeterminismProfile;

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
   * Turn how a person names something into a handle an action will accept.
   *
   * Optional, like `photograph`, and for the same reason: a realm with no addressable surface
   * has nothing to locate. A service answers requests; there is no "the button called Pay" in
   * it, and requiring this would make every such realm return an empty array forever.
   *
   * It is a READ, so it returns data. That is why it cannot be folded into `perform`, which
   * returns a receipt and never data — a receipt that carried results would be the shape the
   * action/verdict separation exists to prevent, and an action that returned what it found
   * would be one step from an action that returns whether it worked.
   *
   * A realm MAY return several handles, and MUST NOT guess between them. Returning the first
   * plausible match for an ambiguous description is how a driver ends up acting on the element
   * beside the one it meant, which this project has measured and reported as a clean green.
   */
  locate?(query: unknown): Promise<readonly Handle[]>;

  /**
   * Two things in this window that cannot both be true.
   *
   * §8 defines twelve anomaly kinds and, until this method existed, named nobody who produces
   * one. `adjudicate` took them as an input and the interface had no way to return one, so a
   * conformant implementation could be built in which the whole of anomaly detection was
   * unreachable — and one was. Three planted defects came back `yes`.
   *
   * **Why it is safe for an adapter to do this, when a realm must never return a verdict.** An
   * anomaly is not a verdict; it is the observation that two channels disagree, and the
   * adjudicator decides what that is worth. More importantly it is GATED: a disagreement may
   * only convict when at least one of the two channels is independent of the action, and that
   * check runs on the adjudicator's side over the channel declaration. So an implementation
   * that reported its own screen contradicting its own store would find the anomaly recorded
   * and deciding nothing. It cannot convict itself however hard it tries.
   *
   * Optional, because detecting these needs to know what a request or a render IS, and a realm
   * with neither has nothing to compare. An implementation that omits it is conformant and
   * simply never reports the class.
   *
   * An implementation MUST set the tier honestly. `observed` may force a `no`;
   * `absence-derived` may only downgrade to `unknown`, because "I did not see it happen" and
   * "it did not happen" are different facts and the window's end was our choice, not the
   * subject's.
   */
  detect?(window: Window, observed: readonly Observation[]): Promise<readonly Anomaly[]>;

  /** Pixels, when this realm has them. Optional: a service has nothing to photograph. */
  photograph?(window: Window): Promise<Uint8Array>;

  /**
   * Put the subject into state somebody captured earlier, and capture it — both optional.
   *
   * A suite of fifty flows that each start from cold spends most of its time proving the login
   * works, fifty times; and the flow that logs OUT leaves every flow after it signed out, which no
   * amount of navigating repairs, because the problem is not where the subject is but what it holds.
   *
   * What a fixture IS cannot live in this protocol — a saved `storageState`, a seeded container, a
   * save file, rows and a migration, a homed rig. The protocol says THAT one exists and when it is
   * applied; you say how.
   *
   * Offering neither is a correct implementation that is merely slower: every flow runs from cold.
   * Offering one you cannot honour is the failure this is shaped to prevent — a fixture you claim
   * and cannot restore produces flows that pass because the PREVIOUS flow happened to leave the
   * right state behind, which is a suite that only works in the order it was written. Same rule as
   * `channels()`, and the same reason.
   *
   * Check `fixtureIsUsable` before applying one: state captured from a build that has since been
   * rewritten is a green flow standing on a session the current code would never have issued.
   */
  applyFixture?(ref: FixtureRef): Promise<void>;
  captureFixture?(): Promise<FixtureRef>;

  /**
   * Break the subject on purpose, and hand back how to undo it — optional.
   *
   * This is what lets a verifier grade ITSELF. A flow that would stay green if the feature broke is
   * worse than no flow, and there is no way to tell one from a real flow by reading it: the only
   * way is to break the thing it claims to watch and see whether it notices. A flow that does not go
   * red is demoted — it is not a test, it is a click sequence.
   *
   * A realm perturbs what it has: a web page loses a handler or a locator, a service fails a
   * request, a game freezes a subsystem. Hardware almost certainly declares nothing, and that is a
   * correct answer rather than a missing feature — a rig you can break on demand is a rig you can
   * break by accident.
   *
   * The `Reversal` is not optional politeness. A break nobody can undo is damage, and a run that
   * lost track of what it left broken would hand the next one a subject that is not the subject.
   */
  mutate?(mutation: { kind: string; target?: string }): Promise<Reversal>;

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
