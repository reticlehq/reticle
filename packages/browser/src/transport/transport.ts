import {
  CommandMessageSchema,
  MessageKind,
  SESSION_LIFECYCLE,
  type CommandMessage,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { nativeSetTimeout, nativeNow } from '../timers/native-timers.js';
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
   * .BRIDGE_LOST_MS — i.e. the server/agent process is gone, so no server-pushed end can arrive and
   * the SDK must end the session itself instead of showing a forever-"running" HUD.
   */
  onConnectionLost?: () => void;
  /**
   * Called with the cumulative drop count each time the outbound queue overflows. The
   * caller (Reticle) emits a synthetic TRANSPORT_OVERFLOW event so the agent learns about gaps.
   */
  onOverflow?: (dropped: number) => void;
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
}

/** Default visibility source: fire `handler` whenever the document returns to the foreground. */
function subscribeDocumentVisible(handler: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const listener = (): void => {
    if (document.visibilityState === 'visible') handler();
  };
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

const RECONNECT_DELAY_MS = 1000;
const MAX_QUEUE = 500;
/** Warn that the bridge is unreachable after this many consecutive failed INITIAL connects (~3s). */
const UNREACHABLE_WARN_AFTER = 3;

/** WebSocket client to the bridge. Reconnects across reloads; buffers events while down. */
export class Transport {
  #ws: WebSocket | undefined;
  #queue: string[] = [];
  #closed = false;
  /** When the current continuous outage began (nativeNow), or undefined while connected. */
  #disconnectedSince: number | undefined;
  /** Whether onConnectionLost has already fired for the current outage (fire-once). */
  #lost = false;
  /** True once the socket has opened at least once — gates the "unreachable" first-connect warning. */
  #everConnected = false;
  /** Consecutive failed INITIAL connects (before any success). */
  #initialFailures = 0;
  /** Whether the unreachable warning has fired (fire-once). */
  #warnedUnreachable = false;
  #overflowCount = 0;
  /** Teardown for the visibility subscription (foreground-triggered reconnect), while connected. */
  #unsubscribeVisible: (() => void) | undefined;
  readonly #deps: TransportDeps;
  readonly #now: () => number;

  constructor(deps: TransportDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? nativeNow;
  }

  connect(): void {
    if (typeof WebSocket === 'undefined') return;
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
    if (this.#closed || this.#ws !== undefined) return;
    this.#open();
  }

  #open(): void {
    const ws = new WebSocket(this.#deps.url);
    this.#ws = ws;
    ws.onopen = (): void => {
      this.#disconnectedSince = undefined; // healthy again — reset the loss timer
      this.#lost = false;
      this.#everConnected = true; // a real connection happened ⇒ never warn "unreachable"
      // HELLO is SDK-owned schema data. Preserve its pairing token; the generic sanitizer
      // intentionally redacts fields named "token" from app-controlled payloads.
      ws.send(JSON.stringify(this.#deps.hello()));
      for (const msg of this.#queue) ws.send(msg);
      this.#queue = [];
      this.#deps.onConnected?.();
    };
    ws.onmessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      void this.#onMessage(typeof data === 'string' ? data : String(data));
    };
    ws.onclose = (): void => {
      this.#ws = undefined;
      this.#noteOutage();
      this.#noteInitialFailure();
      if (!this.#closed) nativeSetTimeout(() => this.#reopen(), RECONNECT_DELAY_MS);
    };
    ws.onerror = (): void => {
      ws.close();
    };
  }

  /**
   * A scheduled reconnect — skipped if the SDK was torn down, or if a foreground-triggered reconnect
   * already opened a socket (guard against the throttled timer racing #onVisible into a duplicate).
   */
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
    if (!result.success) return;
    const command = result.data;
    const currentSessionId = this.#deps.hello().sessionId;
    if (command.sessionId !== undefined && command.sessionId !== currentSessionId) return;
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
    this.#sendRaw(safeStringify({ kind: MessageKind.EVENT, event }));
  }

  #sendRaw(text: string): void {
    if (this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(text);
      return;
    }
    if (this.#queue.length >= MAX_QUEUE) {
      // Full offline queue: drop the OLDEST and keep the newest (ring), so after reconnect the agent
      // replays RECENT activity instead of 500 stale events with the latest lost. The overflow
      // counter still signals that a gap occurred.
      this.#queue.shift();
      this.#overflowCount += 1;
      this.#deps.onOverflow?.(this.#overflowCount);
    }
    this.#queue.push(text);
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribeVisible?.();
    this.#unsubscribeVisible = undefined;
    this.#ws?.close();
    this.#ws = undefined;
  }
}
