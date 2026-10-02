import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventType,
  ReticleDir,
  JOURNAL_FILE_VERSION,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { SessionJournal } from './session-journal.js';

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

describe('SessionJournal — durable JSONL over a temp dir', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-journal-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('appends events in batches and reads them back in order', async () => {
    const j = new SessionJournal(fs, root, 'demo');
    await j.appendEvents([evt(0), evt(1)]);
    await j.appendEvents([evt(2)]);
    const back = await j.readEvents();
    expect(back.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('reads incrementally across appends — a re-read after more writes returns the union', async () => {
    // The parse-cache only parses the TAIL written since the last read (queryEvents calls readEvents on
    // every observe/network/console once the ring buffer evicts, so re-parsing the whole file each time
    // was the hot cost). Correctness: reads interleaved with appends must still return every event once.
    const j = new SessionJournal(fs, root, 'demo');
    await j.appendEvents([evt(0), evt(1)]);
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1]);
    // A re-read with nothing new returns the same set (cache hit, no duplication).
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1]);
    // Append more, then re-read: the tail is parsed and merged, no earlier event lost or repeated.
    await j.appendEvents([evt(2)]);
    await j.appendEvents([evt(3), evt(4)]);
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // The returned array is a copy — mutating it must not corrupt the cache for the next read.
    const back = await j.readEvents();
    back.pop();
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('appends and reads back actions', async () => {
    const j = new SessionJournal(fs, root, 'demo');
    await j.appendAction(action({ actionId: 'c1' }));
    await j.appendAction(action({ actionId: 'c2', seqRange: { from: 0, to: 2 } }));
    const back = await j.readActions();
    expect(back.map((a) => a.actionId)).toEqual(['c1', 'c2']);
    expect(back[1]?.seqRange?.to).toBe(2);
  });

  it('returns [] for a session with no journal on disk (never throws)', async () => {
    const j = new SessionJournal(fs, root, 'fresh');
    expect(await j.readEvents()).toEqual([]);
    expect(await j.readActions()).toEqual([]);
  });

  it('skips malformed and schema-invalid lines instead of throwing', async () => {
    const j = new SessionJournal(fs, root, 'demo');
    await j.appendEvents([evt(0)]);
    await fs.appendFile(join(root, 'sessions', 'demo', 'events.jsonl'), 'not json\n{"seq":99}\n');
    await j.appendEvents([evt(1)]);
    const back = await j.readEvents();
    expect(back.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('is a no-op on an empty event batch (no empty lines written)', async () => {
    const j = new SessionJournal(fs, root, 'demo');
    await j.appendEvents([]);
    expect(await j.readEvents()).toEqual([]);
  });

  it('rejects an unsafe session id before any disk path is built', () => {
    expect(() => new SessionJournal(fs, root, '../escape')).toThrow();
  });

  it('stays correct once the evicted prefix is compacted away', async () => {
    // Eviction advances a head index and only reclaims the dead prefix once it dominates the
    // backing array — the branch a handful of evictions never reaches, and therefore the one that
    // would rot untested. A thousand records in one batch crosses it in a single read.
    const OVER_COMPACTION_THRESHOLD = 1200;
    const j = new SessionJournal(fs, root, 'demo', { maxRetainedEvents: 3 });
    await j.appendEvents(Array.from({ length: OVER_COMPACTION_THRESHOLD }, (_, i) => evt(i)));

    expect((await j.readEvents()).map((e) => e.seq)).toEqual([1197, 1198, 1199]);

    // And the cursor survived the compaction: the next append arrives once, on top of the newest.
    await j.appendEvents([evt(1200)]);
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([1198, 1199, 1200]);
    expect(j.readLoss()?.droppedEvents).toBe(OVER_COMPACTION_THRESHOLD - 2);
  });

  it('bounded read tracks BYTE offsets, not char offsets, across multi-byte unicode payloads', async () => {
    // The trap: the parse offset advances by UTF-16 code units, but a byte-offset file read needs BYTES.
    // An event whose data contains multi-byte chars (é, 世, 🎉) would desync a char-offset read and
    // corrupt every subsequent line. Reads resume at a '\n' (1-byte) boundary, so byte offsets are safe —
    // this proves the round-trip survives non-ASCII.
    const j = new SessionJournal(fs, root, 'demo');
    await j.appendEvents([evt(0, { data: { role: 'button', name: 'café 世界 🎉' } })]);
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0]); // first read consumes the unicode line
    await j.appendEvents([evt(1, { data: { role: 'link', name: 'plain' } })]);
    // Second read must resume from the correct BYTE position and pick up event 1 without corruption.
    const back = await j.readEvents();
    expect(back.map((e) => e.seq)).toEqual([0, 1]);
    expect(back[0]?.data['name']).toBe('café 世界 🎉'); // payload intact
  });

  it('does NOT drop an event when a read observes a partial trailing line mid-append', async () => {
    // Reads and writes are not on the same chain and hit separate libuv threads, so a read can see the
    // file ending mid-record. Advancing the parse offset past that partial line used to splice its tail
    // onto the next read's head, fail to parse the join, and lose that event from the durable cache
    // forever. The offset must stop at the last newline and re-read the completed line.
    let fileText = '';
    const controllable: FileSystemPort = {
      ...fs,
      readFile: (path) =>
        path.endsWith('events.jsonl') ? Promise.resolve(fileText) : fs.readFile(path),
      // Serve the bounded read (the production fast path) from the same in-memory content. Events here
      // are ASCII, so a char offset equals a byte offset.
      readFileFrom: (path, byteOffset) => {
        if (!path.endsWith('events.jsonl')) return Promise.resolve({ text: '', size: 0 });
        const size = Buffer.byteLength(fileText, 'utf8');
        const text =
          byteOffset >= size
            ? ''
            : Buffer.from(fileText, 'utf8').subarray(byteOffset).toString('utf8');
        return Promise.resolve({ text, size });
      },
      appendFile: (path, data) => {
        if (path.endsWith('events.jsonl')) {
          fileText += data;
          return Promise.resolve();
        }
        return fs.appendFile(path, data);
      },
      mkdir: () => Promise.resolve(),
    };
    const j = new SessionJournal(controllable, root, 'demo');
    const complete = `${JSON.stringify(evt(0))}\n${JSON.stringify(evt(1))}\n`;
    fileText = `${complete}${JSON.stringify(evt(2))}`; // event 2 is a PARTIAL trailing line (no \n yet)
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1]); // partial line left unconsumed

    fileText = `${complete}${JSON.stringify(evt(2))}\n`; // the append completes with the newline
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1, 2]); // event 2 recovered, not dropped
    // A port that implements neither the ceiling nor `from` declares no loss — the behaviour every
    // partial double had before the ceiling existed, and the one this must not change.
    expect(j.readLoss()).toBeUndefined();
  });

  /**
   * A live session's directory can be removed under it — retention used to be able to do exactly
   * that, because a directory's mtime is frozen at creation and a long drive therefore looks like
   * the oldest thing on disk. The journal latched `#dirEnsured` on the first append, so after the
   * removal every later append failed ENOENT forever while the in-memory cache kept answering
   * reads, and the loss was invisible until somebody opened the file.
   */
  it('recreates its directory when it is removed under a live session', async () => {
    const journal = new SessionJournal(fs, root, 'demo');
    await journal.appendEvents([evt(1)]);
    await fs.rm(join(root, ReticleDir.SESSIONS_SUBDIR, 'demo'));

    await journal.appendEvents([evt(2)]);
    await journal.appendAction(action());

    const reread = new SessionJournal(fs, root, 'demo');
    expect((await reread.readEvents()).map((e) => e.seq)).toEqual([2]);
    expect(await reread.readActions()).toHaveLength(1);
  });
});

/**
 * A read can come back SHORTER than the file it was sized against.
 *
 * `readFileFrom` stats the file and then reads it: a truncation, or a plain short read, returns
 * fewer bytes than the stat promised. The resume cursor must therefore be derived from the bytes
 * that ARRIVED, never from the file's end — a cursor at the stat'd end skips every record the read
 * did not return, forever, and reports nothing.
 */
describe('SessionJournal — a read that returns less than the file holds', () => {
  const root = '/root';

  /** A port that hands back at most `chunkBytes` per read, whatever the file holds. */
  function dribbleFs(file: () => string, chunkBytes: number): FileSystemPort {
    return {
      ...unusedFs(),
      readFileFrom: (path, byteOffset) => {
        if (!path.endsWith('events.jsonl')) return Promise.resolve({ text: '', size: 0 });
        const bytes = Buffer.from(file(), 'utf8');
        if (byteOffset >= bytes.length) {
          return Promise.resolve({ text: '', size: bytes.length, from: byteOffset });
        }
        const end = Math.min(bytes.length, byteOffset + chunkBytes);
        return Promise.resolve({
          text: bytes.subarray(byteOffset, end).toString('utf8'),
          size: bytes.length,
          from: byteOffset,
        });
      },
    };
  }

  /** Every member these fixtures never touch; present so the port is whole rather than cast. */
  function unusedFs(): FileSystemPort {
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

  it('resumes from the bytes it actually received, not from the end the stat reported', async () => {
    const all = [evt(0), evt(1), evt(2), evt(3)];
    const file = `${all.map((e) => JSON.stringify(e)).join('\n')}\n`;
    const twoRecords = Buffer.byteLength(
      `${[evt(0), evt(1)].map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
    const j = new SessionJournal(
      dribbleFs(() => file, twoRecords),
      root,
      'demo',
    );

    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1]);

    // A cursor taken from the stat'd size would sit at EOF here, and events 2 and 3 would never be
    // read by anybody, with no loss declared and nothing to say why the answer is short.
    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('resumes correctly when the short read ends inside a multi-byte character', async () => {
    // The trailing bytes of a cut character decode to ONE replacement char, which is not the byte
    // width of what it replaced — so a cursor measured backwards from the file's end is wrong by
    // the difference, and every line after it is spliced at the wrong place.
    const fancy = (seq: number): ReticleEvent => evt(seq, { data: { name: '🎉世界é' } });
    const all = [fancy(0), fancy(1)];
    const file = `${all.map((e) => JSON.stringify(e)).join('\n')}\n`;
    const CUT_INSIDE_LAST_EMOJI = 6;
    const j = new SessionJournal(
      dribbleFs(() => file, Buffer.byteLength(file, 'utf8') - CUT_INSIDE_LAST_EMOJI),
      root,
      'demo',
    );

    expect((await j.readEvents()).map((e) => e.seq)).toEqual([0]);

    const back = await j.readEvents();
    expect(back.map((e) => e.seq)).toEqual([0, 1]);
    expect(back[1]?.data['name']).toBe('🎉世界é'); // payload intact, no replacement char
  });

  it('declares no loss for a short read — nothing was skipped, only deferred', async () => {
    const all = [evt(0), evt(1), evt(2)];
    const file = `${all.map((e) => JSON.stringify(e)).join('\n')}\n`;
    const j = new SessionJournal(
      dribbleFs(() => file, 20),
      root,
      'demo',
    );

    await j.readEvents();

    expect(j.readLoss()).toBeUndefined();
  });
});

describe('SessionJournal — the ceiling overrides a caller can pass', () => {
  // A real port: the bounds are checked at construction, before anything is opened.
  const fs = createNodeFileSystem();

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a %s byte ceiling instead of reading with a nonsense bound', (_label, value) => {
    expect(() => new SessionJournal(fs, '/root', 'demo', { maxReadBytes: value })).toThrow(
      /maxReadBytes/,
    );
  });

  it('refuses a nonsense retention bound on the same terms', () => {
    expect(() => new SessionJournal(fs, '/root', 'demo', { maxRetainedEvents: 0 })).toThrow(
      /maxRetainedEvents/,
    );
    expect(() => new SessionJournal(fs, '/root', 'demo', { maxRetainedBytes: Number.NaN })).toThrow(
      /maxRetainedBytes/,
    );
  });

  it('accepts the bounds it is given', () => {
    expect(
      () =>
        new SessionJournal(fs, '/root', 'demo', {
          maxReadBytes: 1024,
          maxRetainedBytes: 2048,
          maxRetainedEvents: 10,
        }),
    ).not.toThrow();
  });
});
