/**
 * The intent ledger on disk: one directory per subject, and a flow's name IS its subject.
 *
 *   .reticle/intent/index.json               every id, its subject and one line — derived
 *   .reticle/intent/<subject>/intent.json    the full records for that subject
 *
 * The ONE place intents are stored. `IntentStore` is the domain API over it (declare, bind,
 * discharge) and never writes a file of its own; `reticle_intent`'s record/get/index/subject read
 * this directly. Two stores kept in two files is how an intent written through one action became
 * invisible to the other, and an agent told its own intent does not exist concludes it does not.
 *
 * Git-checked on purpose: a human sees in review when an intent is narrowed to match what was easy
 * to prove. Writes are byte-stable, and a write that changes nothing writes nothing, because a ledger
 * that churns on every run is one whose diffs nobody reads.
 *
 * ## Migration happens on the first write, and it removes what it moved
 *
 * The old single `.reticle/intent.json` (and any interim `intent/<subject>.json`) is read until then,
 * so nothing is invisible before the move. The first write folds every record into its directory and
 * deletes the old files, so the change shows up in one reviewable diff. A legacy file that does not
 * PARSE is never deleted: a hand-merge leaves conflict markers, it reads as empty, and removing it
 * would destroy the only copy of every intent inside.
 */
import {
  IntentFileSchema,
  IntentState,
  amendIntent,
  isActionLabel,
  type Intent,
} from '@reticlehq/core/artifacts';
import { IntentDir, ReticleDir } from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { withFileLock } from '@/memory/project/file-lock.js';
import { subjectFor } from './intent-subject.js';
import type { Clock } from '@/machine/clock.js';
import {
  emptyShard,
  indexFrom,
  IntentShardSchema,
  IntentStatus,
  recordFromIntent,
  serialise,
  shardsFrom,
  statusFromState,
  type IntentIndex,
  type IntentRecord,
  type IntentShard,
} from './intent-shard.js';
import { writeFileAtomic } from '@/memory/project/fs/write-atomic.js';

const JSON_SUFFIX = '.json';
/** Beside an unparseable shard: its bytes, kept before it is rewritten. See `#shardForWrite`. */
const UNREADABLE_SUFFIX = '.unreadable-';

/** What a caller supplies to write an intent through `record`. Everything optional is optional. */
interface IntentInput {
  id: string;
  statement: string;
  subject?: string | undefined;
  why?: string | undefined;
  source?: string | undefined;
  status?: IntentStatus | undefined;
  surface?: Intent['surface'];
  binding?: unknown;
}

/** The ledger-level facts a write may set beside the intent itself. */
export interface RecordFacts {
  subject?: string | undefined;
  status?: IntentStatus | undefined;
  why?: string | undefined;
  source?: string | undefined;
}

/** A legacy file: what it held, and whether it may be deleted once moved. */
interface Legacy {
  path: string;
  records: IntentRecord[];
  parsed: boolean;
}

/** The intent fields a record is compared on — `updatedAt` alone changing is not a change. */
const comparable = (record: IntentRecord): string => serialise({ ...record, updatedAt: 0 });

export class IntentShardStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #clock: Clock;

  constructor(fs: FileSystemPort, root: string, clock: Clock) {
    this.#fs = fs;
    this.#root = root;
    this.#clock = clock;
  }

  #dir(): string {
    return `${reticleDirPaths(this.#root).root}/${ReticleDir.INTENT_SUBDIR}`;
  }

  #indexPath(): string {
    return `${this.#dir()}/${IntentDir.INDEX_FILE}`;
  }

  #shardPath(subject: string): string {
    return `${this.#dir()}/${subject}/${IntentDir.SHARD_FILE}`;
  }

  /** Parse one legacy file, remembering whether it parsed — only a parsed file may be deleted. */
  async #readLegacy(
    pathOf: () => string,
    toRecords: (raw: unknown) => IntentRecord[],
  ): Promise<Legacy> {
    let path = '';
    let text: string;
    try {
      // Resolved INSIDE the try: with no known project root there is no path, and that must read as
      // "no legacy file" — the old store failed soft here, and a caller only asking what is still
      // open must not be taken down by it.
      path = pathOf();
      text = await this.#fs.readFile(path);
    } catch {
      return { path, records: [], parsed: true };
    }
    try {
      return { path, records: toRecords(JSON.parse(text) as unknown), parsed: true };
    } catch {
      return { path, records: [], parsed: false };
    }
  }

  /** The old single file, and any interim `intent/<subject>.json` from before directories. */
  async #legacySources(): Promise<Legacy[]> {
    const flat = await this.#readLegacy(
      () => reticleDirPaths(this.#root).intent,
      (raw) => Object.values(IntentFileSchema.parse(raw).intents).map(recordFromIntent),
    );
    const interim = await Promise.all(
      (await this.#entries())
        .filter((e) => e.endsWith(JSON_SUFFIX) && IntentDir.INDEX_FILE !== e)
        .map((e) =>
          this.#readLegacy(
            () => `${this.#dir()}/${e}`,
            (raw) => Object.values(IntentShardSchema.parse(raw).intents),
          ),
        ),
    );
    return [flat, ...interim].filter((l) => l.records.length > 0 || !l.parsed);
  }

  async #entries(): Promise<string[]> {
    try {
      return await this.#fs.readdir(this.#dir());
    } catch {
      return [];
    }
  }

  /**
   * Which subjects exist, read from the DIRECTORY rather than the index.
   *
   * The index is derived from the shards, so discovering shards through it would be circular: a new
   * subject was once invisible to the very write that created it. Listing the directory also makes
   * the index self-healing — delete it and the next write rebuilds it from what is actually there.
   */
  async #subjectsOnDisk(): Promise<string[]> {
    const subjects: string[] = [];
    for (const entry of await this.#entries()) {
      if (entry.endsWith(JSON_SUFFIX)) continue;
      if (await this.#fs.exists(this.#shardPath(entry))) subjects.push(entry);
    }
    return subjects;
  }

  async #readShard(subject: string): Promise<IntentShard> {
    try {
      return IntentShardSchema.parse(JSON.parse(await this.#fs.readFile(this.#shardPath(subject))));
    } catch {
      return emptyShard(subject);
    }
  }

  /**
   * A shard about to be rewritten, read so that nothing in it can be lost.
   *
   * `#readShard` answers "what is recorded here" and treats an unparseable shard as empty, which is
   * right for reading and wrong for rewriting: the next write put "empty plus one record" over a file
   * that held every other intent for that subject (#994). An unreadable shard's bytes are copied
   * beside it, untouched, before it is replaced, the same rule migration keeps for a legacy file it
   * cannot parse. A missing shard is simply empty.
   */
  async #shardForWrite(subject: string): Promise<IntentShard> {
    const path = this.#shardPath(subject);
    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch {
      return emptyShard(subject);
    }
    try {
      return IntentShardSchema.parse(JSON.parse(text));
    } catch {
      await writeFileAtomic(
        this.#fs,
        `${path}${UNREADABLE_SUFFIX}${String(this.#clock.now())}`,
        text,
      );
      return emptyShard(subject);
    }
  }

  async #storedRecords(): Promise<IntentRecord[]> {
    const shards = await Promise.all((await this.#subjectsOnDisk()).map((s) => this.#readShard(s)));
    return shards.flatMap((s) => Object.values(s.intents));
  }

  /** Every record: the directories, plus any legacy intent not yet moved. Directories win. */
  async all(): Promise<IntentRecord[]> {
    const merged = new Map<string, IntentRecord>();
    for (const legacy of await this.#legacySources()) {
      for (const record of legacy.records) merged.set(record.id, record);
    }
    for (const record of await this.#storedRecords()) merged.set(record.id, record);
    return [...merged.values()].sort(
      (a, b) => a.declaredAt - b.declaredAt || a.id.localeCompare(b.id),
    );
  }

  /** The cheap read: one line per intent. Derived from disk, never from the stored copy. */
  async index(): Promise<IntentIndex> {
    return indexFrom(shardsFrom(await this.all()));
  }

  /** Every record for one subject — the working read, once an agent knows what it is touching. */
  async subject(name: string): Promise<IntentRecord[]> {
    return (await this.all()).filter((r) => name === r.subject);
  }

  /** One record by id, or null. */
  async get(id: string): Promise<IntentRecord | null> {
    return (await this.all()).find((r) => id === r.id) ?? null;
  }

  /**
   * Create or change ONE intent atomically: read, transform, write, under the ledger's lock.
   *
   * `transform` returns the next intent, or undefined for "leave it as it is". A result equal to
   * what is stored writes nothing. Returns the stored record, or undefined when nothing was there
   * and nothing was created.
   */
  async upsert(
    id: string,
    transform: (existing: IntentRecord | undefined) => Intent | undefined,
    facts: RecordFacts = {},
  ): Promise<IntentRecord | undefined> {
    return withFileLock(this.#indexPath(), async () => {
      await this.#migrateLegacy();
      await this.#retireLabels();
      const existing = (await this.#storedRecords()).find((r) => id === r.id);
      const next = transform(existing);
      if (next === undefined) return existing;
      const record = this.#recordFrom(amendIntent(existing, next), existing, facts);
      if (existing !== undefined && comparable(existing) === comparable(record)) return existing;
      await this.#write(record, existing?.subject);
      return record;
    });
  }

  /**
   * The ledger-level fields of a record: where it lives and how settled it is.
   *
   * A flow's name IS its subject, so an intent a flow claims moves into that flow's directory.
   * Otherwise an explicit subject wins, then the one it already had, then inference.
   */
  #recordFrom(next: Intent, existing: IntentRecord | undefined, facts: RecordFacts): IntentRecord {
    const flow = next.surface?.flow;
    const subject =
      flow !== undefined
        ? subjectFor({ surface: { flow } })
        : (facts.subject ??
          existing?.subject ??
          subjectFor({ surface: next.surface, binding: next.binding }));
    const why = facts.why ?? existing?.why;
    const source = facts.source ?? existing?.source;
    return {
      ...existing,
      ...next,
      subject,
      status: this.#statusOf(next, existing, facts.status),
      updatedAt: this.#clock.now(),
      ...(why === undefined ? {} : { why }),
      ...(source === undefined ? {} : { source }),
    };
  }

  /**
   * How settled the record is. A verdict proving it makes it proved; losing that proof (the words
   * changed, a different check was bound) steps it back rather than leaving a stale "proved".
   */
  #statusOf(
    next: Intent,
    existing: IntentRecord | undefined,
    asked: IntentStatus | undefined,
  ): IntentStatus {
    if (asked !== undefined) return asked;
    if (IntentState.PROVED === next.state) return IntentStatus.PROVED;
    if (IntentStatus.PROVED === existing?.status) return statusFromState(next.state);
    return existing?.status ?? IntentStatus.PROPOSED;
  }

  /** Write one intent through `reticle_intent { action: "record" }`, merging onto what is stored. */
  async record(input: IntentInput): Promise<IntentRecord> {
    const now = this.#clock.now();
    const stored = await this.upsert(
      input.id,
      (existing) => ({
        ...(existing ?? { id: input.id, state: IntentState.DECLARED, declaredAt: now }),
        statement: input.statement,
        ...(input.surface === undefined ? {} : { surface: input.surface }),
        ...(input.binding === undefined ? {} : { binding: input.binding }),
      }),
      { subject: input.subject, status: input.status, why: input.why, source: input.source },
    );
    // upsert only returns undefined when the transform declines, and this one never does.
    return stored as IntentRecord;
  }

  /** Persist one record, rewriting its shard and the index, and removing it from its old shard. */
  async #write(record: IntentRecord, previousSubject?: string): Promise<void> {
    if (previousSubject !== undefined && record.subject !== previousSubject) {
      const old = await this.#shardForWrite(previousSubject);
      const { [record.id]: _moved, ...rest } = old.intents;
      await this.#putShard({ ...old, intents: rest });
    }
    const shard = await this.#shardForWrite(record.subject);
    shard.intents[record.id] = record;
    await this.#putShard(shard);
    await this.#writeIndex();
  }

  /** Write a shard, or remove it when it no longer holds anything. */
  async #putShard(shard: IntentShard): Promise<void> {
    const path = this.#shardPath(shard.subject);
    if (0 === Object.keys(shard.intents).length) {
      await this.#fs.rm(path).catch(() => undefined);
      return;
    }
    // Checked against the schema the reader applies, BEFORE it reaches the disk: a record the
    // reader would refuse makes the whole shard unreadable, and every other intent in it with it.
    // Refused here, loudly, where the one bad write is still the caller's to fix (#1020).
    const valid = IntentShardSchema.parse(shard);
    await this.#fs.mkdir(`${this.#dir()}/${shard.subject}`);
    await writeFileAtomic(this.#fs, path, serialise(valid));
  }

  async #writeIndex(): Promise<void> {
    await this.#fs.mkdir(this.#dir());
    const index = indexFrom(shardsFrom(await this.#storedRecords()));
    await writeFileAtomic(this.#fs, this.#indexPath(), serialise(index));
  }

  /**
   * Move every legacy record into its directory, then remove the legacy files that parsed.
   * Called under the lock by every write, so the first write after an upgrade is the migration.
   */
  async #migrateLegacy(): Promise<{ migrated: IntentRecord[] }> {
    const sources = await this.#legacySources();
    if (0 === sources.length) return { migrated: [] };
    const known = new Set((await this.#storedRecords()).map((r) => r.id));
    const incoming = sources.flatMap((s) => s.records).filter((r) => !known.has(r.id));
    for (const shard of shardsFrom(incoming)) {
      const current = await this.#shardForWrite(shard.subject);
      await this.#putShard({ ...current, intents: { ...shard.intents, ...current.intents } });
    }
    for (const source of sources) {
      if (source.parsed) await this.#fs.rm(source.path).catch(() => undefined);
    }
    await this.#writeIndex();
    return { migrated: incoming };
  }

  /**
   * Mark every stored step label stale: "click button \"Cancel\"" describes what was DONE, not a
   * rule. Kept rather than deleted, because removing a record loses the fact it was ever written.
   * Runs with every write, and writes nothing once there is nothing left to retire.
   */
  async #retireLabels(): Promise<number> {
    const labels = (await this.#storedRecords()).filter(
      (r) => IntentStatus.STALE !== r.status && isActionLabel(r.statement),
    );
    if (0 === labels.length) return 0;
    for (const subject of new Set(labels.map((r) => r.subject))) {
      const shard = await this.#shardForWrite(subject);
      for (const record of labels.filter((r) => subject === r.subject)) {
        shard.intents[record.id] = {
          ...record,
          status: IntentStatus.STALE,
          updatedAt: this.#clock.now(),
        };
      }
      await this.#putShard(shard);
    }
    await this.#writeIndex();
    return labels.length;
  }

  /** `reticle_intent { action: "migrate" }`: do now what the next write would do anyway. */
  async migrate(): Promise<{ migrated: number; subjects: string[] }> {
    return withFileLock(this.#indexPath(), async () => {
      const { migrated } = await this.#migrateLegacy();
      await this.#retireLabels();
      return {
        migrated: migrated.length,
        subjects: [...new Set(migrated.map((r) => r.subject))].sort(),
      };
    });
  }
}
