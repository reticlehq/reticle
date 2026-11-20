/**
 * Joins the bridge as a peer, the way the SDK in a web page does, so every tool an agent has for
 * a page reaches a desktop application. There is no code in the application.
 */
import {
  COMPUTER_USE_RUNTIME,
  CONTRACT_FINGERPRINT,
  CONTRACT_PARTS,
  EventType,
  MessageKind,
  PlatformProfile,
  RETICLE_PROTOCOL_VERSION,
} from '@reticlehq/core';
import type { WorkspacePort } from '@reticlehq/cli-realm';
import { WebSocket } from 'ws';

import type { UiDriver } from '../driver.js';
import { PEER_ACTIONS, PEER_COMMANDS, PeerCommands } from './commands.js';

/** The bridge admits a dial with no Origin only when it has a token. A loopback Origin always passes. */
const ORIGIN = 'http://localhost';
const ADAPTER = 'computer-use';
/** A session with no word for 12 s reads as throttled. The SDK in a page sends this at the same rate. */
const HEARTBEAT_MS = 5000;
const FILES_EVERY_MS = 1000;
const TREE_EVERY_MS = 250;
/** A look may take one part in this many of the time. */
const LOOK_SHARE = 10;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;
/** The bridge drops a result whose error is longer than 4,096 characters, and the command then waits. */
const MAX_ERROR = 4000;
const HealthReason = { CONNECT: 'connect', HEARTBEAT: 'heartbeat' } as const;

const EVENTS = [
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
  EventType.PAGE_HEALTH,
];

/**
 * How long to wait before the next look at the tree.
 *
 * A look is a whole read. For a small window it takes a few milliseconds. For a window with
 * thousands of elements it takes hundreds, and four of those in a second would load the
 * application more than the agent does. So the wait is at least ten times the last read: the
 * looks take a tenth of the time at most, and a large window is looked at less often.
 */
export function nextLookMs(everyMs: number, lastReadMs: number): number {
  return Math.max(everyMs, lastReadMs * LOOK_SHARE);
}

export interface PeerInput {
  /** `ws://localhost:4400/reticle`. */
  url: string;
  /** The pairing token of the bridge, when it has one. */
  token?: string;
  sessionId: string;
  /** Always given: two applications have no web origin to tell them apart. */
  projectId: string;
  driver: UiDriver;
  /** Folders to watch for files an action writes. */
  workspace?: WorkspacePort;
  /** How often the watched folders are looked at between actions. The default is one second. */
  filesEveryMs?: number;
  /** How often the tree is looked at between actions. The default is a quarter of a second. */
  treeEveryMs?: number;
  /** How long to wait before the first new dial when the bridge goes away. The default is one second. */
  retryMs?: number;
  now: () => number;
}

export interface Peer {
  /** Resolves when the socket is open and the peer has announced itself. */
  ready: Promise<void>;
  close(): void;
}

/** The names this peer speaks that the bridge also knows. An unknown name reads as version skew. */
function known(mine: readonly string[], theirs: readonly string[]): string[] {
  return mine.filter((name) => theirs.includes(name));
}

export function connectPeer(input: PeerInput): Peer {
  let socket: WebSocket | undefined;
  let closed = false;
  let joinedOnce = false;
  let retryMs = input.retryMs ?? RETRY_MS;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let files: ReturnType<typeof setInterval> | undefined;
  let tree: ReturnType<typeof setTimeout> | undefined;

  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
  const emit = (type: EventType, data: Record<string, unknown>): void => {
    send({
      kind: MessageKind.EVENT,
      event: { t: input.now(), type, sessionId: input.sessionId, data },
    });
  };
  // One for the life of the peer, not one for each connection: a ref that the agent holds must
  // still be the same element after the bridge comes back.
  const commands = new PeerCommands({
    driver: input.driver,
    emit,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  });
  const health = (reason: string): void => {
    emit(EventType.PAGE_HEALTH, {
      hidden: false,
      focused: true,
      reason,
      runtime: COMPUTER_USE_RUNTIME,
    });
  };
  const stopTimers = (): void => {
    clearInterval(heartbeat);
    clearInterval(files);
    clearTimeout(tree);
  };

  const announce = (): void => {
    const { app, pid } = input.driver.subject();
    send({
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      url: `app://${encodeURIComponent(app)}/`,
      title: `${app} (${String(pid)})`,
      adapters: [ADAPTER],
      projectId: input.projectId,
      ...(input.token === undefined ? {} : { token: input.token }),
      platform: PlatformProfile.NATIVE,
      hasCapabilities: false,
      sourceMapping: false,
      commands: [...PEER_COMMANDS],
      contract: CONTRACT_FINGERPRINT,
      contractParts: {
        commands: known(PEER_COMMANDS, CONTRACT_PARTS.commands),
        events: known(EVENTS, CONTRACT_PARTS.events),
        actions: known(PEER_ACTIONS, CONTRACT_PARTS.actions),
      },
    });
    health(HealthReason.CONNECT);
    heartbeat = setInterval(() => {
      health(HealthReason.HEARTBEAT);
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const look = (waitMs: number): void => {
      tree = setTimeout(() => {
        const started = input.now();
        const again = (): void => {
          look(nextLookMs(input.treeEveryMs ?? TREE_EVERY_MS, input.now() - started));
        };
        commands.sendTreeChanges().then(again, again);
      }, waitMs);
      tree.unref();
    };
    look(input.treeEveryMs ?? TREE_EVERY_MS);
    if (input.workspace !== undefined) {
      // ponytail: a whole look at the folders each time. Watch them for changes when a folder
      // is large enough for the look to cost more than the wait.
      files = setInterval(() => {
        commands.sendFileChanges();
      }, input.filesEveryMs ?? FILES_EVERY_MS);
      files.unref();
    }
  };

  const onMessage = (raw: unknown): void => {
    if (!Buffer.isBuffer(raw)) {
      return;
    }
    const message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const id = message['id'];
    const name = message['name'];
    if (
      message['kind'] !== MessageKind.COMMAND ||
      typeof id !== 'string' ||
      typeof name !== 'string'
    ) {
      return;
    }
    const args = message['args'];
    const outward = message['outward'];
    const allowed =
      'object' === typeof outward &&
      outward !== null &&
      'allowed' in outward &&
      Array.isArray(outward.allowed)
        ? outward.allowed.map(String)
        : undefined;
    commands
      .answer(
        name,
        'object' === typeof args && args !== null ? (args as Record<string, unknown>) : {},
        allowed,
      )
      .then(
        (result) => {
          send({ kind: MessageKind.COMMAND_RESULT, id, ok: true, result });
        },
        (error: unknown) => {
          const words = error instanceof Error ? error.message : String(error);
          send({
            kind: MessageKind.COMMAND_RESULT,
            id,
            ok: false,
            error: words.slice(0, MAX_ERROR),
          });
        },
      );
  };

  /**
   * Dials the bridge. When the bridge goes away after the peer joined it once, the peer dials
   * again, and waits longer each time up to ten seconds. The daemon ends when it is idle and
   * starts again on the next tool call, and a peer that stayed gone made the application
   * disappear for the agent with no word.
   */
  const dial = (onFirst?: { resolve: () => void; reject: (error: unknown) => void }): void => {
    const next = new WebSocket(input.url, { origin: ORIGIN });
    socket = next;
    next.once('open', () => {
      joinedOnce = true;
      retryMs = input.retryMs ?? RETRY_MS;
      announce();
      onFirst?.resolve();
    });
    next.on('message', onMessage);
    // An error before the first join is the caller's to know: the bridge is not there. After
    // it, the close that follows starts the next dial.
    next.on('error', (error) => {
      if (!joinedOnce) {
        onFirst?.reject(error);
      }
    });
    next.on('close', () => {
      stopTimers();
      if (closed || !joinedOnce) {
        return;
      }
      retry = setTimeout(() => {
        dial();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    });
  };

  const ready = new Promise<void>((resolve, reject) => {
    dial({ resolve, reject });
  });

  return {
    ready,
    close: () => {
      closed = true;
      clearTimeout(retry);
      stopTimers();
      socket?.close();
    },
  };
}
