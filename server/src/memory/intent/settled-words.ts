/**
 * Decisions made on the dashboard, brought down to the record of the person whose words were set
 * aside.
 *
 * A maintainer settled a disagreement by keeping the team's words; the author's own record still
 * said hers, agreed, and her daemon re-sent it every minute, so the same decision was made three
 * times. The platform returns each memory entry with the decisions taken on it; a local record
 * whose statement one of them set aside takes the words that were kept, and says who decided.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { asRecord, asString } from '@reticlehq/core';
import type { IntentShardStore } from './intent-shard-store.js';
import { IntentStatus } from './intent-shard.js';

/**
 * One settled disagreement: the words kept, the words set aside, and who chose — or, with no words
 * set aside, the status the team settled on the kept words.
 */
export interface SettledWords {
  kept: string;
  setAside?: string;
  by?: string;
  status?: IntentStatus;
  /** The file the platform holds for the kept words; a record re-sent without it erased it there. */
  file?: string;
}

/** How settled each status is; a record is only ever raised along it, never lowered. */
const RANK: Readonly<Record<IntentStatus, number>> = {
  [IntentStatus.PROPOSED]: 0,
  [IntentStatus.AGREED]: 1,
  [IntentStatus.PROVED]: 2,
  [IntentStatus.STALE]: 1,
};

/** A status the platform settled, read defensively; proposed settles nothing. */
const settledStatus = (value: unknown): IntentStatus | undefined =>
  [IntentStatus.AGREED, IntentStatus.PROVED, IntentStatus.STALE].find((s) => s === value);

const str = (value: unknown): string | undefined => {
  const text = asString(value);
  return text === undefined || 0 === text.length ? undefined : text;
};

/** The settled disagreements in the platform's memory entries, read defensively. */
export function settledWordsIn(entries: readonly unknown[]): SettledWords[] {
  return entries.flatMap((raw) => {
    const entry = asRecord(raw);
    const kept = str(entry['statement']);
    const decisions = entry['decisions'];
    const status = settledStatus(entry['status']);
    const file = str(entry['sourceFile']);
    if (kept === undefined) return [];
    const settled = status === undefined ? [] : [{ kept, status }];
    if (!Array.isArray(decisions)) return settled;
    return decisions
      .flatMap((d: unknown): SettledWords[] => {
        const setAside = str(asRecord(asRecord(d)['setAside'])['statement']);
        const by = str(asRecord(d)['byEmail']);
        return setAside === undefined || setAside === kept
          ? []
          : [
              {
                kept,
                setAside,
                ...(by === undefined ? {} : { by }),
                ...(file === undefined ? {} : { file }),
              },
            ];
      })
      .concat(settled);
  });
}

/** Where the record's words now come from. */
const decidedBy = (by: string | undefined): string =>
  `decided on the dashboard${by === undefined ? '' : ` by ${by}`}`;

/** Apply them to the local records; returns how many records changed. */
export async function applySettledWords(
  store: IntentShardStore,
  settled: readonly SettledWords[],
): Promise<number> {
  if (0 === settled.length) return 0;
  let changed = 0;
  for (const record of await store.all()) {
    // The team settled these very words: the record takes that status, so this machine never
    // re-sends them as proposed and undoes the decision. Raised only, never lowered.
    const status = settled.find(
      (s) => s.status !== undefined && s.kept === record.statement,
    )?.status;
    if (status !== undefined && RANK[status] > RANK[record.status]) {
      const raised = await store.upsert(record.id, (existing) => existing, {
        status,
        source: decidedBy(undefined),
      });
      if (raised?.status === status) changed += 1;
      continue;
    }
    const decision = settled.find((s) => s.setAside === record.statement);
    if (decision === undefined) continue;
    const next = await store.upsert(
      record.id,
      (existing) =>
        // The check bound to the words set aside proves nothing about the words kept.
        existing === undefined
          ? undefined
          : {
              ...withoutBinding(existing),
              statement: decision.kept,
              // The files were the set-aside words'; the kept words carry the platform's.
              surface: {
                ...existing.surface,
                files: decision.file === undefined ? [] : [decision.file],
              },
            },
      { source: decidedBy(decision.by) },
    );
    if (next?.statement === decision.kept) changed += 1;
  }
  return changed;
}

/** A record with its bound check taken off: the words it was bound to were set aside. */
function withoutBinding<T extends { binding?: unknown }>(record: T): Omit<T, 'binding'> {
  const { binding: _dropped, ...rest } = record;
  return rest;
}

/**
 * The agent's recorded request, with each statement a decision set aside replaced by the words kept:
 * a run reports it as "What was asked", and the run that proved the kept words showed the rejected
 * ones as its goal. Never throws; no request, nothing to change.
 */
export async function keptWordsInRequest(
  path: string,
  settled: readonly SettledWords[],
): Promise<void> {
  const decided = settled.filter(
    (s): s is SettledWords & { setAside: string } => s.setAside !== undefined,
  );
  if (0 === decided.length) return;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const statements = Array.isArray(raw['statements']) ? raw['statements'] : [];
    let changed = false;
    const next = statements.map((s: unknown) => {
      const statement = asRecord(s);
      const kept = decided.find((d) => d.setAside === statement['text'])?.kept;
      if (kept === undefined) return s;
      changed = true;
      return { ...statement, text: kept };
    });
    if (changed)
      await writeFile(path, `${JSON.stringify({ ...raw, statements: next }, null, 2)}\n`);
  } catch {
    // No request recorded, or one this cannot read: nothing to correct.
  }
}
