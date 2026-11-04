/**
 * Journal loss reaches the verdict, through the channel ring-buffer loss already uses.
 *
 * `Session.lostSince` is the one honest input to "was the capture clean" — `assert-verdict.ts` turns
 * it into `honesty.integrity.losses: ["buffer_loss"]` and can downgrade an absence claim to
 * `unknown` over it. The durable journal is the ledger the ring buffer is a hot cache over, so when
 * the journal cannot reach back as far as the window being judged, the session has lost evidence for
 * that window exactly as if the buffer had evicted it. Reported only through the `readLoss()` report
 * on the reader, that fact would live where no agent can see it.
 *
 * The boundary is INCLUSIVE, matching `RingBuffer.lostSince` (`lastScarceLossT >= cursor`), and for
 * the same reason: `t` is an elapsed MILLISECOND, and many events share one. A window opened at the
 * same millisecond a record was lost at is not a window this reader answered in full.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventType, type JournalAction, type ReticleEvent } from '@reticlehq/core';
import { JournalRecorder, type JournalReadLoss } from '@/memory/journal/journal-recorder.js';
import { SessionJournal } from '@/memory/journal/session-journal.js';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { createFakeSession } from './fake-session.js';

const INERT_SINK = {
  appendEvents: (): Promise<void> => Promise.resolve(),
  appendAction: (): Promise<void> => Promise.resolve(),
};

/** A reader that holds no events and declares whatever loss the test is about. */
function readerDeclaring(loss: JournalReadLoss | undefined): {
  readEvents: () => Promise<ReticleEvent[]>;
  readActions: () => Promise<JournalAction[]>;
  readLoss: () => JournalReadLoss | undefined;
} {
  return {
    readEvents: () => Promise.resolve([]),
    readActions: () => Promise.resolve([]),
    readLoss: () => loss,
  };
}

function sessionWithLoss(loss: JournalReadLoss | undefined): ReturnType<typeof createFakeSession> {
  const session = createFakeSession();
  session.setJournal(new JournalRecorder(INERT_SINK, { now: () => 0 }), readerDeclaring(loss));
  return session;
}

describe('Session.lostSince — the durable journal half', () => {
  const lostThrough4: JournalReadLoss = {
    droppedBytes: 4096,
    droppedEvents: 0,
    lostThroughT: 4,
    note: 'partial — parsed records were evicted through t=4',
  };

  it('reports loss for a window that starts before the newest record the journal lost', () => {
    expect(sessionWithLoss(lostThrough4).lostSince(0)).toBe(true);
  });

  it('reports loss for a window opened at the very millisecond the loss reaches', () => {
    // Parsed cache evictions have known timestamps; the boundary millisecond is still lost.
    expect(sessionWithLoss(lostThrough4).lostSince(4)).toBe(true);
  });

  it('reports NO loss for a window that starts after everything the journal lost', () => {
    // Over-warning is the safe direction, but not to the point of impeaching every verdict: a
    // cursor past the boundary asks about a window the journal answered in full.
    expect(sessionWithLoss(lostThrough4).lostSince(5)).toBe(false);
    expect(sessionWithLoss(lostThrough4).lostSince(9)).toBe(false);
  });

  it('reports loss for every window when skipped timestamps are unknown', () => {
    // The missing bound means discarded timestamps were not observed, even if a tail survives.
    const unbounded: JournalReadLoss = {
      droppedBytes: 9,
      droppedEvents: 0,
      note: 'partial — nothing readable',
    };
    expect(sessionWithLoss(unbounded).lostSince(1000)).toBe(true);
  });

  it('is unchanged for a session whose journal declared nothing', () => {
    expect(sessionWithLoss(undefined).lostSince(0)).toBe(false);
    expect(createFakeSession().lostSince(0)).toBe(false);
  });
});

/**
 * The same thing again with nothing faked but the clock: a real `SessionJournal` over a real file,
 * reached the way a verdict reaches it — through `queryEvents`' durable fall-through.
 *
 * A stubbed reader proves `lostSince` reads the report. It cannot prove the report is ever
 * populated on the path a verdict takes, and that is the half a false green would hide in: the
 * journal is only read once the ring buffer has evicted, so a loss that is only discovered during
 * that read has to be visible to a `lostSince` called afterwards.
 */
describe('Session.lostSince — after the real durable fall-through', () => {
  let root = '';
  const churn = (seq: number): ReticleEvent => ({
    t: seq,
    seq,
    type: EventType.DOM_TEXT,
    sessionId: 'demo',
    data: { text: `t${seq}` },
  });
  /** Past the ring buffer's byte budget, so the second push evicts the first. */
  const OVER_BUDGET_BYTES = 9 * 1024 * 1024;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-session-loss-'));
    root = join(dir, '.reticle');
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  async function sessionOverJournal(
    maxReadBytes: number,
    written: readonly ReticleEvent[] = Array.from({ length: 12 }, (_, i) => churn(i)),
  ): Promise<{
    session: ReturnType<typeof createFakeSession>;
    journal: SessionJournal;
  }> {
    const journal = new SessionJournal(createNodeFileSystem(), root, 'demo', { maxReadBytes });
    await journal.appendEvents(written);
    const session = createFakeSession();
    session.setJournal(new JournalRecorder(journal, { now: () => 0 }), journal);
    // Churn eviction, so the BUFFER declares no scarce loss: whatever `lostSince` reports here came
    // from the journal, which is the thing under test.
    session.pushEvent(churn(100), OVER_BUDGET_BYTES);
    session.pushEvent(churn(101), OVER_BUDGET_BYTES);
    return { session, journal };
  }

  it('carries a truncated durable read into the verdict-facing loss check', async () => {
    const { session, journal } = await sessionOverJournal(120);
    expect(session.bufferHealth().dropped).toBeGreaterThan(0);

    const events = await session.queryEvents({ since: 0 });

    // The read was cut, so the answer is short and the session says so for the window it covers.
    expect(events.length).toBeLessThan(12);
    expect(journal.readLoss()?.droppedBytes).toBeGreaterThan(0);
    expect(session.lostSince(0)).toBe(true);
  });

  it('impeaches the boundary millisecond itself, where the cut may have taken a twin', async () => {
    // The whole false-green risk in one fixture, and it needs no field name to state: two records
    // are written at the SAME elapsed millisecond, the cut takes the older one, and a verdict is
    // then asked about a window opened at exactly that millisecond. The surviving record cannot
    // vouch for that window — its twin is gone — so the only honest answer is "lost".
    const twin = (seq: number): ReticleEvent => ({ ...churn(seq), t: 7 });
    const roomForTheNewestOnly = Buffer.byteLength(`${JSON.stringify(twin(1))}\n`, 'utf8') + 10;
    const { session } = await sessionOverJournal(roomForTheNewestOnly, [twin(0), twin(1)]);

    const events = await session.queryEvents({ since: 0 });

    expect(events.map((e) => e.seq)).toContain(1);
    expect(events.map((e) => e.seq)).not.toContain(0);
    expect(session.lostSince(7)).toBe(true);
  });

  it('keeps a byte cut unknown even for a later requested window', async () => {
    const { session, journal } = await sessionOverJournal(120);

    await session.queryEvents({ since: 0 });
    expect(journal.readLoss()?.droppedBytes).toBeGreaterThan(0);
    expect(journal.readLoss()?.lostThroughT).toBeUndefined();
    expect(session.lostSince(1000)).toBe(true);
  });

  it('does not infer discarded timestamps from a tail after the page clock resets', async () => {
    const written = [
      { ...churn(0), t: 200 },
      { ...churn(1), t: 201 },
      { ...churn(2), t: 10 },
    ];
    const newest = written[2];
    const cap = Buffer.byteLength(`${JSON.stringify(newest)}\n`, 'utf8') + 10;
    const { session, journal } = await sessionOverJournal(cap, written);

    await session.queryEvents({ since: 150 });

    // Session ids survive reloads, while elapsed page timestamps can restart. The unparsed
    // prefix contains t=200/201 even though the surviving tail says t=10.
    expect(journal.readLoss()?.droppedBytes).toBeGreaterThan(0);
    expect(session.lostSince(150)).toBe(true);
    expect(journal.readLoss()?.lostThroughT).toBeUndefined();
  });

  /**
   * A session over a journal that one read already consumed, then a burst past the read ceiling:
   * the shape of the field report, where the cut came between two reads.
   */
  async function sessionCutAfterRead(
    before: readonly ReticleEvent[],
    burst: readonly ReticleEvent[],
    maxReadBytes = 120,
  ): Promise<{ session: ReturnType<typeof createFakeSession>; journal: SessionJournal }> {
    const { session, journal } = await sessionOverJournal(maxReadBytes, before);
    await session.queryEvents({ since: 0 });
    expect(journal.readLoss()).toBeUndefined();
    await journal.appendEvents(burst);
    await session.queryEvents({ since: 0 });
    expect(journal.readLoss()?.droppedBytes).toBeGreaterThan(0);
    return { session, journal };
  }

  const burst = Array.from({ length: 11 }, (_, i) => churn(i + 1));

  it('bounds a cut between two reads at the first record that survived it', async () => {
    const { journal } = await sessionCutAfterRead([churn(0)], burst);

    // `t` and `seq` went up across the cut, so the clock did not start again. Every skipped
    // record is then at or before the first record that survived the cut.
    expect(journal.readLoss()?.lostThroughT).toBe(11);
  });

  it('clears a window opened after the cut, and still impeaches one opened before it', async () => {
    const { session } = await sessionCutAfterRead([churn(0)], burst);

    expect(session.lostSince(0)).toBe(true);
    expect(session.lostSince(11)).toBe(true);
    expect(session.lostSince(1000)).toBe(false);
  });

  it('stays clear for later windows after the next read finds nothing new', async () => {
    // The defect was sticky: once a cut happened, every later verdict on the session was unknown.
    const { session } = await sessionCutAfterRead([churn(0)], burst);

    await session.queryEvents({ since: 1000 });

    expect(session.lostSince(1000)).toBe(false);
    expect(session.lostSince(5000)).toBe(false);
  });

  it('keeps the window before a clock reset lost when the cut spans the reset', async () => {
    // A window opens at t=150 and its click reloads the page. The cut takes the old connection's
    // records at t=200 and t=201, which ARE in that window, and the new clock starts at t=10.
    // A bound from the new clock would clear the window over the evidence it lost.
    const newest = { ...churn(3), t: 10 };
    const cap = Buffer.byteLength(`${JSON.stringify(newest)}\n`, 'utf8') + 10;
    const { session, journal } = await sessionCutAfterRead(
      [{ ...churn(0), t: 150 }],
      [{ ...churn(1), t: 200 }, { ...churn(2), t: 201 }, newest],
      cap,
    );

    expect(journal.readLoss()?.lostThroughT).toBeUndefined();
    expect(session.lostSince(150)).toBe(true);
  });

  it('keeps a cut unbounded when the document changed across it', async () => {
    // A full navigation mints a new document. The new document's clock can already be past the
    // old `t`, so only the document id shows that the clock started again.
    const inDocument = (seq: number, t: number, documentId: string): ReticleEvent => ({
      ...churn(seq),
      t,
      documentId,
    });
    const newest = inDocument(3, 300, 'doc-b');
    const cap = Buffer.byteLength(`${JSON.stringify(newest)}\n`, 'utf8') + 10;
    const { session, journal } = await sessionCutAfterRead(
      [inDocument(0, 150, 'doc-a')],
      [inDocument(1, 200, 'doc-a'), inDocument(2, 400, 'doc-a'), newest],
      cap,
    );

    expect(journal.readLoss()?.lostThroughT).toBeUndefined();
    expect(session.lostSince(350)).toBe(true);
  });

  it('declares nothing when the whole journal fitted', async () => {
    const { session } = await sessionOverJournal(1024 * 1024);

    const events = await session.queryEvents({ since: 0 });

    expect(events.length).toBeGreaterThanOrEqual(12);
    expect(session.lostSince(0)).toBe(false);
  });
});
