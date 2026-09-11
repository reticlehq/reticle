import { Realm } from '../spi/realm.js';
import { CHANNEL_DEFAULTS, ChannelId, type ChannelDescriptor } from '../vocabulary/channel.js';
import {
  type Action,
  type ActionReceipt,
  type Capability,
  CloseCondition,
  RefusalReason,
  type Window,
} from '../vocabulary/realm-surface.js';
import { BlindSpotKind, type Coverage, type Observation } from '../vocabulary/evidence.js';
import type { SubjectRef } from '../vocabulary/subject.js';

/**
 * A realm for something with no screen, written to find out whether this interface is honest.
 *
 * The specification claims the adjudicator is realm-blind and that a browser is one implementation
 * of a general shape rather than the shape itself. That claim is cheap to make and is falsified
 * only by writing a realm that shares nothing with a browser -- no DOM, no elements, no
 * quiescence, no screen to photograph. This is that realm.
 *
 * It is a REFERENCE, not a product. It ships in this package deliberately, because an implementer
 * asked to extend an abstract class with eight methods deserves to read one that already does, and
 * because a specification whose only implementation is the author's flagship has not demonstrated
 * anything.
 *
 * ── WHAT WRITING IT ESTABLISHED ─────────────────────────────────────────────────────────────────
 *
 * **The close condition really is the load-bearing generalisation.** A service does not go quiet.
 * It answers, and the answer is frequently `202 Accepted`, which means the truth has not arrived
 * and will arrive later through a channel nobody is currently holding open. If `openWindow` had
 * been allowed to assume quiescence -- the obvious choice, and the one a web-shaped design makes
 * without noticing -- this realm could not have been written at all, and the failure would have
 * looked like "the protocol does not support backends" rather than "the protocol has a browser
 * baked into one method".
 *
 * **`photograph` being optional is not a courtesy.** There is nothing here to photograph. An
 * interface that required it would have forced every non-visual realm to return an empty buffer,
 * and an empty buffer saved as a baseline is a comparison that passes forever.
 *
 * **Declaring two channels honestly beats declaring five hopefully.** This realm reaches the
 * `effect` profile and can never reach `in-realm`, because it observes the service from outside
 * and cannot read its memory. That is not a deficiency to be worked around. It is the true
 * statement about what this vantage point can see, and the profile exists so it can be said.
 */

/** What the service under test can be asked to do. Domain language, not transport language. */
export interface ServiceCommand {
  readonly name: string;
  readonly meaning: string;
  readonly mutating: boolean;
  /** Perform it. Returns the transport-level answer, which is NOT a verdict. */
  readonly call: (parameters: unknown) => Promise<ServiceCall>;
}

/** One request/response pair as this realm observed it, from outside the service. */
export interface ServiceCall {
  readonly method: string;
  readonly target: string;
  readonly status: number;
  readonly body: unknown;
  /** Set when the service answered "accepted, not finished" and named where the truth will land. */
  readonly pendingAt?: string;
  readonly at: number;
}

/** A line the service emitted about itself, observed from its log stream rather than its code. */
export interface ServiceLogLine {
  readonly level: string;
  readonly message: string;
  readonly at: number;
}

export interface ServiceRealmPorts {
  /** Identity that DIES: the running instance plus the deploy it is carrying. */
  readonly instance: () => { id: string; deploy?: string };
  /** The round of source edits, when the pipeline can say. Absent is not zero. */
  readonly epoch?: () => number | undefined;
  readonly commands: readonly ServiceCommand[];
  /** Everything seen at the boundary since a timestamp. */
  readonly callsSince: (at: number) => readonly ServiceCall[];
  readonly logSince: (at: number) => readonly ServiceLogLine[];
  /** Injected, never read from a global. A window's arithmetic must be reproducible. */
  readonly now: () => number;
}

/**
 * How long after an acknowledgement this realm keeps believing the truth might still arrive.
 *
 * Named rather than inlined because it is the one number in this file that is a judgement rather
 * than a fact, and a reader is entitled to argue with it. Past it, an accepted-and-unfinished call
 * stops being "pending" and starts being a blind spot -- the effect is somewhere this vantage
 * point cannot follow, which is a true statement and not a failure of the service.
 */
const RECONCILE_DEADLINE_MS = 30_000;

export class ServiceRealm extends Realm {
  readonly #ports: ServiceRealmPorts;
  #windowSeq = 0;

  constructor(ports: ServiceRealmPorts) {
    super();
    this.#ports = ports;
  }

  identity(): SubjectRef {
    const { id, deploy } = this.#ports.instance();
    const epoch = this.#ports.epoch?.();
    return {
      surface: 'service',
      // A restart replaces the instance and everything observed under the old one stops being
      // about the world. Folding the deploy in means a redeploy invalidates too, which is the
      // service equivalent of a navigation.
      instance: deploy === undefined ? id : `${id}@${deploy}`,
      ...(epoch === undefined ? {} : { epoch }),
      ...(deploy === undefined ? {} : { revision: deploy }),
    };
  }

  /**
   * Two channels, and both honest.
   *
   * `net` is what the service does at its boundary -- independent, because another party decides
   * the answer. `log` is what it says about itself, and it is `context` rather than `consequence`
   * for a reason worth stating: a service logging "order created" has told you its code reached a
   * log statement. The order is in the database or it is not, and the log line is not evidence
   * either way.
   */
  channels(): readonly ChannelDescriptor[] {
    return [
      { id: ChannelId.NET, ...CHANNEL_DEFAULTS[ChannelId.NET], note: 'observed at the boundary' },
      { id: ChannelId.LOG, ...CHANNEL_DEFAULTS[ChannelId.LOG], note: 'the service log stream' },
    ];
  }

  capabilities(): readonly Capability[] {
    return this.#ports.commands.map((c) => ({
      name: c.name,
      meaning: c.meaning,
      mutating: c.mutating,
    }));
  }

  /** What is here: the commands, and what the boundary has seen lately. No screen, no elements. */
  async describe(): Promise<unknown> {
    return {
      subject: this.identity(),
      commands: this.capabilities().map((c) => c.name),
      recent: this.#ports.callsSince(this.#ports.now() - 60_000).length,
    };
  }

  protected async dispatch(action: Action): Promise<ActionReceipt> {
    const command = this.#ports.commands.find((c) => c.name === action.capability);
    if (command === undefined) {
      // Unreachable through `perform`, which checks the declaration first. Kept because
      // `dispatch` is protected rather than private, and a subclass could reach it.
      return this.refuse(action, RefusalReason.UNDECLARED, `no command ${action.capability}`);
    }
    try {
      await command.call(action.parameters);
    } catch (error) {
      // A transport failure is a refusal, not a verdict. Nothing was learned about the service's
      // behaviour, only about our ability to reach it.
      return this.refuse(action, RefusalReason.UNAVAILABLE, `the call threw: ${String(error)}`);
    }
    return {
      action: action.id,
      dispatched: true,
      subject: this.identity(),
      at: this.#ports.now(),
    };
  }

  /**
   * A window that closes on acknowledgement, not on silence.
   *
   * The whole reason this file exists. A service is never quiet -- health checks, other tenants,
   * background work -- so waiting for quiescence here waits forever and then reports a
   * budget-exhausted close on a service that answered correctly in eleven milliseconds.
   */
  openWindow(budgetMs: number): Window {
    this.#windowSeq += 1;
    return {
      id: `w${String(this.#windowSeq)}`,
      openedAt: this.#ports.now(),
      budgetMs,
      closes: CloseCondition.ACK,
      subject: this.identity(),
    };
  }

  async observe(window: Window): Promise<readonly Observation[]> {
    const calls = this.#ports.callsSince(window.openedAt);
    const lines = this.#ports.logSince(window.openedAt);
    return [
      ...calls.map((call, index) => ({
        id: `${window.id}-net-${String(index)}`,
        window: window.id,
        channel: ChannelId.NET,
        at: call.at,
        value: call,
        summary: `${call.method} ${call.target} → ${String(call.status)}`,
      })),
      // The same call as a MEASURED QUANTITY, so a claim can say "within 300 ms" rather than
      // only "it happened". Latency from the window opening to the call being observed, which
      // needs no input this realm does not already have.
      //
      // A separate observation rather than a field inside the one above, because `measure`
      // reads `observation.value` when it is a number and will not reach into a structure. That
      // is deliberate in the specification: a path selector would be a predicate language
      // arriving through the back door, which is the same reason `summary` is matched exactly
      // rather than by pattern. So a realm that wants a quantity measured emits it as one.
      //
      // The unit is in the summary. The specification has no unit field on purpose: one the
      // engine could not check would exist to be ignored, and two implementations disagreeing
      // about it would disagree silently.
      ...calls.map((call, index) => ({
        id: `${window.id}-latency-${String(index)}`,
        window: window.id,
        channel: ChannelId.NET,
        at: call.at,
        value: call.at - window.openedAt,
        summary: 'service.call.latency.ms',
      })),
      ...lines.map((line, index) => ({
        id: `${window.id}-log-${String(index)}`,
        window: window.id,
        channel: ChannelId.LOG,
        at: line.at,
        value: line,
        summary: `${line.level}: ${line.message}`,
      })),
    ];
  }

  /**
   * What this vantage point could not see.
   *
   * Three of them, and enumerating them is the difference between a verifier that is modest and
   * one that is merely quiet. The two channels it never watches are declared unobserved and
   * NON-impeaching by default -- most claims here do not read them -- while an accepted-and-
   * unfinished call is impeaching, because the claim it belongs to is exactly the one whose
   * answer has not arrived.
   */
  async coverage(window: Window): Promise<Coverage> {
    const calls = this.#ports.callsSince(window.openedAt);
    const now = this.#ports.now();
    const pending = calls.filter(
      (c) => c.pendingAt !== undefined && now - c.at < RECONCILE_DEADLINE_MS,
    );
    const abandoned = calls.filter(
      (c) => c.pendingAt !== undefined && now - c.at >= RECONCILE_DEADLINE_MS,
    );
    return {
      window: window.id,
      observed: [ChannelId.NET, ChannelId.LOG],
      blindSpots: [
        {
          kind: BlindSpotKind.CHANNEL_UNOBSERVED,
          channel: ChannelId.STATE,
          detail: 'this realm watches the service from outside and cannot read its memory',
          impeaching: false,
          remedy: 'run an in-realm implementation inside the service to reach the in-realm profile',
        },
        ...pending.map((call) => ({
          kind: BlindSpotKind.STILL_IN_FLIGHT,
          channel: ChannelId.NET,
          detail:
            `${call.method} ${call.target} was accepted for later processing; the outcome will ` +
            `land at ${String(call.pendingAt)} and has not yet`,
          impeaching: true,
          remedy: 'adjudicate again once the outcome arrives, and supersede this verdict',
        })),
        ...abandoned.map((call) => ({
          kind: BlindSpotKind.EFFECT_ELSEWHERE,
          channel: ChannelId.NET,
          detail:
            `${call.method} ${call.target} was accepted and the reconcile deadline passed without ` +
            'the outcome arriving anywhere this realm watches',
          impeaching: true,
        })),
      ],
    };
  }

  /**
   * Close a window, saying what actually ended it.
   *
   * `closes` is the intent and `closedBy` is what happened, and they differ exactly when something
   * went wrong. A window whose budget ran out MUST say so: it is the difference between a verifier
   * that waited and a verifier that gave up, and only the first can support a proof.
   */
  closeWindow(window: Window): Window {
    const now = this.#ports.now();
    const acked = this.#ports.callsSince(window.openedAt).length > 0;
    const overBudget = now - window.openedAt >= window.budgetMs;
    return {
      ...window,
      closedAt: now,
      closedBy: acked && !overBudget ? CloseCondition.ACK : CloseCondition.BUDGET_EXHAUSTED,
    };
  }
}
