/**
 * Decisions made on the dashboard, brought down to the record of the person whose words were set
 * aside.
 *
 * A maintainer settled a disagreement by keeping the team's words; the author's own record still
 * said hers, agreed, and her daemon re-sent it every minute, so the same decision was made three
 * times. The platform returns each memory entry with the decisions taken on it; a local record
 * whose statement one of them set aside takes the words that were kept, and says who decided.
 */
import { asRecord, asString } from '@reticlehq/core';
import type { IntentShardStore } from './intent-shard-store.js';

/** One settled disagreement: the words kept, the words set aside, and who chose. */
export interface SettledWords {
  kept: string;
  setAside: string;
  by?: string;
}

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
    if (kept === undefined || !Array.isArray(decisions)) return [];
    return decisions.flatMap((d: unknown) => {
      const setAside = str(asRecord(asRecord(d)['setAside'])['statement']);
      const by = str(asRecord(d)['byEmail']);
      return setAside === undefined || setAside === kept
        ? []
        : [{ kept, setAside, ...(by === undefined ? {} : { by }) }];
    });
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
    const decision = settled.find((s) => s.setAside === record.statement);
    if (decision === undefined) continue;
    const next = await store.upsert(
      record.id,
      (existing) =>
        existing === undefined ? undefined : { ...existing, statement: decision.kept },
      { source: decidedBy(decision.by) },
    );
    if (next?.statement === decision.kept) changed += 1;
  }
  return changed;
}
