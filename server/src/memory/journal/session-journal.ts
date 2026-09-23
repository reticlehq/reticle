import type { z, ZodTypeAny } from 'zod';
import type { SessionId } from '@reticlehq/core';
import {
  EventType,
  JOURNAL_FILE_VERSION,
  JournalActionSchema,
  JournalWriteLossSchema,
  ReticleEventSchema,
  TruncationChannel,
  type JournalAction,
  type JournalWriteLoss,
  type ReticleEvent,
} from '@reticlehq/core';
import { log } from '@/log.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  isValidSessionId,
  journalActionsPath,
  journalClosedPath,
  journalEventsPath,
  sessionDirPath,
} from '@/memory/project/dir/reticle-dir.js';
import type { JournalLedgerSize, JournalReadLoss } from './journal-recorder.js';

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
 * Default byte budget for one serialized writer's event ledger (#986).
 *
 * A ledger may exceed this by one bounded truncation marker. Existing oversized files are not
 * deleted or rewritten; they stop accepting event batches. This is a per-event-file limit, not a
 * workspace-wide quota, and does not bound action journals or concurrent independent writers.
 */
export const JOURNAL_EVENT_BYTES_CAP = 64 * 1024 * 1024;

/** Construction-time knobs. The cap is injected so a test can prove the bound at a few kilobytes. */
export interface SessionJournalOptions {
  /** Byte ceiling for this session's event ledger. Defaults to {@link JOURNAL_EVENT_BYTES_CAP}. */
  eventBytesCap?: number;
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
 * The event ledger is also bounded on the WRITE side — see {@link JOURNAL_EVENT_BYTES_CAP} and
 * `#closeAtCap`. Session directories are pruned by recency in `on-disk/retention.ts`; this is the
 * per-file half of the same question, and the half a single runaway session needs. The two ceilings
 * answer different questions and neither substitutes for the other: one stops a read from throwing,
 * the other stops the file from growing without end.
 *
 * `readActions` is NOT bounded: it reads the whole action ledger as one string and would throw the
 * same V8 string-length error on a large enough one. Left that way deliberately, and the reason is
 * the loss channel rather than the read — the action ledger is one record per tool call, so it is
 * orders of magnitude smaller than the event stream, and it is read by the run fold rather than by
 * a verdict. Bounding it needs a loss report of its own: folding an action-ledger cut into
 * `readLoss` would impeach page verdicts (through `Session.lostSince`) over a ledger that is not
 * page evidence. Do that when an action ledger is measured large, not before.
 *
 * ponytail: append-per-batch. Perf ceiling: if main-thread overhead becomes visible at high event
 * rates, coalesce batches behind a flush timer.
 */
export class SessionJournal {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #sessionId: SessionId;
  readonly #eventBytesCap: number;
  #dirEnsured = false;
  /**
   * Bytes of `events.jsonl` on disk, or undefined until the first append reads the file's real size.
   *
   * Seeded from `stat` rather than counted from zero, because a session id survives a reload (it
   * lives in sessionStorage) and the next connection reopens the SAME file. A per-connection budget
   * would let a reload loop grow the ledger by a whole cap each time, which is the bug with an extra
   * step in it.
   */
  #eventBytes: number | undefined;
  /**
   * The ledger's closure report, once known — `undefined` means open, and `#lossLoaded` says which.
   *
   * Read from disk rather than remembered, because a fresh object is exactly what a reconnect
   * produces. The first implementation of this cap held the closed state in a boolean field, so the
   * ledger reopened on every connection: it re-appended a declaration line each time (a file that
   * still grew without bound, slower, while claiming a hard ceiling), and where the refused batch
   * had been large enough to leave room under the ceiling it also accepted the NEXT small batch —
   * writing events after the marker that says the ledger stopped.
   */
  #writeLoss: JournalWriteLoss | undefined;
  #lossLoaded = false;
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
    const cap = options.eventBytesCap ?? JOURNAL_EVENT_BYTES_CAP;
    // Checked rather than trusted, because every way of getting this wrong fails SILENTLY as a
    // journal that quietly stopped writing: zero and negatives refuse every batch, a fraction is a
    // ceiling no byte count can ever equal, and NaN makes every comparison false so the bound is
    // simply absent. Refusing at construction turns all four into a crash at the one place that
    // names the value.
    if (!Number.isSafeInteger(cap) || cap <= 0) {
      throw new Error(
        `refusing to journal against a ${String(cap)}-byte event cap: expected a positive whole number of bytes`,
      );
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
    this.#eventBytesCap = cap;
  }

  /**
   * Append a batch, or refuse it at the byte cap and say so.
   *
   * A batch is accepted whole or not at all. This preserves the batch's ordering and avoids
   * representing only part of a refused batch as successfully persisted evidence.
   *
   * REFUSAL, not rotation. Rotation keeps the newest evidence, which is the better policy in the
   * abstract, but it shrinks the file — and `readEvents` tracks a byte offset into it, so a rotation
   * resets that cursor and the reader silently returns FEWER events than it did a call earlier, with
   * nothing to say why. Refusal keeps the file monotonic, so every cursor stays valid, no evidence
   * already on disk is deleted, and the loss is at the end where it can be declared.
   */
  async appendEvents(events: readonly ReticleEvent[]): Promise<void> {
    if (0 === events.length) return;
    // Durable, not a field: see #writeLoss. A closed ledger is closed for a one-event batch too.
    if ((await this.#closureReport()) !== undefined) return;
    await this.#ensureDir();
    const path = journalEventsPath(this.#root, this.#sessionId);
    const written = await this.#eventBytesOnDisk(path);
    const budget = this.#eventBytesCap - written;
    // Serialized INCREMENTALLY, stopping the moment the batch has outgrown what is left. Building
    // the whole string first means the runaway session pays full serialization cost and peak memory
    // for every batch it will never be allowed to write — the flood stops costing disk and keeps
    // costing everything else. Nothing here touches the caller's events.
    const lines: string[] = [];
    let bytes = 0;
    for (const event of events) {
      const line = `${JSON.stringify(event)}\n`;
      bytes += Buffer.byteLength(line, 'utf8');
      if (bytes > budget) {
        await this.#closeAtCap(path, written, events);
        return;
      }
      lines.push(line);
    }
    await this.#fs.appendFile(path, lines.join(''));
    this.#eventBytes = written + bytes;
  }

  /**
   * Bytes already in the ledger, read once from disk per instance then tracked in memory.
   *
   * Seeded from `stat` rather than counted from zero, because a session id survives a reload (it
   * lives in sessionStorage) and the next connection reopens the SAME file.
   */
  async #eventBytesOnDisk(path: string): Promise<number> {
    const known = this.#eventBytes;
    if (known !== undefined) return known;
    let size: number;
    try {
      size = (await this.#fs.stat(path)).size;
    } catch (error) {
      // ENOENT is the ONLY absence. A permission change, an IO error, a directory where the ledger
      // belongs — each of those is a size nobody knows, and answering zero there hands the writer a
      // full budget over a file that may already be at the ceiling, then CACHES that zero so every
      // later batch on this connection is measured against an empty file. The cap would be disabled
      // by exactly the conditions most likely to accompany a failing disk. Thrown before anything is
      // appended; `JournalRecorder` swallows sink errors, so a live session is never taken down by
      // one.
      if (!this.#fs.isNotFound(error)) throw error;
      size = 0;
    }
    this.#eventBytes = size;
    return size;
  }

  /**
   * The ledger's closure report, or `undefined` while it is still open. Read from disk once.
   *
   * A present-but-unparseable report still means CLOSED: its presence is the durable fact and its
   * contents are the detail. Reading a corrupted note as "no closure" would reopen a ledger that
   * was deliberately shut, which is the one answer that cannot be right. The details are reported
   * absent rather than reconstructed from what is true now — this instance's ceiling is not
   * necessarily the ceiling that closed the file.
   */
  async #closureReport(): Promise<JournalWriteLoss | undefined> {
    if (this.#lossLoaded) return this.#writeLoss;
    let text: string;
    try {
      text = await this.#fs.readFile(journalClosedPath(this.#root, this.#sessionId));
    } catch (error) {
      // Same rule as the size read above, and for the same reason: only ENOENT is "never closed".
      if (!this.#fs.isNotFound(error)) throw error;
      this.#lossLoaded = true;
      return undefined;
    }
    this.#lossLoaded = true;
    this.#writeLoss = parseClosureReport(text);
    return this.#writeLoss;
  }

  /**
   * What this session's durable ledger lost on the WRITE side, or `undefined` if it lost nothing.
   *
   * The half the in-band marker cannot cover. That record carries the `t` of the last refused event
   * and every journal-backed query filters on `t`, so a window opened after the ceiling was reached
   * holds no marker and no events — which is indistinguishable from a complete window in which
   * nothing happened. Named `readWriteLoss` because it is the WRITER's loss: what never reached the
   * file, as opposed to what a bounded read declined to hand back.
   */
  async readWriteLoss(): Promise<JournalWriteLoss | undefined> {
    return this.#closureReport();
  }

  /**
   * The ledger's size against its ceiling, once the size is known.
   *
   * `undefined` before the first append, because `#eventBytes` is seeded from `stat` at that point
   * and a zero reported before it is measured would be a claim rather than a reading.
   */
  ledger(): JournalLedgerSize | undefined {
    const bytes = this.#eventBytes;
    return bytes === undefined ? undefined : { bytes, capBytes: this.#eventBytesCap };
  }

  /**
   * Close the ledger for good, and declare the loss twice — durably, then in-band.
   *
   * The two declarations do different jobs and neither replaces the other. The sidecar report is the
   * GATE: it is what makes the closure survive the reconnect that reopens this file with a fresh
   * object, and it is the only declaration a time-windowed query cannot filter away. The in-band
   * `TRUNCATED` record is the COURTESY: every reader of this file already reads `ReticleEvent`s, so
   * it needs no new field, no new interface and no new allowlist, and `EventType.TRUNCATED` is the
   * vocabulary the browser's own per-channel caps already use — this adds a channel, not a second
   * mechanism.
   *
   * Written in that order deliberately. A failure between the two leaves a ledger that is closed
   * with no in-band marker, which `readWriteLoss` still reports; the other order leaves a ledger
   * that is marked and not closed, so the next connection would mark it again and the file would
   * keep growing one line per reload. The failure that would hit here is a disk that cannot take
   * another byte, which is precisely the condition this cap exists for, so the order is chosen for
   * how it fails rather than for how it reads.
   *
   * `t` is the last record's timestamp in the first refused batch, not a measured start of loss.
   * The sidecar reports closure independently of that timestamp so later queries cannot hide it.
   *
   * The marker line is allowed past the ceiling. That is the whole overrun: ONE line, once, for the
   * life of the ledger — not one per connection, which was this method's first shape.
   */
  async #closeAtCap(
    path: string,
    written: number,
    refused: readonly ReticleEvent[],
  ): Promise<void> {
    const last = refused[refused.length - 1];
    const loss: JournalWriteLoss = {
      v: JOURNAL_FILE_VERSION,
      channel: TruncationChannel.JOURNAL,
      capBytes: this.#eventBytesCap,
      bytesOnDisk: written,
      droppedInBatch: refused.length,
      at: last?.t ?? 0,
    };
    // In memory first, so this instance refuses everything after this point even if a write below
    // throws. A half-closed ledger must still be a closed one.
    this.#writeLoss = loss;
    this.#lossLoaded = true;
    log('journal_events_cap_reached', {
      sessionId: this.#sessionId,
      capBytes: this.#eventBytesCap,
      writtenBytes: written,
      droppedEvents: refused.length,
    });
    await this.#fs.writeFile(
      journalClosedPath(this.#root, this.#sessionId),
      `${JSON.stringify(loss)}\n`,
    );
    const declaration: ReticleEvent = {
      t: loss.at ?? 0,
      type: EventType.TRUNCATED,
      sessionId: this.#sessionId,
      data: { channel: TruncationChannel.JOURNAL, dropped: refused.length },
    };
    const line = `${JSON.stringify(declaration)}\n`;
    await this.#fs.appendFile(path, line);
    this.#eventBytes = written + Buffer.byteLength(line, 'utf8');
  }

  async appendAction(action: JournalAction): Promise<void> {
    await this.#ensureDir();
    await this.#fs.appendFile(
      journalActionsPath(this.#root, this.#sessionId),
      `${JSON.stringify(action)}\n`,
    );
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
      // Shrink guard: if the file is smaller than what we consumed, the offset is meaningless — reset
      // and re-read from 0. The writer never rotates (see appendEvents), so this is defence against an
      // outside hand on the file, not a path the journal itself takes. What was already declared lost
      // stays lost: the records are no less absent for the file having been rewritten under us.
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

/**
 * The closure report a session's sidecar holds — details when it can be read, the bare fact when not.
 *
 * Never `undefined`: this is only ever called on a file that EXISTS, and the existence is the claim.
 * Unparseable bytes cost the numbers, not the closure, so the fallback states the channel and stops
 * there. Guessing the rest from the current ceiling would put a value that was never measured into
 * the one field a reader consults to decide whether evidence is complete.
 */
function parseClosureReport(text: string): JournalWriteLoss {
  const closed: JournalWriteLoss = { v: JOURNAL_FILE_VERSION, channel: TruncationChannel.JOURNAL };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return closed;
  }
  const result = JournalWriteLossSchema.safeParse(parsed);
  return result.success ? result.data : closed;
}
