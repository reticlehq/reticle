/**
 * Joins the bridge as a peer, the way the SDK in a web page does, so every tool an agent has for
 * a page reaches a desktop application. There is no code in the application.
 */
import {
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
/** The bridge drops a result whose error is longer than 4,096 characters, and the command then waits. */
const MAX_ERROR = 4000;
const HealthReason = { CONNECT: 'connect', HEARTBEAT: 'heartbeat' } as const;

const EVENTS = [
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
  EventType.PAGE_HEALTH,
];

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
  const socket = new WebSocket(input.url, { origin: ORIGIN });
  const send = (message: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
  const emit = (type: EventType, data: Record<string, unknown>): void => {
    send({
      kind: MessageKind.EVENT,
      event: { t: input.now(), type, sessionId: input.sessionId, data },
    });
  };
  const commands = new PeerCommands({
    driver: input.driver,
    emit,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  });
  const health = (reason: string): void => {
    emit(EventType.PAGE_HEALTH, { hidden: false, focused: true, reason });
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => {
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
      resolve();
    });
  });

  socket.on('message', (raw) => {
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
    commands
      .answer(
        name,
        'object' === typeof args && args !== null ? (args as Record<string, unknown>) : {},
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
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
  });

  return {
    ready,
    close: () => {
      clearInterval(heartbeat);
      socket.close();
    },
  };
}
