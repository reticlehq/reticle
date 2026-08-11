import * as http from 'node:http';
import { authFailureReason } from './auth-failure-reason.js';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  EventType,
  HumanControlKind,
  RETICLE_WS_PATH,
  ReticleMessageSchema,
  LOOPBACK_HOST,
  MessageKind,
  ReticleEnv,
  RETICLE_PROTOCOL_VERSION,
  TRANSPORT_LIMITS,
  isLocalPage,
  isLoopbackHostname,
  isOpaqueOrigin,
  OPAQUE_ORIGIN,
  isHighValueEvent,
  RATE_CAP_HIGH_VALUE_RESERVE_RATIO,
  type HelloMessage,
  CONTRACT_FINGERPRINT,
} from '@reticlehq/core';
import { Session, SessionManager } from '../session/session.js';
import { tokensMatch } from './token-auth.js';
import { log } from '../log.js';
import { describeSkew, sdkFix, SkewPair } from '../version/version-skew.js';
import { noteVersionSkew } from '../version/version-nudge.js';
import { SERVER_VERSION } from '../version/server-version.js';

/**
 * Take the mutable half of a session's identity from a repeat HELLO.
 *
 * Lives here rather than on Session because this is where the protocol decision is made — the caller
 * has already established that the hello belongs to this same session — and because these fields are
 * the session's public surface, read by the tools on every listing.
 *
 * `hasCapabilities` is the one that matters: it is announced in the hello, which the SDK sends at
 * connect(), while capabilities are registered AFTER connect by design (registerStore needs a live
 * SDK to subscribe through). Without this refresh, an app that declared its entire testable surface
 * reported `hasCapabilities: false` forever.
 */
function refreshIdentity(session: Session, hello: HelloMessage): void {
  session.url = hello.url;
  session.title = hello.title;
  session.adapters = hello.adapters;
  session.hasCapabilities = hello.hasCapabilities ?? false;
}

/** A human clicked ▶ on a saved flow in the panel — replay it with no agent. Wired by the daemon. */
type ReplayRequestHandler = (sessionId: string, flowName: string) => void;
/** Called once a browser session connects, so the daemon can push it the replayable-flow list. */
type SessionReadyHandler = (session: Session) => void;

/**
 * The close reasons worth telling an AGENT about, not just the SDK.
 *
 * The SDK prints these and stops retrying. The agent then calls a tool and is told "no browser
 * session connected" — which is indistinguishable from an app nobody started. An outdated SDK and a
 * stale pairing token were both invisible for that reason; these two carry their own remedy, so
 * surfacing them is strictly better than the generic answer.
 */
export const WS_CLOSE_REASON = {
  PROTOCOL_MISMATCH: 'protocol version mismatch — upgrade @reticlehq/browser',
  AUTH_FAILED: 'authentication failed — reload the page to pick up the current pairing token',
} as const;

/** WS close codes + reasons the bridge sends to the SDK (1008 = policy violation, 1013 = try again later). */
const WS_CLOSE = {
  TOO_MANY_HANDSHAKES: [1013, 'too many pending handshakes'],
  HELLO_TIMEOUT: [1008, 'hello timeout'],
  INVALID_MESSAGE: [1008, 'invalid message'],
  HELLO_DUPLICATE: [1008, 'hello already received'],
  // Names the recovery, because the SDK prints this reason and then stops retrying — so it is the
  // last thing the developer sees. The common cause is a page served before the daemon existed,
  // which carries no token; a reload re-fetches the connect module and picks the current one up.
  // Kept under the 123-byte WebSocket close-reason limit.
  AUTH_FAILED: [1008, WS_CLOSE_REASON.AUTH_FAILED],
  SESSION_LIMIT: [1013, 'session limit reached'],
  PROTOCOL_MISMATCH: [1008, WS_CLOSE_REASON.PROTOCOL_MISMATCH],
} as const;

/** Parse a positive integer env override; anything else (unset, zero, junk) falls through to the default. */
function positiveIntFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** The flow name if this event is a panel ▶ replay request, else undefined. Pure boundary narrowing. */
function replayRequest(event: { type: string; data: Record<string, unknown> }): string | undefined {
  if (event.type !== EventType.HUMAN_CONTROL) return undefined;
  if (event.data['kind'] !== HumanControlKind.REPLAY) return undefined;
  const name = event.data['text'];
  return 'string' === typeof name && name.length > 0 ? name : undefined;
}

interface BridgeOptions {
  port: number;
  host?: string;
  token?: string;
  allowedOrigins?: string[];
  maxMessagesPerSecond?: number;
  maxSessions?: number;
  maxPendingConnections?: number;
  helloTimeoutMs?: number;
  clock?: () => number;
  /**
   * When set, the WebSocket server attaches to this HTTP server instead of binding standalone.
   * Used in daemon mode where a single HTTP server handles both WS and SSE MCP traffic.
   * `port` and `host` are ignored for binding when this is provided.
   */
  server?: http.Server;
}

/**
 * Canonical comparable form of a WS `Origin`. Web origins collapse to scheme://host[:port]. An
 * OPAQUE origin — a desktop webview (`tauri://localhost`, `app://.`) or `file://`, whose `URL.origin`
 * is the string "null" — is kept VERBATIM instead, so it survives into the allow-list and can be
 * compared. Collapsing those to "null" would both merge every desktop scheme into one bucket and
 * feed an unparseable string to `new URL`. Returns null only for a header that is not an origin.
 */
function normalizeOrigin(origin: string): string | null {
  if (origin === OPAQUE_ORIGIN) return OPAQUE_ORIGIN;
  try {
    const web = new URL(origin).origin;
    return web === OPAQUE_ORIGIN ? origin : web;
  } catch {
    return null;
  }
}

/**
 * When a message fails the strict schema, detect the specific case of a HELLO whose protocolVersion
 * differs from ours — so we can tell the operator "upgrade @reticlehq/browser" instead of dropping the
 * connection into the generic NO_SESSION_CONNECTED path, which misdiagnoses it as a port mismatch.
 * Returns the mismatched version, or null when it isn't a version-mismatched HELLO.
 */
function helloProtocolMismatch(text: string): number | null {
  try {
    const json = JSON.parse(text) as { kind?: unknown; protocolVersion?: unknown };
    if (
      json.kind === MessageKind.HELLO &&
      'number' === typeof json.protocolVersion &&
      json.protocolVersion !== RETICLE_PROTOCOL_VERSION
    ) {
      return json.protocolVersion;
    }
  } catch {
    /* not JSON — fall through to the generic invalid-message path */
  }
  return null;
}

/** Normalize ws RawData (string | Buffer | Buffer[] | ArrayBuffer) into a UTF-8 string. */
function rawToString(raw: RawData): string {
  if ('string' === typeof raw) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

/**
 * The browser-facing half of the relay: a localhost WebSocket server. Each connection
 * announces itself with HELLO (registering a Session), then streams EVENTs and replies to
 * COMMANDs.
 */
export class Bridge {
  readonly sessions = new SessionManager();
  /** Resolves with the actually-bound port once the server is listening. */
  readonly ready: Promise<number>;
  readonly #wss: WebSocketServer;
  readonly #clock: () => number;
  readonly #token: string | undefined;
  /**
   * Projects this daemon has ACCEPTED a session from. Evidence, not derivation: it is what lets a
   * leaked daemon say "I belong to another project" instead of "authentication failed". See
   * authFailureReason.
   */
  readonly #servedProjects = new Set<string>();
  readonly #allowedOrigins: Set<string>;
  readonly #maxMessagesPerSecond: number;
  readonly #maxSessions: number;
  readonly #maxPendingConnections: number;
  readonly #helloTimeoutMs: number;
  #pendingConnections = 0;
  #onReplay: ReplayRequestHandler | undefined;
  #onSessionReady: SessionReadyHandler | undefined;
  #onSessionCreate: ((session: Session) => void) | undefined;
  /** Fired when a session is removed — flushes its journal tail + persists what it learned. */
  #onSessionEnd: ((session: Session) => Promise<void>) | undefined;

  constructor(options: BridgeOptions) {
    const host = options.host ?? LOOPBACK_HOST;
    if ((options.token?.length ?? 0) > TRANSPORT_LIMITS.MAX_TOKEN_LENGTH) {
      throw new Error(
        `Reticle pairing token exceeds ${String(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH)} characters`,
      );
    }
    if (!isLoopbackHostname(host) && (options.token === undefined || 0 === options.token.length)) {
      throw new Error('a pairing token is required when the Reticle bridge binds beyond localhost');
    }
    this.#clock = options.clock ?? (() => Date.now());
    this.#token =
      options.token !== undefined && options.token.length > 0 ? options.token : undefined;
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? [])
        .map(normalizeOrigin)
        .filter((origin): origin is string => origin !== null),
    );
    // Binding beyond localhost means the browser dials in from a non-loopback Origin. With no
    // allow-list, #originAllowed rejects every such Origin at the WS handshake, so the bridge comes
    // up but accepts nothing — a silent, fail-closed footgun. Refuse to start with a clear message.
    if (!isLoopbackHostname(host) && 0 === this.#allowedOrigins.size) {
      throw new Error(
        `${ReticleEnv.ALLOWED_ORIGINS} must list the app origin(s) when the Reticle bridge binds ` +
          'beyond localhost — otherwise every non-loopback browser is rejected at the WebSocket ' +
          'origin check and no connection can be established.',
      );
    }
    // Explicit option wins; then the env override, so a genuinely busy app can raise the ceiling
    // instead of accepting sampled coverage. Free and local — the daemon runs on the same machine,
    // so a higher cap costs nobody anything, which is also why this is not a paid knob.
    this.#maxMessagesPerSecond =
      options.maxMessagesPerSecond ??
      positiveIntFromEnv(process.env[ReticleEnv.MAX_MESSAGES_PER_SECOND]) ??
      TRANSPORT_LIMITS.MAX_MESSAGES_PER_SECOND;
    this.#maxSessions = options.maxSessions ?? TRANSPORT_LIMITS.MAX_SESSIONS;
    this.#maxPendingConnections =
      options.maxPendingConnections ?? TRANSPORT_LIMITS.MAX_PENDING_CONNECTIONS;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? TRANSPORT_LIMITS.HELLO_TIMEOUT_MS;

    if (options.server !== undefined) {
      const srv = options.server;
      this.#wss = new WebSocketServer({
        server: srv,
        path: RETICLE_WS_PATH,
        maxPayload: TRANSPORT_LIMITS.MAX_MESSAGE_BYTES,
        verifyClient: ({ origin }, done) => {
          const allowed = this.#originAllowed(origin);
          if (!allowed) log('origin_rejected', { origin: origin ?? 'missing' });
          done(allowed, 403, 'Forbidden');
        },
      });
      // In shared-server mode the daemon owns listen; but a WebSocketServer bound to a server that
      // fails to listen (EADDRINUSE) surfaces the error on the WS instance too. Without a listener
      // that is an unhandled 'error' that can crash/hang the process — so absorb it here and reject
      // `ready`, mirroring the standalone branch. The daemon's own listen handler reports the failure.
      this.ready = new Promise<number>((resolve, reject) => {
        this.#wss.once('error', reject);
        if (srv.listening) {
          this.#wss.removeListener('error', reject);
          resolve((srv.address() as AddressInfo).port);
        } else {
          srv.once('listening', () => {
            this.#wss.removeListener('error', reject);
            resolve((srv.address() as AddressInfo).port);
          });
        }
      });
    } else {
      this.#wss = new WebSocketServer({
        port: options.port,
        host,
        path: RETICLE_WS_PATH,
        maxPayload: TRANSPORT_LIMITS.MAX_MESSAGE_BYTES,
        verifyClient: ({ origin }, done) => {
          const allowed = this.#originAllowed(origin);
          if (!allowed) log('origin_rejected', { origin: origin ?? 'missing' });
          done(allowed, 403, 'Forbidden');
        },
      });
      // Reject on 'error' as well as resolve on 'listening'. A port collision (EADDRINUSE) emits
      // 'error'; with no listener that becomes an unhandled 'error' (process crash) AND leaves
      // `ready` pending forever. Surfacing it lets the CLI print "port already in use" cleanly.
      this.ready = new Promise<number>((resolve, reject) => {
        this.#wss.once('error', reject);
        this.#wss.on('listening', () => {
          this.#wss.removeListener('error', reject);
          resolve((this.#wss.address() as AddressInfo).port);
        });
      });
    }

    this.#wss.on('connection', (socket) => {
      this.#onConnection(socket);
    });
  }

  #onConnection(socket: WebSocket): void {
    if (this.#pendingConnections >= this.#maxPendingConnections) {
      socket.close(...WS_CLOSE.TOO_MANY_HANDSHAKES);
      return;
    }
    this.#pendingConnections += 1;
    let awaitingHello = true;
    let session: Session | undefined;
    let messageWindowStartedAt = this.#clock();
    let messagesInWindow = 0;
    let highValueInWindow = 0;
    const highValueReserve = Math.ceil(
      this.#maxMessagesPerSecond * RATE_CAP_HIGH_VALUE_RESERVE_RATIO,
    );
    const releasePending = (): void => {
      if (!awaitingHello) return;
      awaitingHello = false;
      this.#pendingConnections -= 1;
    };
    const helloTimer = setTimeout(() => {
      if (!awaitingHello) return;
      releasePending();
      socket.close(...WS_CLOSE.HELLO_TIMEOUT);
    }, this.#helloTimeoutMs);

    let droppedByRate = 0;
    socket.on('message', (raw) => {
      const now = this.#clock();
      if (now - messageWindowStartedAt >= 1000) {
        messageWindowStartedAt = now;
        messagesInWindow = 0;
        highValueInWindow = 0;
      }
      messagesInWindow += 1;
      const overRate = messagesInWindow > this.#maxMessagesPerSecond;

      const text = rawToString(raw);
      const parsed = this.#parse(text);
      if (null === parsed) {
        const got = helloProtocolMismatch(text);
        if (got !== null) {
          log('protocol_version_mismatch', { got, expected: RETICLE_PROTOCOL_VERSION });
          // Told to the AGENT too, not only to the SDK that is about to stop retrying. Without this
          // the next tool call answers "no browser session connected", which reads as "no app is
          // running" — so an SDK too old to connect is invisible.
          this.sessions.noteClosure(WS_CLOSE_REASON.PROTOCOL_MISMATCH, this.#clock());
          socket.close(...WS_CLOSE.PROTOCOL_MISMATCH);
          return;
        }
        socket.close(...WS_CLOSE.INVALID_MESSAGE);
        return;
      }

      // Over the cap we SAMPLE — we never disconnect. Going blind is the one thing an observability
      // layer must not do when it sees too much, and the close was a policy code the SDK correctly
      // never retries: the app kept running and Reticle was blind from that instant, on exactly the
      // busiest apps. Measured: each request emits two messages (pending + settled), so the cap binds
      // at ~500 requests/second — a dashboard burst reaches it, a streaming app lives above it.
      //
      // Only EVENTS are dropped. A dropped hello would strand the session and a dropped
      // command_result would hang the agent's in-flight call, so control traffic is always processed
      // however fast it arrives — the cap exists to bound observation, not to break the protocol.
      // Over the cap we drop by VALUE, not by arrival order. Volume is inversely correlated with
      // value — a render-commit storm is thousands/second while the network call an assertion turns
      // on is one — so first-come-first-dropped spends the budget on churn and loses the signal.
      // High-value kinds get a bounded reserve on top of the cap; see event-priority.ts.
      if (overRate && parsed.kind === MessageKind.EVENT) {
        const withinReserve =
          isHighValueEvent(parsed.event.type) && highValueInWindow < highValueReserve;
        if (withinReserve) {
          highValueInWindow += 1;
        } else {
          droppedByRate += 1;
          if (session !== undefined) session.noteRateLimited(droppedByRate);
          return;
        }
      }

      if (parsed.kind === MessageKind.HELLO) {
        if (session !== undefined) {
          // A repeat hello on the SAME socket for the SAME session is an identity refresh, not a
          // violation: the SDK re-announces when the app registers capabilities, which happens after
          // connect by design. Closing the socket on it made `hasCapabilities` permanently false for
          // every app that declared anything. A hello bearing a DIFFERENT session id is still a
          // protocol violation — that is the case this guard exists for.
          if (parsed.sessionId !== session.id) {
            socket.close(...WS_CLOSE.HELLO_DUPLICATE);
            return;
          }
          refreshIdentity(session, parsed);
          return;
        }
        if (this.#token !== undefined && !tokensMatch(this.#token, parsed.token)) {
          // A daemon left running by ANOTHER project answers this app and rejects it on token. The
          // token is not wrong, it is somebody else's — and "authentication failed" sends the user to
          // check the one thing that is fine. See auth-failure-reason.
          const reason = authFailureReason(this.#servedProjects, parsed.projectId);
          log('authentication_failed', {
            served: [...this.#servedProjects],
            ...(parsed.projectId === undefined ? {} : { helloProject: parsed.projectId }),
          });
          this.sessions.noteClosure(WS_CLOSE_REASON.AUTH_FAILED, this.#clock());
          socket.close(WS_CLOSE.AUTH_FAILED[0], reason);
          return;
        }
        const existing = this.sessions.get(parsed.sessionId);
        if (existing === undefined && this.sessions.count() >= this.#maxSessions) {
          socket.close(...WS_CLOSE.SESSION_LIMIT);
          return;
        }
        clearTimeout(helloTimer);
        releasePending();
        session = new Session(parsed, socket, this.#clock);
        // Recorded on ACCEPTANCE, so it is evidence of what this daemon really serves.
        if (parsed.projectId !== undefined) this.#servedProjects.add(parsed.projectId);
        this.#onSessionCreate?.(session); // attach the durable journal before any events stream in
        const replaced = this.sessions.add(session);
        if (replaced !== undefined) {
          // Name the newcomer. A field report had a live session vanish during `reticle_lease` and the
          // only evidence was "session replaced by a newer connection" in the page console — which
          // says a replacement happened but not BY WHAT, so the cause had to be inferred. A session
          // is only ever replaced by one carrying the SAME id, and knowing which URL claimed it is
          // the difference between a diagnosis and a guess.
          log('session_replaced', {
            sessionId: session.id,
            byUrl: session.url,
            previousUrl: replaced.url,
          });
          replaced.disconnect(
            `session replaced by a newer connection claiming the same id (${session.id}) from ${session.url}`,
          );
        }
        // The daemon is the single judge of skew, and HELLO is where the page announces itself.
        // Reported on the session (reticle_sessions) AND queued for the next tool result, because an
        // agent driving a flow never calls reticle_sessions and would never learn.
        const skew = describeSkew(
          {
            what: 'the page',
            version: parsed.sdkVersion,
            contract: parsed.contract,
            fix: sdkFix(SERVER_VERSION),
          },
          { version: SERVER_VERSION, contract: CONTRACT_FINGERPRINT },
        );
        if (skew !== undefined) {
          log('version_skew', {
            sessionId: session.id,
            sdk: parsed.sdkVersion,
            daemon: SERVER_VERSION,
          });
          session.versionSkew = skew;
          noteVersionSkew(SkewPair.SDK, skew);
        }
        log('session_connected', { sessionId: session.id, url: session.url });
        this.#onSessionReady?.(session); // daemon pushes the replayable-flow list to the panel
        return;
      }
      if (session === undefined) return;
      session.touch();

      if (parsed.kind === MessageKind.EVENT) {
        // A panel ▶ replay needs the daemon's flow store, which the Session can't reach — route it to
        // the daemon-wired handler instead of the in-session control path. Everything else is normal.
        const replay = replayRequest(parsed.event);
        if (replay !== undefined) this.#onReplay?.(session.id, replay);
        // Pass the raw frame's byte length so the buffer doesn't re-serialize every event for accounting.
        else session.pushEvent(parsed.event, Buffer.byteLength(text, 'utf8'));
      } else if (parsed.kind === MessageKind.COMMAND_RESULT) {
        session.handleResult(parsed);
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      releasePending();
      if (session !== undefined) {
        const ended = session;
        if (this.sessions.remove(ended)) {
          log('session_disconnected', { sessionId: ended.id });
          // Best-effort teardown: flush the journal tail + persist ambient learning. Never awaited here
          // (the socket is already closing) and never allowed to reject into the close handler.
          void this.#onSessionEnd?.(ended).catch(() => undefined);
        }
      }
    });

    socket.on('error', (err) => {
      log('socket_error', { error: err.message });
    });
  }

  #originAllowed(origin: string | undefined): boolean {
    // A real browser SDK connection always carries an Origin. A missing Origin means a non-browser
    // local process (another app, a malicious npm postinstall, an extension's native host) — untrusted
    // unless a pairing token is required, in which case the HELLO token check is the real gate.
    if (origin === undefined) return this.#token !== undefined;
    const normalized = normalizeOrigin(origin);
    if (null === normalized) return false;
    if (this.#allowedOrigins.has(normalized)) return true;
    // A desktop webview (Electron, Tauri) or a file:// document sends an opaque Origin: no host to
    // check, so it is exactly as attributable as a missing Origin — defer to the token, as above.
    // Without this branch `new URL` throws INSIDE the WS upgrade handler, crashing the process.
    if (isOpaqueOrigin(normalized)) return this.#token !== undefined;
    // `isLocalPage`, not `isLoopbackHostname` — the SAME rule the SDK applies on the page side.
    //
    // They had drifted, and the drift made a whole platform unreachable. Tauri v2 uses an opaque
    // `tauri://localhost` on macOS/Linux, but on WINDOWS the webview needs a real http origin and
    // Tauri serves `http://tauri.localhost`. `isLocalPage` was taught that hostname; this check was
    // not. So a Windows Tauri app passed its own gate, dialed the bridge, and every handshake came
    // back 403 — Reticle could not connect to a Tauri app on Windows at all, which is precisely the
    // platform the release notes admitted had never been executed.
    //
    // No weaker than before: `.localhost` is reserved for loopback by RFC 6761, so the name cannot
    // resolve to a remote host, and this is the argument core already made when it accepted the same
    // hostname for the page.
    const url = new URL(normalized);
    return isLocalPage(url.protocol, url.hostname);
  }

  #parse(text: string): ReturnType<typeof ReticleMessageSchema.parse> | null {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const result = ReticleMessageSchema.safeParse(json);
    if (!result.success) {
      log('bad_message', { issues: result.error.issues.length });
      return null;
    }
    return result.data;
  }

  /** Register the daemon's handler for a panel ▶ replay (it owns the flow store). */
  attachReplay(handler: ReplayRequestHandler): void {
    this.#onReplay = handler;
  }

  /** Register a callback fired when a browser session connects (to push it the replayable flows). */
  attachSessionReady(handler: SessionReadyHandler): void {
    this.#onSessionReady = handler;
  }

  /** Register a callback fired the instant a session is created — used to attach the durable journal. */
  /**
   * Teardown handler fired when a session is removed (tab closed/disconnected). Without it the journal's
   * batched tail (< one flush batch) never reaches disk and the learned ambient map is discarded.
   */
  attachSessionEnd(handler: (session: Session) => Promise<void>): void {
    this.#onSessionEnd = handler;
  }

  attachSessionCreate(handler: (session: Session) => void): void {
    this.#onSessionCreate = handler;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.#wss.clients) client.terminate();
      this.#wss.close(() => {
        resolve();
      });
    });
  }
}
