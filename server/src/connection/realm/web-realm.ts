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
  type Handle,
  type Observation,
  Realm,
  RefusalReason,
  type SubjectRef,
  type Window as ProtocolWindow,
} from '@reticlehq/openreality';
import {
  CONTRADICTION_CHANNELS,
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

export interface WebRealmDeps {
  readonly session: Session;
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

const CHANNEL_OF_PREFIX: Readonly<Record<string, ProtocolChannel>> = {
  net: ProtocolChannel.NET,
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
const PROTOCOL_ANOMALY: Readonly<Record<string, string>> = {
  [ContradictionKind.UI_ADVANCED_REQUEST_FAILED]: AnomalyKind.ADVANCED_OVER_FAILURE,
  [ContradictionKind.SIGNAL_CONTRADICTED]: AnomalyKind.CLAIMED_OVER_FAILURE,
  [ContradictionKind.RESPONSE_IGNORED]: AnomalyKind.EFFECT_DISCARDED,
  [ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE]: AnomalyKind.CLAIM_UNCORROBORATED,
  [ContradictionKind.PARTIAL_FAILURE_IN_OK_RESPONSE]: AnomalyKind.FAILURE_INSIDE_SUCCESS,
  [ContradictionKind.UNIT_MISMATCH]: AnomalyKind.VALUE_NOT_APPLIED,
  [ContradictionKind.WRITE_FIELD_IGNORED]: AnomalyKind.VALUE_NOT_APPLIED,
  [ContradictionKind.DUPLICATE_REQUEST]: AnomalyKind.DUPLICATED_EFFECT,
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

  constructor(deps: WebRealmDeps) {
    super();
    this.#deps = deps;
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
  channels(): readonly ChannelDescriptor[] {
    const declared = this.#deps.session.channels ?? [];
    return declared
      .filter((id): id is ProtocolChannel => id in CHANNEL_DEFAULTS)
      .map((id) => ({ id, ...CHANNEL_DEFAULTS[id] }));
  }

  capabilities(): readonly Capability[] {
    return PAGE_CAPABILITIES;
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
      blindSpots: [...structural, ...truncated, ...undeclared, ...this.#stillInFlight(window)],
    });
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
    const found = findContradictions(events, { actionSince: window.openedAt });
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
