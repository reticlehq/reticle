import { afterEach, describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions as hunt } from './contradictions.js';
import { registerContradictionFold, registeredContradictionFolds } from './contradiction-folds.js';

const findContradictions = (
  events: readonly ReticleEvent[],
  options: Parameters<typeof hunt>[1] = {},
): ReturnType<typeof hunt> => hunt(events, { actionSince: 0, ...options });

/**
 * A consumer may add its own rule to the verdict, without editing the ones this package ships.
 *
 * Every rule here is a pure fold over a recording: events in, findings out, no session, no clock, no
 * IO. That is exactly the shape a service embedding this engine wants for rules of its own — and the
 * only thing standing between it and one was that `findContradictions` reads a fixed list of folds
 * written into the function body. Appending to that list means editing this file, which means a fork,
 * which means the consumer's rules and this package's own become one tree that has to be
 * merged forever.
 *
 * A registry rather than a parameter, because there are six call sites and none of them are reached
 * by the consumer: the tools call `findContradictions` internally, and a tool handler is handed a
 * deps bag, not options. Threading a parameter would mean touching every path a verdict can take and
 * would still miss the ones inside `crawl`. Registration is once, at boot, by whoever composed the
 * process.
 */

const unregisters: (() => void)[] = [];

function register(fold: Parameters<typeof registerContradictionFold>[0]): void {
  unregisters.push(registerContradictionFold(fold));
}

afterEach(() => {
  // A registry that leaked between tests would make each one depend on the order it ran in.
  while (unregisters.length > 0) unregisters.pop()?.();
});

const CONSUMER_KIND = 'consumer-rule-fired';

function consoleEvent(text: string, t: number): ReticleEvent {
  return { type: EventType.CONSOLE_ERROR, t, data: { text } } as unknown as ReticleEvent;
}

describe('registered contradiction folds', () => {
  it('contributes findings alongside the rules this package ships', () => {
    register((events) =>
      events.some((e) => e.type === EventType.CONSOLE_ERROR)
        ? [
            {
              kind: CONSUMER_KIND,
              claim: 'the consumer rule saw something',
              counter: 'and said so',
              detail: 'evidence',
            },
          ]
        : [],
    );

    const found = findContradictions([consoleEvent('boom', 1)]);

    expect(found.map((f) => f.kind)).toContain(CONSUMER_KIND);
  });

  it('stays silent when nothing is registered', () => {
    expect(registeredContradictionFolds()).toEqual([]);
    expect(findContradictions([consoleEvent('boom', 1)])).toEqual([]);
  });

  it('unregisters, so a consumer can take its rule back out', () => {
    const undo = registerContradictionFold(() => [
      { kind: CONSUMER_KIND, claim: 'a', counter: 'b', detail: 'c' },
    ]);
    expect(findContradictions([]).map((f) => f.kind)).toContain(CONSUMER_KIND);

    undo();

    expect(findContradictions([]).map((f) => f.kind)).not.toContain(CONSUMER_KIND);
  });

  it('survives a fold that throws, because a verdict is not a consumer rule to lose', () => {
    // The trust boundary that matters. A registered fold is somebody else's code running inside every
    // verdict path this package has. If its bug could propagate, one defect in a consumer's oracle
    // would take down `assert`, `act_and_wait`, `observe` and `crawl` at once — turning a missing
    // finding into a dead engine. It is contained, and the rules that DID run still report.
    register(() => {
      throw new Error('consumer rule is broken');
    });
    register(() => [{ kind: CONSUMER_KIND, claim: 'a', counter: 'b', detail: 'c' }]);

    const found = findContradictions([]);

    expect(found.map((f) => f.kind)).toEqual([CONSUMER_KIND]);
  });

  it('sees the same events the shipped rules see — dev tooling already removed', () => {
    // Folds run over the app's own traffic, not the toolchain's. A consumer rule that reported on
    // Vite's HMR socket would be reporting on the dev server, and the shipped rules all agree on
    // this split already — a second answer to "which events count" is a second product.
    let seen: readonly ReticleEvent[] = [];
    register((events) => {
      seen = events;
      return [];
    });

    const appRequest = {
      type: EventType.NET_REQUEST,
      t: 2,
      data: { method: 'GET', url: 'https://app.test/api/items', status: 200, ok: true },
    } as unknown as ReticleEvent;
    const hmr = {
      type: EventType.NET_REQUEST,
      t: 1,
      data: { method: 'GET', url: 'http://localhost:5173/@vite/client', status: 200, ok: true },
    } as unknown as ReticleEvent;

    findContradictions([hmr, appRequest], { pageUrl: 'https://app.test/' });

    expect(seen.map((e) => String((e.data as { url?: unknown }).url))).toEqual([
      'https://app.test/api/items',
    ]);
  });

  it('passes the options the shipped rules were given', () => {
    let seenAction: string | undefined;
    register((_events, options) => {
      seenAction = options.action;
      return [];
    });

    findContradictions([], { action: 'click #save' });

    expect(seenAction).toBe('click #save');
  });
});
