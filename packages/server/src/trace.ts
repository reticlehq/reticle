/**
 * Verbose internal flow tracing, for people working ON Reticle.
 *
 * The gap it fills: the journal records what the AGENT did to the app, and telemetry records
 * aggregates. Neither says which of OUR code a tool call went through, in what order, or where the
 * time went — so every "why is this flow slow" and "which path produced this verdict" was
 * reconstructed by hand from reading source. One line per stage answers both.
 *
 * Design, in order of what it cost to get wrong elsewhere in this repo:
 *
 *  - OFF by default, and ~126ns per site when off (measured) — `span` calls the function and
 *    returns. A trace on every tool call is a real cost on the hot path, and the hot path is a
 *    verification loop of 50–200 calls.
 *  - ONE line per stage, emitted when it ENDS, carrying its own duration. A start line as well
 *    would double the volume to say something the end line already implies.
 *  - Correlated by a call id and a depth, carried in AsyncLocalStorage rather than threaded through
 *    every signature. Several agents are inside `runTool` at once — interleaving is the normal case
 *    — so without an id the output is a pile of unrelated lines, and instrumenting anything would
 *    mean changing its parameters, which is how instrumentation stops being added.
 *  - Through the existing `log()`, so it lands in the same stderr stream the daemon already
 *    redirects to `~/.reticle/daemon-<port>.log`. No new sink, no new file, nothing else to tail.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ReticleEnv } from '@reticlehq/core';
import { log } from './log.js';

/** The `event` field every trace line carries, so one `grep` separates it from milestone logs. */
const TRACE_EVENT = 'trace';

const ON_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'on', 'yes']);

interface CallContext {
  callId: string;
  depth: number;
}

const context = new AsyncLocalStorage<CallContext>();

/**
 * Monotonic within a process, and PID-qualified so it stays unique across them.
 *
 * A bare counter was not enough: the e2e battery runs many daemons, and a restarted daemon starts
 * over at 1, so `c7` named a different call in every process. Aggregating that trace silently
 * merged unrelated calls into one — measured on the first real trace collected, before it had a
 * chance to mislead anything.
 */
let nextCallId = 0;
const CALL_ID_PREFIX = `p${String(process.pid)}-c`;

/**
 * Whether tracing is on.
 *
 * Read per call, not cached at import, and the reason is `loadDotEnv`: the CLI populates
 * `process.env` from the project's .env AFTER every module has been imported, so a value captured at
 * import time would miss a `RETICLE_TRACE` set there — silently, which is the worst way for a
 * diagnostic switch to fail. (The reason originally given here — "so it can be turned on while the
 * daemon runs" — was wrong: nothing outside a process can change its environment.)
 *
 * Measured cost of reading it per call: 126ns per traced site when tracing is OFF, against a ~9ns
 * bare call. With a handful of spans per tool call that is under a microsecond on a call that takes
 * milliseconds — cheap enough to be worth the correctness, and not the literal zero this comment
 * used to imply.
 */
export function traceEnabled(): boolean {
  const raw = process.env[ReticleEnv.TRACE];
  return raw !== undefined && ON_VALUES.has(raw.trim().toLowerCase());
}

/** The scope a stage runs in, plus how to report it. Shared by the async and sync forms. */
function openSpan(
  name: string,
  fields: Record<string, unknown>,
): { child: CallContext; emit: (ok: boolean, extra: Record<string, unknown>) => void } {
  const parent = context.getStore();
  const scope: CallContext =
    parent === undefined
      ? { callId: `${CALL_ID_PREFIX}${String((nextCallId += 1))}`, depth: 0 }
      : parent;
  const depth = parent === undefined ? 0 : parent.depth;
  const startedAt = Date.now();
  return {
    // The child scope is what nested spans see: same call, one level deeper.
    child: { callId: scope.callId, depth: depth + 1 },
    emit: (ok, extra) => {
      log(TRACE_EVENT, {
        span: name,
        ms: Date.now() - startedAt,
        depth,
        callId: scope.callId,
        ok,
        ...fields,
        ...extra,
      });
    },
  };
}

/**
 * Bind a callback to the call that is running NOW, so it reports inside that call when it fires later.
 *
 * `waitForPredicate` re-checks its predicate from a WebSocket event listener and an interval. Neither
 * is in the awaited chain, so AsyncLocalStorage does not reach them and every re-check used to open a
 * brand new call at depth 0. Measured on one healthy run: 165 spans across 60 callIds, 25 of them a
 * `browser.command` with no matching `tool.handler`.
 *
 * That is not cosmetic. The documented signature of a HUNG tool call is exactly "a browser.command
 * with no tool.handler for that callId, ever" — the invariant that located a real hang. A clean run
 * emitting 23 of them makes the invariant unusable and hides the next hang in its own noise.
 *
 * Returns `fn` unchanged when there is no call to bind to, so a caller outside a span is not given a
 * fabricated parent.
 */
export function bindSpanContext<A extends unknown[]>(
  fn: (...args: A) => void,
): (...args: A) => void {
  const captured = context.getStore();
  if (captured === undefined) return fn;
  return (...args: A): void => {
    context.run(captured, () => fn(...args));
  };
}

/** How much of a thrown value to keep. Enough to identify it, not enough to paste a stack into a log. */
const ERROR_CHARS = 300;

/**
 * Run `fn` as a named stage, recording how long it took and how it sat inside the call around it.
 *
 * Wrap a stage worth a line in a bottleneck hunt — a session resolve, a browser round-trip, a
 * predicate evaluation — not every function. The value of the trace is that reading it is faster
 * than reading the code, and that stops being true somewhere around one line per statement.
 */
export async function span<T>(
  name: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!traceEnabled()) return fn();
  const { child, emit } = openSpan(name, fields);
  try {
    const value = await context.run(child, async () => fn());
    emit(true, {});
    return value;
  } catch (err) {
    // A stage that THREW is the one most worth having in the trace: without this line the trace
    // shows a call that entered a stage and never left it, which reads as a hang.
    emit(false, { error: String(err).slice(0, ERROR_CHARS) });
    throw err;
  }
}

/**
 * The synchronous form. Same line, same tree, same cost when off.
 *
 * It exists because `reticle init` — the flow every user hits before anything else, and the one
 * whose slowness they experience personally — is synchronous end to end. An async-only span left
 * exactly that flow untraceable.
 */
export function spanSync<T>(name: string, fields: Record<string, unknown>, fn: () => T): T {
  if (!traceEnabled()) return fn();
  const { child, emit } = openSpan(name, fields);
  try {
    const value = context.run(child, fn);
    emit(true, {});
    return value;
  } catch (err) {
    emit(false, { error: String(err).slice(0, ERROR_CHARS) });
    throw err;
  }
}
