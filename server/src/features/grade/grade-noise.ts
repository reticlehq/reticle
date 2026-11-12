/**
 * Noise by cell, not by line. Pure.
 *
 * An app writes the time of a run into a row (`updated_at`). The two correct runs then differ in that
 * cell, and the line rule ignores those two lines. But the candidate writes a third time, so its
 * line is new, and a correct run failed. Here, for each row (table and id) that differs between the
 * two correct runs, the cells that differ are noise. A removed line and an added line of the same row
 * that differ only in noise cells are not a difference. A cell the two correct runs agree on (a date
 * the task sets) is never noise.
 */
import { parse, type Row } from './grade-renumber.js';

const rowKey = (row: Row): string => `${row.table}\t${row.id}`;

/** The cells that differ between the same row of two lines. Undefined when the rows differ in shape. */
function changedCells(a: Row, b: Row): number[] | undefined {
  if (a.cells.length !== b.cells.length) {
    return undefined;
  }
  return a.cells.flatMap((cell, i) => (cell === b.cells[i] ? [] : [i]));
}

export interface NoiseCells {
  /** The reference's own line for each noisy row. */
  reference: Map<string, Row>;
  /** The cells that differ, for each noisy row. */
  cells: Map<string, Set<number>>;
}

/** For each row the two correct runs wrote differently, the cells that differ. */
export function noiseCells(
  referenceOnly: readonly string[],
  againOnly: readonly string[],
): NoiseCells {
  const again = new Map<string, Row>();
  for (const line of againOnly) {
    const row = parse(line);
    if (row !== undefined) {
      again.set(rowKey(row), row);
    }
  }
  const out: NoiseCells = { reference: new Map(), cells: new Map() };
  for (const line of referenceOnly) {
    const row = parse(line);
    const other = row === undefined ? undefined : again.get(rowKey(row));
    const cells = row === undefined || other === undefined ? undefined : changedCells(row, other);
    if (row !== undefined && cells !== undefined) {
      out.reference.set(rowKey(row), row);
      out.cells.set(rowKey(row), new Set(cells));
    }
  }
  return out;
}

/**
 * The added lines less those that differ from the reference's line of the same row only in noise
 * cells. The reference's line is already noise, so no removed line pairs with it.
 */
export function withoutNoiseCells(
  added: readonly string[],
  noise: NoiseCells,
): { added: string[]; ignored: number } {
  const kept = added.filter((line) => {
    const row = parse(line);
    const key = row === undefined ? '' : rowKey(row);
    const ours = noise.reference.get(key);
    const allowed = noise.cells.get(key);
    const cells = row === undefined || ours === undefined ? undefined : changedCells(ours, row);
    return cells === undefined || allowed === undefined || !cells.every((c) => allowed.has(c));
  });
  return { added: kept, ignored: added.length - kept.length };
}
