import { EventType, TRANSPORT_LIMITS } from '@reticlehq/core';
import type { Emit, Teardown } from './types.js';
import { safeStringify } from '../security/serialization.js';
import { requireCapturedMethod } from '../util/captured-method.js';

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';

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
      // Only console.error carries a stack — the diagnosis case; log/warn stay lean.
      const stack = 'error' === method ? firstErrorStack(args) : undefined;
      emit(METHOD_EVENT[method], {
        message: stringifyArgs(args),
        ...(stack === undefined ? {} : { stack }),
      });
      callOriginal(...args);
    };
    patched.set(method, wrapper);
    console[method] = wrapper;
  }

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
      emit(EventType.ERROR_UNCAUGHT, {
        message: `<${tag}> failed to load${0 === url.length ? '' : `: ${url}`}`,
        kind: 'resource',
        ...(0 === url.length ? {} : { source: url }),
      });
      return;
    }
    const stack = capStack(event.error instanceof Error ? event.error.stack : undefined);
    emit(EventType.ERROR_UNCAUGHT, {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      ...(stack === undefined ? {} : { stack }),
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    const stack = capStack(reason instanceof Error ? reason.stack : undefined);
    emit(EventType.ERROR_UNCAUGHT, {
      message: reason instanceof Error ? reason.message : String(reason),
      kind: 'unhandledrejection',
      ...(stack === undefined ? {} : { stack }),
    });
  };
  // Capture phase: element `error` events do not bubble, so this is the only registration that
  // sees a failed subresource. Uncaught script errors reach a capturing window listener too, so one
  // registration covers both.
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    for (const [method, original] of originals) {
      // Restore only if console[method] still holds our wrapper — a logging SDK (Sentry, LogRocket)
      // that wrapped console AFTER connect() must keep its instrumentation on teardown.
      if (console[method] === patched.get(method)) console[method] = original as typeof console.log;
    }
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
