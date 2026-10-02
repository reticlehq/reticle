/**
 * Take the dev server with us when setup crashes, and hand the user one sentence.
 *
 * The sibling of `interrupt.ts`, and for a related reason: a `finally` does not run when the
 * process dies on an uncaught throw either, so a bug of ours left the detached dev server holding a
 * port nobody could account for — and printed a raw Node stack trace on the way out.
 *
 * The prototype this phase was ported from had exactly this handler. It was not ported, and nothing
 * noticed for one specific reason: the break-matrix scenario written to catch it
 * (`a-bug-of-our-own-is-not-a-stack-trace`) was still aimed at the prototype, so it went on passing
 * while the shipped CLI did the thing it forbids. A gate pointed at code nobody runs is not a gate.
 *
 * A bug of ours is still our bug — but it should arrive as one sentence, with the machine left
 * tidy, and with whatever the caller is parsing still well formed.
 */

/** The parts of `process` this needs, so the behaviour is testable without throwing anything. */
export interface CrashTarget {
  on(event: 'uncaughtException' | 'unhandledRejection', handler: (err: unknown) => void): void;
  off(event: 'uncaughtException' | 'unhandledRejection', handler: (err: unknown) => void): void;
  exit(code: number): void;
}

/**
 * Report a crash: `message` is one line safe to show, `stack` is for a file and never for a stream.
 *
 * Injected rather than written here, because where the trace lands is the caller's business — and
 * because a handler that writes files is a handler nothing can test.
 */
export type CrashReporter = (message: string, stack: string) => void;

/**
 * How to report the crash, in the only form that works while the process is dying.
 *
 * The shell command, never `reticle_session { action: "feedback" }`: this handler runs BECAUSE
 * Reticle is going down, so there is no daemon to accept a tool call and no session to file
 * through. `feedback --agent` needs neither.
 *
 * The sentence used to end "Please report it." -- a wish with no call in it, which an agent cannot
 * act on and a human has to go and look up. This is the moment a report is worth most: a defect in
 * OUR code, in somebody else's project, held by an agent whose context is about to end.
 */
export const CRASH_REPORT_ASK =
  'Please report it — a crash is always our bug, and this is the one we most want to hear about: ' +
  'npx @reticlehq/server feedback --agent --kind bug "what you ran, and the message above"';

/**
 * The one line a crash is allowed to print. Exported so it can be asserted without throwing.
 *
 * `hit a bug of its own` is load-bearing: the break-matrix scenario
 * `a-bug-of-our-own-is-not-a-stack-trace` greps for exactly that, and it is what tells a reader
 * this is not their fault before they start debugging their own project.
 */
export function crashSentence(message: string, crashLog: string): string {
  return (
    `reticle hit a bug of its own and stopped: ${message}. Anything it had already done is done, ` +
    `and re-running is safe. The trace is in ${crashLog}. ${CRASH_REPORT_ASK}`
  );
}

/** Long enough to identify the fault, short enough that it cannot become the output. */
const MESSAGE_MAX = 300;

const FATAL = ['uncaughtException', 'unhandledRejection'] as const;

/** Anything can be thrown, so this takes `unknown` and never assumes a shape. */
function oneLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return (raw.split('\n')[0] ?? '').slice(0, MESSAGE_MAX);
}

/**
 * Run `stop`, report once, and leave with a failure code if this process dies of its own bug.
 *
 * Returns a disposer, and callers must use it: `init` keeps running after setup, and a handler left
 * behind would tear down a server it no longer owns.
 */
export function stopOnCrash(
  stop: () => void,
  target: CrashTarget,
  report: CrashReporter,
): () => void {
  // Once only, for the reason `stopOnInterrupt` states: `stop` kills a process GROUP, and on a
  // recycled pid a second kill is somebody else's process. Both fatals can fire for one fault.
  let done = false;
  const handlers = FATAL.map((event) => {
    const handler = (err: unknown): void => {
      if (!done) {
        done = true;
        stop();
        report(oneLine(err), String(err instanceof Error ? (err.stack ?? err.message) : err));
      }
      target.exit(1);
    };
    target.on(event, handler);
    return { event, handler };
  });
  return () => {
    for (const { event, handler } of handlers) target.off(event, handler);
  };
}
