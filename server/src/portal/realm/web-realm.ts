import {
  CHANNEL_DEFAULTS,
  type Action,
  type ActionReceipt,
  type BlindSpot,
  BlindSpotKind,
  type Capability,
  type ChannelDescriptor,
  ChannelId as ProtocolChannel,
  CloseCondition,
  type Anomaly,
  AnomalyKind,
  AnomalyTier,
  type Coverage,
  type DeterminismProfile,
  type Handle,
  type Observation,
  Realm,
  RefusalReason,
  fixtureIsUsable,
  type FixtureRef,
  type Reversal,
  type SubjectRef,
  type Window as ProtocolWindow,
} from '@reticlehq/openreality';
import {
  CONTRADICTION_CHANNELS,
  SettleReason,
  ContradictionKind,
  EventType,
  ReticleCommand,
  subjectOf,
  tierOfFinding,
} from '@reticlehq/core';
import { findContradictions } from '@reticlehq/engine/disagreement/contradictions.js';
import type { Session } from '../session/session.js';

/**
 * Reticle's own realms, said in the protocol's words.
 *
 * We wrote a specification with an abstract class at the middle of it and then did not extend it
 * anywhere. The two realms this product actually ships -- a browser document and a desktop
 * webview -- predate `Realm` and are built around a wire rather than around a class, so they
 * conformed to the vocabulary and not to the interface. An author who publishes an interface and
 * implements it nowhere has published a suggestion.
 *
 * This closes that. It is an ADAPTER, not a rewrite: every method delegates to the session that
 * already knows the answer, and nothing about the wire, the SDK or the daemon changes. What it
 * buys is not new behaviour, it is a second opinion -- writing the eight answers down in the
 * protocol's shape is what makes it possible to notice that one of them was never being asked.
 *
 * ── WHAT WRITING IT ESTABLISHED ─────────────────────────────────────────────────────────────────
 *
 * **A "realm" here is a PAIR, not a page.** The protocol's realm answers eight questions; this
 * codebase answers half of them in the browser and half in the daemon, across a socket. The class
 * has to live on the side that can see both, which is the daemon -- the SDK alone can never
 * implement this interface, because it cannot photograph itself and does not know its own
 * document id until the daemon assigns one. That is worth knowing before somebody tries to make
 * the SDK extend it.
 *
 * **Desktop is the same realm with a different camera.** Electron and Tauri run this same SDK in
 * their renderer, so identity, channels, actions and observations are byte-identical to the web.
 * The only divergence is who owns the pixels — one method, which is why this is one class rather
 * than three subclasses.
 *
 * The surface used to arrive as a PARAMETER, on the same reasoning. It is derived now, because
 * a parameter is a place to be wrong: every caller in the repository passed `'web'`, the session
 * had known its runtime the whole time, and `desktop` had therefore never once been the surface
 * of anything. A field a caller must remember to set correctly, which nothing checks, and which
 * every caller sets the same way, is not a parameter — it is a constant with a way to lie.
 */

/**
 * A way to save and restore whatever the subject is holding — a cookie jar, localStorage, a session.
 *
 * Optional, because on the web the capability belongs to the CONNECTION rather than to the realm. An
 * attached session — the user's own browser with the SDK in it, which is the common case — cannot
 * write a cookie jar from inside the page; httpOnly is the entire point of httpOnly. A DRIVEN page
 * has a browser context behind it and can.
 *
 * The payload is opaque here on purpose: the protocol never reads it, and only whatever wrote it can.
 */
export interface FixturePort {
  capture(): Promise<unknown>;
  apply(payload: unknown): Promise<void>;
}

/**
 * A way to break the subject on purpose and put it back.
 *
 * Optional for the same reason the fixture port is: a driven page can be perturbed and an attached
 * tab cannot. Declared as what the realm NEEDS rather than imported from whatever provides it.
 */
export interface MutationPort {
  mutate(mutation: { kind: string; target?: string }): Promise<Reversal>;
  revert(): Promise<void>;
}

export interface WebRealmDeps {
  readonly session: Session;
  /** Present only when this connection can actually perturb the page. See `MutationPort`. */
  readonly mutations?: MutationPort;
  /** Present only when this connection can actually restore state. See `FixturePort`. */
  readonly fixtures?: FixturePort;
  /**
   * The SESSION's clock, in elapsed milliseconds since it connected — `session.elapsed()`.
   *
   * Not wall time, and the distinction is not stylistic. Every event in the buffer is stamped in
   * this domain, and the buffer is searched BY TIMESTAMP, so a window opened at a wall-clock
   * instant selects every event ever recorded or none of them depending on which side of 1970 you
   * are standing on. Writing this file with `Date.now()` produced a window that observed nothing
   * and reported it as a page that did nothing, which is the most expensive shape of wrong
   * available here.
   *
   * Injected rather than read from the session so the arithmetic stays reproducible in a test.
   */
  readonly now: () => number;
}

/**
 * The commands a driven page accepts, as protocol capabilities.
 *
 * Domain language where this codebase has it and transport language where it does not. `act` is
 * honestly named -- a page is a surface and pressing things on it is what an actor does -- while
 * `state_read` and `storage_read` are named for the channel they read rather than for a business
 * verb, because a generic page has no business verbs to borrow.
 *
 * `mutating` is the field that earns its place: a verifier that cannot tell a read from a write
 * either refuses to explore or explores destructively, and both are how a crawl ends up placing
 * an order.
 */
const PAGE_CAPABILITIES: readonly Capability[] = [
  {
    name: ReticleCommand.ACT,
    meaning: 'perform one interaction with something on screen',
    mutating: true,
  },
  {
    name: ReticleCommand.ACT_SEQUENCE,
    meaning: 'perform several interactions in order',
    mutating: true,
  },
  { name: ReticleCommand.NAVIGATE, meaning: 'go to a different location', mutating: true },
  { name: ReticleCommand.REFRESH, meaning: 'reload the current location', mutating: true },
  { name: ReticleCommand.SCROLL, meaning: 'move the viewport', mutating: false },
  {
    name: ReticleCommand.SNAPSHOT,
    meaning: 'read what is on screen as a structure',
    mutating: false,
  },
  {
    name: ReticleCommand.QUERY,
    meaning: 'find something on screen by how it is described',
    mutating: false,
  },
  {
    name: ReticleCommand.MATCH,
    meaning: 'ask whether something on screen matches',
    mutating: false,
  },
  { name: ReticleCommand.INSPECT, meaning: 'read one thing on screen in detail', mutating: false },
  { name: ReticleCommand.STATE_READ, meaning: 'read the application store', mutating: false },
  {
    name: ReticleCommand.STORAGE_READ,
    meaning: 'read values that outlive a screen',
    mutating: false,
  },
  { name: ReticleCommand.ANIMATIONS, meaning: 'read what is currently moving', mutating: false },
  {
    name: ReticleCommand.CAPABILITIES,
    meaning: 'read what this application declared about itself',
    mutating: false,
  },
];

/**
 * Which protocol channel each observed event belongs to.
 *
 * `Record` over the event vocabulary would be better and is not available here without importing
 * the whole enum, so this reads the event's own prefix -- the convention every event name in this
 * codebase already follows (`net.request`, `dom.added`, `state.change`). An event whose prefix is
 * unrecognised is reported on no channel rather than guessed onto one, because a guess here is an
 * observation attributed to a source that did not produce it.
 */
/** Why an action's settle wait ended, when the page said. */
function readSettleReason(result: unknown): string | undefined {
  if ('object' !== typeof result || null === result) return undefined;
  const reason = (result as { settleReason?: unknown }).settleReason;
  return 'string' === typeof reason ? reason : undefined;
}

/** A network event's correlation id, if it carries one. Events are `unknown` at this boundary. */
function readRequestId(data: unknown): string | undefined {
  if ('object' !== typeof data || null === data) return undefined;
  const id = (data as { id?: unknown }).id;
  return 'string' === typeof id ? id : undefined;
}

/** What the request was pointed at, for a blind spot a person has to read. */
function readUrl(data: unknown): string | undefined {
  if ('object' !== typeof data || null === data) return undefined;
  const url = (data as { url?: unknown }).url;
  return 'string' === typeof url ? url : undefined;
}

export const CHANNEL_OF_PREFIX: Readonly<Record<string, ProtocolChannel>> = {
  net: ProtocolChannel.NET,
  // Screen facts. Each is unambiguously "what is on the subject's surface", which is what the
  // protocol's `ui` channel means, and each was being dropped as an unrecognised prefix -- so
  // an animation, a dialog or a reveal was recorded by the SDK and never reached the
  // adjudicator at all. The refusal to guess was right; the list of things that need no
  // guessing was short.
  anim: ProtocolChannel.UI,
  dialog: ProtocolChannel.UI,
  focus: ProtocolChannel.UI,
  render: ProtocolChannel.UI,
  reveal: ProtocolChannel.UI,
  scroll: ProtocolChannel.UI,
  visible: ProtocolChannel.UI,
  ipc: ProtocolChannel.NET,
  dom: ProtocolChannel.UI,
  state: ProtocolChannel.STATE,
  signal: ProtocolChannel.SIGNAL,
  console: ProtocolChannel.LOG,
  error: ProtocolChannel.LOG,
  route: ProtocolChannel.ROUTE,
  storage: ProtocolChannel.STORAGE,
  perf: ProtocolChannel.TIME,
};

/**
 * Prefixes that are deliberately NOT evidence, each with the reason.
 *
 * These describe the TOOL rather than the subject: Reticle's own transport overflowing, its SDK
 * failing, a person pressing pause in the HUD, a flow being recorded. Reporting any of them as
 * evidence about the application would be the observer contaminating the observation, which is
 * the confusion this whole protocol exists to prevent.
 *
 * Named rather than left to fall through, because "unrecognised" and "deliberately excluded"
 * were producing identical behaviour and only one of them is a decision. `every-event-is-placed
 * .test.ts` fails if a new prefix belongs to neither list.
 */
export const NOT_EVIDENCE: Readonly<Record<string, string>> = {
  context: "Reticle's own context tool opening, not something the application did",
  flow: 'a flow being recorded by the tool',
  human: 'a person driving the HUD: pause, resume, a mark. The operator, not the subject',
  page: "the SDK's own health report about the page it is inside",
  sdk: 'the SDK itself failing, which is a fact about the observer',
  transport: "the tool's own buffer overflowing",
  'blind-spot':
    'a region the SDK cannot observe: a cross-origin iframe, a closed shadow root. Reported as ' +
    'coverage rather than evidence -- `coverage()` emits it from `session.blindSpots()` as the ' +
    "protocol's `boundary-uncrossable`, which is where a gap in observation belongs",
  truncated:
    'a per-channel cap dropping part of a batch. This IS reported, as coverage rather than as ' +
    "evidence: `coverage()` already emits it as the protocol's `buffer-truncated` blind spot, " +
    'which is the plane the specification puts it in',
};

/**
 * Application behaviour the protocol has no channel for.
 *
 * `download` is the app producing a FILE -- a Blob handed to `URL.createObjectURL` and saved.
 * It is unambiguously the subject acting, and it is the one artifact class nothing outside the
 * browser can inspect, because it never crosses the network: there is no request to intercept.
 *
 * The protocol's nine channels cannot say it. It is not `net` (its own definition is that no
 * network is involved), not `storage` (that is cookies and web storage), not `ui`. Mapping it to
 * the nearest one would be exactly the error `observe()` refuses elsewhere -- an observation
 * attributed to a source that did not produce it.
 *
 * So it is named here rather than mapped or silently dropped, and it is a **gap in the
 * specification** rather than in this adapter: a tenth channel, for a consequence the subject
 * emitted that left no trace on any of the nine.
 */
export const NO_PROTOCOL_CHANNEL: Readonly<Record<string, string>> = {
  download: 'a file the application produced; the protocol has no channel for an emitted artifact',
};

/**
 * The capabilities that change the world, and therefore need an attribution window.
 *
 * Derived from the same `mutating` flag the protocol already asks for, rather than a second
 * hand-written list — a read that opened an action window would put a snapshot in the journal as
 * something the agent DID, and a write that did not would leave a real change unattributed.
 */
const MUTATING_COMMANDS: ReadonlySet<string> = new Set(
  PAGE_CAPABILITIES.filter((c) => c.mutating).map((c) => c.name),
);

/**
 * Reticle's contradiction kinds, in the protocol's vocabulary.
 *
 * `Record` would be wrong here: ours is deliberately the larger list, and a kind with no
 * protocol equivalent is reported with an `x-` prefix rather than squeezed into the nearest
 * listed one. Filing an anomaly under the wrong kind is worse than filing it under an
 * unfamiliar name, because the wrong kind is believed.
 */
/**
 * Findings the specification models as COVERAGE rather than as anomalies.
 *
 * Both describe a gap in what was observed, not a fault in the application, and the protocol
 * gives each a `BlindSpotKind`: `consequence-elsewhere` is `effect-elsewhere`, and
 * `request-never-settled` is `still-in-flight`. Reporting them as anomalies put them in the
 * wrong plane -- and `request-never-settled` was reported TWICE, once here and once as the
 * blind spot `coverage()` already emits.
 *
 * The verdict is unchanged either way, because both were absence-derived and both routes
 * downgrade to `unknown`. The plane is what matters: the specification separates "I could not
 * see" from "something is wrong" precisely so that an unsettled request cannot read as a fault,
 * and an implementation that files it under anomalies has agreed with the words and not the
 * shape.
 */
const REPORTED_AS_COVERAGE: ReadonlySet<string> = new Set<string>([
  ContradictionKind.CONSEQUENCE_ELSEWHERE,
  ContradictionKind.REQUEST_NEVER_SETTLED,
]);

const PROTOCOL_ANOMALY: Readonly<Record<string, string>> = {
  [ContradictionKind.UI_ADVANCED_REQUEST_FAILED]: AnomalyKind.ADVANCED_OVER_FAILURE,
  [ContradictionKind.SIGNAL_CONTRADICTED]: AnomalyKind.CLAIMED_OVER_FAILURE,
  [ContradictionKind.RESPONSE_IGNORED]: AnomalyKind.EFFECT_DISCARDED,
  [ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE]: AnomalyKind.CLAIM_UNCORROBORATED,
  [ContradictionKind.PARTIAL_FAILURE_IN_OK_RESPONSE]: AnomalyKind.FAILURE_INSIDE_SUCCESS,
  [ContradictionKind.UNIT_MISMATCH]: AnomalyKind.VALUE_NOT_APPLIED,
  [ContradictionKind.WRITE_FIELD_IGNORED]: AnomalyKind.VALUE_NOT_APPLIED,
  [ContradictionKind.DUPLICATE_REQUEST]: AnomalyKind.DUPLICATED_EFFECT,
  // The same kind, and the TIER carries the difference: Reticle grades this one `advisory`,
  // which the specification defines as "true, worth reporting, and not about the claim. Decides
  // nothing." It was falling through to `x-duplicate-request-unrelated` for want of a line,
  // which named a kind no reader of the protocol knows while the protocol already had the exact
  // pairing.
  [ContradictionKind.DUPLICATE_REQUEST_UNRELATED]: AnomalyKind.DUPLICATED_EFFECT,
  [ContradictionKind.STALE_RESPONSE_APPLIED]: AnomalyKind.STALE_APPLIED,
  [ContradictionKind.ACTION_HAD_NO_EFFECT]: AnomalyKind.NO_EFFECT,
  [ContradictionKind.FAILURE_MISATTRIBUTED]: AnomalyKind.FAULT_MISATTRIBUTED,
  [ContradictionKind.EVIDENCE_SUPERSEDED]: AnomalyKind.EVIDENCE_SUPERSEDED,
  [ContradictionKind.EVIDENCE_PREDATES_EDIT]: AnomalyKind.EVIDENCE_PREDATES_EDIT,
};

/** Reticle's finding tiers, in the protocol's. The tier decides what an anomaly may do. */
const PROTOCOL_TIER: Readonly<Record<string, AnomalyTier>> = {
  observed: AnomalyTier.OBSERVED,
  'absence-derived': AnomalyTier.ABSENCE_DERIVED,
  advisory: AnomalyTier.ADVISORY,
};

export class WebRealm extends Realm {
  readonly #deps: WebRealmDeps;
  #windowSeq = 0;
  /**
   * Whether the last action's settle wait ended because the page was THROTTLED.
   *
   * Kept because the specification names this exact case and forbids the obvious handling of
   * it: *"'the verifier gave up' and 'this realm cannot measure the close condition' are
   * different facts, and an implementation MUST NOT report the second as the first. A hidden
   * browser tab never flushes the frame that quiescence is read from, and a hidden tab is the
   * NORMAL state for agent-driven verification, so an implementation that reports an
   * unmeasurable settle signal as `budget-exhausted` makes every backgrounded subject
   * permanently unprovable."*
   *
   * Which is what this adapter did. `closedBy` derives `budget-exhausted` from elapsed time, and
   * a throttled tab always outlasts its budget, so every verdict taken in a backgrounded page
   * was `unknown` at clause 5 -- the specification's own example of the mistake, committed by
   * the implementation that ships beside it.
   */
  #settleThrottled = false;

  /**
   * Saved state, and putting it back — assigned in the constructor rather than declared as methods.
   *
   * That is the difference between offering a capability and having one. A realm must not OFFER a
   * fixture it cannot honour: claiming one you cannot restore produces flows that pass because the
   * PREVIOUS flow happened to leave the right state behind, which is a suite that only works in the
   * order it was written — worse than running every flow from cold, which is merely slower.
   *
   * A declared method is always present, so a realm with no port would answer "yes I do fixtures"
   * and then throw. `applyFixture === undefined` is how an optional member says *not offered*, and
   * these are therefore fields that exist only when something can back them.
   */
  /**
   * Break the subject, when something can — and be ABSENT when nothing can.
   *
   * The same structural honesty the fixture methods carry: a declared method is always present, so
   * a realm with no port would answer "yes I can be broken" and then throw. A mutation set that
   * cannot be applied is not a small mutation set, it is a mutation score that demotes flows for
   * surviving things that never happened to them.
   */
  override readonly mutate?: (mutation: { kind: string; target?: string }) => Promise<Reversal>;

  override readonly captureFixture?: () => Promise<FixtureRef>;
  override readonly applyFixture?: (ref: FixtureRef) => Promise<void>;

  constructor(deps: WebRealmDeps) {
    super();
    this.#deps = deps;
    const breaker = deps.mutations;
    if (breaker !== undefined) this.mutate = (mutation) => breaker.mutate(mutation);
    const port = deps.fixtures;
    if (port !== undefined) {
      this.captureFixture = async (): Promise<FixtureRef> => ({
        id: `web-${String(deps.now())}`,
        // Stamped with the subject it came from, epoch included. State that cannot say where it was
        // taken is state nothing can check before putting it back.
        subject: this.identity(),
        capturedAt: deps.now(),
        payload: await port.capture(),
      });
      this.applyFixture = async (ref: FixtureRef): Promise<void> => {
        /*
         * Refused when the subject has moved on, and this is the reason the epoch travels at all.
         * Restoring a session the current build would never have issued makes every flow after it
         * green against a state that cannot happen — a false green with a long tail, because it
         * survives until somebody notices the fixture is older than the code.
         */
        if (!fixtureIsUsable(ref, this.identity())) {
          throw new Error(
            `refusing to apply fixture "${ref.id}": it was captured from a different subject ` +
              `(${ref.subject.instance}@${String(ref.subject.epoch)}), and this one is ` +
              `${this.identity().instance}@${String(this.identity().epoch)}. State from a build ` +
              'that has since been rewritten is not a shortcut — it is a green flow standing on a ' +
              'session the current code would never have issued. Capture a fresh one.',
          );
        }
        await port.apply(ref.payload);
      };
    }
  }

  /**
   * Identity that dies with the document, and an epoch that moves when the code does.
   *
   * `currentDocumentId` is already the thing that changes on a full navigation, and
   * `currentEditEpoch` already the round of edits — both were built for exactly the reasons the
   * protocol gives, years before the protocol said so. Mapping them is a rename, which is the
   * strongest evidence available that the abstraction was not invented for this document.
   */
  identity(): SubjectRef {
    return subjectOf(this.#deps.session);
  }

  /**
   * What the page said it can observe, at the grades this specification assigns.
   *
   * Read from the handshake rather than assumed. An SDK too old to declare returns UNDEFINED
   * there, and this reports an empty list — which makes every claim `unknown` and is the correct,
   * loud answer. Substituting a hopeful default here would be this file quietly restoring the
   * exact bug the declaration was added to remove.
   */
  /**
   * A browser is the cheapest subject in this table, and saying so is what lets the rest of the
   * protocol stop assuming every subject is one.
   *
   * `replayPrefix: 'free'` is measured, not asserted: re-driving a recorded step costs ~27ms, which
   * is what makes "fix the break, resume, find the next one" a loop rather than a full re-read.
   * `time: 'injectable'` because the clock control ships. `actions: 'reversible'` is about the REALM
   * — a click can be undone by a reload — and not a promise about the app behind it, which is why a
   * destructive action still needs its own confirmation.
   */
  determinism(): DeterminismProfile {
    return {
      reset: 'cheap',
      replayPrefix: 'free',
      time: 'injectable',
      observation: 'exact',
      actions: 'reversible',
    };
  }

  channels(): readonly ChannelDescriptor[] {
    const declared = this.#deps.session.channels ?? [];
    return declared
      .filter((id): id is ProtocolChannel => id in CHANNEL_DEFAULTS)
      .map((id) => ({ id, ...CHANNEL_DEFAULTS[id] }));
  }

  capabilities(): readonly Capability[] {
    // Narrowed to what THIS page said it serves. The list above is what a current build can do;
    // the session's handshake says what the build on the other end actually does, and declaring
    // the union of the two was a first assertion that could be false.
    //
    // The protocol treats capabilities as the implementation's own claim, and seals `perform()`
    // so an undeclared one is refused before an action is spent. Declaring a command the page
    // cannot answer inverts that: the refusal arrives later, from the session, after the action
    // has been committed to.
    //
    // `undefined` means an SDK too old to report its commands, and is NOT "none" -- the same
    // rule `HandshakeFacts` states for every field it carries. Such a page gets the full list,
    // which is the behaviour it had before anyone could ask.
    const served = this.#deps.session.commands;
    if (served === undefined) return PAGE_CAPABILITIES;
    const offered = new Set(served);
    return PAGE_CAPABILITIES.filter((c) => offered.has(c.name));
  }

  async describe(query?: unknown): Promise<unknown> {
    const args =
      'object' === typeof query && null !== query ? (query as Record<string, unknown>) : {};
    const result = await this.#deps.session.command(ReticleCommand.SNAPSHOT, args);
    return result.result;
  }

  protected async dispatch(action: Action): Promise<ActionReceipt> {
    // Open the attribution window BEFORE the command goes out.
    //
    // Every act in this codebase has to be inside one, and a guard enforces it, because a
    // dispatch path that skips it is invisible: the journal records nothing, the causal summary
    // has no action to hang events off, and the verdict that follows is attributed to whatever
    // happened to be in the buffer. Writing this adapter produced exactly that path, and the
    // guard is why it lasted about ninety seconds.
    if (MUTATING_COMMANDS.has(action.capability)) {
      this.#deps.session.beginAction(action.capability, {
        ...(action.target === undefined ? {} : { ref: action.target }),
      });
    }
    const args: Record<string, unknown> = {
      ...('object' === typeof action.parameters && null !== action.parameters
        ? (action.parameters as Record<string, unknown>)
        : {}),
      ...(action.target === undefined ? {} : { ref: action.target }),
    };
    const result = await this.#deps.session.command(action.capability, args);
    this.#settleThrottled = readSettleReason(result.result) === SettleReason.THROTTLED;
    if (true !== result.ok) {
      // The page answered and said no. That is a refusal, not a verdict and not a failure of the
      // application: nothing was learned about whether the consequence would have held.
      return this.refuse(
        action,
        RefusalReason.UNAVAILABLE,
        'string' === typeof result.error ? result.error : 'the page did not perform it',
      );
    }
    return {
      action: action.id,
      dispatched: true,
      subject: this.identity(),
      at: this.#deps.now(),
    };
  }

  /**
   * A window that closes when the page goes quiet.
   *
   * Quiescence is the right answer HERE and is not the concept — see the specification's note on
   * why an engine that hard-codes it excludes every asynchronous domain. A document has a frame
   * loop and a network stack that both eventually stop, which is exactly the condition under
   * which waiting for silence is meaningful.
   */
  openWindow(budgetMs: number): ProtocolWindow {
    this.#windowSeq += 1;
    const id = `w${String(this.#windowSeq)}`;
    // `openedAt` IS the cursor. The buffer is searched by timestamp, so the moment the window
    // opened selects exactly this window's events and no earlier ones -- which is what makes an
    // observation's claim about its window true rather than approximate.
    //
    // An earlier draft kept a separate index per window and seeded it from the buffer's LENGTH.
    // That reads as a cursor and is not one: `since()` binary-searches timestamps, so a count of
    // three meant "everything from millisecond three onward". It observed the wrong events on a
    // young session and none at all on an old one, and the second failure looks exactly like a
    // page that did nothing.
    return {
      id,
      openedAt: this.#deps.now(),
      budgetMs,
      closes: CloseCondition.QUIESCENCE,
      subject: this.identity(),
    };
  }

  observe(window: ProtocolWindow): Promise<readonly Observation[]> {
    const events = this.#deps.session.eventsSince(window.openedAt);
    const out: Observation[] = [];
    for (const [index, event] of events.entries()) {
      const channel = CHANNEL_OF_PREFIX[String(event.type).split('.')[0] ?? ''];
      // Unrecognised prefix: reported on no channel rather than guessed onto one. An observation
      // attributed to a source that did not produce it is worse than an observation nobody has.
      if (channel === undefined) continue;
      out.push({
        id: `${window.id}-${String(index)}`,
        window: window.id,
        channel,
        at: event.t,
        value: event.data,
        summary: String(event.type),
      });
    }
    // Synchronous underneath: the buffer is already in memory. The interface is async because a
    // realm that must go and ask for its observations exists, and one signature has to serve both.
    return Promise.resolve(out);
  }

  /**
   * What could not be seen.
   *
   * `impeaching` is left FALSE throughout, deliberately. Whether a blind spot bears on a verdict
   * depends on which channels the claim reads, and a realm does not see the claim — deciding it
   * here would be the observer grading the relevance of its own gaps. What a realm CAN do is say
   * which channel each gap falls on, and the adjudicator matches that against the claim.
   *
   * That is a correction. Both halves used to defer: this said the adjudicator would decide, and
   * the adjudicator filtered on a flag that nothing ever set. Clause 6 was unreachable, and a
   * window that closed over a request still in flight proved things.
   */
  coverage(window: ProtocolWindow): Promise<Coverage> {
    const { session } = this.#deps;
    const observed = this.channels().map((c) => c.id);
    const structural = Object.entries(session.blindSpots()).map(([kind, count]) => ({
      kind: BlindSpotKind.BOUNDARY_UNCROSSABLE,
      detail: `${kind} × ${String(count)}`,
      impeaching: false,
    }));
    const truncated = session.lostSince(window.openedAt)
      ? [
          {
            kind: BlindSpotKind.BUFFER_TRUNCATED,
            detail: 'the event buffer evicted part of this window before it was read',
            impeaching: false,
          },
        ]
      : [];
    // Every channel this specification names that the page did not declare. Stated rather than
    // implied: a reader comparing two implementations needs to see what each one is NOT watching,
    // and an absence that is merely absent from a list reads as an oversight.
    const undeclared = Object.values(ProtocolChannel)
      .filter((id) => !observed.includes(id))
      .map((id) => ({
        kind: BlindSpotKind.CHANNEL_UNOBSERVED,
        channel: id,
        detail: `this build did not declare ${id} at connect`,
        impeaching: false,
      }));
    // Synchronous underneath, like `observe`: everything read here is already in memory. The
    // interface is async because a realm that has to go and ask exists, and one signature serves
    // both.
    return Promise.resolve({
      window: window.id,
      observed,
      blindSpots: [
        ...structural,
        ...truncated,
        ...undeclared,
        ...this.#stillInFlight(window),
        ...this.#effectElsewhere(window),
        ...(this.#settleThrottled
          ? [
              {
                kind: BlindSpotKind.BOUNDARY_UNCROSSABLE,
                channel: ProtocolChannel.TIME,
                detail:
                  'the page was throttled, so the frame quiescence is read from never arrived; ' +
                  'this window cannot say whether it went idle',
                // Non-impeaching, exactly as the specification prescribes: it costs a claim
                // nothing unless that claim reads `time`, and clause 6 decides that by matching
                // the channel rather than by trusting this flag.
                impeaching: false,
              },
            ]
          : []),
      ],
    });
  }

  /**
   * Did the last settle wait end because the page was throttled?
   *
   * Read by the binding as well as by `coverage()`, so that the close condition and the blind
   * spot agree about the same window rather than each deciding for itself.
   */
  settleWasThrottled(): boolean {
    return this.#settleThrottled;
  }

  /**
   * A consequence that happened somewhere this observer cannot follow.
   *
   * Reticle finds this and used to report it as an anomaly. The specification models it as a
   * blind spot, which is the same judgement in the right plane: nothing here says the
   * application is wrong, only that the proof is somewhere we cannot reach.
   */
  #effectElsewhere(window: ProtocolWindow): readonly BlindSpot[] {
    const events = this.#deps.session.eventsSince(window.openedAt);
    return findContradictions(events, { actionSince: window.openedAt })
      .filter((c) => ContradictionKind.CONSEQUENCE_ELSEWHERE === c.kind)
      .map((c) => ({
        kind: BlindSpotKind.EFFECT_ELSEWHERE,
        detail: c.detail ?? c.counter,
        impeaching: false,
      }));
  }

  /**
   * Operations that had not finished when the window closed.
   *
   * A request that opened and never settled is the difference between "it did not happen" and
   * "I stopped watching first", and only the second is true. The window's end was our choice, so
   * an unsettled operation is a gap in the OBSERVATION and never a fault in the application —
   * which is why it lands here rather than among the anomalies, where it could force a `no` on
   * somebody whose backend is merely slow.
   */
  #stillInFlight(window: ProtocolWindow): readonly BlindSpot[] {
    const opened = new Map<string, string>();
    for (const event of this.#deps.session.eventsSince(window.openedAt)) {
      const id = readRequestId(event.data);
      if (id === undefined) continue;
      if (event.type === EventType.NET_PENDING) opened.set(id, readUrl(event.data) ?? id);
      else if (event.type === EventType.NET_REQUEST) opened.delete(id);
    }
    return [...opened.values()].map((where) => ({
      kind: BlindSpotKind.STILL_IN_FLIGHT,
      channel: ProtocolChannel.NET,
      detail: `${where} had not settled when the window closed`,
      impeaching: false,
    }));
  }

  /**
   * Two things in the window that cannot both be true.
   *
   * This is not new detection. Reticle has found these for a long time -- seventeen kinds of
   * cross-channel contradiction -- and the specification simply never said whose job it was, so
   * a binding written from the specification passed an empty array and three planted defects
   * came back green. The rules were here; nothing was asking for them.
   *
   * What crosses from Reticle's registry to the protocol's is deliberately lossy. The protocol
   * names twelve domain-independent kinds and Reticle has seventeen, because several of ours are
   * about a browser specifically. A kind with no protocol equivalent is reported with an `x-`
   * prefix, which the specification allows, rather than being forced into the nearest listed one
   * -- an anomaly filed under the wrong kind is worse than one filed under an unfamiliar name.
   *
   * The TIER is carried across unchanged and that is the load-bearing part: `absence-derived`
   * may only downgrade a verdict to `unknown`, never force a `no`, because the window's end was
   * our choice and "I stopped looking" is not "it did not happen".
   */
  override detect(
    window: ProtocolWindow,
    observed: readonly Observation[],
  ): Promise<readonly Anomaly[]> {
    void observed;
    const events = this.#deps.session.eventsSince(window.openedAt);
    // `actionSince` is not optional decoration: several rules -- the double-submit one among
    // them -- do not run at all without it, because "the same write fired twice" is only a
    // finding relative to ONE action. Passing `{}` left that rule switched off, and a planted
    // double submit came back proved. In this protocol the window IS the action's extent, so
    // its opening moment is exactly the boundary those rules are asking for.
    const found = findContradictions(events, { actionSince: window.openedAt }).filter(
      (c) => !REPORTED_AS_COVERAGE.has(c.kind),
    );
    // Synchronous underneath: the rules read a buffer that is already in memory. The interface
    // is async for a realm that has to go and ask.
    return Promise.resolve(
      found.map((contradiction) => {
        const kind = PROTOCOL_ANOMALY[contradiction.kind] ?? `x-${contradiction.kind}`;
        const channels = CONTRADICTION_CHANNELS[contradiction.kind as ContradictionKind];
        return {
          kind,
          // An unrecognised tier falls to ABSENCE_DERIVED, not OBSERVED. The safe direction is
          // the one that can only downgrade a verdict: a tier we do not understand must never be
          // able to force a `no` on an application.
          tier: PROTOCOL_TIER[tierOfFinding(contradiction.kind)] ?? AnomalyTier.ABSENCE_DERIVED,
          claim: contradiction.claim,
          counter: contradiction.counter,
          between: (channels ?? [ProtocolChannel.UI, ProtocolChannel.NET]) as [
            ProtocolChannel,
            ProtocolChannel,
          ],
          evidence: [],
        };
      }),
    );
  }

  /**
   * How a person names a control, turned into a handle `act` will accept.
   *
   * The gap that a driver written against this interface fell straight into: it held
   * `testid=login-submit`, handed it to `act` as a target, and every action was refused --
   * correctly, because a selector is not a handle, and nothing in the interface bridged the two.
   *
   * Several matches are returned, never narrowed. Picking the first plausible one is how a
   * driver acts on the element beside the one it meant, which this project has measured on a
   * real dashboard and reported as a clean green.
   */
  override async locate(query: unknown): Promise<readonly Handle[]> {
    const args = 'object' === typeof query && null !== query ? { ...query } : {};
    const result = await this.#deps.session.command(ReticleCommand.QUERY, args);
    if (true !== result.ok) return [];
    const elements = (result.result as { elements?: unknown } | undefined)?.elements;
    if (!Array.isArray(elements)) return [];
    const found: Handle[] = [];
    for (const element of elements) {
      if ('object' !== typeof element || null === element) continue;
      const ref = (element as { ref?: unknown }).ref;
      if ('string' !== typeof ref) continue;
      const name = (element as { name?: unknown; text?: unknown }).name;
      const text = (element as { text?: unknown }).text;
      found.push({
        ref,
        describes:
          'string' === typeof name && name.length > 0
            ? name
            : 'string' === typeof text && text.length > 0
              ? text
              : ref,
      });
    }
    return found;
  }

  /**
   * Pixels, and the one place the two surfaces genuinely differ.
   *
   * A browser tab is photographed through the debugging protocol; a desktop window has no such
   * endpoint and is read from its own backing store through the shell. Both arrive here as the
   * same command, which is why one class serves both — and why capturing a screen REGION was the
   * wrong answer for desktop: it photographs the glass, so a window behind the editor yields a
   * picture of the editor, saved as a baseline a later comparison would trust.
   */
  override async photograph(): Promise<Uint8Array> {
    const result = await this.#deps.session.command(ReticleCommand.CAPTURE, {});
    const data = (result.result as { data?: unknown } | undefined)?.data;
    if ('string' !== typeof data) {
      throw new Error('this realm could not produce a picture, and must not pretend it did');
    }
    return Uint8Array.from(Buffer.from(data, 'base64'));
  }
}
