import { readFileSync } from 'node:fs';
import { DaemonStartupError, NODE_ERROR_CODE } from '@reticlehq/core';

/** The structured log event emitted when the daemon child cannot start. */
export const DAEMON_START_FAILED_EVENT = 'reticle_daemon_start_failed';

/** The `syscall` that Node puts on the error of a failed bind. */
const LISTEN_SYSCALL = 'listen';

type LogFn = (event: string, fields: Record<string, unknown>) => void;

/** The Node error code on `error`, or undefined. Only a value that has the shape of a code. */
function nodeErrorCode(error: unknown): string | undefined {
  if ('object' !== typeof error || null === error) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return 'string' === typeof code && NODE_ERROR_CODE.test(code) ? code : undefined;
}

function isListenError(error: unknown): boolean {
  if ('object' !== typeof error || null === error) {
    return false;
  }
  return LISTEN_SYSCALL === (error as { syscall?: unknown }).syscall;
}

/**
 * Write a failed start to the daemon log, before the process exits (#2043).
 *
 * The line has three fields. `error` is the message, for the person who reads the log and for
 * `readDaemonStartupCause`. `code` is the Node error code, read from the error and not from the
 * message. `stage` is where the start failed: a failed bind is always `listen`, whatever the caller
 * gave. The next start reads `code` and `stage` into `daemon_died_unclean`. The message stays here.
 */
export function recordStartupFailure(log: LogFn, error: unknown, stage: DaemonStartupError): void {
  const code = nodeErrorCode(error);
  log(DAEMON_START_FAILED_EVENT, {
    stage: isListenError(error) ? DaemonStartupError.LISTEN : stage,
    ...(code === undefined ? {} : { code }),
    error: error instanceof Error ? error.message : String(error),
  });
}

/** The parts of `process` that the startup trap uses. */
export interface StartupTrapTarget {
  prependListener(
    event: 'uncaughtException' | 'unhandledRejection',
    handler: (value: unknown) => void,
  ): void;
  off(event: 'uncaughtException' | 'unhandledRejection', handler: (value: unknown) => void): void;
}

/**
 * Write a throw or a rejection that stops the start to the daemon log.
 *
 * Before the daemon is ready, the process crash guard owns these two events. It writes one sentence
 * to stderr and exits, and that sentence has no event name and no code. So a daemon that died in
 * its first 100 ms left a log that no reader could classify. This trap runs FIRST (it is prepended)
 * and writes one structured line. It does not exit: the crash guard still does that.
 *
 * Returns a disposer. Call it when the daemon is ready, because from then on the daemon's own
 * resilience handlers own these events, and a crash is no longer a failed start.
 */
export function installStartupTrap(proc: StartupTrapTarget, log: LogFn): () => void {
  let written = false;
  const trap =
    (stage: DaemonStartupError) =>
    (value: unknown): void => {
      if (written) {
        return;
      }
      written = true;
      recordStartupFailure(log, value, stage);
    };
  const onException = trap(DaemonStartupError.UNCAUGHT_EXCEPTION);
  const onRejection = trap(DaemonStartupError.UNHANDLED_REJECTION);
  proc.prependListener('uncaughtException', onException);
  proc.prependListener('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onException);
    proc.off('unhandledRejection', onRejection);
  };
}

/**
 * Return the most recent startup cause written by this launch attempt.
 *
 * Daemon logs are append-only across launches, so an event name alone is not enough: surfacing an
 * older failure would confidently diagnose the wrong attempt. The parent supplies the timestamp it
 * captured immediately before spawning and this reader ignores every earlier record. Malformed or
 * unavailable logs are best-effort misses; the caller still has its generic fallback diagnosis.
 */
export function readDaemonStartupCause(path: string, sinceMs: number): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  const lines = contents.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (undefined === line || 0 === line.length) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || null === record) continue;

    const candidate = record as { event?: unknown; error?: unknown; t?: unknown };
    if (candidate.event !== DAEMON_START_FAILED_EVENT) continue;
    if (typeof candidate.t !== 'string' || typeof candidate.error !== 'string') continue;

    const recordedAt = Date.parse(candidate.t);
    const error = candidate.error.trim();
    if (!Number.isFinite(recordedAt) || recordedAt < sinceMs || 0 === error.length) continue;
    return error;
  }
  return undefined;
}
