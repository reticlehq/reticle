import {
  CHURN_TYPES,
  CommandMessageSchema,
  EventType,
  MessageKind,
  SESSION_LIFECYCLE,
  type CommandMessage,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { nativeSetTimeout, nativeNow } from '../timers/native-timers.js';
import { nativeWarn } from '../timers/native-console.js';
import { safeStringify } from '../security/serialization.js';

export interface CommandOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface TransportDeps {
  url: string;
  hello: () => HelloMessage;
  handleCommand: (command: CommandMessage) => Promise<CommandOutcome>;
  /** Unthrottled, unpatched clock for bridge-loss timing. Defaults to nativeNow (performance.now). */
  now?: () => number;
  /** Fired each time the WebSocket (re-)connects to the bridge. */
  onConnected?: () => void;
  /**
   * Liveness fallback: fired once when the bridge has been unreachable for SESSION_LIFECYCLE
   *.BRIDGE_LOST_MS — i.e. the server/agent process is gone, so no server-pushed end can arrive and
   * the SDK must end the session itself instead of showing a forever-"running" HUD.
   */
  onConnectionLost?: () => void;
  /**
   * Fired once when the VERY FIRST connection keeps failing (never opened) — i.e. the bridge is
   * unreachable at this URL, most often a wrong port or a container/WSL network boundary. Distinct
   * from onConnectionLost (which is about losing an ALREADY-established session). The caller surfaces
   * an actionable hint instead of retrying silently forever.
   */
  onUnreachable?: (detail: { url: string; attempts: number }) => void;
  /**
   * Subscribe to "the tab became visible again" (default: document `visibilitychange`). Browsers
   * throttle or suspend timers in a backgrounded tab, so the 1s reconnect loop stalls while hidden —
   * a bridge blip during sleep/background otherwise leaves the panel stuck on "ENDED" until a manual
   * reload. On foreground we retry IMMEDIATELY instead of waiting for the throttled timer. Returns an
   * unsubscribe; injected so a test can drive visibility without a real document.
   */
  onVisible?: (handler: () => void) => () => void;
  /**
   * Schedule an internal retry (default: `nativeSetTimeout`). Injected for the same reason `now` and
   * `onVisible` are — the default is bound to the real timer at module load so a frozen app clock
   * cannot deadlock the SDK, which also means no fake clock can observe what was scheduled.
   */
  schedule?: (fn: () => void, ms: number) => void;
}

/** Default visibility source: fire `handler` whenever the document returns to the foreground. */
function subscribeDocumentVisible(handler: () => void): () => void {
  if ('undefined' === typeof document) return () => undefined;
  const listener = (): void => {
    if ('visible' === document.visibilityState) handler();
  };
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

/** The first retry after a drop. Kept short: the common outage is a daemon restarting. */
const RECONNECT_DELAY_MS = 1000;
/**
 * The ceiling on reconnect backoff.
 *
 * A flat 1s retry with no growth and no cap meant a tab left open against a stopped daemon made
 * ~600 failed WebSocket opens in ten minutes — CPU, and a devtools console full of
 * ERR_CONNECTION_REFUSED. Backing off is only safe BECAUSE this transport also reconnects on
 * focus/visibility, so a human returning to the tab retries immediately rather than waiting out
 * the delay; the backoff resets on that path for the same reason.
 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * The next reconnect delay: double, then clamp. Pure, and exported so the POLICY is testable —
 * the scheduling itself runs on `nativeSetTimeout`, which is bound to the real timer at module load
 * (deliberately, so a frozen `reticle_clock` cannot deadlock the SDK) and therefore cannot be driven
 * by a fake clock.
 */
export function nextReconnectDelay(previous: number): number {
  return Math.min(previous * 2, RECONNECT_MAX_DELAY_MS);
}
/** Offline queue cap. Exported so tests overflow the real bound instead of a mirrored copy of it. */
export const MAX_QUEUE = 500;
/**
 * Standard WebSocket close code 1008 ("policy violation") — the bridge sends it for TERMINAL refusals:
 * a protocol-version mismatch (the browser package is older than the bridge and must be upgraded),
 * auth failure, or a duplicate/invalid handshake. Reconnecting cannot fix any of those, so a blind
 * retry loop just hammers the bridge every second forever and buries the actionable reason. 1013
 * ("try again later" — rate/session limits) and transport-level closes stay retryable.
 */
const WS_POLICY_VIOLATION = 1008;
/** Warn that the bridge is unreachable after this many consecutive failed INITIAL connects (~3s). */
const UNREACHABLE_WARN_AFTER = 3;

/**
 * An outbound message waiting for the socket. EVENT messages also carry their envelope coordinates:
 * evicting one is an observation gap the agent has to be told about, and the marker that declares it
 * can only be positioned correctly if we remember what it displaced.
 */
interface QueuedMessage {
  text: string;
  event?: { seq: number | undefined; t: number; type: string } | undefined;
  order: number;
}

/** WebSocket client to the bridge. Reconnects across reloads; buffers events while down. */
export class Transport {
  #ws: WebSocket | undefined;
  #churnQueue: QueuedMessage[] = [];
  #signalQueue: QueuedMessage[] = [];
  #insertOrder = 0;
  #closed = false;
  /** When the current continuous outage began (nativeNow), or undefined while connected. */
  #disconnectedSince: number | undefined;
  /** Current reconnect delay; grows on each failure, resets on a successful open or on focus. */
  #reconnectDelay = RECONNECT_DELAY_MS;
  /** Whether onConnectionLost has already fired for the current outage (fire-once). */
  #lost = false;
  /** True once the socket has opened at least once — gates the "unreachable" first-connect warning. */
  #everConnected = false;
  /** Consecutive failed INITIAL connects (before any success). */
  #initialFailures = 0;
  /** Whether the unreachable warning has fired (fire-once). */
  #warnedUnreachable = false;
  /** Events the offline queue has evicted since the last gap marker reached the bridge. */
  #dropped = 0;
  /**
   * Envelope coordinates of the most recent evicted event — the pending marker's tombstone. Set while
   * a gap is undeclared, cleared once the bridge has been told about it.
   */
  #gap: { seq: number | undefined; t: number } | undefined;
  /** Session id, cached from the first hello(). Stable for a Transport's life — no need to rebuild the
   * whole HelloMessage (url/title/adapters) on every inbound command just to read it. */
  #sessionId: string | undefined;
  /** Teardown for the visibility subscription (foreground-triggered reconnect), while connected. */
  #unsubscribeVisible: (() => void) | undefined;
  readonly #deps: TransportDeps;
  readonly #now: () => number;

  constructor(deps: TransportDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? nativeNow;
  }

  connect(): void {
    if ('undefined' === typeof WebSocket) return;
    this.#closed = false;
    this.#unsubscribeVisible ??= (this.#deps.onVisible ?? subscribeDocumentVisible)(() =>
      this.#onVisible(),
    );
    this.#open();
  }

  /**
   * The tab returned to the foreground. If we're disconnected (and not deliberately closed), reconnect
   * NOW — a hidden tab's throttled timer may be minutes from firing. A no-op when a socket already
   * exists (connected or mid-connect), so we never open a duplicate racing the scheduled retry.
   */
  #onVisible(): void {
    if (this.#closed) return;
    // A human just came back to the tab, which is the strongest signal the outage may be over — and
    // it is what makes a 30s ceiling safe. Reset the backoff BEFORE the mid-connect early return: if
    // a socket is already in flight and then fails, that retry should be prompt too, rather than
    // inheriting a delay earned while nobody was watching.
    this.#reconnectDelay = RECONNECT_DELAY_MS;
    if (this.#ws !== undefined) return;
    this.#open();
  }

  #open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#deps.url);
    } catch {
      // `new WebSocket()` throws SYNCHRONOUSLY on a mixed-content SecurityError — a ws:// URL from an
      // https page, which Safari does not exempt for localhost the way Chrome does. Unguarded, that
      // exception propagates out of connect() into the host app's bootstrap (the SDK's cardinal sin:
      // it must never break the app it observes) AND leaves connect() half-run, so #connected never
      // flips true and disconnect() can't remove the monkeypatches. Treat it like any failed open:
      // note the outage and schedule the normal retry.
      this.#noteOutage();
      this.#noteInitialFailure();
      this.#scheduleReopen();
      return;
    }
    this.#ws = ws;
    ws.onopen = (): void => {
      this.#disconnectedSince = undefined; // healthy again — reset the loss timer
      this.#lost = false;
      this.#everConnected = true; // a real connection happened ⇒ never warn "unreachable"
      this.#reconnectDelay = RECONNECT_DELAY_MS; // recovered — the next drop starts prompt again
      // HELLO is SDK-owned schema data. Preserve its pairing token; the generic sanitizer
      // intentionally redacts fields named "token" from app-controlled payloads.
      const greeting = this.#deps.hello();
      this.#sessionId ??= greeting.sessionId;
      ws.send(JSON.stringify(greeting));
      // Declare any gap BEFORE replaying the backlog, stamped with the OLDEST event the queue
      // dropped — see #sendRaw. The two queues are drained back into one stream in insertion order,
      // so what the bridge receives is the order the page produced, minus the holes.
      this.#sendGapMarker(ws, greeting.sessionId);
      const replay = [...this.#churnQueue, ...this.#signalQueue].sort((a, b) => a.order - b.order);
      for (const msg of replay) ws.send(msg.text);
      this.#churnQueue = [];
      this.#signalQueue = [];
      this.#deps.onConnected?.();
    };
    ws.onmessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      void this.#onMessage('string' === typeof data ? data : String(data));
    };
    ws.onclose = (event: CloseEvent): void => {
      this.#ws = undefined;
      // A 1008 is the bridge saying "don't come back as you are" — a version mismatch, a rejected
      // handshake. Retrying every second cannot change the outcome; stop and surface the reason (the
      // bridge puts an actionable message there, e.g. "upgrade @reticlehq/browser") instead of a
      // silent reconnect storm. End the session cleanly so the HUD doesn't hang on "running".
      if (event.code === WS_POLICY_VIOLATION) {
        this.#closed = true;
        const reason = event.reason.length > 0 ? event.reason : 'policy violation';
        nativeWarn(`[reticle] bridge refused the connection: ${reason} — not retrying.`);
        this.#deps.onConnectionLost?.();
        return;
      }
      this.#noteOutage();
      this.#noteInitialFailure();
      this.#scheduleReopen();
    };
    ws.onerror = (): void => {
      ws.close();
    };
  }

  /**
   * A scheduled reconnect — skipped if the SDK was torn down, or if a foreground-triggered reconnect
   * already opened a socket (guard against the throttled timer racing #onVisible into a duplicate).
   */
  /**
   * Schedule the next retry and grow the delay. Nothing is scheduled once the SDK is torn down.
   *
   * The delay grows AFTER scheduling, so the first retry of any outage is prompt (a daemon
   * restarting must not cost 30 seconds) and only a persistent outage backs off.
   */
  #scheduleReopen(): void {
    if (this.#closed) return;
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = nextReconnectDelay(delay);
    const schedule = this.#deps.schedule ?? nativeSetTimeout;
    schedule(() => this.#reopen(), delay);
  }

  #reopen(): void {
    if (this.#closed || this.#ws !== undefined) return;
    this.#open();
  }

  /**
   * The first connection has never opened: count failures and, once they cross the threshold, fire
   * onUnreachable ONCE so the app surfaces an actionable hint (wrong port / container network) rather
   * than retrying silently forever. Suppressed entirely once any connection has succeeded.
   */
  #noteInitialFailure(): void {
    if (this.#everConnected || this.#warnedUnreachable) return;
    this.#initialFailures += 1;
    if (this.#initialFailures >= UNREACHABLE_WARN_AFTER) {
      this.#warnedUnreachable = true;
      this.#deps.onUnreachable?.({ url: this.#deps.url, attempts: this.#initialFailures });
    }
  }

  /**
   * Track how long the bridge has been unreachable. Once the outage exceeds BRIDGE_LOST_MS, fire
   * onConnectionLost exactly once so the SDK can end the session (the server/agent is gone and can
   * no longer push an end itself).
   */
  #noteOutage(): void {
    const at = this.#now();
    this.#disconnectedSince ??= at;
    if (!this.#lost && at - this.#disconnectedSince >= SESSION_LIFECYCLE.BRIDGE_LOST_MS) {
      this.#lost = true;
      this.#deps.onConnectionLost?.();
    }
  }

  async #onMessage(text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const result = CommandMessageSchema.safeParse(parsed);
    if (!result.success) {
      // Also once silent. A command the page cannot parse is a version skew between the SDK and the
      // daemon, and dropping it produces the same unfalsifiable timeout every other hang produces — the one
      // failure mode where the cause is knowable and was being thrown away. Reply if we can recover
      // an id; a message without one is not a command we can answer at all.
      const id: unknown = (parsed as { id?: unknown } | null)?.id;
      if ('string' === typeof id && id.length > 0) {
        this.#sendRaw(
          safeStringify({
            kind: MessageKind.COMMAND_RESULT,
            id,
            ok: false,
            error:
              'this page could not parse the command — the @reticlehq/browser SDK and the daemon ' +
              'are probably different versions. Nothing ran.',
          }),
        );
      }
      return;
    }
    const command = result.data;
    // #sessionId is set in onopen, which always precedes any inbound command on the same socket.
    //
    // A mismatch used to `return` — silently. The command then had no reply of any kind, so the agent
    // waited out its full timeout and got "command timed out", which reads as a hung or suspended
    // page. Measured on a Tauri shell: the session was connected and streaming events the whole time
    // while every command vanished here, and three rounds of debugging went looking at the webview.
    // A dropped command is a real fault, so it now says so and names both ids.
    if (command.sessionId !== undefined && command.sessionId !== this.#sessionId) {
      this.#sendRaw(
        safeStringify({
          kind: MessageKind.COMMAND_RESULT,
          id: command.id,
          ok: false,
          error:
            `command addressed to session ${command.sessionId} but this page is ` +
            `${this.#sessionId ?? '(none)'} — the page reconnected under a new id, or two sessions ` +
            'share a socket. Nothing ran.',
        }),
      );
      return;
    }
    let outcome: CommandOutcome;
    try {
      outcome = await this.#deps.handleCommand(command);
    } catch (error) {
      outcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.#sendRaw(
      safeStringify({
        kind: MessageKind.COMMAND_RESULT,
        id: command.id,
        ok: outcome.ok,
        result: outcome.result,
        error: outcome.error,
      }),
    );
  }

  sendEvent(event: ReticleEvent): void {
    this.#sendRaw(safeStringify({ kind: MessageKind.EVENT, event }), {
      seq: event.seq,
      t: event.t,
      type: event.type,
    });
  }

  /**
   * Re-send the HELLO on a live socket.
   *
   * The hello carries `hasCapabilities`, and it goes out at connect() — before the app has had a
   * chance to call `registerCapabilities`, which by design happens AFTER connect so `registerStore`
   * has a live SDK to subscribe through. So an app that declared its whole testable surface still
   * appeared to the agent as having none, and nothing ever corrected it. Cheap and idempotent: the
   * bridge treats a hello as the session's current identity, not as a new session.
   */
  reannounce(): void {
    if (this.#ws === undefined || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(this.#deps.hello()));
  }

  #sendRaw(text: string, event?: QueuedMessage['event']): void {
    // A terminal refusal (1008) sets `#closed` and never reconnects. Queuing after that fills the
    // offline buffer forever — the gap marker only ships on a successful reopen that will not happen —
    // so upstream looks clean while every observation is discarded. Drop instead of enqueue.
    if (this.#closed) return;
    if (this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(text);
      return;
    }
    if (this.#churnQueue.length + this.#signalQueue.length >= MAX_QUEUE) {
      // Prefer sacrificing churn (high-volume, low-signal) over signal events. Falls back to signal
      // FIFO only when the churn queue is empty — the buffer is bounded either way.
      const evicted =
        this.#churnQueue.length > 0 ? this.#churnQueue.shift() : this.#signalQueue.shift();
      if (evicted?.event !== undefined) {
        this.#dropped += 1;
        // Keep the EARLIEST drop, not the latest. Under plain FIFO the two were the same thing, so
        // "latest evicted" was a precise boundary: everything before it was gone. Churn-first
        // eviction breaks that — a churn event newer than a surviving signal event can be the one
        // sacrificed, and stamping the marker with it would claim a hole that swallows events the
        // agent is about to receive. The oldest drop is the honest floor: the hole starts no later
        // than here. A truncation marker may over-state its reach; it must never under-state it.
        const previous = this.#gap;
        if (previous === undefined || evicted.event.t < previous.t) this.#gap = evicted.event;
      }
    }
    const isChurn = event !== undefined && CHURN_TYPES.has(event.type);
    const order = this.#insertOrder++;
    if (isChurn) {
      this.#churnQueue.push({ text, event, order });
    } else {
      this.#signalQueue.push({ text, event, order });
    }
  }

  /**
   * Tell the bridge the offline queue swallowed events, then consider the gap declared.
   *
   * Written straight to the open socket instead of going back through `sendEvent`, for two reasons
   * that both bite at exactly the moment the marker matters. The queue is full when a drop happens,
   * so a queued marker would evict another real event — every declared gap widening the gap it
   * declares. And it would re-enter `#sendRaw` from inside the eviction branch, between the `shift`
   * and the `push`, growing the queue by one on every later send. Writing here makes both impossible.
   *
   * The marker inherits the seq/t of the last event it displaced. That event never reaches the
   * bridge, so the coordinates are free, and the server orders a session by `seq` — a marker minted
   * at reconnect would carry the highest seq and blame a segment that never had a hole in it.
   */
  #sendGapMarker(ws: WebSocket, sessionId: string): void {
    const gap = this.#gap;
    if (gap === undefined) return;
    const marker: ReticleEvent = {
      t: gap.t,
      seq: gap.seq,
      type: EventType.TRANSPORT_OVERFLOW,
      sessionId,
      data: { dropped: this.#dropped },
    };
    ws.send(safeStringify({ kind: MessageKind.EVENT, event: marker }));
    this.#gap = undefined;
    this.#dropped = 0;
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribeVisible?.();
    this.#unsubscribeVisible = undefined;
    this.#ws?.close();
    this.#ws = undefined;
  }
}
