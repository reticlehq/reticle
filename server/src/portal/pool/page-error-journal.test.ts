/**
 * A module that throws at import time, before the SDK is injected, was invisible to the agent.
 *
 * The zero-install reader is evaluated after `goto` resolves, so an app whose own module graph
 * throws during that first navigation fired its `error` event into a page with no Reticle listener
 * in it. `reticle_console` then reported an unrelated 404 and a bare count, and the agent had to
 * re-run the page under headless Chrome with `--enable-logging` to learn why it was blank (#1966).
 *
 * The server owns the leased page's Playwright handle from BEFORE the navigation, so it is the one
 * witness that cannot miss the error. The journal here takes what the pool heard, buffers it for
 * the session that has not connected yet, and journals it as a console error with message and
 * stack — deduplicated against the SDK's own `error.uncaught` for the same exception.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { makePageErrorJournal, uncaughtIdentity } from './page-error-journal.js';
import type { JournalableSession } from './page-error-journal.js';
import type { PooledPageError } from './pool-contract.js';

/** A Session double: records pushed events and fans them out to `onEvent` listeners like the real one. */
const fakeSession = (id: string, url?: string): JournalableSession => {
  const events: ReticleEvent[] = [];
  const listeners: Array<(e: ReticleEvent) => void> = [];
  const push = (event: ReticleEvent): void => {
    events.push(event);
    for (const listener of listeners) {
      listener(event);
    }
  };
  return {
    id,
    ...(url === undefined ? {} : { url }),
    pushEvent: push,
    eventsSince(): ReticleEvent[] {
      return events;
    },
    onEvent(listener: (e: ReticleEvent) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
  };
};

const immediate = (): Promise<void> => Promise.resolve();
const MODULE_ERROR: PooledPageError = {
  message: 'boom at module evaluation',
  stack: 'Error: boom at module evaluation\n    at http://app.test/main.js:1:7',
};

const flush = async (): Promise<void> => {
  // The journal defers a tick before it journals (the dedupe window); tests pass a no-op sleep,
  // so one microtask turn is enough for every pending push to have settled.
  await Promise.resolve();
  await Promise.resolve();
};

describe('page errors the SDK never sees', () => {
  it('buffers an error thrown before the session connected, and flushes it when the session registers', async () => {
    // Holder, not a `let`: the resolver must see NOTHING until the session registers, which is
    // what makes the page error buffer instead of journaling straight through.
    const state: { session: JournalableSession | undefined } = { session: undefined };
    const journal = makePageErrorJournal({ resolveSession: () => state.session, sleep: immediate });
    journal.onPoolPageError('lease-1', MODULE_ERROR);

    // The leased tab's URL carries the lease marker — that is how the session is found.
    const session = fakeSession('sess-1', 'http://app.test/?__reticle_session=lease-1');
    state.session = session;
    journal.onSessionCreate(session);
    await flush();

    expect(session.eventsSince(0)).toHaveLength(1);
    const event = session.eventsSince(0)[0];
    if (event === undefined) {
      throw new Error('expected one journaled event');
    }
    expect(event.type).toBe(EventType.CONSOLE_ERROR);
    expect(event.sessionId).toBe('sess-1');
    expect(event.data['message']).toBe('boom at module evaluation');
    expect(event.data['kind']).toBe('pageerror');
    expect(event.data['stack']).toContain('http://app.test/main.js:1:7');
    // The source the issue asks for: the agent reads file:line, not a bare message.
    expect(event.data['source']).toBe('http://app.test/main.js');
    expect(event.data['line']).toBe(1);
  });

  it('journals an error on a session that is already connected', async () => {
    const session = fakeSession('sess-1');
    const journal = makePageErrorJournal({ resolveSession: () => session, sleep: immediate });
    journal.onSessionCreate(session);

    journal.onPoolPageError('lease-1', MODULE_ERROR);
    await flush();

    const events = session.eventsSince(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.data['message']).toBe('boom at module evaluation');
  });

  it('skips its copy when the SDK already reported the same exception', async () => {
    const session = fakeSession('sess-1');
    const journal = makePageErrorJournal({ resolveSession: () => session, sleep: immediate });
    journal.onSessionCreate(session);
    // The SDK reports through the session's own ingest path, which fans out to subscribers.
    session.pushEvent({
      t: 1,
      type: EventType.ERROR_UNCAUGHT,
      sessionId: 'sess-1',
      data: {
        message: 'Uncaught Error: boom at module evaluation',
        source: 'http://app.test/main.js',
        line: 1,
      },
    });

    journal.onPoolPageError('lease-1', MODULE_ERROR);
    await flush();

    expect(session.eventsSince(0)).toHaveLength(1);
  });

  it('keeps a bounded buffer and says how many it dropped', async () => {
    const state: { session: JournalableSession | undefined } = { session: undefined };
    const journal = makePageErrorJournal({ resolveSession: () => state.session, sleep: immediate });
    for (let i = 0; i < 10; i += 1) {
      journal.onPoolPageError('lease-1', { message: `boom ${String(i)}` });
    }

    const session = fakeSession('sess-1', 'http://app.test/?__reticle_session=lease-1');
    state.session = session;
    journal.onSessionCreate(session);
    await flush();

    const events = session.eventsSince(0);
    expect(events).toHaveLength(8);
    expect(events[0]?.data['droppedPageErrors']).toBe(2);
    expect(events[0]?.data['message']).toBe('boom 2');
  });

  it("drops a lease's buffer when the lease is released — a session that never connects must not leave it behind", async () => {
    const state: { session: JournalableSession | undefined } = { session: undefined };
    const journal = makePageErrorJournal({ resolveSession: () => state.session, sleep: immediate });
    journal.onPoolPageError('lease-1', MODULE_ERROR);
    journal.onLeaseClosed('lease-1');

    // A session for the same lease connects LATER (a retry); nothing from the dead lease may
    // flush into it.
    state.session = fakeSession('sess-1', 'http://app.test/?__reticle_session=lease-1');
    journal.onSessionCreate(state.session);
    await flush();

    expect(state.session.eventsSince(0)).toHaveLength(0);
  });

  it("forgets a session's identities when the session ends, so its dedupe memory does not outlive it", async () => {
    const session = fakeSession('sess-1');
    const journal = makePageErrorJournal({ resolveSession: () => session, sleep: immediate });
    journal.onSessionCreate(session);
    session.pushEvent({
      t: 1,
      type: EventType.ERROR_UNCAUGHT,
      sessionId: 'sess-1',
      data: { message: 'Uncaught Error: boom at module evaluation' },
    });
    journal.onSessionEnd('sess-1');

    // The same throw arrives again through the pool after the end — a NEW session for the same
    // app reuses the id space only by coincidence; the old memory must not suppress it.
    journal.onPoolPageError('lease-1', MODULE_ERROR);
    await flush();

    const consoleEvents = session.eventsSince(0).filter((e) => e.type === EventType.CONSOLE_ERROR);
    expect(consoleEvents).toHaveLength(1);
  });

  it('reads one identity out of both the browser and the SDK spelling of the same throw', () => {
    expect(uncaughtIdentity('Uncaught Error: boom at module evaluation')).toBe(
      'boom at module evaluation',
    );
    expect(uncaughtIdentity('Error: boom at module evaluation')).toBe('boom at module evaluation');
    expect(uncaughtIdentity('boom at module evaluation')).toBe('boom at module evaluation');
    expect(uncaughtIdentity('Uncaught TypeError: x is not a function')).toBe('x is not a function');
  });
});

describe('a native dialog the leased-tab pool dismissed', () => {
  it('is journaled as dialog.opened with the declining answer, so the verdict can read it', () => {
    const session = fakeSession('lease-1');
    const journal = makePageErrorJournal({ resolveSession: () => session, sleep: immediate });

    journal.onPoolDialog('lease-1', { kind: 'confirm', message: 'Delete?' });
    journal.onPoolDialog('lease-1', { kind: 'prompt', message: 'Name?' });
    journal.onPoolDialog('lease-1', { kind: 'alert', message: 'Saved' });
    journal.onPoolDialog('lease-1', { kind: 'beforeunload', message: '' });
    journal.onPoolDialog('lease-1', { kind: 'toString', message: '' });

    const dialogs = session.eventsSince(0).filter((e) => e.type === EventType.DIALOG_OPENED);
    expect(dialogs.map((e) => e.data)).toEqual([
      { kind: 'confirm', message: 'Delete?', answered: false },
      { kind: 'prompt', message: 'Name?', answered: null },
      { kind: 'alert', message: 'Saved' },
    ]);
  });

  it('is dropped when no session is connected for the lease yet: no window can hold it', () => {
    const journal = makePageErrorJournal({ resolveSession: () => undefined, sleep: immediate });
    expect(() => journal.onPoolDialog('lease-1', { kind: 'confirm', message: 'x' })).not.toThrow();
  });
});
