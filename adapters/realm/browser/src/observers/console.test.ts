import { describe, it, expect, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
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

describe('installConsole', () => {
  let teardown: Teardown | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits CONSOLE_ERROR and still forwards to the original console', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    console.error('boom', 42);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.CONSOLE_ERROR);
    expect(events[0]?.data['message']).toBe('boom 42');
  });

  it('captures the stack of an Error argument to console.error', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    console.error('failed:', new Error('kaboom'));

    expect(events[0]?.type).toBe(EventType.CONSOLE_ERROR);
    expect(typeof events[0]?.data['stack']).toBe('string');
    expect(events[0]?.data['stack']).toContain('kaboom');
  });

  it('does not attach a stack when console.error has no Error argument', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    console.error('just a string');

    expect(events[0]?.data['stack']).toBeUndefined();
  });

  it('captures console.info and console.debug lean (no stack), excluded from summaries downstream', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    // Reach the methods via globalThis so this test never trips the no-console lint rule.
    const c = globalThis.console;
    c.info('info line', 1);
    c.debug('debug line');

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe(EventType.CONSOLE_INFO);
    expect(events[0]?.data['message']).toBe('info line 1');
    expect(events[0]?.data['stack']).toBeUndefined();
    expect(events[1]?.type).toBe(EventType.CONSOLE_DEBUG);
    expect(events[1]?.data['message']).toBe('debug line');
  });

  it('restores the original console methods (identity) on teardown', () => {
    const beforeLog = console.log;
    const beforeWarn = console.warn;
    const beforeError = console.error;
    const t = installConsole(collect().emit);
    expect(console.error).not.toBe(beforeError);
    t();
    expect(console.log).toBe(beforeLog);
    expect(console.warn).toBe(beforeWarn);
    expect(console.error).toBe(beforeError);
  });
});

/**
 * A failed subresource is an error the browser writes to the console and `console.error` never sees.
 *
 * `<img src=missing.png>`, a 404 stylesheet, a script that will not load — the browser reports each
 * on the console, and none of them goes through a console method. They fire an `error` event on the
 * ELEMENT, and element error events do not bubble, so a listener registered on `window` in the
 * bubble phase never runs. Ours was, so `console absent` came back green on pages visibly full of
 * red — the single most-advertised assertion returning a confident false pass.
 *
 * Capture phase is the whole fix: a capturing `window` listener sees an event that never bubbles.
 */
describe('browser-emitted resource failures reach the console channel', () => {
  let teardown: Teardown | undefined;
  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  /** An element `error` event, exactly as the browser dispatches one for a failed subresource. */
  const dispatchResourceError = (tag: string, url: string): void => {
    const el = document.createElement(tag);
    el.setAttribute('src', url);
    document.body.appendChild(el);
    // `bubbles: false` is not a detail — it is the property that made the old listener blind.
    el.dispatchEvent(new Event('error', { bubbles: false, cancelable: false }));
    el.remove();
  };

  it('captures an image that failed to load', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);
    dispatchResourceError('img', 'https://example.test/missing.png');
    const uncaught = events.filter((e) => e.type === EventType.ERROR_UNCAUGHT);
    expect(uncaught, 'a failed subresource must not be invisible').toHaveLength(1);
    expect(String(uncaught[0]?.data['message'])).toContain('missing.png');
  });

  it('names the element so the message is actionable, not just "error"', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);
    dispatchResourceError('script', 'https://example.test/vendor.js');
    const message = String(
      events.find((e) => e.type === EventType.ERROR_UNCAUGHT)?.data['message'],
    );
    expect(message.toLowerCase()).toContain('script');
    expect(message).toContain('vendor.js');
  });

  it('does not double-report a script error that also fires as a real ErrorEvent', () => {
    // A script that LOADS and then throws produces an ErrorEvent with `message` and `error` set. It
    // is already captured on the uncaught path, and must not be counted twice by the resource rule.
    const { emit, events } = collect();
    teardown = installConsole(emit);
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', error: new Error('boom'), bubbles: false }),
    );
    expect(events.filter((e) => e.type === EventType.ERROR_UNCAUGHT)).toHaveLength(1);
  });

  it('stops reporting after teardown', () => {
    const { emit, events } = collect();
    installConsole(emit)();
    dispatchResourceError('img', 'https://example.test/missing.png');
    expect(events.filter((e) => e.type === EventType.ERROR_UNCAUGHT)).toHaveLength(0);
  });
});

describe('CSP violations reach the console channel', () => {
  let teardown: Teardown | undefined;
  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  /**
   * `securitypolicyviolation` as the browser dispatches it. Constructed rather than provoked: a
   * real violation needs a CSP header the test environment cannot set, and the shape is what the
   * listener reads.
   */
  const dispatchViolation = (violatedDirective: string, blockedURI: string): void => {
    const event = new Event('securitypolicyviolation', { bubbles: true, cancelable: false });
    Object.assign(event, { violatedDirective, blockedURI });
    document.dispatchEvent(event);
  };

  it('reports a blocked subresource that no console method ever sees', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    dispatchViolation('script-src', 'https://cdn.example.test/analytics.js');

    const errors = events.filter((e) => e.type === EventType.CONSOLE_ERROR);
    expect(errors, 'DevTools prints this; an absent-console assertion must not pass').toHaveLength(
      1,
    );
    expect(String(errors[0]?.data['message'])).toContain('analytics.js');
    expect(String(errors[0]?.data['message'])).toContain('script-src');
    expect(errors[0]?.data['kind']).toBe('securitypolicyviolation');
    expect(errors[0]?.data['source']).toBe('https://cdn.example.test/analytics.js');
  });

  it('names inline content rather than reporting a blocked empty string', () => {
    // `blockedURI` is '' for inline script/style, which is the common script-src violation. A bare
    // interpolation would read "blocked " and say nothing about what was refused.
    const { emit, events } = collect();
    teardown = installConsole(emit);

    dispatchViolation('script-src', '');

    const error = events.find((e) => e.type === EventType.CONSOLE_ERROR);
    expect(String(error?.data['message'])).toContain('inline content');
    expect(error?.data).not.toHaveProperty('source');
  });

  it('stops reporting after teardown', () => {
    const { emit, events } = collect();
    installConsole(emit)();

    dispatchViolation('img-src', 'https://example.test/pixel.gif');

    expect(events.filter((e) => e.type === EventType.CONSOLE_ERROR)).toHaveLength(0);
  });
});
