import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

/** The JSONL record terminator, as a byte — the only boundary a capped tail read can align to. */
const NEWLINE_BYTE = 0x0a;

/**
 * The largest single `read(2)` this port will ask for: 2^31 - 1, the int32 ceiling.
 *
 * Past it `fs.read` does not throw — it ABORTS the process on a V8 assertion
 * (`node::fs::Read ... Assertion failed: args[3]->IsInt32()`, where args[3] is the length). That is
 * not catchable, so one oversized journal takes the daemon down and with it every session on the
 * machine, including unrelated ones. Reported from the field exactly that way.
 *
 * Reachable in practice because `Buffer.allocUnsafe` happily allocates well past this, so a
 * `size - start` over 2 GiB allocates fine and then kills node at the syscall. A `.reticle/sessions`
 * has been observed in the multi-gigabyte range, so "no journal is ever that big" is not a bound
 * anybody is enforcing.
 *
 * Clamping rather than throwing is deliberate: a caller reading a tail wants the newest records, and
 * returning the last 2 GiB of them is a better answer than an error. The boundary realignment below
 * already handles a window that opens mid-record, which is exactly what a clamp produces.
 */
const MAX_SINGLE_READ_BYTES = 2_147_483_647;

/**
 * Refuse an offset that cannot survive the arithmetic below.
 *
 * `length = size - start`, so a non-integer or negative offset produces a non-integer or negative
 * length, and those fail in two different ways one layer apart: `Buffer.allocUnsafe` throws a
 * RangeError for a fractional length, while an oversized one reaches `fs.read` and aborts the
 * process. Checking here means the caller gets one predictable rejection instead of either.
 */
function requireByteCount(label: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative safe integer, got ${String(value)} — a fractional or negative byte count cannot reach a read syscall safely`,
    );
  }
}

/**
 * The injectable filesystem seam. Server logic depends on this interface, never on node:fs
 * directly — so tests pass an in-memory or temp-dir adapter and never touch the repo's .reticle/.
 */
export interface FileSystemPort {
  /** Read a UTF-8 file. Rejects (ENOENT) if absent. */
  readFile(path: string): Promise<string>;
  /**
   * Read a UTF-8 file from a BYTE offset to EOF, returning the tail plus the file's total byte size.
   * The append-only journal grows unboundedly, so re-reading the whole file per query is O(N-per-call);
   * this reads only what was appended since the caller's tracked offset. Callers MUST pass an offset
   * that lands on a `\n` boundary (the journal's line terminator, 1 ASCII byte) so the returned tail
   * starts on a valid UTF-8 char boundary. Optional — a FileSystemPort that omits it makes readers fall
   * back to a whole-file read.
   *
   * `maxBytes` caps what ONE call materialises as a single string. It is not a performance knob: V8
   * cannot build a string longer than 0x1fffffe8 characters, and `Buffer.prototype.toString` THROWS
   * past that rather than returning a shorter one — so a tail bigger than the ceiling is not a slow
   * read, it is a failed one. When the cap bites, the NEWEST bytes are kept (a journal tail is read
   * to answer about what just happened).
   *
   * Two guarantees make the returned text safe to account for in bytes, and an implementation owes
   * both:
   *
   *   - `from` is where the text ACTUALLY starts. It equals `byteOffset` when nothing was skipped,
   *     and a caller can compare the two to see that a cap bit. (Omitted by a port that does not
   *     implement the cap — read that as `byteOffset`, since such a port never skips.)
   *   - When the cap moves the start, `from` lands just past a `\n`, so the text begins at a record
   *     boundary and never with the replacement char of a character the window cut in half. A
   *     window holding no `\n` at all returns empty text with `from` at the end of what was read.
   *
   * `size` is the file's length as `fstat` reported it, which is NOT where the returned text ends:
   * a truncation between the stat and the read, or any short read, returns less. Advance a cursor
   * by what arrived, never by `size`.
   */
  readFileFrom?(
    path: string,
    byteOffset: number,
    maxBytes?: number,
  ): Promise<{ text: string; size: number; from?: number }>;
  writeFile(path: string, data: string): Promise<void>;
  /** Append UTF-8 text, creating the file if absent — for the append-only JSONL journal. */
  appendFile(path: string, data: string): Promise<void>;
  /** Read raw bytes (PNG baselines). Rejects (ENOENT) if absent. */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Write raw bytes (PNG screenshots/diffs). */
  writeFileBytes(path: string, data: Uint8Array): Promise<void>;
  /** Recursive + idempotent: no throw if the directory already exists. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** List entries of a directory (for flows/baselines listing). */
  readdir(path: string): Promise<string[]>;
  /** Atomically replace `to` with `from` (same-FS rename) — for crash-safe writes. */
  rename(from: string, to: string): Promise<void>;
  /** Idempotent remove (no throw if absent) — for retention pruning + cleaning temp files. */
  rm(path: string): Promise<void>;
  /** Modification time in epoch ms — for recency-based retention pruning. Rejects if absent. */
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  /** Resolve symlinks to their real path — for upload trust-boundary checks. Rejects if absent. */
  realpath(path: string): Promise<string>;
  /** ENOENT classifier — narrows unknown without `any`, so callers can distinguish missing-file. */
  isNotFound(error: unknown): boolean;
}

/** Production adapter — the single import site of node:fs/promises in the server. */
export function createNodeFileSystem(): FileSystemPort {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    readFileFrom: async (path, byteOffset, maxBytes) => {
      requireByteCount('byteOffset', byteOffset);
      requireByteCount('maxBytes', maxBytes);
      const fh = await open(path, 'r');
      try {
        const { size } = await fh.stat();
        if (byteOffset >= size) return { text: '', size, from: byteOffset };
        // Keep the newest bytes when the tail is over the caller's ceiling. Clamped into the file
        // rather than trusted: a ceiling of zero would otherwise size a negative buffer.
        const cut =
          maxBytes === undefined ? byteOffset : Math.max(byteOffset, size - Math.max(maxBytes, 0));
        const capped = cut > byteOffset;
        // One byte BEFORE that cut, so a cut landing exactly on a record boundary is recognised as
        // one instead of sacrificing the record after it.
        const start = capped ? cut - 1 : byteOffset;
        // Clamped to the int32 ceiling: past it `fs.read` aborts the process rather than throwing.
        // Keep the NEWEST bytes, matching what every caller of a tail read is asking for.
        const want = size - start;
        const length = Math.min(want, MAX_SINGLE_READ_BYTES);
        const readFrom = start + (want - length);
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buf, 0, length, readFrom);
        // ONLY what the read returned. `allocUnsafe` hands back whatever was last in that heap
        // block, and `fstat` runs one syscall ahead of `read` — so a file truncated in between, or
        // any short read, would otherwise decode that memory and hand it back as journal text.
        const got = buf.subarray(0, bytesRead);
        if (!capped && readFrom === start) return { text: got.toString('utf8'), size, from: start };
        // The ceiling moved the start, so the window may open inside a record whose head was never
        // read. Drop up to the first boundary in BYTES, before decoding: `\n` is one byte and
        // cannot occur inside a multi-byte sequence, so everything past it is intact UTF-8 and a
        // whole number of records.
        const newline = got.indexOf(NEWLINE_BYTE);
        // No boundary in the whole window: there is no record here that can be read, and half of
        // one is worse than none. `from` still says how far the read reached.
        if (-1 === newline) return { text: '', size, from: readFrom + bytesRead };
        return {
          text: got.subarray(newline + 1).toString('utf8'),
          size,
          from: readFrom + newline + 1,
        };
      } finally {
        await fh.close();
      }
    },
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    appendFile: (path, data) => appendFile(path, data, 'utf8'),
    readFileBytes: async (path) => {
      const buf = await readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    writeFileBytes: (path, data) => writeFile(path, data),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    readdir: (path) => readdir(path),
    rename: (from, to) => rename(from, to),
    rm: async (path) => {
      // recursive so a session-journal DIRECTORY can be pruned; force so a missing path is a no-op.
      // recursive is harmless for the file-removal callers (run/flow artifacts).
      await rm(path, { recursive: true, force: true });
    },
    stat: async (path) => {
      const s = await stat(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
    realpath: (path) => realpath(path),
    isNotFound: (error) => 'ENOENT' === (error as NodeJS.ErrnoException | undefined)?.code,
  };
}
