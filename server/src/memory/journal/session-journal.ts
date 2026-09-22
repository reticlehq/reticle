import type { z, ZodTypeAny } from 'zod';
import type { SessionId } from '@reticlehq/core';
import {
  JournalActionSchema,
  ReticleEventSchema,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  isValidSessionId,
  journalActionsPath,
  journalEventsPath,
  sessionDirPath,
} from '@/memory/project/dir/reticle-dir.js';
import type { JournalReadLoss } from './journal-recorder.js';

/**
 * The two ceilings a durable read is held to.
 *
 * Neither is a tuning number. `events.jsonl` is append-only and nothing prunes a single session's
 * file (`pruneSessions` caps how many session DIRECTORIES survive, never how large one grows), and
 * the session id lives in the page's sessionStorage, so a reload reconnects under the same id and
 * builds a fresh journal over the same file with its byte cursor back at zero. That first read
 * asked for the whole accumulated file, and V8 cannot build a string longer than 0x1fffffe8
 * characters: `Buffer.prototype.toString` throws rather than returning a shorter one. The throw came
 * out of the daemon as a raw exception on `reticle_assert` and `reticle_act_and_wait` — the only
 * tools that reach this fall-through, and the only two that produce a verdict at all.
 *
 * `MAX_READ_BYTES` bounds ONE read. That alone bounds nothing over the life of a session: reads are
 * incremental, so a thousand reads each well under the ceiling still accumulate every record they
 * parsed. `MAX_RETAINED_*` bound what the parse-cache keeps, which is the quantity that actually
 * grows with session age.
 *
 * The numbers, and what they are measured against:
 *
 *   - 32 MiB is four times the ring buffer's own byte budget (`RING_BUFFER_DEFAULTS.MAX_BYTES`), so
 *     the durable half still reaches meaningfully further back than the hot cache it backs, and
 *     roughly a sixteenth of the string ceiling above (0x1fffffe8 characters, about 512 MB of
 *     ASCII) — a margin, not an order of magnitude, and enough of one.
 *   - Retention is bounded in journal BYTES and in RECORDS, because neither alone bounds memory:
 *     bytes track the file, records track the parsed objects, and an object costs several times the
 *     JSONL it came from (see the parse-cache note below). 100k records is fifty times the ring
 *     buffer's event budget, so the fall-through is still the long-memory half by a wide margin.
 */
export const JOURNAL_READ_LIMITS = {
  /** What ONE read materialises as a single string. */
  MAX_READ_BYTES: 32 * 1024 * 1024,
  /** What the parse-cache keeps, in the journal bytes those records were parsed from. */
  MAX_RETAINED_BYTES: 32 * 1024 * 1024,
  /** What the parse-cache keeps, in records. Whichever bound binds first wins. */
  MAX_RETAINED_EVENTS: 100_000,
} as const;

/** Ceiling overrides. Injected so a test can drive a cut without writing 32 MiB of fixture. */
export interface SessionJournalOptions {
  maxReadBytes?: number;
  maxRetainedBytes?: number;
  maxRetainedEvents?: number;
}

/**
 * Reclaim the evicted prefix once it dominates the cache — the same amortized-O(1) compaction the
 * ring buffer uses, and for the same reason: shifting per evicted event is O(n) per read.
 */
const CACHE_COMPACT_AT = 1024;

/**
 * A ceiling is a whole number of bytes or records, or it is a bug upstream.
 *
 * Checked rather than coerced: `NaN` and `Infinity` both survive every arithmetic comparison a
 * bound is used in and silently disable it, which is the one failure mode a bound must not have.
 */
function boundedOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `refusing a journal ${name} that is not a positive whole number: ${String(value)}`,
    );
  }
  return value;
}

/**
 * The durable per-session journal: append-only JSONL for events and actions, the ledger the ring
 * buffer becomes a hot cache over. Writes are batched (the caller flushes ring-buffer windows), so a
 * batch is one syscall — not one per event. Reads never throw: a missing file is `[]`, a malformed or
 * schema-invalid line is skipped, matching the never-throw discipline of the run store.
 *
 * Events are already browser-edge-redacted (network/storage/DOM) before they reach the wire, so the
 * journal stores redacted payloads; the ledger is local-only. A server-side second-pass event redactor
 * is defense-in-depth for a later commit, not a correctness gate here.
 *
 * Event READS are BOUNDED at both ends — one read, and what the parse-cache keeps across reads.
 * Both keep the NEWEST records and declare what they removed through `readLoss()`. Without the read
 * ceiling a long session's file outgrew what a JavaScript string can hold and the read threw
 * instead of answering; without the retention ceiling the cache grew for the life of the session.
 * See `JOURNAL_READ_LIMITS` and `session-journal.lossy-conformance.test.ts`.
 *
 * `readActions` is NOT bounded: it reads the whole action ledger as one string and would throw the
 * same V8 string-length error on a large enough one. Left that way deliberately, and the reason is
 * the loss channel rather than the read — the action ledger is one record per tool call, so it is
 * orders of magnitude smaller than the event stream, and it is read by the run fold rather than by
 * a verdict. Bounding it needs a loss report of its own: folding an action-ledger cut into
 * `readLoss` would impeach page verdicts (through `Session.lostSince`) over a ledger that is not
 * page evidence. Do that when an action ledger is measured large, not before.
 *
 * ponytail: append-per-batch. Bounded-DISK pruning (cap session dirs / file size, "pruned like
 * runs/") is still a dedicated follow-up — the ceilings above bound what is READ, not what is
 * written. Perf ceiling: if main-thread overhead becomes visible at high event rates, coalesce
 * batches behind a flush timer.
 */
export class SessionJournal {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #sessionId: SessionId;
  #dirEnsured = false;
  // Parse-cache for the append-only EVENTS journal. queryEvents falls through to readEvents on every
  // observe/network/console call once the ring buffer has evicted (permanent ~60s into any session), so
  // a naive readEvents re-read + re-JSON.parse + re-zod-validated the WHOLE file each time — measured at
  // a 1-hour 100 ev/s session as ~1.5s CPU + ~300MB transient heap PER tool call, growing with age. The
  // journal only ever grows and is always a run of complete '\n'-terminated lines, so we keep the parsed
  // events and the char count already consumed, and parse only the tail written since the last read.
  #eventCache: (ReticleEvent | undefined)[] = [];
  /** Journal bytes each cached event was parsed from, parallel to #eventCache — the retention cost. */
  #eventCost: number[] = [];
  /** Index of the first LIVE event; [0, #cacheHead) are evicted but not yet compacted out. */
  #cacheHead = 0;
  #retainedBytes = 0;
  #eventCharsConsumed = 0; // fallback (whole-file) path: UTF-16 code units consumed
  #eventBytesConsumed = 0; // fast (bounded-read) path: UTF-8 bytes consumed, always at a '\n' boundary
  readonly #maxReadBytes: number;
  readonly #maxRetainedBytes: number;
  readonly #maxRetainedEvents: number;
  /** Journal bytes not represented in the answer: skipped by a cut, or evicted after parsing. */
  #droppedBytes = 0;
  /** Parsed records evicted from the retained set. Exact — these were counted, not estimated. */
  #droppedEvents = 0;
  /**
   * Latest parsed eviction timestamp, or +Infinity after unparsed bytes were skipped.
   * -Infinity means no loss. Later intact reads cannot narrow an unknown discarded time range.
   */
  #lostThroughT = Number.NEGATIVE_INFINITY;

  constructor(
    fs: FileSystemPort,
    root: string,
    sessionId: string,
    options: SessionJournalOptions = {},
  ) {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`refusing to journal an unsafe session id: ${sessionId}`);
    }
    this.#fs = fs;
    this.#root = root;
    this.#sessionId = sessionId;
    this.#maxReadBytes = boundedOption(
      options.maxReadBytes,
      JOURNAL_READ_LIMITS.MAX_READ_BYTES,
      'maxReadBytes',
    );
    this.#maxRetainedBytes = boundedOption(
      options.maxRetainedBytes,
      JOURNAL_READ_LIMITS.MAX_RETAINED_BYTES,
      'maxRetainedBytes',
    );
    this.#maxRetainedEvents = boundedOption(
      options.maxRetainedEvents,
      JOURNAL_READ_LIMITS.MAX_RETAINED_EVENTS,
      'maxRetainedEvents',
    );
  }

  async appendEvents(events: readonly ReticleEvent[]): Promise<void> {
    if (0 === events.length) return;
    const text = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await this.#append(journalEventsPath(this.#root, this.#sessionId), text);
  }

  async appendAction(action: JournalAction): Promise<void> {
    await this.#append(
      journalActionsPath(this.#root, this.#sessionId),
      `${JSON.stringify(action)}\n`,
    );
  }

  /**
   * The one write path, so both ledgers heal the same way.
   *
   * The session directory can VANISH under a live session: retention's count bound and byte budget
   * both used to be able to take it, because a directory's mtime is frozen at creation and a long
   * drive therefore looks like the oldest thing on disk. Both bounds now skip open sessions, but the
   * directory can also be removed by a user, by a cleanup script, or by a peer daemon sweeping the
   * same `.reticle/`, and the journal must not be one `rm` away from silently writing nothing for
   * the rest of the session.
   *
   * Retry on ENOENT rather than dropping `#dirEnsured` and calling `mkdir` before every append:
   * dropping the latch would still leave a window between the `mkdir` and the `appendFile` — small
   * is not zero, and the failure it produces is exactly the invisible one — while costing a syscall
   * on every batch, which is the cost batching exists to avoid. This pays nothing on the path that
   * works and recovers on the one that does not.
   */
  async #append(path: string, text: string): Promise<void> {
    await this.#ensureDir();
    try {
      await this.#fs.appendFile(path, text);
    } catch (error) {
      if (!this.#fs.isNotFound(error)) throw error;
      this.#dirEnsured = false;
      await this.#ensureDir();
      await this.#fs.appendFile(path, text);
    }
  }

  async readEvents(): Promise<ReticleEvent[]> {
    const path = journalEventsPath(this.#root, this.#sessionId);
    // Fast path: read only the BYTES appended since the last read, so cost tracks the tail, not the
    // whole (unboundedly growing) file. Falls back to a whole-file read for a FileSystemPort that omits
    // readFileFrom (test stubs).
    const readFrom = this.#fs.readFileFrom?.bind(this.#fs);
    if (readFrom !== undefined) {
      let chunk: { text: string; size: number; from?: number };
      try {
        chunk = await readFrom(path, this.#eventBytesConsumed, this.#maxReadBytes);
      } catch (error) {
        if (this.#fs.isNotFound(error)) return this.#liveEvents();
        throw error;
      }
      // Shrink/rotation guard (not done today): if the file is smaller than what we consumed, the offset
      // is meaningless — reset and re-read from 0. What was already declared lost stays lost: the
      // records are no less absent for the file having been rewritten under us.
      if (chunk.size < this.#eventBytesConsumed) {
        this.#resetCache();
        this.#eventBytesConsumed = 0;
        chunk = await readFrom(path, 0, this.#maxReadBytes);
      }
      // A port that implements the ceiling says where the text really starts; one that does not
      // never skips, so its start IS the offset we asked for.
      const from = chunk.from ?? this.#eventBytesConsumed;
      const skipped = Math.max(0, from - this.#eventBytesConsumed);
      this.#ingestTail(chunk.text);
      if (skipped > 0) this.#noteCut(skipped);
      // Resume at the end of the last COMPLETE line, counted forward over the bytes that actually
      // ARRIVED. Not from `chunk.size`: that is the file's end as `fstat` reported it, and a read
      // truncated or cut short returns less — a cursor there would skip every unread byte, silently
      // and permanently. Counting forward is exact because the text starts at a record boundary, so
      // its prefix up to the last newline is whole records and no replacement char can widen it.
      this.#eventBytesConsumed =
        from + Buffer.byteLength(chunk.text.slice(0, chunk.text.lastIndexOf('\n') + 1), 'utf8');
      return this.#liveEvents();
    }

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      if (this.#fs.isNotFound(error)) return this.#liveEvents();
      throw error;
    }
    // Fallback (whole-file) path: #eventCharsConsumed is a UTF-16 offset into the whole text. Shrink
    // guard, then ingest the un-consumed tail up to its last newline (see #ingestTail for the
    // partial-line rationale).
    if (text.length < this.#eventCharsConsumed) {
      this.#resetCache();
      this.#eventCharsConsumed = 0;
    }
    const end = text.lastIndexOf('\n') + 1;
    if (end > this.#eventCharsConsumed) {
      this.#ingestTail(text.slice(this.#eventCharsConsumed, end));
      this.#eventCharsConsumed = end;
    }
    return this.#liveEvents();
  }

  /** The retained events, as a copy — a caller mutating the answer must not corrupt the cache. */
  #liveEvents(): ReticleEvent[] {
    return this.#eventCache
      .slice(this.#cacheHead)
      .filter((event): event is ReticleEvent => event !== undefined);
  }

  /** Drop everything parsed so far. Declared loss is NOT reset: those records are still absent. */
  #resetCache(): void {
    this.#eventCache = [];
    this.#eventCost = [];
    this.#cacheHead = 0;
    this.#retainedBytes = 0;
  }

  /**
   * Parse complete ('\n'-terminated) JSON event lines from `tail` into #eventCache, stopping at the LAST
   * newline. A concurrent append can be observed mid-record (reads and writes run on separate libuv
   * threads), and consuming a partial trailing line would splice its tail onto the next read's head, fail
   * to parse, and drop that event forever — so the partial tail is left for the next read.
   *
   * `tail` always begins at a record boundary: when a ceiling moves a read's start, `readFileFrom`
   * drops the straddled record in BYTES before decoding, so nothing here has to guess whether a
   * leading line is whole. Enforces the retention bound before returning, so no caller can forget to.
   */
  #ingestTail(tail: string): void {
    const end = tail.lastIndexOf('\n') + 1;
    if (0 === end) return; // no complete line yet
    for (const line of tail.slice(0, end).split('\n')) {
      if (0 === line.length) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const result = ReticleEventSchema.safeParse(parsed);
      if (result.success) {
        this.#eventCache.push(result.data);
        // Its cost in the file, newline included — so the retained bound is in the same unit the
        // read ceiling and the loss report are.
        const cost = Buffer.byteLength(line, 'utf8') + 1;
        this.#eventCost.push(cost);
        this.#retainedBytes += cost;
      }
    }
    this.#evictToRetentionBound();
  }

  /**
   * Hold the parse-cache to its bounds, oldest first, and count what that cost.
   *
   * Eviction advances a HEAD index rather than shifting, and the dead prefix is compacted away only
   * once it dominates — the same amortized-O(1) shape the ring buffer uses. A `splice(0, n)` per
   * read looks cheaper and is not: `queryEvents` re-reads on every observe/network/console call, so
   * one O(n) memmove per read over a cache the size of the bound is quadratic across a session.
   *
   * Evicted payload references are cleared immediately. Empty slots can remain until compaction,
   * but they must not keep the discarded snapshots reachable.
   *
   * The newest record always survives the BYTE bound, even if it alone exceeds it. Evicting it would
   * empty the cache on every read and turn the fall-through into a permanent silent nothing.
   */
  #evictToRetentionBound(): void {
    while (
      this.#eventCache.length - this.#cacheHead > this.#maxRetainedEvents ||
      (this.#retainedBytes > this.#maxRetainedBytes &&
        this.#eventCache.length - this.#cacheHead > 1)
    ) {
      const victim = this.#eventCache[this.#cacheHead];
      const cost = this.#eventCost[this.#cacheHead] ?? 0;
      this.#retainedBytes -= cost;
      this.#droppedBytes += cost;
      this.#droppedEvents += 1;
      // Exact, unlike a byte cut: this record was parsed, so the millisecond it was lost at is known.
      if (victim !== undefined) this.#lostThroughT = Math.max(this.#lostThroughT, victim.t);
      // Release the payload now. Waiting for slot compaction keeps evicted snapshots strongly
      // reachable, so a short returned list alone would not bound retained evidence in memory.
      this.#eventCache[this.#cacheHead] = undefined;
      this.#cacheHead += 1;
    }
    if (this.#cacheHead > CACHE_COMPACT_AT && this.#cacheHead * 2 >= this.#eventCache.length) {
      this.#eventCache = this.#eventCache.slice(this.#cacheHead);
      this.#eventCost = this.#eventCost.slice(this.#cacheHead);
      this.#cacheHead = 0;
    }
  }

  /**
   * Skipped bytes have unknown timestamps: page clocks can reset while the journal id survives.
   * A surviving tail cannot bound records that were never parsed. Later intact reads cannot
   * reconstruct that history; finite bounds apply only to parsed cache evictions.
   */
  #noteCut(skippedBytes: number): void {
    this.#droppedBytes += skippedBytes;
    this.#lostThroughT = Number.POSITIVE_INFINITY;
  }

  /**
   * What these reads could not produce, or `undefined` when nothing was lost.
   *
   * A report beside the value, not inside it: the events keep the exact shape their consumers parse,
   * and a caller holding a short list can still tell it apart from a complete one. `Session.lostSince`
   * is what carries this to a verdict.
   */
  readLoss(): JournalReadLoss | undefined {
    if (0 === this.#droppedBytes && 0 === this.#droppedEvents) return undefined;
    const bounded = Number.isFinite(this.#lostThroughT);
    return {
      droppedBytes: this.#droppedBytes,
      droppedEvents: this.#droppedEvents,
      ...(bounded ? { lostThroughT: this.#lostThroughT } : {}),
      note:
        `partial — this answer is missing at least ${String(this.#droppedBytes)} byte(s) of this session's durable journal, ` +
        `including ${String(this.#droppedEvents)} record(s) evicted after parsing, ` +
        (bounded
          ? `so no window opened at or before t=${String(this.#lostThroughT)} can be answered from it; anything earlier survives only in the ring buffer.`
          : 'and the skipped records have unknown timestamps, so no window this journal answers is known complete.'),
    };
  }

  /**
   * The action ledger, whole — the one read here that is still UNBOUNDED, on purpose. See the class
   * note: it holds one record per tool call rather than one per observed event, and bounding it
   * needs a loss channel that does not impeach page verdicts.
   */
  async readActions(): Promise<JournalAction[]> {
    return this.#readLines(journalActionsPath(this.#root, this.#sessionId), JournalActionSchema);
  }

  async #ensureDir(): Promise<void> {
    if (this.#dirEnsured) return;
    await this.#fs.mkdir(sessionDirPath(this.#root, this.#sessionId));
    this.#dirEnsured = true;
  }

  async #readLines<S extends ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>[]> {
    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      if (this.#fs.isNotFound(error)) return [];
      throw error;
    }
    const out: z.infer<S>[] = [];
    for (const line of text.split('\n')) {
      if (0 === line.length) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const result = schema.safeParse(parsed);
      // Validated at this boundary; ZodTypeAny widens `.data` to any, so re-narrow to the schema output.
      if (result.success) out.push(result.data as z.infer<S>);
    }
    return out;
  }
}
