import {
  EventType,
  IRIS_DEFAULT_PORT,
  IRIS_PROTOCOL_VERSION,
  IRIS_WS_PATH,
  IrisCommand,
  MessageKind,
  type CommandMessage,
  type HelloMessage,
  type IrisEvent,
} from '@iris/protocol';
import { createCommandRegistry, type CommandHandler } from './commands.js';
import { Transport, type CommandOutcome } from './transport.js';
import { adapterNames } from './adapters.js';
import { registerCapabilities, hasCapabilities, type CapabilitiesInput } from './capabilities.js';
import { installDom } from './observers/dom.js';
import { installNetwork } from './observers/network.js';
import { installRoute } from './observers/route.js';
import { installConsole } from './observers/console.js';
import { installAnimation } from './observers/animation.js';
import { installScroll } from './observers/scroll.js';
import { installHealth } from './observers/health.js';
import { installOverlay, type OverlayHandle } from './overlay.js';
import { Presenter } from './presenter.js';
import { refs } from './refs.js';
import { describe } from './a11y.js';
import { resetClock } from './clock.js';
import type { Teardown } from './observers/types.js';

export interface IrisConnectOptions {
  /** WS endpoint of the local bridge. Defaults to ws://localhost:<port><path>. */
  url?: string;
  /** Human-friendly session label so the agent can target the right tab. */
  session?: string;
  /** Show a small in-page status chip (connection + event count). */
  overlay?: boolean;
  /** Presenter mode: glow border, animated cursor, click/hover effects, narration HUD. */
  present?: boolean;
  /** Per-action pacing (ms) in presenter mode so a human can follow. Default 450. */
  pace?: number;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** A short human label for a ref ("button \"Save\"") for the presenter HUD. */
function refLabel(refId: string): string {
  const el = refs.resolve(refId);
  if (!(el instanceof Element)) return refId;
  const d = describe(el);
  return d.name.length > 0 ? `${d.role} "${d.name}"` : `${d.role} (${refId})`;
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
  #overlay: OverlayHandle | undefined;
  #presenter: Presenter | undefined;
  #eventCount = 0;

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
      installScroll(emit),
      installDom(emit),
      installHealth(emit), // F2: page visibility/focus health + heartbeat
    ];

    if (options.overlay === true) {
      this.#overlay = installOverlay();
      this.#overlay.update({ connected: true, events: 0 });
    }

    if (options.present === true) {
      this.#presenter = new Presenter(options.pace !== undefined ? { paceMs: options.pace } : {});
      this.#presenter.mount();
    }

    this.#transport.connect();
    this.#connected = true;
  }

  /** Surface an arbitrary app-domain observation the DOM can't express (plan/03 §7). */
  signal(name: string, data: Record<string, unknown> = {}): void {
    this.#emit(EventType.SIGNAL, { name, data });
  }

  /** Report a framework/store state change the agent can observe and assert on. */
  state(name: string, value: unknown): void {
    this.#emit(EventType.STATE_CHANGE, { name, value });
  }

  /** Advertise the app's testable surface so the agent learns it without reading source. */
  describe(input: CapabilitiesInput): void {
    registerCapabilities(input);
  }

  disconnect(): void {
    if (!this.#connected) return;
    for (const teardown of this.#teardowns) teardown();
    this.#teardowns = [];
    this.#transport?.close();
    this.#transport = undefined;
    this.#overlay?.destroy();
    this.#overlay = undefined;
    this.#presenter?.destroy();
    this.#presenter = undefined;
    resetClock(); // restore any frozen timers
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
    this.#eventCount += 1;
    this.#overlay?.update({ connected: true, events: this.#eventCount });
  };

  #hello(): HelloMessage {
    return {
      kind: MessageKind.HELLO,
      protocolVersion: IRIS_PROTOCOL_VERSION,
      sessionId: this.#session,
      url: location.href,
      title: document.title,
      adapters: adapterNames(),
      hasCapabilities: hasCapabilities(),
    };
  }

  async #handleCommand(command: CommandMessage): Promise<CommandOutcome> {
    // NARRATE: the agent tells the human what it's about to do / decide (presenter HUD).
    if (command.name === IrisCommand.NARRATE) {
      this.#presenter?.narrate(str(command.args['text']), str(command.args['level'], 'info'));
      return { ok: true, result: { shown: this.#presenter !== undefined } };
    }

    const handler = this.#registry.get(command.name);
    if (handler === undefined) {
      return { ok: false, error: `unknown command '${command.name}'` };
    }

    await this.#presentBefore(command);
    try {
      const result = await handler(command.args);
      this.#presenter?.result(true);
      return { ok: true, result };
    } catch (error) {
      this.#presenter?.result(false);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.#presenter?.scheduleIdle();
    }
  }

  /** Drive the presenter (cursor/effects/status) before the real action runs. */
  async #presentBefore(command: CommandMessage): Promise<void> {
    const p = this.#presenter;
    if (p === undefined) return;
    if (command.name === IrisCommand.ACT) {
      const ref = str(command.args['ref']);
      await p.beforeAct(ref, str(command.args['action']), refLabel(ref));
    } else if (command.name === IrisCommand.ACT_SEQUENCE) {
      const steps = Array.isArray(command.args['steps']) ? command.args['steps'] : [];
      for (const step of steps) {
        const s = step as { ref?: unknown; action?: unknown };
        const ref = str(s.ref);
        await p.beforeAct(ref, str(s.action), refLabel(ref));
      }
    } else {
      p.status(presentStatus(command.name));
    }
  }
}

function presentStatus(commandName: string): string {
  switch (commandName) {
    case IrisCommand.SNAPSHOT:
      return 'Looking at the page';
    case IrisCommand.QUERY:
    case IrisCommand.MATCH:
      return 'Finding an element';
    case IrisCommand.INSPECT:
      return 'Inspecting an element';
    default:
      return commandName;
  }
}
