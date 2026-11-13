/**
 * #1540: an app that fails before Reticle attaches showed an empty page and an empty console.
 *
 * The Vite plugin's inline buffer (PRE_ATTACH_ERRORS_SOURCE) keeps what the page raised before
 * `connect()`: the entry module's failed `<script>`, an uncaught error, a rejection, a
 * `console.error`. These tests build a buffer of the same shape by hand, because this package cannot
 * import the plugin; the plugin's own tests run the real inline source.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CONSOLE_EVENT, EventType, RETICLE_PRE_ATTACH_ERRORS } from '@reticlehq/core';
import { installConsole } from './console.js';
import type { Emit, Teardown } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

const holder = globalThis as unknown as Record<string, unknown>;

interface FakeBuffer {
  queue: unknown[];
  dropped: number;
  open: boolean;
  close: () => void;
}

/** A buffer with the plugin's shape and behaviour: it listens on window until it is closed. */
function installBuffer(limit = 50): FakeBuffer {
  const buffer: FakeBuffer = { queue: [], dropped: 0, open: true, close: () => undefined };
  const keep = (item: unknown): void => {
    if (!buffer.open) {
      return;
    }
    if (buffer.queue.length < limit) {
      buffer.queue.push(item);
    } else {
      buffer.dropped += 1;
    }
  };
  const onEvent = (event: Event): void => {
    keep({ event });
  };
  window.addEventListener('error', onEvent, true);
  window.addEventListener('unhandledrejection', onEvent, true);
  const nativeError = console.error;
  console.error = (...args: unknown[]): void => {
    keep({ args });
    nativeError(...args);
  };
  buffer.close = () => {
    buffer.open = false;
    buffer.queue = [];
    window.removeEventListener('error', onEvent, true);
    window.removeEventListener('unhandledrejection', onEvent, true);
  };
  holder[RETICLE_PRE_ATTACH_ERRORS] = buffer;
  return buffer;
}

/** A `<script>` whose src failed to load, dispatched exactly as the browser does: not bubbling. */
function failScript(src: string): void {
  const el = document.createElement('script');
  el.setAttribute('type', 'module');
  el.setAttribute('src', src);
  document.body.appendChild(el);
  el.dispatchEvent(new Event('error', { bubbles: false, cancelable: false }));
}

function throwUncaught(message: string): void {
  window.dispatchEvent(
    new ErrorEvent('error', {
      message: `Uncaught Error: ${message}`,
      filename: 'http://localhost:5173/src/main.ts',
      lineno: 3,
      error: new Error(message),
    }),
  );
}

function rejectUnhandled(reason: unknown): void {
  // jsdom has no PromiseRejectionEvent; the observer reads only `reason`.
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
}

const uncaught = (events: Emitted[]): Emitted[] =>
  events.filter((e) => EventType.ERROR_UNCAUGHT === e.type);

describe('errors raised before the SDK attached (#1540)', () => {
  let teardown: Teardown | undefined;
  const nativeError = console.error;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    console.error = nativeError;
    delete holder[RETICLE_PRE_ATTACH_ERRORS];
    document.body.innerHTML = '';
  });

  it('reports an entry module that failed to load before attach, marked pre-attach', () => {
    installBuffer();
    failScript('/src/main.tsx');
    const { emit, events } = collect();
    teardown = installConsole(emit);

    const errors = uncaught(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data['message']).toBe('<script> failed to load: /src/main.tsx');
    expect(errors[0]?.data['source']).toBe('/src/main.tsx');
    expect(errors[0]?.data[CONSOLE_EVENT.PRE_ATTACH]).toBe(true);
  });

  it('reports an uncaught throw, a rejection and a console.error from before attach, in order', () => {
    installBuffer();
    throwUncaught('boom at import');
    rejectUnhandled(new Error('config fetch failed'));
    console.error('htmx:syntax:error', 'bad attribute');
    const { emit, events } = collect();
    teardown = installConsole(emit);

    expect(events.map((e) => e.type)).toEqual([
      EventType.ERROR_UNCAUGHT,
      EventType.ERROR_UNCAUGHT,
      EventType.CONSOLE_ERROR,
    ]);
    expect(events[0]?.data['message']).toBe('Uncaught Error: boom at import');
    expect(events[0]?.data['line']).toBe(3);
    expect(String(events[0]?.data['stack'])).toContain('boom at import');
    expect(events[1]?.data['message']).toBe('config fetch failed');
    expect(events[1]?.data['kind']).toBe('unhandledrejection');
    expect(events[2]?.data['message']).toBe('htmx:syntax:error bad attribute');
    for (const event of events) {
      expect(event.data[CONSOLE_EVENT.PRE_ATTACH]).toBe(true);
    }
  });

  it('reports nothing twice: an error after attach is reported once, and not as pre-attach', () => {
    const buffer = installBuffer();
    throwUncaught('before');
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(buffer.open).toBe(false);

    throwUncaught('after');
    console.error('after, logged');
    failScript('/src/lazy-chunk.js');

    expect(events.map((e) => e.data['message'])).toEqual([
      'Uncaught Error: before',
      'Uncaught Error: after',
      'after, logged',
      '<script> failed to load: /src/lazy-chunk.js',
    ]);
    expect(events.map((e) => e.data[CONSOLE_EVENT.PRE_ATTACH])).toEqual([
      true,
      undefined,
      undefined,
      undefined,
    ]);
    expect(buffer.queue).toEqual([]);
  });

  it('reports the buffer once: a second connect on the same page reports none of it again', () => {
    installBuffer();
    failScript('/src/main.tsx');
    const first = collect();
    teardown = installConsole(first.emit);
    teardown();
    const second = collect();
    teardown = installConsole(second.emit);

    expect(uncaught(first.events)).toHaveLength(1);
    expect(second.events).toEqual([]);
  });

  it('declares the errors the full buffer did not keep, on the first one it did', () => {
    installBuffer(2);
    for (let i = 0; i < 5; i += 1) {
      failScript(`/src/chunk-${String(i)}.js`);
    }
    const { emit, events } = collect();
    teardown = installConsole(emit);

    const errors = uncaught(events);
    expect(errors.map((e) => e.data['source'])).toEqual(['/src/chunk-0.js', '/src/chunk-1.js']);
    expect(errors[0]?.data[CONSOLE_EVENT.DROPPED_PRE_ATTACH]).toBe(3);
    expect(errors[1]?.data[CONSOLE_EVENT.DROPPED_PRE_ATTACH]).toBeUndefined();
  });

  it('reports nothing extra on a page with no buffer (no build plugin)', () => {
    failScript('/src/main.tsx');
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(events).toEqual([]);
  });

  it.each([
    ['a string', 'not a buffer'],
    ['a closed buffer', { open: false, queue: [{ args: ['x'] }], dropped: 0 }],
    ['a queue that is not an array', { open: true, queue: 'x', dropped: 'y' }],
    ['entries of the wrong shape', { open: true, queue: [1, null, { event: {} }, { args: 'x' }] }],
    [
      'a close() that throws',
      {
        open: true,
        queue: [],
        close: () => {
          throw new Error('hostile');
        },
      },
    ],
  ])('a page global that is %s gives nothing and does not break the observer', (_, value) => {
    holder[RETICLE_PRE_ATTACH_ERRORS] = value;
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(events).toEqual([]);
    console.error('live');
    expect(events.map((e) => e.data['message'])).toEqual(['live']);
  });
});
