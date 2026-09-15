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
