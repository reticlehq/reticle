/**
 * Why a daemon died, read from its own log by the start that finds it dead.
 *
 * The daemon log already says how a daemon ended: a heartbeat every 30 s, a line for a signal, a
 * line for an exit, and a line for a failed start (see heartbeat.ts). Nobody uploads that file, so
 * `daemon_died_unclean` carried only the age, and a reboot, a killed process tree, an out-of-memory
 * kill and a crash at startup sent the same event. The next start reads the log before it rotates
 * it, and sends the cause with the event.
 *
 * Only facts that are names or numbers leave this module: an end, a signal name, a Node error code,
 * counts. Never a message, because a message can carry the user's paths.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { DaemonEnd, NODE_ERROR_CODE, type DaemonDeath } from '@reticlehq/core';
import { DAEMON_HEARTBEAT_EVENT, classifyDaemonLife } from './heartbeat.js';
import { DAEMON_START_FAILED_EVENT } from './startup-failure.js';

/** What the log says about the dead daemon. `ageMs` is the caller's to add. */
export type DeathCause = Omit<DaemonDeath, 'ageMs'> & { end: DaemonEnd };

/**
 * A Node error code where Node writes one: `[ERR_MODULE_NOT_FOUND]`, `code: 'EADDRINUSE'`, or
 * `listen EADDRINUSE:`. A bare upper-case word elsewhere is not a code.
 */
const ERROR_CODE_IN_TEXT = /\b(E[A-Z]{3,30}|ERR_[A-Z0-9_]{2,60})(?=\]|'|"|:)/g;
/** Upper-case words that sit before a colon and are not codes. */
const NOT_A_CODE: ReadonlySet<string> = new Set(['ERROR', 'EXIT', 'ENV']);

interface ParsedLine {
  t: number;
  event: string;
  [field: string]: unknown;
}

function parse(raw: string): ParsedLine | undefined {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if ('object' !== typeof record || null === record) {
    return undefined;
  }
  const r = record as Record<string, unknown>;
  const t = 'string' === typeof r['t'] ? Date.parse(r['t']) : Number.NaN;
  if (!Number.isFinite(t) || 'string' !== typeof r['event']) {
    return undefined;
  }
  return { ...r, t, event: r['event'] };
}

/** The last Node error code in `text`, or undefined. Only the code, never the text around it. */
function lastErrorCode(text: string): string | undefined {
  const codes = [...text.matchAll(ERROR_CODE_IN_TEXT)].map((m) => m[1]);
  const code = codes.filter((c) => c !== undefined && !NOT_A_CODE.has(c)).at(-1);
  return code !== undefined && NODE_ERROR_CODE.test(code) ? code : undefined;
}

const count = (v: unknown): number | undefined =>
  'number' === typeof v && Number.isInteger(v) && 0 <= v ? v : undefined;

/**
 * Read the cause of death of the daemon that started at `startedMs`.
 *
 * The log is append-only across launches, so only lines at or after `startedMs` count. A daemon
 * that crashed before it wrote any line leaves only a raw Node stack, after the last line of the
 * daemon before it; the error code is read from there.
 */
export function deathCauseFromLog(text: string, startedMs: number, nowMs: number): DeathCause {
  const ours: ParsedLine[] = [];
  const rawAfterLastLine: string[] = [];
  const rawInOurs: string[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (0 === trimmed.length) {
      continue;
    }
    const parsed = parse(trimmed);
    if (parsed === undefined) {
      (0 < ours.length ? rawInOurs : rawAfterLastLine).push(trimmed);
      continue;
    }
    if (parsed.t >= startedMs) {
      ours.push(parsed);
    } else {
      rawAfterLastLine.length = 0;
    }
  }

  const life = classifyDaemonLife(ours, nowMs);
  const cause: DeathCause = { end: life.end };
  if (life.silentForMs !== undefined) {
    cause.silentMs = Math.max(0, Math.round(life.silentForMs));
  }
  if (life.signal !== undefined && /^SIG[A-Z0-9]{1,12}$/.test(life.signal)) {
    cause.signal = life.signal;
  }

  const lastBeat = ours.findLast((l) => l.event === DAEMON_HEARTBEAT_EVENT);
  if (lastBeat !== undefined) {
    const sessions = count(lastBeat['sessions']);
    const rssMb = count(lastBeat['rssMb']);
    if (sessions !== undefined) {
      cause.sessions = sessions;
    }
    if ('boolean' === typeof lastBeat['served']) {
      cause.served = lastBeat['served'];
    }
    if (rssMb !== undefined) {
      cause.rssMb = rssMb;
    }
  }

  const failed = ours.findLast((l) => l.event === DAEMON_START_FAILED_EVENT);
  const error =
    ('string' === typeof failed?.['error'] ? lastErrorCode(failed['error']) : undefined) ??
    // Raw lines before this daemon's first line belong to the daemon before it, unless this one
    // wrote no line at all, which is a crash before its first log line.
    lastErrorCode((0 < ours.length ? rawInOurs : rawAfterLastLine).join('\n'));
  if (error !== undefined) {
    cause.error = error;
  }
  return cause;
}

/** How much of the end of a daemon log the next start reads. The last beats and a stack fit. */
const LOG_TAIL_BYTES = 256 * 1024;

/** The last part of the log at `path`, or undefined when it cannot be read. Never throws. */
export function readLogTail(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
