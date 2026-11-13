/**
 * #1540: an app that fails before Reticle attaches showed an empty page and an empty console.
 *
 * The Vite plugin's inline buffer (PRE_ATTACH_ERRORS_SOURCE) keeps what the page raised before
 * `connect()`: the entry module's failed `<script>`, an uncaught error, a rejection, a
 * `console.error`. These tests build a buffer that behaves the same way by hand, because this package
 * cannot import the plugin; the plugin's own tests run the real inline source.
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

type Drain = (
  onError: (event: Event) => void,
  onRejection: (event: Event) => void,
  onConsole: (method: 'error', args: unknown[]) => void,
  dropped: (count: number) => void,
) => void;

interface FakeBuffer {
  open: boolean;
  drain: Drain;
}

/** A buffer with the plugin's behaviour: it listens on window until the SDK drains it. */
function installBuffer(limit = 50): FakeBuffer {
  let queue: ({ event: Event } | { args: unknown[] })[] = [];
  let dropped = 0;
  const keep = (item: { event: Event } | { args: unknown[] }): void => {
    if (!buffer.open) {
      return;
    }
    if (queue.length < limit) {
      queue.push(item);
    } else {
      dropped += 1;
    }
  };
  const onEvent = (event: Event): void => {
    keep({ event });
  };
  const buffer: FakeBuffer = {
    open: true,
    drain: (onError, onRejection, onConsole, setDropped) => {
      if (!buffer.open) {
        return;
      }
      const kept = queue;
      buffer.open = false;
      queue = [];
      window.removeEventListener('error', onEvent, true);
      window.removeEventListener('unhandledrejection', onEvent, true);
      kept.forEach((item, i) => {
        setDropped(0 === i ? dropped : 0);
        if ('args' in item) {
          onConsole('error', item.args);
        } else if ('unhandledrejection' === item.event.type) {
          onRejection(item.event);
        } else {
          onError(item.event);
        }
      });
    },
  };
  window.addEventListener('error', onEvent, true);
  window.addEventListener('unhandledrejection', onEvent, true);
  const nativeError = console.error;
  console.error = (...args: unknown[]): void => {
    keep({ args });
    nativeError(...args);
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
    expect(uncaught(events)).toHaveLength(1);

    const errors = uncaught(events);
    expect(errors[0]?.data['message']).toBe('<script> failed to load: /src/main.tsx');
    expect(errors[0]?.data['source']).toBe('/src/main.tsx');
    expect(errors[0]?.data[CONSOLE_EVENT.PRE_ATTACH]).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('reports an uncaught throw, a rejection and a console.error from before attach, in order', () => {
    installBuffer();
    throwUncaught('boom at import');
    rejectUnhandled(new Error('config fetch failed'));
    console.error('htmx:syntax:error', 'bad attribute');
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(events).toHaveLength(3);

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
    // Drained in the same call that installed the listeners: nothing raised from here on is kept.
    expect(buffer.open).toBe(false);

    throwUncaught('after');
    console.error('after, logged');
    failScript('/src/lazy-chunk.js');

    const byMessage = new Map(
      events.map((e) => [e.data['message'], e.data[CONSOLE_EVENT.PRE_ATTACH]]),
    );
    expect(events).toHaveLength(4);
    expect(byMessage).toEqual(
      new Map<unknown, unknown>([
        ['Uncaught Error: before', true],
        ['Uncaught Error: after', undefined],
        ['after, logged', undefined],
        ['<script> failed to load: /src/lazy-chunk.js', undefined],
      ]),
    );
  });

  it('reports the buffer once: a second connect on the same page reports none of it again', () => {
    installBuffer();
    failScript('/src/main.tsx');
    const first = collect();
    teardown = installConsole(first.emit);
    expect(uncaught(first.events)).toHaveLength(1);
    teardown();
    const second = collect();
    teardown = installConsole(second.emit);

    expect(uncaught(first.events)).toHaveLength(1);
    expect(second.events).toEqual([]);
  });

  it('reports nothing for a page that started cleanly, and still drains its buffer', () => {
    const buffer = installBuffer();
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(buffer.open).toBe(false);
    expect(events).toEqual([]);
    console.error('live');
    expect(events.map((e) => e.data)).toEqual([{ message: 'live' }]);
  });

  it('declares the errors the full buffer did not keep, on the first one it did', () => {
    installBuffer(2);
    for (let i = 0; i < 5; i += 1) {
      failScript(`/src/chunk-${String(i)}.js`);
    }
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(uncaught(events)).toHaveLength(2);

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
    ['an object with no drain()', { open: true }],
    ['a drain that is not a function', { drain: 'x' }],
    [
      'a drain() that throws',
      {
        drain: () => {
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
    expect(events.map((e) => e.data)).toEqual([{ message: 'live' }]);
  });

  it('marks only what arrives during the hand-over, even when the page keeps the callbacks', () => {
    let keptDropped: ((count: number) => void) | undefined;
    let keptConsole: ((method: 'error', args: unknown[]) => void) | undefined;
    const drain: Drain = (_onError, _onRejection, onConsole, setDropped) => {
      keptDropped = setDropped;
      keptConsole = onConsole;
    };
    holder[RETICLE_PRE_ATTACH_ERRORS] = { drain };
    const { emit, events } = collect();
    teardown = installConsole(emit);
    // The page calls what it kept, after attach.
    keptDropped?.(7);
    keptConsole?.('error', ['forged later']);
    console.error('after attach');
    throwUncaught('live throw');

    for (const event of events) {
      expect(event.data[CONSOLE_EVENT.PRE_ATTACH]).toBeUndefined();
      expect(event.data[CONSOLE_EVENT.DROPPED_PRE_ATTACH]).toBeUndefined();
    }
    expect(events.map((e) => e.data['message'])).toEqual([
      'forged later',
      'after attach',
      'Uncaught Error: live throw',
    ]);
  });

  it.each([
    ['a negative count', -3],
    ['a fraction', 1.5],
    ['a string', '7'],
    ['an object', { kind: 'forged' }],
  ])('takes only a positive integer as the dropped count, not %s', (_, count) => {
    const drain: Drain = (_onError, _onRejection, onConsole, setDropped) => {
      setDropped(count as number);
      onConsole('error', ['early']);
    };
    holder[RETICLE_PRE_ATTACH_ERRORS] = { drain };
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(events.map((e) => e.data)).toEqual([
      { [CONSOLE_EVENT.PRE_ATTACH]: true, message: 'early' },
    ]);
    expect(events[0]?.data[CONSOLE_EVENT.DROPPED_PRE_ATTACH]).toBeUndefined();
  });

  it('a page cannot add a field of its own to a pre-attach entry', () => {
    const drain = (
      _onError: unknown,
      _onRejection: unknown,
      onConsole: (method: 'error', args: unknown[]) => void,
      setDropped: (fields: unknown) => void,
    ): void => {
      setDropped({ kind: 'forged', message: 'forged' });
      onConsole('error', ['real']);
    };
    holder[RETICLE_PRE_ATTACH_ERRORS] = { drain };
    const { emit, events } = collect();
    teardown = installConsole(emit);
    expect(events).toHaveLength(1);
    expect(events[0]?.data['message']).toBe('real');
    expect(events[0]?.data['kind']).toBeUndefined();
    expect(events[0]?.data[CONSOLE_EVENT.PRE_ATTACH]).toBe(true);
  });
});
