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

import { RETICLE_DEFAULT_PORT, TelemetryActor, TelemetryEventKind } from '@reticlehq/core';
import {
  errorSkeleton,
  errorTypeOf,
  fingerprintCrash,
  MAX_REPORTED_FRAMES,
  reticleFrames,
} from '../../telemetry/error-fingerprint.js';
import { getSessionMetrics } from '../../telemetry/session-metrics.js';
import { machineSnapshot } from '../../telemetry/machine-snapshot.js';
import { crashCause } from '../../telemetry/crash-cause.js';
import { getTelemetry } from '../../telemetry/telemetry.js';

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

/**
 * Nobody went away — nobody was ever there. A refused connect is the daemon not being up YET.
 *
 * This is the difference that made `runtime_crashed` useless. In the field **every crash event
 * carried one fingerprint, `connect ECONNREFUSED`, and every affected user was in the
 * never-verified set.** The proxy is BUILT to tolerate this — it answers the handshake from cache
 * and wakes a daemon on the next request — so reporting it as a crash meant the one metric that is
 * supposed to say "Reticle broke" said nothing but "the daemon had not booted yet", and a real crash
 * would have been invisible underneath it.
 *
 * Absorbed, not silenced: it still logs, and the outage it belongs to is already counted as
 * `connect_error` on `mcp_connection_lost`, which is the metric that can actually act on it.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED']);

/**
 * How many absorbed client disconnects mean the client is GONE rather than between reconnects.
 *
 * Absorbing a disconnect and continuing is right for one: the client closed a socket, the proxy
 * rebuilds it. It is catastrophic for a stream of them, because the write that failed is retried
 * immediately, fails identically, and is absorbed again — a tight loop with no backoff and no exit.
 *
 * Measured in the field: one proxy ran four days after its editor closed, at 97-98% of a core, with
 * 1473 minutes of CPU time and ~930 MB/hour of identical log lines, every entry stamped to the same
 * millisecond. Nothing in Reticle's own output showed it — the daemon beside it reported healthy,
 * `sessions: 0` — so it was findable only by running `ps` by hand, and thirteen more idle pairs from
 * earlier sessions were still resident behind it.
 *
 * Chosen well above the handful a genuine reconnect produces and far below a runaway. The proxy's
 * whole purpose is to be the stdio server its editor launched; once that editor is gone there is
 * nobody left to serve, and the correct thing is to leave rather than to burn a core proving it.
 */
const DISCONNECT_STORM = 20;

/** The expected-failure code this value carries, and which class it belongs to. */
function expectedCode(value: unknown): { code: string; unreachable: boolean } | undefined {
  const raw = (value as { code?: unknown } | null | undefined)?.code;
  if ('string' !== typeof raw) return undefined;
  if (DISCONNECT_CODES.has(raw)) return { code: raw, unreachable: false };
  if (UNREACHABLE_CODES.has(raw)) return { code: raw, unreachable: true };
  return undefined;
}

/** The two event names a caller uses for the two expected-failure classes. */
interface ExpectedEvents {
  readonly disconnected: string;
  readonly unreachable: string;
}

/**
 * Log an expected failure and report `true`, so the caller skips the crash report.
 *
 * It is still WRITTEN DOWN. A client leaving is normal, but a daemon that suddenly logs a hundred of
 * these is a finding — the difference between "not a crash" and "not worth knowing" is the whole
 * reason this logs instead of returning early in silence.
 */
function absorbExpected(value: unknown, log: LogFn, events: ExpectedEvents): boolean {
  const hit = expectedCode(value);
  if (hit === undefined) return false;
  log(hit.unreachable ? events.unreachable : events.disconnected, {
    code: hit.code,
    note: hit.unreachable
      ? 'the daemon was not reachable — expected while it boots, not a crash'
      : 'the client went away — expected, not a crash',
  });
  return true;
}

/** The two ways a failure reaches the top of the process. Named so the analytics can tell them apart. */
export const CrashKind = {
  UNHANDLED_REJECTION: 'unhandled_rejection',
  UNCAUGHT_EXCEPTION: 'uncaught_exception',
} as const;
export type CrashKind = (typeof CrashKind)[keyof typeof CrashKind];

/**
 * The ports Reticle itself uses, so a refusal can be classified as ours or somebody else's.
 *
 * Read here rather than threaded through `installCrashHandlers`: a crash handler is installed once,
 * at startup, and the port can be set after it. The values are only ever compared against — the
 * port a crash names is turned into an enum and then discarded.
 */
function knownPorts(): readonly number[] {
  const configured = Number(process.env['RETICLE_PORT']);
  return Number.isInteger(configured) && configured > 0
    ? [RETICLE_DEFAULT_PORT, configured]
    : [RETICLE_DEFAULT_PORT];
}

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
    // Where the frames cannot say. A refused socket's stack is entirely node internals, so
    // `reticleFrames` correctly keeps nothing and the report lands with no location at all — the
    // single commonest crash shape in a loopback-heavy tool.
    const cause = crashCause(value, knownPorts());
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
        // The syscall, the errno, whether it was loopback, whether the port was ours, and the
        // innermost frame in NODE's own source. Present only when the error carries them.
        ...cause,
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
  const expected: ExpectedEvents = {
    disconnected: 'reticle_daemon_client_disconnected',
    unreachable: 'reticle_daemon_peer_unreachable',
  };
  proc.on('unhandledRejection', (reason: unknown) => {
    if (absorbExpected(reason, log, expected)) return;
    log('reticle_daemon_unhandled_rejection', { reason: describe(reason) });
    reportCrash(CrashKind.UNHANDLED_REJECTION, reason);
  });
  proc.on('uncaughtException', (err: unknown) => {
    // Not fatal either: Node's "the process state is undefined" guidance is about a throw that
    // escaped everything, not about a write to a socket somebody closed. Exiting here would let one
    // departing client take down the daemon serving every other agent.
    if (absorbExpected(err, log, expected)) return;
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
 * `onCrash` is for reporting only — it must not end the process. `onGone` is the ONE exception, and
 * it is the subject of DISCONNECT_STORM below.
 */
export function installProxyResilience(
  proc: ProcessLike,
  log: LogFn,
  onCrash: (kind: CrashKind, cause: unknown) => void = reportCrash,
  onGone: () => void = () => process.exit(0),
): void {
  const expected: ExpectedEvents = {
    disconnected: 'reticle_mcp_proxy_client_disconnected',
    unreachable: 'reticle_mcp_proxy_daemon_unreachable',
  };
  // "Absorb the disconnect and keep serving" is right for ONE disconnect and catastrophic for a
  // stream of them — see DISCONNECT_STORM.
  let disconnects = 0;
  let gone = false;
  const absorb = (value: unknown): boolean => {
    if (!absorbExpected(value, log, expected)) return false;
    if (false === expectedCode(value)?.unreachable) {
      disconnects += 1;
      if (disconnects >= DISCONNECT_STORM && !gone) {
        gone = true;
        log('reticle_mcp_proxy_client_gone', {
          disconnects,
          note: 'the client end is gone for good, not between reconnects — exiting instead of retrying forever',
        });
        onGone();
      }
    }
    return true;
  };
  proc.on('unhandledRejection', (reason: unknown) => {
    if (absorb(reason)) return;
    log('reticle_mcp_proxy_unhandled_rejection', { reason: describe(reason) });
    onCrash(CrashKind.UNHANDLED_REJECTION, reason);
  });
  proc.on('uncaughtException', (err: unknown) => {
    // The client closing its end of stdio is how this process is SUPPOSED to end its day.
    if (absorb(err)) return;
    log('reticle_mcp_proxy_uncaught_exception', {
      error: describe(err),
      note: 'still serving — exiting here would disconnect the MCP client',
    });
    onCrash(CrashKind.UNCAUGHT_EXCEPTION, err);
  });
}
