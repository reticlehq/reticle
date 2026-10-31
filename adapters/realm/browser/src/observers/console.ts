import { EventType, TRANSPORT_LIMITS } from '@reticlehq/core';
import { observeSafely, type Emit, type Teardown } from './types.js';
import { safeStringify } from '@/security/serialization.js';
import { requireCapturedMethod } from '@/util/captured-method.js';
import { createRepeatLimiter, type ErrorIdentity } from './error-repeats.js';

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';

/** The DOM event a CSP violation arrives as, and the `kind` it is reported under. */
const CSP_VIOLATION_EVENT = 'securitypolicyviolation';
/** `disposition` of a report-only policy: the browser reported the resource and did not block it. */
const REPORT_ONLY = 'report';

const METHOD_EVENT: Record<ConsoleMethod, EventType> = {
  log: EventType.CONSOLE_LOG,
  warn: EventType.CONSOLE_WARN,
  error: EventType.CONSOLE_ERROR,
  // info/debug are captured for the raw console channel but excluded from summaries/deviation reports
  // (low signal — most apps chatter here). Lean: no stack, like log/warn.
  info: EventType.CONSOLE_INFO,
  debug: EventType.CONSOLE_DEBUG,
};

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if ('string' === typeof a) return a;
      if (a instanceof Error) return a.message;
      return safeStringify(a);
    })
    .join(' ');
}

/** Stacks can be long; cap so a deep async trace never blows the event budget. */
const MAX_STACK_LEN = TRANSPORT_LIMITS.MAX_STACK_LENGTH;

function capStack(stack: string | undefined): string | undefined {
  if (stack === undefined || 0 === stack.length) return undefined;
  return stack.length > MAX_STACK_LEN ? stack.slice(0, MAX_STACK_LEN) : stack;
}

/** The stack of the first Error argument, if any — the single biggest diagnosis upgrade, near-zero cost. */
function firstErrorStack(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error) return capStack(arg.stack);
  }
  return undefined;
}

/** Patch console.{log,warn,error} and window error events. Reversible. */
export function installConsole(emit: Emit): Teardown {
  const methods: ConsoleMethod[] = ['log', 'warn', 'error', 'info', 'debug'];
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const patched = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of methods) {
    // Store the true original for teardown identity; call through a bound copy. Read as a stored
    // VALUE rather than a method reference — see capturedMethod for why that distinction is the
    // honest way to say "I am detaching this deliberately and putting it back".
    const original = requireCapturedMethod<(...args: unknown[]) => void>(console, method);
    originals.set(method, original);
    const callOriginal = original.bind(console);
    const wrapper = (...args: unknown[]): void => {
      // The message reaches the console FIRST, outside the guard — storage.ts's ordering, and for the
      // same reason. `stringifyArgs` walks arbitrary app objects, so one hostile getter or revoked
      // proxy would otherwise throw out of the app's own `console.log` before it had logged anything.
      callOriginal(...args);
      observeSafely(() => {
        // Only console.error carries a stack — the diagnosis case; log/warn stay lean.
        const stack = 'error' === method ? firstErrorStack(args) : undefined;
        emit(METHOD_EVENT[method], {
          message: stringifyArgs(args),
          ...(stack === undefined ? {} : { stack }),
        });
      });
    };
    patched.set(method, wrapper);
    console[method] = wrapper;
  }

  // One uncaught error repeating is one fact. Recording an error can raise the same error, so this
  // path can feed itself until a disk fills (#986). Per-installation, so a
  // teardown and re-connect starts clean.
  const repeats = createRepeatLimiter();
  /**
   * Emit an uncaught error unless it is a repeat already reported enough times.
   *
   * The payload IS the identity: every field that distinguishes two occurrences is a field the
   * event already carries, so there is nothing to keep in step between them.
   */
  const emitError = (payload: ErrorIdentity): void => {
    const decision = repeats.admit(payload);
    if (!decision.emit) return;
    emit(EventType.ERROR_UNCAUGHT, {
      ...payload,
      ...(undefined === decision.repeats ? {} : { repeats: decision.repeats }),
    });
  };

  const onError = (event: Event): void => {
    // A SUBRESOURCE that failed to load — `<img>`, `<script>`, `<link>`, media. The browser writes
    // these to the console and none of them passes through a console method, so patching console
    // cannot see them. They dispatch on the ELEMENT and do not bubble, which is why this listener
    // is registered in the CAPTURE phase: a bubble-phase listener on `window` never runs for one,
    // and `console absent` came back green on pages visibly full of red.
    //
    // Told apart from a real script error by the event's own type, not by guessing: a script that
    // loaded and then threw dispatches an `ErrorEvent` carrying `message`/`error`, while a resource
    // failure dispatches a plain `Event` whose target is the element. No double-report either way.
    if (!(event instanceof ErrorEvent)) {
      const target = event.target;
      if (!(target instanceof Element) || target === (document as unknown as Element)) return;
      const tag = target.tagName.toLowerCase();
      const url = target.getAttribute('src') ?? target.getAttribute('href') ?? '';
      observeSafely(() => {
        const message = `<${tag}> failed to load${0 === url.length ? '' : `: ${url}`}`;
        emitError({ message, kind: 'resource', ...(0 === url.length ? {} : { source: url }) });
      });
      return;
    }
    observeSafely(() => {
      const stack = capStack(event.error instanceof Error ? event.error.stack : undefined);
      const payload = {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        ...(stack === undefined ? {} : { stack }),
      };
      emitError(payload);
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    observeSafely(() => {
      const reason: unknown = event.reason;
      const stack = capStack(reason instanceof Error ? reason.stack : undefined);
      const payload = {
        message: reason instanceof Error ? reason.message : String(reason),
        kind: 'unhandledrejection',
        ...(stack === undefined ? {} : { stack }),
      };
      emitError(payload);
    });
  };
  /**
   * A CSP violation is not a console call, and the browser never routes it through one.
   *
   * DevTools prints it, so a human reading the page sees dozens of them while
   * `reticle_assert({ kind: "console", level: "error", absent: true })` returns a confident pass.
   * That is a false green in the one place the product's claim rests, and
   * `securitypolicyviolation` exists precisely so a page can observe what the browser refused.
   *
   * `blockedURI` is empty for inline content, which is the common case for a script-src violation;
   * it is named rather than reported as a blocked empty string.
   */
  const onViolation = (event: SecurityPolicyViolationEvent): void => {
    const what = 0 === event.blockedURI.length ? 'inline content' : event.blockedURI;
    // A report-only policy blocked NOTHING: the browser ran the resource and only reported it, and
    // DevTools shows it as a warning. Calling it an error that "blocked" something would be a false
    // red against a page that works.
    const reportOnly = REPORT_ONLY === event.disposition;
    emit(reportOnly ? EventType.CONSOLE_WARN : EventType.CONSOLE_ERROR, {
      message: reportOnly
        ? `[Report Only] Content Security Policy directive: ${event.violatedDirective} would block ${what}`
        : `Content Security Policy directive: ${event.violatedDirective} blocked ${what}`,
      kind: CSP_VIOLATION_EVENT,
      ...(0 === event.blockedURI.length ? {} : { source: event.blockedURI }),
    });
  };
  // Capture phase: element `error` events do not bubble, so this is the only registration that
  // sees a failed subresource. Uncaught script errors reach a capturing window listener too, so one
  // registration covers both.
  // One controller for every window listener, so teardown cannot forget one of them.
  const listeners = new AbortController();
  const { signal } = listeners;
  window.addEventListener('error', onError, { capture: true, signal });
  window.addEventListener('unhandledrejection', onRejection, { signal });
  // Dispatched on `document` and it bubbles, so a window listener sees it; registered in the
  // capture phase alongside the others so a page that stops propagation on `document` cannot hide
  // one from us.
  window.addEventListener(CSP_VIOLATION_EVENT, onViolation, { capture: true, signal });

  return () => {
    for (const [method, original] of originals) {
      // Restore only if console[method] still holds Reticle's wrapper — a logging SDK (Sentry, LogRocket)
      // that wrapped console AFTER connect() must keep its instrumentation on teardown.
      if (console[method] === patched.get(method)) console[method] = original as typeof console.log;
    }
    listeners.abort();
  };
}
