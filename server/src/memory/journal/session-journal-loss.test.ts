import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import {
  EventType,
  JOURNAL_FILE_VERSION,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  RING_BUFFER_DEFAULTS,
  TruncationChannel,
  type HelloMessage,
  type JournalWriteLoss,
  type ReticleEvent,
} from '@reticlehq/core';
import * as logModule from '@/log.js';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { Session } from '@/portal/session/session.js';
import { JournalRecorder, type JournalReader, type JournalSink } from './journal-recorder.js';
import { SessionJournal } from './session-journal.js';

/**
 * A closed ledger has to reach the thing that grades evidence, not just the file it stopped writing.
 *
 * The in-band `truncated` record is a real declaration and an insufficient one: it carries the `t`
 * of the last refused event, and every journal-backed query filters on `t`. A window opened after
 * the cap was hit therefore contains no marker, no events from after the cap, and nothing that
 * distinguishes it from a window in which nothing happened. That is a durable partial answer an
 * agent cannot tell apart from a complete one — the exact shape this project calls a false green.
 *
 * `Session.journalWriteLoss` is the out-of-band half. It reports only when a query for this session
 * actually READS the journal, which is the same condition `queryEvents` uses to fall through to it:
 * while the buffer still holds the window, the ledger's state says nothing about that window's
 * completeness and claiming otherwise would impeach healthy verdicts for free.
 */

function hello(): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: 'demo',
    url: 'http://localhost/',
    title: 'Demo',
    adapters: [],
  };
}

const noopSocket = { send: () => undefined, close: () => undefined } as unknown as WebSocket;
const noopSink: JournalSink = {
  appendEvents: () => Promise.resolve(),
  appendAction: () => Promise.resolve(),
};

function evt(seq: number): ReticleEvent {
  return { t: seq, seq, type: EventType.DOM_ADDED, sessionId: 'demo', data: {} };
}

const LOSS: JournalWriteLoss = {
  v: JOURNAL_FILE_VERSION,
  channel: TruncationChannel.JOURNAL,
  capBytes: 4096,
  bytesOnDisk: 4010,
  droppedInBatch: 8,
  at: 900,
};

function newSession(reader: JournalReader): Session {
  const session = new Session(hello(), noopSocket, () => 0);
  session.setJournal(new JournalRecorder(noopSink, { now: () => session.elapsed() }), reader);
  return session;
}

/** Push past the ring buffer's count cap, which is what makes queries fall through to the journal. */
function evictBuffer(session: Session): void {
  for (let i = 0; i <= RING_BUFFER_DEFAULTS.MAX_EVENTS; i += 1) session.pushEvent(evt(i));
}

describe('Session.journalWriteLoss', () => {
  const reader = (loss?: JournalWriteLoss): JournalReader => ({
    readEvents: () => Promise.resolve([]),
    readWriteLoss: () => Promise.resolve(loss),
  });

  it('reports the ledger closure once queries read the journal', async () => {
    const session = newSession(reader(LOSS));
    evictBuffer(session);
    expect(await session.journalWriteLoss()).toEqual(LOSS);
  });

  it('stays silent while the buffer still holds the window', async () => {
    // Nothing has been read from disk, so the ledger's state says nothing about this window. A
    // report here would impeach every verdict on every session that ever hit its ceiling, forever.
    const session = newSession(reader(LOSS));
    session.pushEvent(evt(0));
    expect(await session.journalWriteLoss()).toBeUndefined();
  });

  it('stays silent when the journal never closed', async () => {
    const session = newSession(reader(undefined));
    evictBuffer(session);
    expect(await session.journalWriteLoss()).toBeUndefined();
  });

  it('stays silent for a reader that cannot answer the question', async () => {
    // `readWriteLoss` is optional on JournalReader for the same reason `readActions` is: a partial
    // test double must not have to grow a method it has no opinion about. An absent answer is "not
    // measured", and must never be dressed up as "no loss happened" by throwing instead.
    const session = newSession({ readEvents: () => Promise.resolve([]) });
    evictBuffer(session);
    expect(await session.journalWriteLoss()).toBeUndefined();
  });

  it('stays silent when the session journals nowhere at all', async () => {
    const session = new Session(hello(), noopSocket, () => 0);
    evictBuffer(session);
    expect(await session.journalWriteLoss()).toBeUndefined();
  });
});

/**
 * The seam itself, with nothing faked between the file and the session.
 *
 * Every case above stubs the reader, which proves the RULE and not the WIRING — and the wiring is
 * exactly what goes quietly missing: `makeJournalAttach` hands one `SessionJournal` to the session
 * as both sink and reader, so a method that exists on the class and not on the interface (or the
 * reverse) fails by doing nothing at all. A real ledger, a real temp directory, a real session.
 */
describe('a real capped ledger reaches a real session', () => {
  /** Smaller than one batch below, so a single append is refused and closes the ledger. */
  const TINY_CAP_BYTES = 256;
  /** Events in the one refused batch — comfortably past `TINY_CAP_BYTES` at ~70 bytes a line. */
  const OVERFLOW_EVENTS = 40;

  it('reports the closure that a real SessionJournal wrote', async () => {
    vi.spyOn(logModule, 'log').mockImplementation(() => undefined);
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-seam-'));
    try {
      const root = join(dir, '.reticle');
      const journal = new SessionJournal(createNodeFileSystem(), root, 'demo', {
        eventBytesCap: TINY_CAP_BYTES,
      });
      const overflowing: ReticleEvent[] = [];
      for (let i = 0; i < OVERFLOW_EVENTS; i += 1) overflowing.push(evt(i));
      await journal.appendEvents(overflowing);

      const session = newSession(journal);
      evictBuffer(session);
      const loss = await session.journalWriteLoss();
      expect(loss?.channel).toBe(TruncationChannel.JOURNAL);
      expect(loss?.capBytes).toBe(TINY_CAP_BYTES);
      expect(loss?.droppedInBatch).toBe(OVERFLOW_EVENTS);
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });

  it('still answers queries from the live ring buffer over a closed ledger', async () => {
    // The cap must not cost a session the evidence it still HAS. Nothing in memory is discarded
    // because a file stopped accepting writes; the ledger's closure is a caveat on the verdict, not
    // a reason to stop answering.
    vi.spyOn(logModule, 'log').mockImplementation(() => undefined);
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-live-'));
    try {
      const root = join(dir, '.reticle');
      const journal = new SessionJournal(createNodeFileSystem(), root, 'demo', {
        eventBytesCap: TINY_CAP_BYTES,
      });
      const overflowing: ReticleEvent[] = [];
      for (let i = 0; i < OVERFLOW_EVENTS; i += 1) overflowing.push(evt(i));
      await journal.appendEvents(overflowing);

      const session = newSession(journal);
      evictBuffer(session);
      const live = RING_BUFFER_DEFAULTS.MAX_EVENTS;
      expect((await session.queryEvents({})).some((e) => e.seq === live)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });
});
