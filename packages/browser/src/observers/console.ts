/* eslint-disable no-console -- this module's whole purpose is to wrap console.{log,warn,error} */
import { EventType } from '@syrin/protocol';
import type { Emit, Teardown } from './types.js';

type ConsoleMethod = 'log' | 'warn' | 'error';

const METHOD_EVENT: Record<ConsoleMethod, EventType> = {
  log: EventType.CONSOLE_LOG,
  warn: EventType.CONSOLE_WARN,
  error: EventType.CONSOLE_ERROR,
};

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/** Patch console.{log,warn,error} and window error events. Reversible. */
export function installConsole(emit: Emit): Teardown {
  const methods: ConsoleMethod[] = ['log', 'warn', 'error'];
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    originals.set(method, original);
    console[method] = (...args: unknown[]): void => {
      emit(METHOD_EVENT[method], { message: stringifyArgs(args) });
      original(...args);
    };
  }

  const onError = (event: ErrorEvent): void => {
    emit(EventType.ERROR_UNCAUGHT, {
      message: event.message,
      source: event.filename,
      line: event.lineno,
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    emit(EventType.ERROR_UNCAUGHT, {
      message: reason instanceof Error ? reason.message : String(reason),
      kind: 'unhandledrejection',
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    for (const [method, original] of originals) {
      console[method] = original as typeof console.log;
    }
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
