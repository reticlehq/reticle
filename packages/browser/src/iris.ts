import {
  EventType,
  IRIS_DEFAULT_PORT,
  IRIS_PROTOCOL_VERSION,
  IRIS_WS_PATH,
  MessageKind,
  type CommandMessage,
  type HelloMessage,
  type IrisEvent,
} from '@iris/protocol';
import { createCommandRegistry, type CommandHandler } from './commands.js';
import { Transport, type CommandOutcome } from './transport.js';
import { adapterNames } from './adapters.js';
import { installDom } from './observers/dom.js';
import { installNetwork } from './observers/network.js';
import { installRoute } from './observers/route.js';
import { installConsole } from './observers/console.js';
import { installAnimation } from './observers/animation.js';
import type { Teardown } from './observers/types.js';

export interface IrisConnectOptions {
  /** WS endpoint of the local bridge. Defaults to ws://localhost:<port><path>. */
  url?: string;
  /** Human-friendly session label so the agent can target the right tab. */
  session?: string;
}

/**
 * The browser-side orchestrator. Wires observers -> events -> bridge, and bridge
 * commands -> handlers. Embedded in the host app (dev only).
 */
export class Iris {
  #transport: Transport | undefined;
  #registry: Map<string, CommandHandler> = new Map();
  #teardowns: Teardown[] = [];
  #connected = false;
  #session = 'default';
  #start = 0;

  connect(options: IrisConnectOptions = {}): void {
    if (this.#connected) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    this.#session = options.session ?? `s${Date.now().toString(36)}`;
    this.#start = performance.now();
    this.#registry = createCommandRegistry();

    const url = options.url ?? `ws://localhost:${String(IRIS_DEFAULT_PORT)}${IRIS_WS_PATH}`;
    this.#transport = new Transport({
      url,
      hello: () => this.#hello(),
      handleCommand: (command) => this.#handleCommand(command),
    });

    const emit = this.#emit;
    this.#teardowns = [
      installNetwork(emit),
      installRoute(emit),
      installConsole(emit),
      installAnimation(emit),
      installDom(emit),
    ];

    this.#transport.connect();
    this.#connected = true;
  }

  /** Surface an arbitrary app-domain observation the DOM can't express (plan/03 §7). */
  signal(name: string, data: Record<string, unknown> = {}): void {
    this.#emit(EventType.SIGNAL, { name, data });
  }

  disconnect(): void {
    if (!this.#connected) return;
    for (const teardown of this.#teardowns) teardown();
    this.#teardowns = [];
    this.#transport?.close();
    this.#transport = undefined;
    this.#connected = false;
  }

  readonly #emit = (type: EventType, data: Record<string, unknown>, ref?: string): void => {
    const event: IrisEvent = {
      t: Math.round(performance.now() - this.#start),
      type,
      sessionId: this.#session,
      ref,
      data,
    };
    this.#transport?.sendEvent(event);
  };

  #hello(): HelloMessage {
    return {
      kind: MessageKind.HELLO,
      protocolVersion: IRIS_PROTOCOL_VERSION,
      sessionId: this.#session,
      url: location.href,
      title: document.title,
      adapters: adapterNames(),
    };
  }

  async #handleCommand(command: CommandMessage): Promise<CommandOutcome> {
    const handler = this.#registry.get(command.name);
    if (handler === undefined) {
      return { ok: false, error: `unknown command '${command.name}'` };
    }
    try {
      const result = await handler(command.args);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
