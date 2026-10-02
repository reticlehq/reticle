import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asSessionId,
  EventType,
  JOURNAL_FILE_VERSION,
  TruncationChannel,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import * as logModule from '@/log.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  journalClosedPath,
  journalEventsPath,
  sessionDirPath,
} from '@/memory/project/dir/reticle-dir.js';
import { SessionJournal } from './session-journal.js';

/**
 * The event ledger has to be BOUNDED on disk, and has to STAY bounded across reconnects.
 *
 * Issue #986: a repeating uncaught error drove one session's `events.jsonl` until it filled the
 * machine's disk. Nothing in the writer said no, because nothing in the writer could.
 *
 * A cap that stops writing is only half the fix, and both halves are pinned here:
 *
 *  - **The bound is durable.** A session id survives a reload, so the next connection reopens the
 *    same file with a fresh object and an empty memory. A ceiling that only lives in one instance's
 *    field is a ceiling per CONNECTION, which is the original bug with a reconnect loop in front of
 *    it. Once closed, the ledger stays closed — for a large batch and for a one-event one.
 *  - **The loss is declared where a query cannot hide it.** An agent reading a truncated ledger must
 *    be able to tell it from a complete one, or a "no such event" answer becomes a false negative it
 *    has no way to doubt. The in-band marker carries a timestamp, so a window opened after the cap
 *    filters it straight back out; the out-of-band report is the half that survives that.
 *
 * Small injected cap, real temp dir, no wall-clock assertions: the property under test is a BOUND,
 * and proving it with the 64 MiB default would be a statement about the machine.
 */

/** Tiny on purpose — ~50 event lines, so every case here costs a few kilobytes of temp disk. */
const CAP_BYTES = 4096;

/**
 * How far past the cap the file may end up: exactly one declaration line. Generous against the ~140
 * bytes that line actually costs, because the assertion is "bounded", not "bounded to the byte".
 */
const MARKER_ALLOWANCE_BYTES = 512;

/** Events per batch, and the number the refusal is expected to report as dropped. */
const BATCH_SIZE = 8;

/** Batches that comfortably outrun `CAP_BYTES` — ~32 KB of events against a 4 KB ceiling. */
const BATCHES_PAST_CAP = 40;

/**
 * A generous per-test ceiling for the cases that write a real temp directory inside a loop.
 *
 * Never a duration assertion: this is here so vitest's 5s default does not decide the result on a
 * loaded Windows runner, which is a statement about the machine rather than about the bound. See
 * `guards/ci/heavy-browser-tests-declare-a-timeout.test.ts`, which requires it.
 */
const JOURNAL_CAP_TIMEOUT_MS = 30_000;

function evt(seq: number, over: Partial<ReticleEvent> = {}): ReticleEvent {
  return {
    t: seq,
    seq,
    type: EventType.DOM_ADDED,
    sessionId: 'demo',
    data: { role: 'button' },
    ...over,
  };
}

function action(over: Partial<JournalAction> = {}): JournalAction {
  return {
    v: JOURNAL_FILE_VERSION,
    actionId: 'c1',
    tool: 'reticle_act',
    args: {},
    tRange: { from: 0, to: 5 },
    at: 0,
    ...over,
  };
}

/** Append `batches` batches of `size` events, numbering seqs from `from`. */
async function fill(
  journal: SessionJournal,
  from: number,
  batches: number,
  size: number = BATCH_SIZE,
): Promise<void> {
  for (let batch = 0; batch < batches; batch += 1) {
    const start = from + batch * size;
    const events: ReticleEvent[] = [];
    for (let i = 0; i < size; i += 1) events.push(evt(start + i));
    await journal.appendEvents(events);
  }
}

/** Every `truncated` record in the ledger, read back through the journal's own reader. */
async function truncationRecords(journal: SessionJournal): Promise<ReticleEvent[]> {
  return (await journal.readEvents()).filter((event) => event.type === EventType.TRUNCATED);
}

describe('SessionJournal — the event ledger is bounded on disk', () => {
  let root: string;
  let fs: FileSystemPort;
  let logged: { event: string; fields: Record<string, unknown> }[];

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-cap-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    logged = [];
    vi.spyOn(logModule, 'log').mockImplementation((event, fields = {}) => {
      logged.push({ event, fields });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(join(root, '..'));
  });

  it(
    'stops growing events.jsonl once the byte cap is reached',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { eventBytesCap: CAP_BYTES });
      await fill(journal, 0, BATCHES_PAST_CAP);
      const { size } = await fs.stat(journalEventsPath(root, asSessionId('demo')));
      expect(size).toBeLessThanOrEqual(CAP_BYTES + MARKER_ALLOWANCE_BYTES);
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it(
    'writes nothing at all once capped — a later batch adds no bytes',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { eventBytesCap: CAP_BYTES });
      await fill(journal, 0, BATCHES_PAST_CAP);
      const capped = (await fs.stat(journalEventsPath(root, asSessionId('demo')))).size;
      await fill(journal, 10_000, BATCHES_PAST_CAP);
      expect((await fs.stat(journalEventsPath(root, asSessionId('demo')))).size).toBe(capped);
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it(
    'declares the refusal in-band, so a reader can tell a capped ledger from a complete one',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { eventBytesCap: CAP_BYTES });
      await fill(journal, 0, BATCHES_PAST_CAP);
      const declared = (await truncationRecords(journal))[0];
      expect(declared).toBeDefined();
      expect(declared?.data['channel']).toBe(TruncationChannel.JOURNAL);
      expect(declared?.data['dropped']).toBe(BATCH_SIZE);
      expect(declared?.sessionId).toBe('demo');
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it(
    'refuses a whole batch rather than writing a partial line',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { eventBytesCap: CAP_BYTES });
      await fill(journal, 0, BATCHES_PAST_CAP);
      const text = await readFile(journalEventsPath(root, asSessionId('demo')), 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      for (const line of text.split('\n')) {
        if (0 === line.length) continue;
        expect(() => {
          JSON.parse(line);
        }, line).not.toThrow();
      }
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it(
    'keeps the read cursor valid across the cap — a re-read repeats and loses nothing',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { eventBytesCap: CAP_BYTES });
      await fill(journal, 0, BATCHES_PAST_CAP);
      const first = await journal.readEvents();
      await fill(journal, 20_000, BATCHES_PAST_CAP);
      const second = await journal.readEvents();
      expect(second.map((event) => event.seq)).toEqual(first.map((event) => event.seq));
      expect(first.some((event) => event.type === EventType.DOM_ADDED)).toBe(true);
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it(
    'names the cap on the daemon log when it refuses, once',
    async () => {
      // Nothing noticed the runaway in #986 — not the daemon, not a counter. One line, carrying the
      // ceiling that was hit, is the cheapest half of that; it must not itself become the flood, so
      // it is written once.
      const journal = new SessionJournal(fs, root, 'demo', { eventBytesCap: CAP_BYTES });
      await fill(journal, 0, BATCHES_PAST_CAP);
      const lines = logged.filter((line) => 'journal_events_cap_reached' === line.event);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.fields['capBytes']).toBe(CAP_BYTES);
      expect(lines[0]?.fields['sessionId']).toBe('demo');
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it('leaves a journal under the ceiling untouched, and declares nothing there', async () => {
    const journal = new SessionJournal(fs, root, 'small', { eventBytesCap: CAP_BYTES });
    await journal.appendEvents([evt(0), evt(1)]);
    const back = await journal.readEvents();
    expect(back.map((event) => event.seq)).toEqual([0, 1]);
    expect(back.some((event) => event.type === EventType.TRUNCATED)).toBe(false);
    expect(await journal.readWriteLoss()).toBeUndefined();
    expect(logged).toEqual([]);
  });

  it(
    'keeps the action ledger writable after the event cap — a different file, a different bound',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { eventBytesCap: CAP_BYTES });
      await fill(journal, 0, BATCHES_PAST_CAP);
      await journal.appendAction(action({ actionId: 'c1' }));
      expect((await journal.readActions()).map((a) => a.actionId)).toEqual(['c1']);
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );
});

describe('SessionJournal — a closed ledger stays closed across reconnects', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-reopen-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    vi.spyOn(logModule, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(join(root, '..'));
  });

  const reopen = (session: string): SessionJournal =>
    new SessionJournal(fs, root, session, { eventBytesCap: CAP_BYTES });

  it(
    'grows by nothing across three reconnects driving three different batch sizes',
    async () => {
      // The reload loop is the shape that matters: the session id lives in sessionStorage, so every
      // reconnect reopens the SAME file with a fresh object. A per-connection budget — or a marker
      // re-appended per connection — turns a bound into a bound-per-reload, which is the original
      // defect with an extra step in it.
      const events = journalEventsPath(root, asSessionId('resumed'));
      await fill(reopen('resumed'), 0, BATCHES_PAST_CAP);
      const closed = (await fs.stat(events)).size;
      expect(closed).toBeLessThanOrEqual(CAP_BYTES + MARKER_ALLOWANCE_BYTES);

      await fill(reopen('resumed'), 10_000, BATCHES_PAST_CAP, 1);
      expect((await fs.stat(events)).size).toBe(closed);

      await fill(reopen('resumed'), 20_000, BATCHES_PAST_CAP, 64);
      expect((await fs.stat(events)).size).toBe(closed);
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it(
    'declares the loss exactly once, however many times the session reconnects',
    async () => {
      // One ledger, one closure, one declaration. A marker per reconnect would be a file that still
      // grows without bound — slower, and claiming a hard ceiling while it did.
      await fill(reopen('resumed'), 0, BATCHES_PAST_CAP);
      await fill(reopen('resumed'), 10_000, 3);
      await fill(reopen('resumed'), 20_000, 3);
      const records = await truncationRecords(reopen('resumed'));
      expect(records).toHaveLength(1);
      expect(records[0]?.data['channel']).toBe(TruncationChannel.JOURNAL);
    },
    JOURNAL_CAP_TIMEOUT_MS,
  );

  it('refuses a one-event batch that would fit in the space a refused large batch left', async () => {
    // The nastiest reopen: a BIG batch is turned away while the file is still far below the ceiling,
    // so there is room afterwards. A budget check alone re-admits the next small batch and appends
    // it AFTER the marker that claims the ledger stopped — evidence following its own epitaph.
    const events = journalEventsPath(root, asSessionId('roomy'));
    const first = reopen('roomy');
    await first.appendEvents([evt(0)]);
    const bulk: ReticleEvent[] = [];
    for (let i = 0; i < 200; i += 1) bulk.push(evt(100 + i));
    await first.appendEvents(bulk);
    const closed = (await fs.stat(events)).size;
    expect(closed).toBeLessThan(CAP_BYTES); // there IS room left — that is the trap

    await reopen('roomy').appendEvents([evt(9000)]);
    expect((await fs.stat(events)).size).toBe(closed);

    const back = await reopen('roomy').readEvents();
    expect(back[back.length - 1]?.type).toBe(EventType.TRUNCATED);
    expect(back.some((event) => 9000 === event.seq)).toBe(false);
  });

  it('closes a ledger that was already oversized before the cap existed, without rewriting it', async () => {
    // The upgrade case, and the one every existing install meets first: a ledger written by a build
    // that had no ceiling. It must stop growing on the very first append, get ONE marker, and keep
    // every byte it already had — a fix that repaired the file by truncating it would destroy the
    // evidence somebody kept the session for.
    const events = journalEventsPath(root, asSessionId('legacy'));
    await mkdir(sessionDirPath(root, asSessionId('legacy')), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 300; i += 1) lines.push(JSON.stringify(evt(i)));
    const legacy = `${lines.join('\n')}\n`;
    await writeFile(events, legacy, 'utf8');
    expect(legacy.length).toBeGreaterThan(CAP_BYTES); // genuinely over the ceiling already

    const journal = reopen('legacy');
    await journal.appendEvents([evt(9001)]);
    const text = await readFile(events, 'utf8');
    expect(text.startsWith(legacy)).toBe(true); // nothing already written was touched
    expect(text.length).toBeLessThanOrEqual(legacy.length + MARKER_ALLOWANCE_BYTES);
    expect(await truncationRecords(journal)).toHaveLength(1);

    const after = (await fs.stat(events)).size;
    await reopen('legacy').appendEvents([evt(9002)]);
    expect((await fs.stat(events)).size).toBe(after);
  });

  it('reports the loss out of band, where a later query window cannot filter it away', async () => {
    // `filterEvents` bounds on `t`, and the in-band marker carries the `t` of the last refused
    // event. Any window opened after that instant drops it — and an agent reading the survivors
    // cannot tell a ledger that was closed from one that simply had nothing to say.
    await fill(reopen('reported'), 0, BATCHES_PAST_CAP);
    const loss = await reopen('reported').readWriteLoss();
    expect(loss?.channel).toBe(TruncationChannel.JOURNAL);
    expect(loss?.capBytes).toBe(CAP_BYTES);
    expect(loss?.droppedInBatch).toBe(BATCH_SIZE);
    expect(loss?.bytesOnDisk).toBeLessThanOrEqual(CAP_BYTES);
    // Not a running total of everything refused afterwards: an append-only ledger cannot revise a
    // line it already wrote, and a number that counted later drops would be invented.
    await fill(reopen('reported'), 50_000, 5, 64);
    expect((await reopen('reported').readWriteLoss())?.droppedInBatch).toBe(BATCH_SIZE);
  });

  it('keeps a ledger closed when its own loss report is unreadable', async () => {
    // A corrupted report still says the ledger was closed — that is what its PRESENCE means. The
    // details are gone, so they are reported absent rather than guessed, and the ledger does not
    // reopen because nobody could read the note explaining why it shut.
    const events = journalEventsPath(root, asSessionId('garbled'));
    await fill(reopen('garbled'), 0, BATCHES_PAST_CAP);
    const closed = (await fs.stat(events)).size;
    await writeFile(journalClosedPath(root, asSessionId('garbled')), 'not json at all\n', 'utf8');

    const after = reopen('garbled');
    await after.appendEvents([evt(9999)]);
    expect((await fs.stat(events)).size).toBe(closed);
    const loss = await after.readWriteLoss();
    expect(loss?.channel).toBe(TruncationChannel.JOURNAL);
    expect(loss?.droppedInBatch).toBeUndefined();
  });
});

/**
 * Whatever the filesystem is doing, an unreadable size is NOT an empty ledger.
 *
 * `stat` was caught wholesale and answered zero, so a permission change, a disk error or a
 * directory where the file belongs all handed the writer a full budget over a file that may already
 * be at the ceiling — the cap silently disabled by the one condition most likely to accompany a
 * full disk. Only ENOENT means absence; everything else must reach the caller before a byte is
 * written.
 */
describe('SessionJournal — an unreadable ledger is not an empty one', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-io-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    vi.spyOn(logModule, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(join(root, '..'));
  });

  /** An errno error shaped the way `FileSystemPort.isNotFound` inspects one. */
  function errno(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`${code}: injected`);
    error.code = code;
    return error;
  }

  it('propagates a permission failure on stat instead of reading it as zero bytes', async () => {
    let appends = 0;
    const blind: FileSystemPort = {
      ...fs,
      stat: () => Promise.reject(errno('EACCES')),
      appendFile: (path, data) => {
        appends += 1;
        return fs.appendFile(path, data);
      },
    };
    const journal = new SessionJournal(blind, root, 'denied', { eventBytesCap: CAP_BYTES });
    await expect(journal.appendEvents([evt(0)])).rejects.toThrow('EACCES');
    expect(appends).toBe(0);
  });

  it('propagates an IO failure on the loss report instead of reopening the ledger', async () => {
    let appends = 0;
    const blind: FileSystemPort = {
      ...fs,
      readFile: (path) =>
        path.endsWith('.json') ? Promise.reject(errno('EIO')) : fs.readFile(path),
      appendFile: (path, data) => {
        appends += 1;
        return fs.appendFile(path, data);
      },
    };
    const journal = new SessionJournal(blind, root, 'unreadable', { eventBytesCap: CAP_BYTES });
    await expect(journal.appendEvents([evt(0)])).rejects.toThrow('EIO');
    expect(appends).toBe(0);
  });

  it('does not reset the byte budget after a failed stat', async () => {
    // The damaging half. Answering zero does not merely lose one batch: it CACHES a budget of zero
    // bytes consumed, so every later batch on that connection is measured against an empty file and
    // the ceiling is gone for the rest of the session.
    const events = journalEventsPath(root, asSessionId('budget'));
    await fill(new SessionJournal(fs, root, 'budget', { eventBytesCap: CAP_BYTES }), 0, 4, 8);
    const before = (await fs.stat(events)).size;

    let failuresLeft = 1;
    const flaky: FileSystemPort = {
      ...fs,
      stat: (path) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Promise.reject(errno('EACCES'));
        }
        return fs.stat(path);
      },
    };
    const journal = new SessionJournal(flaky, root, 'budget', { eventBytesCap: CAP_BYTES });
    await expect(journal.appendEvents([evt(500)])).rejects.toThrow('EACCES');
    expect((await fs.stat(events)).size).toBe(before);

    // stat works again: the budget must be re-read from disk, not remembered as empty.
    const bulk: ReticleEvent[] = [];
    for (let i = 0; i < 200; i += 1) bulk.push(evt(600 + i));
    await journal.appendEvents(bulk);
    expect((await fs.stat(events)).size).toBeLessThanOrEqual(CAP_BYTES + MARKER_ALLOWANCE_BYTES);
  });
});

describe('SessionJournal — the injected cap is validated, and the batch is not built blind', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-cap-args-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    vi.spyOn(logModule, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(join(root, '..'));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %p as a byte ceiling rather than journalling against it',
    (cap) => {
      // A cap of 0 refuses everything, a negative one refuses everything, a fractional one compares
      // a byte count against a value no byte count can equal. All three fail SILENTLY as journaling
      // that quietly stopped, which is the failure mode this whole file exists to make impossible.
      expect(() => new SessionJournal(fs, root, 'bad', { eventBytesCap: cap })).toThrow(/cap/i);
    },
  );

  it('stops serializing a batch once it has outgrown the remaining budget', async () => {
    // Building the whole batch and measuring it afterwards means the runaway session pays full
    // serialization cost for every batch it will never be allowed to write — the flood still costs
    // CPU and peak memory, it just stops costing disk. Each event carries a probe that counts the
    // one moment it is serialized; nothing about the event is mutated.
    let serialized = 0;
    const probe = (seq: number): ReticleEvent =>
      evt(seq, {
        data: {
          role: 'button',
          probe: {
            toJSON: (): string => {
              serialized += 1;
              return 'x'.repeat(16);
            },
          },
        },
      });
    const batch: ReticleEvent[] = [];
    for (let i = 0; i < 500; i += 1) batch.push(probe(i));

    const journal = new SessionJournal(fs, root, 'probed', { eventBytesCap: 512 });
    await journal.appendEvents(batch);
    // 512 bytes of budget against ~100-byte lines: a handful is all that can be measured before the
    // answer is known. A bound, not a duration — the number is generous on purpose.
    expect(serialized).toBeLessThanOrEqual(16);
  });

  it('serializes every event of a batch that fits', async () => {
    // The control for the bound above: stopping early must never mean writing short. A batch under
    // the ceiling is written whole.
    const journal = new SessionJournal(fs, root, 'whole', { eventBytesCap: CAP_BYTES });
    const batch: ReticleEvent[] = [];
    for (let i = 0; i < 10; i += 1) batch.push(evt(i));
    await journal.appendEvents(batch);
    expect((await journal.readEvents()).map((event) => event.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});
