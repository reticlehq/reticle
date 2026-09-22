/**
 * The durable journal read is BOUNDED in two places, and each bound says what it cost.
 *
 * `.reticle/sessions/<id>/events.jsonl` is append-only and nothing prunes a single session's file —
 * `pruneSessions` caps how many session DIRECTORIES survive, never how large one of them grows. The
 * session id lives in the page's sessionStorage, so it survives a reload and the next connection
 * builds a fresh `SessionJournal` over the same file with its byte cursor back at zero. That first
 * read materialises the whole accumulated file as ONE JavaScript string, and V8 cannot build a
 * string longer than 0x1fffffe8 characters: `Buffer.prototype.toString` throws rather than returning
 * a shorter one.
 *
 * The blast radius is precisely the verdict surface. `queryEvents` is the journal fall-through, and
 * the only tools that call it are the ones that decide something — `reticle_assert` and
 * `reticle_act_and_wait`. `reticle_look`, `reticle_act`, `reticle_query` and `reticle_snapshot`
 * drive the DOM and never open the ledger, so they keep working while the two tools that can produce
 * a verdict answer with a raw exception and no `verified` field at all.
 *
 * Two bounds, because one read is not the whole story:
 *
 *   - ONE READ materialises at most `maxReadBytes` and keeps the NEWEST records.
 *   - The RETAINED parse-cache is bounded too. A thousand small reads each under the read ceiling
 *     still accumulate every record they parsed, so bounding only the read bounds nothing over the
 *     life of a session.
 *
 * Whatever either bound removes is declared through `readLoss()` — a report beside the value, which
 * `Session.lostSince` folds into the same `buffer_loss` an evicted ring buffer already reports. A
 * quiet omission is indistinguishable from evidence that never existed.
 *
 * The fixture below is the failure, not a description of it: its port refuses to materialise a span
 * over a ceiling, exactly as `Buffer.prototype.toString` does. The ceiling is small so the property
 * is provable in bytes rather than in half a gigabyte of fixture — the bug is the missing bound, and
 * a bound is the same bound at every scale.
 */
import { constants as BUFFER_CONSTANTS } from 'node:buffer';
import { setImmediate } from 'node:timers/promises';
import { queryObjects } from 'node:v8';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { SessionJournal } from './session-journal.js';

/** The exact text `Buffer.prototype.toString` throws past V8's maximum string length. */
const V8_STRING_LIMIT_MESSAGE = `Cannot create a string longer than 0x${BUFFER_CONSTANTS.MAX_STRING_LENGTH.toString(16)} characters`;

/**
 * V8's ceiling, scaled down so the fixture is bytes instead of half a gigabyte.
 *
 * The property under test is "one read never asks for more than the journal's own ceiling", and
 * that is scale-free: a reproduction at 512 MB would allocate 512 MB to prove the same implication.
 */
const STRING_CEILING_BYTES = 400;
/** The journal's own ceiling, under the string ceiling — where the newest-records cut happens. */
const READ_CEILING_BYTES = 200;

const EVENTS_FILE = 'events.jsonl';

/**
 * A ceiling for the tests that append and re-read through a real temp directory in a loop, never a
 * measurement of one: ten round trips are milliseconds here and can be seconds on a loaded Windows
 * runner, and vitest's 5s default would then decide the result instead of the assertion.
 */
const APPEND_READ_LOOP_TIMEOUT_MS = 20_000;

function evt(seq: number, t = seq): ReticleEvent {
  return { t, seq, type: EventType.SIGNAL, sessionId: 'demo', data: { name: `s${seq}` } };
}

function lines(events: readonly ReticleEvent[]): string {
  return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

/** Every member the journal never touches; present so the port is whole rather than cast. */
function unusedFileSystem(): FileSystemPort {
  const refuse = (): Promise<never> => Promise.reject(new Error('not used by this fixture'));
  return {
    readFile: refuse,
    writeFile: refuse,
    appendFile: refuse,
    readFileBytes: refuse,
    writeFileBytes: refuse,
    mkdir: () => Promise.resolve(),
    exists: () => Promise.resolve(true),
    readdir: refuse,
    rename: refuse,
    rm: refuse,
    stat: refuse,
    realpath: refuse,
    isNotFound: () => false,
  };
}

interface CeilingJournal {
  fs: FileSystemPort;
  /** Byte span of every read this port was asked to materialise as one string. */
  spans: number[];
}

/**
 * An in-memory `events.jsonl` behind a port that CANNOT return a string over `STRING_CEILING_BYTES`.
 *
 * It implements the documented `readFileFrom` contract: honour the caller's ceiling by keeping the
 * newest bytes, start the returned text at a record boundary, and report that start as `from`. And
 * it models the V8 limit faithfully — asked for a span over the ceiling it THROWS, which is what
 * makes this a reproduction rather than an assertion about intent.
 */
function ceilingJournal(text: string): CeilingJournal {
  const spans: number[] = [];
  const bytes = Buffer.from(text, 'utf8');
  return {
    spans,
    fs: {
      ...unusedFileSystem(),
      readFile: () =>
        bytes.length > STRING_CEILING_BYTES
          ? Promise.reject(new Error(V8_STRING_LIMIT_MESSAGE))
          : Promise.resolve(text),
      readFileFrom: (path: string, byteOffset: number, maxBytes?: number) => {
        if (!path.endsWith(EVENTS_FILE)) return Promise.resolve({ text: '', size: 0 });
        const size = bytes.length;
        if (byteOffset >= size) return Promise.resolve({ text: '', size, from: byteOffset });
        const start =
          maxBytes !== undefined && size - byteOffset > maxBytes ? size - maxBytes : byteOffset;
        spans.push(size - start);
        if (size - start > STRING_CEILING_BYTES) {
          return Promise.reject(new Error(V8_STRING_LIMIT_MESSAGE));
        }
        if (start === byteOffset) {
          return Promise.resolve({
            text: bytes.subarray(start).toString('utf8'),
            size,
            from: start,
          });
        }
        const newline = bytes.subarray(start).indexOf(0x0a);
        const from = -1 === newline ? size : start + newline + 1;
        return Promise.resolve({ text: bytes.subarray(from).toString('utf8'), size, from });
      },
    },
  };
}

describe('SessionJournal — a read too large to be one string', () => {
  /** Enough records that the whole file is over the string ceiling and the cut lands mid-record. */
  const written = Array.from({ length: 12 }, (_, i) => evt(i));
  const file = lines(written);

  it('is a real reproduction: the unbounded whole-file read still throws V8 string-length', async () => {
    const { fs } = ceilingJournal(file);

    await expect(fs.readFile(`/root/${EVENTS_FILE}`)).rejects.toThrow(V8_STRING_LIMIT_MESSAGE);
  });

  it('answers with the newest records instead of throwing V8 string-length out of the daemon', async () => {
    const { fs } = ceilingJournal(file);
    const journal = new SessionJournal(fs, '/root', 'demo', {
      maxReadBytes: READ_CEILING_BYTES,
    });

    const back = await journal.readEvents();

    expect(back.length).toBeGreaterThan(0);
    // The NEWEST records, because a verdict is about what just happened.
    expect(back[back.length - 1]?.seq).toBe(written[written.length - 1]?.seq);
  });

  it('never asks for a span larger than a JavaScript string can hold', async () => {
    const { fs, spans } = ceilingJournal(file);
    const journal = new SessionJournal(fs, '/root', 'demo', {
      maxReadBytes: READ_CEILING_BYTES,
    });

    await journal.readEvents().catch(() => undefined);

    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span).toBeLessThanOrEqual(READ_CEILING_BYTES);
  });

  it('declares the records it could not reach rather than returning a short answer silently', async () => {
    const { fs } = ceilingJournal(file);
    const journal = new SessionJournal(fs, '/root', 'demo', {
      maxReadBytes: READ_CEILING_BYTES,
    });

    const back = await journal.readEvents();
    const loss = journal.readLoss();

    expect(back.length).toBeLessThan(written.length);
    expect(loss?.droppedBytes).toBeGreaterThan(0);
    expect(loss?.note).toContain('partial');
    // The timestamps of unparsed records cannot be inferred from the surviving tail.
    expect(loss?.lostThroughT).toBeUndefined();
  });

  it('never claims a boundary when the cut left nothing readable to bound it at', async () => {
    // A long unterminated run ahead of the only record: everything in the capped window up to the
    // first newline is the tail of something the reader never saw the head of, so no complete
    // record survives the cut — and an unknown boundary must read as total loss, never as none.
    const giant = lines([evt(0, 0)]).padStart(READ_CEILING_BYTES * 3, 'x');
    const { fs } = ceilingJournal(giant);
    const journal = new SessionJournal(fs, '/root', 'demo', {
      maxReadBytes: READ_CEILING_BYTES,
    });

    await journal.readEvents();
    const loss = journal.readLoss();

    expect(loss?.droppedBytes).toBeGreaterThan(0);
    expect(loss?.lostThroughT).toBeUndefined();
    expect(loss?.note).toContain('no window');
  });
});

describe('SessionJournal — the ceiling, on a real file', () => {
  let root = '';
  let fs: FileSystemPort;
  const written = [evt(0), evt(1), evt(2), evt(3), evt(4), evt(5)];

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-bound-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  /** Bytes of exactly the last `count` written records, newline included. */
  function bytesOfNewest(count: number): number {
    return Buffer.byteLength(lines(written.slice(written.length - count)), 'utf8');
  }

  it('keeps every record and declares no loss when the journal fits under the ceiling', async () => {
    const journal = new SessionJournal(fs, root, 'demo', { maxReadBytes: 1024 * 1024 });
    await journal.appendEvents(written);

    const back = await journal.readEvents();

    expect(back.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(journal.readLoss()).toBeUndefined();
  });

  it('sacrifices the OLDEST records when the journal does not fit, never the newest', async () => {
    // Room for the last two records and the tail of the one before them, so the cut lands mid-record.
    const journal = new SessionJournal(fs, root, 'demo', { maxReadBytes: bytesOfNewest(2) + 10 });
    await journal.appendEvents(written);

    const back = await journal.readEvents();

    expect(back.map((e) => e.seq)).toEqual([4, 5]);
    expect(journal.readLoss()?.droppedBytes).toBeGreaterThan(0);
    expect(journal.readLoss()?.lostThroughT).toBeUndefined();
  });

  it('reports unknown loss when a byte cut opens a gap after cached records', async () => {
    const journal = new SessionJournal(fs, root, 'demo', { maxReadBytes: bytesOfNewest(2) + 10 });
    await journal.appendEvents([evt(0), evt(1)]);
    expect((await journal.readEvents()).map((e) => e.seq)).toEqual([0, 1]);
    expect(journal.readLoss()).toBeUndefined();

    // A burst larger than the ceiling lands between reads: records 2..5 are unreachable, even though
    // the cache still holds 0 and 1 from before the gap.
    await journal.appendEvents([evt(2), evt(3), evt(4), evt(5)]);
    await journal.readEvents();

    expect(journal.readLoss()?.droppedBytes).toBeGreaterThan(0);
    expect(journal.readLoss()?.lostThroughT).toBeUndefined();
  });

  it('preserves unknown loss across successive byte cuts', async () => {
    const journal = new SessionJournal(fs, root, 'demo', { maxReadBytes: bytesOfNewest(2) + 10 });
    await journal.appendEvents([evt(0), evt(1), evt(2), evt(3)]);
    await journal.readEvents();
    const first = journal.readLoss();

    await journal.appendEvents([evt(4), evt(5), evt(6), evt(7)]);
    await journal.readEvents();
    const second = journal.readLoss();

    expect(first?.droppedBytes).toBeGreaterThan(0);
    expect(second?.droppedBytes).toBeGreaterThan(first?.droppedBytes ?? 0);
    expect(first?.lostThroughT).toBeUndefined();
    expect(second?.lostThroughT).toBeUndefined();
  });

  it('does not let an older kept record vouch for a window a later cut opened a hole in', async () => {
    // A retained record cannot vouch for an unparsed prefix, even with a shared timestamp.
    const journal = new SessionJournal(fs, root, 'demo', { maxReadBytes: bytesOfNewest(1) + 10 });
    await journal.appendEvents([evt(0, 7), evt(1, 7)]);

    const back = await journal.readEvents();

    expect(back.map((e) => e.seq)).toEqual([1]);
    expect(journal.readLoss()?.droppedBytes).toBeGreaterThan(0);
    expect(journal.readLoss()?.lostThroughT).toBeUndefined();
  });
});

describe('SessionJournal — the ceiling on RETAINED evidence', () => {
  let root = '';
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-retain-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it(
    'bounds what many small reads accumulate, keeping the newest records',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { maxRetainedEvents: 3 });

      for (let seq = 0; seq < 10; seq++) {
        await journal.appendEvents([evt(seq)]);
        await journal.readEvents();
      }
      const back = await journal.readEvents();

      // Every read was far under the read ceiling; without a second bound the cache holds all ten.
      expect(back.map((e) => e.seq)).toEqual([7, 8, 9]);
    },
    APPEND_READ_LOOP_TIMEOUT_MS,
  );

  it(
    'reports every evicted record rather than quietly shortening the answer',
    async () => {
      const journal = new SessionJournal(fs, root, 'demo', { maxRetainedEvents: 3 });

      for (let seq = 0; seq < 10; seq++) {
        await journal.appendEvents([evt(seq)]);
        await journal.readEvents();
      }
      const loss = journal.readLoss();

      expect(loss?.droppedEvents).toBe(7);
      expect(loss?.droppedBytes).toBeGreaterThan(0);
      // Exact here, not conservative-by-guess: the evicted records were parsed, so their timestamps
      // are known and the newest of them is the boundary.
      expect(loss?.lostThroughT).toBe(6);
      expect(loss?.note).toContain('partial');
    },
    APPEND_READ_LOOP_TIMEOUT_MS,
  );

  it('bounds retained BYTES as well, and keeps the newest record whatever its size', async () => {
    const one = Buffer.byteLength(lines([evt(0)]), 'utf8');
    const journal = new SessionJournal(fs, root, 'demo', { maxRetainedBytes: one * 2 });

    await journal.appendEvents([evt(0), evt(1), evt(2), evt(3)]);
    const back = await journal.readEvents();

    expect(back.map((e) => e.seq)).toEqual([2, 3]);
    expect(journal.readLoss()?.droppedEvents).toBe(2);
  });

  it('declares nothing for a journal that stayed inside both bounds', async () => {
    const journal = new SessionJournal(fs, root, 'demo', { maxRetainedEvents: 100 });

    await journal.appendEvents([evt(0), evt(1), evt(2)]);

    expect((await journal.readEvents()).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(journal.readLoss()).toBeUndefined();
  });
});

/** Count reachable payloads, not just the entries returned by a trimmed view of the cache. */
const CACHE_RETENTION_TIMEOUT_MS = 30_000;

it(
  'releases evicted payloads before compacting the cache slots',
  async () => {
    class CachedPayload {}
    let bytes = Buffer.alloc(0);
    const fs: FileSystemPort = {
      ...unusedFileSystem(),
      readFileFrom: (_path, from) =>
        Promise.resolve({
          text: bytes.subarray(from).toString('utf8'),
          size: bytes.length,
          from,
        }),
    };
    const journal = new SessionJournal(fs, '/synthetic-workspace', 'demo', {
      maxRetainedEvents: 1,
      maxRetainedBytes: 16_384,
      maxReadBytes: 32_768,
    });
    const parse = JSON.parse;
    // A mock's call history would itself retain every result and invalidate the measurement.
    // Brand only this fixture's nested payload; the event schema clones the outer data record.
    JSON.parse = (text, reviver) => {
      const value: unknown = parse(text, reviver);
      if ('object' === typeof value && value !== null && 'data' in value) {
        const data = value.data;
        if (
          'object' === typeof data &&
          data !== null &&
          'retainedPayloadProbe' in data &&
          true === data.retainedPayloadProbe &&
          'payload' in data &&
          'object' === typeof data.payload &&
          data.payload !== null
        ) {
          Object.setPrototypeOf(data.payload, CachedPayload.prototype);
        }
      }
      return value;
    };
    try {
      for (let seq = 0; seq < 24; seq += 1) {
        const event = {
          ...evt(seq),
          data: { retainedPayloadProbe: true, payload: { text: 'x'.repeat(8192) } },
        };
        bytes = Buffer.concat([bytes, Buffer.from(`${JSON.stringify(event)}\n`)]);
        expect(await journal.readEvents()).toHaveLength(1);
      }
    } finally {
      JSON.parse = parse;
    }
    await setImmediate();
    // Node's heap query performs a full collection: this is an object-count bound, not a timing or
    // heap-size assertion. Keep the journal live through the query by reading it afterwards.
    const reachable = queryObjects(CachedPayload, { format: 'count' });
    expect(await journal.readEvents()).toHaveLength(1);
    expect(reachable).toBe(1);
  },
  CACHE_RETENTION_TIMEOUT_MS,
);
