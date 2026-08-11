/**
 * Process-level resilience for the long-running daemon. The daemon serves many agents at once, so a
 * single stray error must not take the whole fleet down:
 *
 * - unhandledRejection (a fire-and-forget promise nobody awaited — the common case in async WS/pool
 * code) → LOG and keep running. One agent's async slip-up can't crash the daemon for everyone.
 * - uncaughtException (a synchronous throw escaped all try/catch) → the process state is undefined
 * per Node's guidance, so LOG a clear reason and exit cleanly; the next `reticle mcp` respawns a fresh
 * daemon, which beats crashing silently or limping along corrupt.
 */

import { TelemetryActor, TelemetryEventKind } from '@reticlehq/core';
import {
  errorSkeleton,
  errorTypeOf,
  fingerprintCrash,
  MAX_REPORTED_FRAMES,
  reticleFrames,
} from '../telemetry/error-fingerprint.js';
import { getSessionMetrics } from '../telemetry/session-metrics.js';
import { machineSnapshot } from '../telemetry/machine-snapshot.js';
import { getTelemetry } from '../telemetry/telemetry.js';

export interface ProcessLike {
  on(event: string, listener: (arg: unknown) => void): unknown;
}

type LogFn = (event: string, data: Record<string, unknown>) => void;

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Node error codes that mean THE OTHER END WENT AWAY, not "we broke".
 *
 * One real session produced nine `runtime_crashed` events, all `write EPIPE`: the MCP client closed
 * its half of the stdio pipe and the very next `process.stdout.write` failed, which is the ordinary
 * way a client leaves. Counted as uncaught exceptions they poison the only metric that answers "is
 * Reticle stable?" — and they recur every single time an editor is closed.
 *
 * Matched on `err.code`, never on the message: a message is prose, gets wrapped, localised and
 * rewritten, and matching it would eventually swallow a real crash that merely mentioned a pipe.
 *
 * - `EPIPE` — wrote to a pipe whose reader is gone. The stdio case, and the nine.
 * - `ECONNRESET` — the peer reset the socket; stdio is a socket when the parent piped it, and the
 *   HTTP/SSE surface produces it when a client vanishes mid-response.
 * - `ERR_STREAM_DESTROYED` — the same race one tick later: the stream was already torn down when
 *   the write landed.
 */
const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
]);

/** The disconnect code this failure carries, if that is all it was. */
function disconnectCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return 'string' === typeof code && DISCONNECT_CODES.has(code) ? code : undefined;
}

/**
 * Log an expected disconnect and report `true`, so the caller skips the crash report.
 *
 * It is still WRITTEN DOWN. A client leaving is normal, but a daemon that suddenly logs a hundred of
 * these is a finding — the difference between "not a crash" and "not worth knowing" is the whole
 * reason this logs instead of returning early in silence.
 */
function absorbDisconnect(value: unknown, log: LogFn, event: string): boolean {
  const code = disconnectCode(value);
  if (code === undefined) return false;
  log(event, { code, note: 'the client went away — expected, not a crash' });
  return true;
}

/** The two ways a failure reaches the top of the process. Named so the analytics can tell them apart. */
export const CrashKind = {
  UNHANDLED_REJECTION: 'unhandled_rejection',
  UNCAUGHT_EXCEPTION: 'uncaught_exception',
} as const;
export type CrashKind = (typeof CrashKind)[keyof typeof CrashKind];

/**
 * Report a crash with enough detail to actually diagnose it.
 *
 * This is the only place in the product that learns about a crash at all. An uncaught exception in a
 * long-running daemon takes down every agent attached to it, and the only other record is a line in a
 * local log nobody sends us.
 *
 * The first version sent a hash and nothing else, which made crashes rankable and undiagnosable — you
 * could see that forty machines hit `a3f2c1d8e9b0` and had no way to learn what that was. So it now
 * carries the four things an RCA needs: WHERE (our own frames, with function names and line numbers),
 * WHAT (the message with every variable part stripped), WHEN (the tool in flight), and WHY-ish (the
 * agent's approach run before it). All of it is our code and our vocabulary; the user's stack frames,
 * their paths, and the contents of their message are removed before any of it is built.
 *
 * Best-effort and wrapped: reporting a crash must never be the reason a crash gets worse.
 */
function reportCrash(kind: CrashKind, value: unknown): void {
  try {
    const errorType = errorTypeOf(value);
    const stack = value instanceof Error ? (value.stack ?? '') : '';
    const message = describe(value);
    const { breadcrumb, inFlight } = getSessionMetrics().trail;
    const machine = machineSnapshot();
    void getTelemetry().emit(TelemetryEventKind.RUNTIME_CRASHED, {
      // A crash is ALWAYS reached through something the agent asked for — the daemon does nothing on
      // its own — so attributing it to the agent is accurate rather than a guess.
      actor: TelemetryActor.AGENT,
      crash: {
        kind,
        errorType,
        fingerprint: fingerprintCrash(errorType, stack, message),
        // The skeleton, not the message: every quoted string, path, URL, id and number is replaced
        // by `*` first. This is what makes the fingerprint mean something to a human reading a chart.
        message: errorSkeleton(message).slice(0, 300),
        // Our own frames, our own published code. The file, the line, and the function — which is the
        // whole of "where did it break". Frames from the user's app never survive this.
        frames: reticleFrames(stack).slice(0, MAX_REPORTED_FRAMES),
        ...(inFlight !== undefined ? { tool: inFlight } : {}),
        ...(breadcrumb.length > 0 ? { breadcrumb } : {}),
        // Crashes cluster hard by runtime version and architecture, and we were recording neither.
        nodeVersion: process.versions.node,
        arch: process.arch,
        // "Out of memory" and "our bug" look identical in a stack trace. This is what tells them apart.
        ...(machine !== undefined ? { machine } : {}),
      },
    });
  } catch {
    /* a crash report must never be the reason a crash gets worse */
  }
}

/**
 * Log EVERY way this process can leave, so a death always leaves a line.
 *
 * Reported from the field: a 115-line daemon log containing zero of `reticle_daemon_idle_exit`,
 * `reticle_daemon_close_error`, `daemon_stopped`, `uncaught` or `unhandled` — the daemon simply
 * stopped existing mid-wait. Both crash handlers below already log before exiting, so their silence
 * ruled themselves out and left nothing else to read: no shutdown path had run at all.
 *
 * `exit` fires for every in-process exit including an explicit `process.exit`, and carries the code.
 * The signals cover an external kill. What neither can catch is SIGKILL or an OOM abort — and that
 * is the point: after this, silence in the log is itself the finding, because every other door is
 * now instrumented.
 */
/**
 * Why the daemon is going away — carried ON the exit line, not left to be inferred.
 *
 * From the field (#123): a real gate log read `reticle_daemon_signalled SIGTERM` then
 * `reticle_daemon_exiting code:0`, then 21 seconds with nothing listening. `code: 0` is the last
 * line before the port goes dark and it cannot distinguish "shut down tidily" from "the bridge every
 * app on this machine needs is now gone". A correct install was written up as a failure naming the
 * fixture because of it.
 *
 * `UNKNOWN` is the load-bearing member, not a fallback: it means the process left through Node
 * WITHOUT passing a shutdown path — an uncaught throw, a stray `process.exit`. That is a different
 * fact from an idle exit, and the one worth noticing.
 */
export const DaemonExitReason = {
  /** A shutdown signal arrived (SIGTERM/SIGINT). */
  SIGNAL: 'signal',
  /** The idle timer fired and the daemon retired itself. */
  IDLE: 'idle',
  /** Left through Node, but not via any shutdown path we own. */
  UNKNOWN: 'unknown',
} as const;
export type DaemonExitReason = (typeof DaemonExitReason)[keyof typeof DaemonExitReason];

/**
 * Set by whichever shutdown path is running, read once by the exit handler.
 *
 * A module-level value rather than a parameter because the two are separated by the whole process
 * lifetime: the reason is known when shutdown STARTS and the exit line is written when Node is on
 * its way out. Exit runs once, on one thread, after everything else — so there is nothing to race.
 */
let exitReason: DaemonExitReason = DaemonExitReason.UNKNOWN;

/** Record why the daemon is shutting down. Called by a shutdown path before it exits. */
export function recordExitReason(reason: DaemonExitReason): void {
  exitReason = reason;
}

export function installExitTrace(proc: ProcessLike, log: LogFn): void {
  proc.on('exit', (code: unknown) => {
    log('reticle_daemon_exiting', {
      code: 'number' === typeof code ? code : null,
      reason: exitReason,
    });
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    proc.on(signal, () => {
      // Log only. Whatever installed a real handler for this signal still runs; adding an exit here
      // would race the shutdown that flushes the session summary.
      log('reticle_daemon_signalled', { signal });
    });
  }
}

export function installDaemonResilience(proc: ProcessLike, log: LogFn, onFatal: () => void): void {
  installExitTrace(proc, log);
  const disconnected = 'reticle_daemon_client_disconnected';
  proc.on('unhandledRejection', (reason: unknown) => {
    if (absorbDisconnect(reason, log, disconnected)) return;
    log('reticle_daemon_unhandled_rejection', { reason: describe(reason) });
    reportCrash(CrashKind.UNHANDLED_REJECTION, reason);
  });
  proc.on('uncaughtException', (err: unknown) => {
    // Not fatal either: Node's "the process state is undefined" guidance is about a throw that
    // escaped everything, not about a write to a socket somebody closed. Exiting here would let one
    // departing client take down the daemon serving every other agent.
    if (absorbDisconnect(err, log, disconnected)) return;
    log('reticle_daemon_uncaught_exception', { error: describe(err) });
    reportCrash(CrashKind.UNCAUGHT_EXCEPTION, err);
    onFatal();
  });
}

/**
 * Process-level resilience for the MCP PROXY, whose rule is the opposite of the daemon's.
 *
 * The daemon exits on an uncaught throw because the next `reticle mcp` respawns it. Nothing respawns
 * the proxy — it is the stdio server the editor launched, and its exit is what the user experiences
 * as "the MCP server disconnected, open /mcp and reconnect". So it logs and keeps serving: its whole
 * state is a socket and a queue, and it already knows how to rebuild both (see the reconnect and
 * dormant paths). A crashed-but-serving proxy answers the handshake and `tools/list` from cache; a
 * dead one answers nothing and needs a human.
 *
 * `onCrash` is for reporting only — it must not end the process.
 */
export function installProxyResilience(
  proc: ProcessLike,
  log: LogFn,
  onCrash: (kind: CrashKind, cause: unknown) => void = reportCrash,
): void {
  const disconnected = 'reticle_mcp_proxy_client_disconnected';
  proc.on('unhandledRejection', (reason: unknown) => {
    if (absorbDisconnect(reason, log, disconnected)) return;
    log('reticle_mcp_proxy_unhandled_rejection', { reason: describe(reason) });
    onCrash(CrashKind.UNHANDLED_REJECTION, reason);
  });
  proc.on('uncaughtException', (err: unknown) => {
    // The client closing its end of stdio is how this process is SUPPOSED to end its day.
    if (absorbDisconnect(err, log, disconnected)) return;
    log('reticle_mcp_proxy_uncaught_exception', {
      error: describe(err),
      note: 'still serving — exiting here would disconnect the MCP client',
    });
    onCrash(CrashKind.UNCAUGHT_EXCEPTION, err);
  });
}
