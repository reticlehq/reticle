import {
  IRIS_DEFAULT_PORT,
  IRIS_WS_PATH,
  IRIS_PROTOCOL_VERSION,
  MessageKind,
  type IrisEvent,
} from '@iris/protocol';

export interface IrisConnectOptions {
  /** WS endpoint of the local bridge. Defaults to ws://localhost:<IRIS_DEFAULT_PORT><IRIS_WS_PATH>. */
  url?: string;
  /** Human-friendly session label so the agent can target the right tab. */
  session?: string;
}

/**
 * Public entry point embedded in the host app.
 *
 *   import { iris } from '@iris/browser';
 *   if (import.meta.env.DEV) iris.connect();
 *
 * This is the M0/M1 skeleton: it establishes intent and the public shape. Observers,
 * snapshot builder, and action executor are implemented per plan/03-05.
 */
class Iris {
  #connected = false;
  #sessionName = 'default';

  connect(options: IrisConnectOptions = {}): void {
    if (this.#connected) return;
    const url = options.url ?? `ws://localhost:${String(IRIS_DEFAULT_PORT)}${IRIS_WS_PATH}`;
    this.#sessionName = options.session ?? this.#sessionName;
    this.#connected = true;
    // TODO(M1): open WS, send HELLO { protocolVersion: IRIS_PROTOCOL_VERSION }, install observers.
    void url;
    void MessageKind.HELLO;
    void IRIS_PROTOCOL_VERSION;
  }

  /**
   * Surface an arbitrary app-domain observation the DOM can't express
   * (webhook received, websocket message, state-machine transition). See plan/03 §7.
   */
  signal(name: string, data: Record<string, unknown> = {}): void {
    if (!this.#connected) return;
    // TODO(M3): push a SIGNAL IrisEvent into the outbound queue.
    void name;
    void data;
  }

  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    // TODO(M1): tear down observers, restore patched globals, close WS.
  }
}

export const iris = new Iris();
export type { IrisEvent };
