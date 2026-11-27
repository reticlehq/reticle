/**
 * The proxied calls still in flight, which of them are Harness drives, and what each one is told
 * when the transport under it is lost.
 */
import { ReticleTool } from '@reticlehq/core';
import { parseLine as parseJsonRpc } from './proxy-handshake.js';

const TOOLS_CALL = 'tools/call';
const EXPLORE_ACTION = 'explore';

export type CompletionKind = 'unknown' | 'not-completed';

const MSG_OUTCOME_UNKNOWN =
  `The outcome is unknown. The action may have run. Check the app with ${ReticleTool.LOOK} ` +
  'before retrying a non-idempotent action.';
const MSG_NOT_COMPLETED = 'The call did NOT complete.';
const MSG_CONNECTION_DROPPED = (reason: string): string =>
  `The daemon connection dropped (${reason}) before this call was answered. `;

/** A `tools/call` of reticle_verify explore, directly or through the reticle_run hatch. */
export function isHarnessDriveCall(msg: { method?: unknown; params?: unknown }): boolean {
  if (TOOLS_CALL !== msg.method) {
    return false;
  }
  const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (ReticleTool.VERIFY_EXPLORE === params.name) {
    return true;
  }
  if (ReticleTool.VERIFY === params.name) {
    return EXPLORE_ACTION === args['action'];
  }
  if (ReticleTool.RUN !== params.name) {
    return false;
  }
  const inner = (args['args'] ?? {}) as Record<string, unknown>;
  return (
    ReticleTool.VERIFY_EXPLORE === args['tool'] ||
    (ReticleTool.VERIFY === args['tool'] && EXPLORE_ACTION === inner['action'])
  );
}

/**
 * A drive lives in the daemon, not in the call: a lost connection does not end it, and retrying the
 * call as if it had not run pays for a second drive.
 */
export const MSG_DRIVE_MAY_BE_RUNNING =
  `The Harness drive this call started or polled may still be running in the daemon. Once ` +
  `Reticle reconnects, call ${ReticleTool.VERIFY} {action:"explore"} with no runId to get the ` +
  `running drive back (it will not start a second), then poll it by runId.`;

/**
 * JSON-RPC requests forwarded on behalf of the client that have not been answered yet.
 *
 * Only used at shutdown, where it is the difference between "the client closed stdin" and "the client
 * closed stdin and we dropped its `tools/list` on the floor while reporting exit 0". A request has an
 * id AND a method; a notification has no id and is owed nothing; a response has an id and no method.
 */
export class PendingRequests {
  #ids = new Set<string>();
  /** The pending requests that start or poll a Harness drive, which outlives a lost connection. */
  #drives = new Set<string>();

  observeOutbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id === undefined || msg.method === undefined) {
      return;
    }
    const id = JSON.stringify(msg.id);
    this.#ids.add(id);
    if (isHarnessDriveCall(msg)) {
      this.#drives.add(id);
    }
  }

  /** Whether this unanswered request asked for a Harness drive. */
  isDrive(id: unknown): boolean {
    return this.#drives.has(JSON.stringify(id));
  }

  observeInbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id === undefined) {
      return;
    }
    this.#ids.delete(JSON.stringify(msg.id));
  }

  get unanswered(): string[] {
    return [...this.#ids];
  }

  /**
   * Claim ONE unanswered id, so exactly one path may answer it. False means somebody already did —
   * a duplicate response to one id is a protocol violation, not a belt-and-braces retry.
   */
  take(id: unknown): boolean {
    this.#drives.delete(JSON.stringify(id));
    return this.#ids.delete(JSON.stringify(id));
  }

  /** Take every unanswered id and forget them, so the same request is failed at most once. */
  drain(): string[] {
    const ids = [...this.#ids];
    this.#ids.clear();
    return ids;
  }

  /** Forget which requests were drives, once their replies are written. */
  clearDrives(): void {
    this.#drives.clear();
  }
}

/**
 * JSON-RPC errors for every request that was in flight when the stream died.
 *
 * These are unrecoverable BY CONSTRUCTION: the daemon builds a fresh MCP session per SSE
 * connection, so the reconnected session has never seen them. Re-sending them is not an option
 * either — a `reticle_act` that already clicked would click twice, and inventing a second action in
 * somebody's app is worse than reporting a failure.
 *
 * So the proxy answers them itself, under each request's own id. Found by brute force: killing the
 * daemon under a live client left 20 of 20 concurrent calls hanging until the client's own timeout,
 * with the MCP server still perfectly alive. An agent cannot tell that apart from "still working".
 */
export function streamLossReplies(
  pending: PendingRequests,
  reason: string,
  nextStep?: string,
): string[] {
  const replies = pending.drain().map((id) => {
    const parsed = JSON.parse(id) as unknown;
    return transportLossReply(parsed, reason, nextStep, pending.isDrive(parsed));
  });
  pending.clearDrives();
  return replies;
}

/**
 * -32001: a server-defined error. Not -32603 (internal): nothing went wrong INSIDE the call, the
 * transport under it went away. The reply states whether the outcome is known.
 */
const TRANSPORT_LOSS_CODE = -32001;

/**
 * The one shape every "the transport ate your call" answer takes, whichever leg died.
 *
 * `nextStep` is appended when the caller knows one. Without it this reply describes a condition and
 * stops there, which is all a first-run user got out of their first ever tool call.
 */
export function transportLossReply(
  id: unknown,
  reason: string,
  nextStep?: string,
  drive = false,
  completionKind: CompletionKind = 'unknown',
): string {
  let outcomeMessage = MSG_OUTCOME_UNKNOWN;
  if (drive) {
    outcomeMessage = MSG_DRIVE_MAY_BE_RUNNING;
  } else if ('not-completed' === completionKind) {
    outcomeMessage = MSG_NOT_COMPLETED;
  }
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: TRANSPORT_LOSS_CODE,
      message:
        MSG_CONNECTION_DROPPED(reason) +
        outcomeMessage +
        (nextStep === undefined ? '' : ` ${nextStep}`),
    },
  });
}
