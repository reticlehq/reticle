import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installConsole } from '../observers/console.js';
import type { Emit, Teardown } from '../observers/types.js';
import { nativeWarn } from './native-console.js';

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

describe('nativeWarn — SDK-internal diagnostics bypass the observer', () => {
  let teardown: Teardown | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    warnSpy.mockRestore();
  });

  it('nativeWarn does NOT emit a CONSOLE_WARN event through the patched observer', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    nativeWarn('[reticle] bridge refused the connection — not retrying.');

    expect(events.filter((e) => e.type === EventType.CONSOLE_WARN)).toHaveLength(0);
  });

  it('nativeWarn still reaches the real console (developer sees it)', () => {
    const { emit } = collect();
    teardown = installConsole(emit);

    // After installConsole, console.warn is the patched wrapper. nativeWarn bypasses it
    // and calls through the original bound reference — which IS the real console.warn.
    // Verify by checking nativeWarn does NOT resolve to the patched wrapper (it's pre-bound).
    expect(nativeWarn).not.toBe(console.warn);

    // And it runs without throwing — reaching the underlying console output.
    expect(() => nativeWarn('[reticle] unreachable after 5 attempts')).not.toThrow();
  });

  it('bare console.warn DOES emit CONSOLE_WARN (the bug this fix prevents)', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    console.warn('[reticle] this should be captured');

    expect(events.filter((e) => e.type === EventType.CONSOLE_WARN)).toHaveLength(1);
  });
});
