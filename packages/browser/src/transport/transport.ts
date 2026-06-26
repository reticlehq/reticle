import {
  CommandMessageSchema,
  MessageKind,
  SESSION_LIFECYCLE,
  type CommandMessage,
  type HelloMessage,
  type IrisEvent,
} from '@syrin/iris-protocol';
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
   * caller (Iris) emits a synthetic TRANSPORT_OVERFLOW event so the agent learns about gaps.
   */
  onOverflow?: (dropped: number) => void;
  /**
   * Fired once when the VERY FIRST connection keeps failing (never opened) — i.e. the bridge is
   * unreachable at this URL, most often a wrong port or a container/WSL network boundary. Distinct
   * from onConnectionLost (which is about losing an ALREADY-established session). The caller surfaces
   * an actionable hint instead of retrying silently forever.
   */
  onUnreachable?: (detail: { url: string; attempts: number }) => void;
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
  readonly #deps: TransportDeps;
  readonly #now: () => number;

  constructor(deps: TransportDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? nativeNow;
  }

  connect(): void {
    if (typeof WebSocket === 'undefined') return;
    this.#closed = false;
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

  /** A scheduled reconnect — skipped if the SDK has since been torn down. */
  #reopen(): void {
    if (this.#closed) return;
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

  sendEvent(event: IrisEvent): void {
    this.#sendRaw(safeStringify({ kind: MessageKind.EVENT, event }));
  }

  #sendRaw(text: string): void {
    if (this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(text);
    } else if (this.#queue.length < MAX_QUEUE) {
      this.#queue.push(text);
    } else {
      this.#overflowCount += 1;
      this.#deps.onOverflow?.(this.#overflowCount);
    }
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
    this.#ws = undefined;
  }
}
