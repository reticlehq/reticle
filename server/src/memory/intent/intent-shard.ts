/**
 * The sharded intent store: one small file per subject, plus an index cheap enough to always load.
 *
 *   .reticle/intent/index.json     every id, its subject and one line of prose
 *   .reticle/intent/<subject>.json the full records for that subject
 *
 * `.reticle/intent.json` was a single unbounded object, so an agent wanting the two rules about
 * checkout pulled every other rule in the project through its context, and an agent changing one
 * rewrote the whole file — a lost write whenever two sessions touch different subjects at once. The
 * index answers "what do we know, and where does it live?" without opening anything; detail is then
 * fetched for the one subject in play, so a READ and a WRITE are both bounded to one subject.
 *
 * KNOWN LIMIT: the index is not tiny — the ids dominate it, and
 * `inline:signing-in-with-the-email-password-created-earli-6ca804e9` is 63 characters before the
 * statement starts. An order of magnitude more records needs a second tier (subjects and counts,
 * ids fetched per subject) rather than a longer single read.
 *
 * `why`, `source` and `subject` are what the legacy records had nowhere to put: the reason a thing
 * must be true, who decided it, and when. Optional, because a migrated record cannot invent them and
 * a store that rejected incomplete records would simply not be written to.
 */
import { z } from 'zod';
import { IntentSchema, type Intent } from '@reticlehq/core/artifacts';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { subjectFor, UNSORTED_SUBJECT } from './intent-subject.js';

const INTENT_SHARD_VERSION = 1;

/** Byte-stable writes: an unchanged shard produces no diff, so the ones that DID change stand out. */
const JSON_INDENT = 2;

/**
 * How settled a record is.
 *
 * Separate from the legacy `state`, which only ever described the VERIFICATION lifecycle
 * (declared → bound → proved). A rule can be agreed with the customer months before anything can
 * prove it, and collapsing those two axes is what made the old file an assertion log rather than a
 * memory.
 */
export const IntentStatus = {
  /** Captured, not yet confirmed by anyone. What an agent writes while building. */
  PROPOSED: 'proposed',
  /** Confirmed as something that must hold. May have no way to prove it yet. */
  AGREED: 'agreed',
  /** A verdict has actually shown it holds. */
  PROVED: 'proved',
  /** Believed out of date — kept, because deleting the record loses the fact it was ever true. */
  STALE: 'stale',
} as const;
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

const IntentRecordSchema = IntentSchema.extend({
  /** Which shard this lives in. Stored as well as implied, so a file read alone is self-describing. */
  subject: z.string().min(1),
  status: z.enum([
    IntentStatus.PROPOSED,
    IntentStatus.AGREED,
    IntentStatus.PROVED,
    IntentStatus.STALE,
  ]),
  /** WHY it must be true. The half the old file had no room for. */
  why: z.string().optional(),
  /** Where it came from — "the user, in conversation" beats an anonymous assertion in six months. */
  source: z.string().optional(),
  /** When it was last touched, so a stale-looking record can be told from an untouched one. */
  updatedAt: z.number().optional(),
});
export type IntentRecord = z.infer<typeof IntentRecordSchema>;

export const IntentShardSchema = z.object({
  version: z.literal(INTENT_SHARD_VERSION),
  subject: z.string().min(1),
  intents: z.record(z.string(), IntentRecordSchema),
});
export type IntentShard = z.infer<typeof IntentShardSchema>;

/**
 * How much of a statement the index carries.
 *
 * The index exists to answer WHICH SHARD, and a clause is enough to decide that; the sentence is one
 * file away. Ellipsis included so a truncated line is never mistaken for the whole intent.
 *
 * A small saving on its own — the ids dominate — but it bounds the damage a 500-character statement
 * can do to a file meant to be read every session, which is the reason to keep it.
 */
const SUMMARY_MAX = 72;

export const summarise = (statement: string): string =>
  statement.length <= SUMMARY_MAX ? statement : `${statement.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;

/** One line per intent: enough to decide whether to open the shard, and no more. */
const IntentIndexEntrySchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  statement: z.string().min(1),
  status: z.enum([
    IntentStatus.PROPOSED,
    IntentStatus.AGREED,
    IntentStatus.PROVED,
    IntentStatus.STALE,
  ]),
});
export type IntentIndexEntry = z.infer<typeof IntentIndexEntrySchema>;

export const IntentIndexSchema = z.object({
  version: z.literal(INTENT_SHARD_VERSION),
  entries: z.array(IntentIndexEntrySchema),
});
export type IntentIndex = z.infer<typeof IntentIndexSchema>;

export const emptyShard = (subject: string): IntentShard => ({
  version: INTENT_SHARD_VERSION,
  subject,
  intents: {},
});

export const emptyIndex = (): IntentIndex => ({ version: INTENT_SHARD_VERSION, entries: [] });

/** The verification lifecycle a legacy record carried, mapped onto the settledness axis. */
export const statusFromState = (state: Intent['state']): IntentStatus =>
  'proved' === state ? IntentStatus.PROVED : IntentStatus.AGREED;

/**
 * Turn a legacy intent into a record, inferring only what can be inferred.
 *
 * `why` and `source` are left ABSENT rather than filled with the statement or a placeholder. A
 * record that claims to carry a reason it does not have is worse than one that admits the gap: the
 * gap is a prompt to write the reason down, and a placeholder is a reason to stop looking.
 */
export const recordFromIntent = (intent: Intent): IntentRecord => ({
  ...intent,
  subject: subjectFor({ surface: intent.surface, binding: intent.binding }),
  status: statusFromState(intent.state),
});

/** Build the index from the shards. Derived, never hand-maintained — two sources would disagree. */
export const indexFrom = (shards: readonly IntentShard[]): IntentIndex => ({
  version: INTENT_SHARD_VERSION,
  entries: shards
    .flatMap((s) => Object.values(s.intents))
    .map((r) => ({
      id: r.id,
      subject: r.subject,
      statement: summarise(r.statement),
      status: r.status,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject) || a.id.localeCompare(b.id)),
});

/** Group records into shards by their own subject. */
export const shardsFrom = (records: readonly IntentRecord[]): IntentShard[] => {
  const bySubject = new Map<string, IntentShard>();
  for (const r of records) {
    const subject = '' === r.subject ? UNSORTED_SUBJECT : r.subject;
    const shard = bySubject.get(subject) ?? emptyShard(subject);
    shard.intents[r.id] = r;
    bySubject.set(subject, shard);
  }
  return [...bySubject.values()].sort((a, b) => a.subject.localeCompare(b.subject));
};

/** Serialise byte-stably, with keys sorted so a re-save of unchanged data is a no-op diff. */
export const serialise = (value: unknown): string =>
  `${JSON.stringify(value, (_k, v: unknown) => sortKeys(v), JSON_INDENT)}\n`;

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value) || null === value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
  );
};

/** Read and validate a JSON document. Only absence permits a fallback, never a read failure. */
export const readJsonFile = async <T>(
  fs: FileSystemPort,
  path: string,
  parse: (raw: unknown) => T,
  fallback: T,
): Promise<T> => {
  try {
    return parse(JSON.parse(await fs.readFile(path)) as unknown);
  } catch (error) {
    if (fs.isNotFound(error)) return fallback;
    throw error;
  }
};
