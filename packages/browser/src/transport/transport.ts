import {
  MessageKind,
  SESSION_LIFECYCLE,
  type CommandMessage,
  type HelloMessage,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { nativeSetTimeout, nativeNow } from '../timers/native-timers.js';

export interface CommandOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface TransportDeps {
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
}

const RECONNECT_DELAY_MS = 1000;
const MAX_QUEUE = 500;

/** WebSocket client to the bridge. Reconnects across reloads; buffers events while down. */
export class Transport {
  #ws: WebSocket | undefined;
  #queue: string[] = [];
  #closed = false;
  /** When the current continuous outage began (nativeNow), or undefined while connected. */
  #disconnectedSince: number | undefined;
  /** Whether onConnectionLost has already fired for the current outage (fire-once). */
  #lost = false;
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
    const msg = parsed as { kind?: string };
    if (msg.kind !== MessageKind.COMMAND) return;
    const command = parsed as CommandMessage;
    const outcome = await this.#deps.handleCommand(command);
    this.#sendRaw(
      JSON.stringify({
        kind: MessageKind.COMMAND_RESULT,
        id: command.id,
        ok: outcome.ok,
        result: outcome.result,
        error: outcome.error,
      }),
    );
  }

  sendEvent(event: IrisEvent): void {
    this.#sendRaw(JSON.stringify({ kind: MessageKind.EVENT, event }));
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
