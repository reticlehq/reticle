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
 * ponytail: append-per-batch, no retention yet. Bounded-disk pruning (cap session dirs / file size,
 * "pruned like runs/") is a dedicated follow-up. Perf ceiling: if main-thread overhead becomes
 * visible at high event rates, coalesce batches behind a flush timer.
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
  #eventCache: ReticleEvent[] | undefined;
  #eventCharsConsumed = 0; // fallback (whole-file) path: UTF-16 code units consumed
  #eventBytesConsumed = 0; // fast (bounded-read) path: UTF-8 bytes consumed, always at a '\n' boundary

  constructor(fs: FileSystemPort, root: string, sessionId: string) {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`refusing to journal an unsafe session id: ${sessionId}`);
    }
    this.#fs = fs;
    this.#root = root;
    this.#sessionId = sessionId;
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
    if (this.#eventCache === undefined) this.#eventCache = [];
    // Fast path: read only the BYTES appended since the last read, so cost tracks the tail, not the
    // whole (unboundedly growing) file. Falls back to a whole-file read for a FileSystemPort that omits
    // readFileFrom (test stubs).
    const readFrom = this.#fs.readFileFrom?.bind(this.#fs);
    if (readFrom !== undefined) {
      let chunk: { text: string; size: number };
      try {
        chunk = await readFrom(path, this.#eventBytesConsumed);
      } catch (error) {
        if (this.#fs.isNotFound(error)) return this.#eventCache.slice();
        throw error;
      }
      // Shrink/rotation guard (not done today): if the file is smaller than what we consumed, the offset
      // is meaningless — reset and re-read from 0.
      if (chunk.size < this.#eventBytesConsumed) {
        this.#eventCache = [];
        this.#eventBytesConsumed = 0;
        chunk = await readFrom(path, 0);
      }
      this.#eventBytesConsumed += this.#ingestTail(chunk.text);
      return this.#eventCache.slice();
    }

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      if (this.#fs.isNotFound(error)) return this.#eventCache.slice();
      throw error;
    }
    // Fallback (whole-file) path: #eventCharsConsumed is a UTF-16 offset into the whole text. Shrink
    // guard, then ingest the un-consumed tail up to its last newline (see #ingestTail for the
    // partial-line rationale).
    if (text.length < this.#eventCharsConsumed) {
      this.#eventCache = [];
      this.#eventCharsConsumed = 0;
    }
    const end = text.lastIndexOf('\n') + 1;
    if (end > this.#eventCharsConsumed) {
      this.#ingestTail(text.slice(this.#eventCharsConsumed, end));
      this.#eventCharsConsumed = end;
    }
    return this.#eventCache.slice();
  }

  /**
   * Parse complete ('\n'-terminated) JSON event lines from `tail` into #eventCache, stopping at the LAST
   * newline. A concurrent append can be observed mid-record (reads and writes run on separate libuv
   * threads), and consuming a partial trailing line would splice its tail onto the next read's head, fail
   * to parse, and drop that event forever — so the partial tail is left for the next read. Returns the
   * UTF-8 BYTES consumed, which the bounded-read path uses to advance its byte offset.
   */
  #ingestTail(tail: string): number {
    const cache = this.#eventCache ?? (this.#eventCache = []);
    const end = tail.lastIndexOf('\n') + 1;
    if (0 === end) return 0; // no complete line yet
    const complete = tail.slice(0, end);
    for (const line of complete.split('\n')) {
      if (0 === line.length) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const result = ReticleEventSchema.safeParse(parsed);
      if (result.success) cache.push(result.data);
    }
    return Buffer.byteLength(complete, 'utf8');
  }

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
