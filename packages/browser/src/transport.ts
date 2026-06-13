import {
  MessageKind,
  type CommandMessage,
  type HelloMessage,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { nativeSetTimeout } from './native-timers.js';

export interface CommandOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface TransportDeps {
  url: string;
  hello: () => HelloMessage;
  handleCommand: (command: CommandMessage) => Promise<CommandOutcome>;
}

const RECONNECT_DELAY_MS = 1000;
const MAX_QUEUE = 500;

/** WebSocket client to the bridge. Reconnects across reloads; buffers events while down. */
export class Transport {
  #ws: WebSocket | undefined;
  #queue: string[] = [];
  #closed = false;
  readonly #deps: TransportDeps;

  constructor(deps: TransportDeps) {
    this.#deps = deps;
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
      ws.send(JSON.stringify(this.#deps.hello()));
      for (const msg of this.#queue) ws.send(msg);
      this.#queue = [];
    };
    ws.onmessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      void this.#onMessage(typeof data === 'string' ? data : String(data));
    };
    ws.onclose = (): void => {
      this.#ws = undefined;
      if (!this.#closed) nativeSetTimeout(() => this.#open(), RECONNECT_DELAY_MS);
    };
    ws.onerror = (): void => {
      ws.close();
    };
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
    }
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
    this.#ws = undefined;
  }
}
