import {
  EventType,
  IRIS_DEFAULT_PORT,
  IRIS_PROTOCOL_VERSION,
  IRIS_WS_PATH,
  IrisCommand,
  MessageKind,
  PresenterMode,
  SESSION_AUTO,
  SessionState,
  TRANSPORT_LIMITS,
  isLoopbackHostname,
  type CommandMessage,
  type HelloMessage,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { createCommandRegistry, type CommandHandler } from './commands/commands.js';
import { Transport, type CommandOutcome } from './transport/transport.js';
import { adapterNames } from './registry/adapters.js';
import {
  registerCapabilities,
  hasCapabilities,
  type CapabilitiesInput,
} from './registry/capabilities.js';
import { installDom } from './observers/dom.js';
import { installNetwork } from './observers/network.js';
import { installRoute } from './observers/route.js';
import { installConsole } from './observers/console.js';
import { installAnimation } from './observers/animation.js';
import { installScroll } from './observers/scroll.js';
import { installHealth } from './observers/health.js';
import { installOverlay, type OverlayHandle } from './presenter/overlay.js';
import {
  Presenter,
  LOG_KIND,
  LOG_RESULT,
  type PresenterOptions,
  type LogHandle,
} from './presenter/presenter.js';
import { refs } from './dom/refs.js';
import { actionVerb } from './presenter/presenter-verbs.js';
import { describe } from './dom/a11y.js';
import { resetClock } from './timers/clock.js';
import { installRecorder, type RecorderHandle } from './recorder/recorder.js';
import { Annotator } from './review/annotator.js';
import type { Teardown } from './observers/types.js';

export interface IrisConnectOptions {
  /** WS endpoint of the local bridge. Defaults to ws://localhost:<port><path>. */
  url?: string;
  /** Human-friendly session label so the agent can target the right tab. */
  session?: string;
  /** Browser/bridge pairing token. Required when either endpoint is non-localhost. */
  token?: string;
  /** Explicitly allow Iris on a non-localhost page or bridge. Requires token. */
  allowNonLocalhost?: boolean;
  /** Show a small in-page status chip (connection + event count). */
  overlay?: boolean;
  /** Presenter mode: glow border, animated cursor, click/hover effects, narration HUD. */
  present?: boolean;
  /** Per-action pacing (ms) in presenter mode so a human can follow. Default 450. */
  pace?: number;
  /** Min ms each narration line stays visible before the next replaces it (presenter). Default 3000. */
  narrationDwellMs?: number;
  /**
   * Border behavior in presenter mode: 'session' (default) persists the border for the whole
   * session; 'busy' restores the fade-after-idle behavior.
   */
  border?: 'session' | 'busy';
  /** Max accumulated activity-log rows before the oldest are pruned (presenter). Default 50. */
  logMax?: number;
  /**
   * Mount the floating human-recorder toolbar (Record/Stop/Annotate).
   * Default off — purely additive, dev-only.
   */
  recorder?: boolean;
  /**
   * Mount the "Flag a bug" annotator: the human clicks an element that looks wrong, types what's
   * wrong, and Iris emits a HUMAN_MARK the agent drains via iris_review. Defaults to ON with the
   * presenter (it's the human's side of the look→act→assert loop); pass `annotate: false` to suppress.
   */
  annotate?: boolean;
  /** Live-control: overridable ended-border fade delay (native timer). Default 4000. */
  endedFadeMs?: number;
  /** Session auto-end after this much agent idle (presenter). Default 5min; agent-tunable via iris_session. */
  idleEndMs?: number;
}

export function connectionPolicy(
  pageHostname: string,
  bridgeUrl: string,
  allowNonLocalhost: boolean,
  token: string | undefined,
): { allowed: boolean; reason?: string } {
  let bridge: URL;
  try {
    bridge = new URL(bridgeUrl);
  } catch {
    return { allowed: false, reason: 'invalid Iris bridge URL' };
  }
  if (bridge.protocol !== 'ws:' && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'Iris bridge URL must use ws:// or wss://' };
  }
  if ((token?.length ?? 0) > TRANSPORT_LIMITS.MAX_TOKEN_LENGTH) {
    return {
      allowed: false,
      reason: `Iris pairing token exceeds ${String(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH)} characters`,
    };
  }
  const remoteBridge = !isLoopbackHostname(bridge.hostname);
  if (remoteBridge && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'a non-local Iris bridge must use wss://' };
  }
  const remote = !isLoopbackHostname(pageHostname) || remoteBridge;
  if (!remote) return { allowed: true };
  if (!allowNonLocalhost) {
    return {
      allowed: false,
      reason: 'Iris is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
    };
  }
  if (token === undefined || token.length === 0) {
    return { allowed: false, reason: 'a pairing token is required outside localhost' };
  }
  return { allowed: true };
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** HUD summary when the SDK self-ends a session because the bridge (server/agent) became unreachable. */
const BRIDGE_LOST_SUMMARY =
  'Session ended — lost connection to Iris (the agent is no longer running).';

/**
 * Resolve the session label. An absent label or the `auto` sentinel yields a fresh per-tab id (via
 * the injected generator) so multi-tab / new-tab routes never collide; any other label is used
 * verbatim so tabs can intentionally share a session. `gen` is injected to keep this clock-free.
 */
export function resolveSessionLabel(option: string | undefined, gen: () => string): string {
  return option === undefined || option === SESSION_AUTO ? gen() : option;
}

/** Narrow an unknown command arg into a SessionState (membership check — no `any`, no zod needed). */
function isSessionState(value: unknown): value is SessionState {
  return (
    value === SessionState.ACTIVE || value === SessionState.PAUSED || value === SessionState.ENDED
  );
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
  #recorder: RecorderHandle | undefined;
  #annotator: Annotator | undefined;
  #eventCount = 0;
  #token: string | undefined;
  /** Act-row log handle for the in-flight act/act_sequence, so its outcome stamps the right row. */
  #actHandle: LogHandle | undefined;

  connect(options: IrisConnectOptions = {}): void {
    if (this.#connected) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const url = options.url ?? `ws://localhost:${String(IRIS_DEFAULT_PORT)}${IRIS_WS_PATH}`;
    const policy = connectionPolicy(
      window.location.hostname,
      url,
      options.allowNonLocalhost === true,
      options.token,
    );
    if (!policy.allowed) {
      globalThis.console.warn(`[Iris] ${policy.reason ?? 'connection blocked'}`);
      return;
    }

    this.#session = resolveSessionLabel(options.session, () =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? `s${globalThis.crypto.randomUUID()}`
        : `s${Date.now().toString(36)}`,
    );
    this.#token =
      options.token !== undefined && options.token.length > 0 ? options.token : undefined;
    this.#start = performance.now();
    this.#registry = createCommandRegistry();

    this.#transport = new Transport({
      url,
      hello: () => this.#hello(),
      handleCommand: (command) => this.#handleCommand(command),
      // Show the presenter HUD as soon as the agent bridge connects — the user immediately sees
      // the glow border and narration panel, even before the first tool call lands.
      onConnected: () => this.#presenter?.sessionStart(),
      // Liveness fallback: if the bridge stays unreachable (the agent killed the server process),
      // no server-pushed end can arrive — so end the run we're presenting ourselves. A returning
      // agent revives it via the normal sessionStart() path on its next command.
      onConnectionLost: () => {
        if (this.#presenter?.sessionActive === true) {
          this.#presenter.setState(SessionState.ENDED, BRIDGE_LOST_SUMMARY);
        }
      },
    });

    const emit = this.#emit;
    this.#teardowns = [
      installNetwork(emit),
      installRoute(emit),
      installConsole(emit),
      installAnimation(emit),
      installScroll(emit),
      installDom(emit),
      installHealth(emit), // page visibility/focus health + heartbeat
    ];

    if (options.overlay === true) {
      this.#overlay = installOverlay();
      this.#overlay.update({ connected: true, events: 0 });
    }

    if (options.present === true) {
      const presenterOptions: PresenterOptions = {};
      if (options.pace !== undefined) presenterOptions.paceMs = options.pace;
      if (options.narrationDwellMs !== undefined) {
        presenterOptions.narrationDwellMs = options.narrationDwellMs;
      }
      if (options.border !== undefined) presenterOptions.border = options.border;
      if (options.logMax !== undefined) presenterOptions.logMax = options.logMax;
      if (options.endedFadeMs !== undefined) presenterOptions.endedFadeMs = options.endedFadeMs;
      if (options.idleEndMs !== undefined) presenterOptions.idleEndMs = options.idleEndMs;
      presenterOptions.sessionId = this.#session;
      // The panel calls this when the human pauses/resumes/ends or sends a message. We emit a
      // HUMAN_CONTROL event over the existing transport; #emit stamps `t` from the elapsed clock.
      presenterOptions.onControl = (intent) =>
        this.#emit(
          EventType.HUMAN_CONTROL,
          intent.text !== undefined
            ? { kind: intent.kind, text: intent.text }
            : { kind: intent.kind },
        );
      this.#presenter = new Presenter(presenterOptions);
      // Mount the overlay. The session (glow + HUD) activates on bridge connect via onConnected,
      // so the presenter is visible as soon as the agent is reachable — not just on first command.
      this.#presenter.mount();
    }

    if (options.recorder === true) {
      this.#recorder = installRecorder({ emit, now: () => Date.now() });
      this.#recorder.mount();
    }

    // The "Flag a bug" annotator rides with the presenter (the human surface) unless explicitly off.
    if (options.annotate ?? options.present === true) {
      const presenter = this.#presenter;
      this.#annotator = new Annotator({
        emit,
        now: () => Date.now(),
        // Echo the flag into the live panel so the human watches their bug report land in the log.
        onMark: (note, label) => presenter?.log(LOG_KIND.HUMAN, `🚩 ${label}: ${note}`),
      });
      this.#annotator.mount();
    }

    this.#transport.connect();
    this.#connected = true;
  }

  /** Whether the in-page SDK is connected to the bridge (read by createIrisEmitter, P5a). */
  get connected(): boolean {
    return this.#connected;
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

  /** Live-control: end the session programmatically from the host app (drives the panel to ended). */
  endSession(): void {
    this.#presenter?.setState(SessionState.ENDED);
  }

  disconnect(): void {
    if (!this.#connected) return;
    for (const teardown of this.#teardowns) teardown();
    this.#teardowns = [];
    this.#transport?.close();
    this.#transport = undefined;
    this.#overlay?.destroy();
    this.#overlay = undefined;
    this.#presenter?.sessionEnd(); // fade the border out before tearing the overlay down
    this.#presenter?.destroy();
    this.#presenter = undefined;
    this.#recorder?.destroy();
    this.#recorder = undefined;
    this.#annotator?.destroy();
    this.#annotator = undefined;
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
      ...(this.#token === undefined ? {} : { token: this.#token }),
      hasCapabilities: hasCapabilities(),
    };
  }

  async #handleCommand(command: CommandMessage): Promise<CommandOutcome> {
    // NARRATE: the agent tells the human what it's about to do / decide (presenter HUD).
    if (command.name === IrisCommand.NARRATE) {
      this.#presenter?.sessionStart(); // first agent activity → reveal the glow + panel
      this.#presenter?.narrate(str(command.args['text']), str(command.args['level'], 'info'));
      return { ok: true, result: { shown: this.#presenter !== undefined } };
    }

    // SESSION_CONFIG: the agent tunes the session for the app (currently the idle-end window).
    if (command.name === IrisCommand.SESSION_CONFIG) {
      const idleEndMs = command.args['idleEndMs'];
      if (typeof idleEndMs === 'number') this.#presenter?.setIdleEndMs(idleEndMs);
      return { ok: true, result: { applied: this.#presenter !== undefined, idleEndMs } };
    }

    // PRESENTER: bridge → browser server-push so an AGENT-driven pause/end mirrors onto the panel.
    // This calls setState ONLY (never re-emits a control), so a HUMAN_CONTROL echo can't loop.
    if (command.name === IrisCommand.PRESENTER) {
      const state = command.args['state'];
      if (isSessionState(state)) {
        this.#presenter?.setState(state, str(command.args['text']) || undefined);
      }
      return { ok: true, result: { applied: this.#presenter !== undefined } };
    }

    const handler = this.#registry.get(command.name);
    if (handler === undefined) {
      return { ok: false, error: `unknown command '${command.name}'` };
    }

    this.#presenter?.sessionStart(); // first agent command → reveal the glow + panel
    await this.#presentBefore(command);
    try {
      const result = await handler(command.args);
      this.#actHandle?.result(LOG_RESULT.PASS);
      return { ok: true, result };
    } catch (error) {
      this.#actHandle?.result(LOG_RESULT.FAIL);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.#actHandle = undefined;
      this.#presenter?.scheduleIdle();
    }
  }

  /** Drive the presenter (cursor/effects/status) before the real action runs. */
  async #presentBefore(command: CommandMessage): Promise<void> {
    const p = this.#presenter;
    if (p === undefined) return;
    p.setMode(modeForCommand(command.name)); // paint reading vs acting intent first
    this.#actHandle = undefined;
    if (command.name === IrisCommand.ACT) {
      const ref = str(command.args['ref']);
      const label = refLabel(ref);
      this.#actHandle = p.log(LOG_KIND.ACT, `${actionVerb(str(command.args['action']))} ${label}`);
      await p.beforeAct(ref, str(command.args['action']), label);
    } else if (command.name === IrisCommand.ACT_SEQUENCE) {
      const steps = Array.isArray(command.args['steps']) ? command.args['steps'] : [];
      for (const step of steps) {
        const s = step as { ref?: unknown; action?: unknown };
        const ref = str(s.ref);
        const label = refLabel(ref);
        // one log row per step; the last handle carries the sequence outcome glyph
        this.#actHandle = p.log(LOG_KIND.ACT, `${actionVerb(str(s.action))} ${label}`);
        await p.beforeAct(ref, str(s.action), label);
      }
    } else {
      const label = presentStatus(command.name, command.args);
      p.status(label);
      p.log(LOG_KIND.READ, label);
    }
  }
}

/**
 * Classify a browser command into the presenter intent the human watcher sees. Exhaustive
 * over the IrisCommand names that actually reach the browser. CLOCK/NARRATE are control/meta
 * (neither a page read nor an act) -> IDLE so they don't paint a misleading chip. NARRATE never
 * reaches #presentBefore anyway (it returns early in #handleCommand) and must not clear the mode.
 */
export function modeForCommand(commandName: string): PresenterMode {
  switch (commandName) {
    case IrisCommand.ACT:
    case IrisCommand.ACT_SEQUENCE:
      return PresenterMode.ACTING;
    case IrisCommand.SNAPSHOT:
    case IrisCommand.QUERY:
    case IrisCommand.MATCH:
    case IrisCommand.INSPECT:
    case IrisCommand.ANIMATIONS:
    case IrisCommand.STATE_READ:
    case IrisCommand.CAPABILITIES:
      return PresenterMode.READING;
    default:
      return PresenterMode.IDLE;
  }
}

/**
 * Human-legible status for a read command — now WITH the target (which testid/value/ref/store), so
 * the watcher sees "Finding [testid=row-3700]" instead of a meaningless repeating "Finding an
 * element". Falls back to the bare verb when no target is in the args.
 */
function presentStatus(commandName: string, args: Record<string, unknown> = {}): string {
  switch (commandName) {
    case IrisCommand.SNAPSHOT:
      return 'Looking at the page';
    case IrisCommand.QUERY:
    case IrisCommand.MATCH: {
      const q = commandName === IrisCommand.MATCH ? (args['query'] ?? {}) : args;
      const target = queryTarget(q as Record<string, unknown>);
      return target !== undefined ? `Finding ${target}` : 'Finding an element';
    }
    case IrisCommand.INSPECT: {
      const ref = str(args['ref']);
      return ref !== undefined ? `Inspecting ${refLabel(ref)}` : 'Inspecting an element';
    }
    case IrisCommand.ANIMATIONS:
      return 'Reading animations';
    case IrisCommand.STATE_READ: {
      const store = str(args['store']);
      return store !== undefined ? `Reading state: ${store}` : 'Reading state';
    }
    case IrisCommand.CAPABILITIES:
      return 'Reading capabilities';
    default:
      return commandName;
  }
}

/** Compact "what we're looking for" from a query's args (testid/value/name/role/text/label). */
function queryTarget(q: Record<string, unknown>): string | undefined {
  const testid = str(q['testid']) ?? (str(q['by']) === 'testid' ? str(q['value']) : undefined);
  if (testid !== undefined) return `[testid=${testid}]`;
  const name = str(q['name']);
  const value = str(q['value']) ?? str(q['text']) ?? str(q['label']) ?? str(q['role']);
  if (value !== undefined) return name !== undefined ? `"${value}" (${name})` : `"${value}"`;
  return name !== undefined ? `"${name}"` : undefined;
}
