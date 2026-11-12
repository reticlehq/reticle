/**
 * Match rows that an app deleted and wrote again with a new id. Pure.
 *
 * Many apps save a record by deleting its child rows and inserting them again. The rows hold the
 * same values, but the database gives them new auto-increment ids. A run that saves a record two
 * times then differs from a run that saves it one time, on every child row, although the data
 * means the same. That made a correct run fail.
 *
 * A text row is `state <label> <id>\t<cell>\t...`. A removed row and an added row of the same
 * table are one record when all their cells after the id are equal, after each id already matched
 * is replaced by its new id. The match records old id -> new id, so a row that refers to the
 * old id (a link to the deleted row) matches next. The loop stops when no row matches.
 *
 * A match needs two integer ids, an old id that the candidate no longer has in that table, and a
 * new id that the reference did not have in that table. So a changed value in a first column that
 * is not an id is not hidden. The caller reports how many rows matched, because this removes
 * lines from the difference.
 */
const CELL = '\t';
const INTEGER = /^\d+$/;

export interface Row {
  /** `state <label>`: the table. */
  table: string;
  id: string;
  cells: string[];
}

export function parse(line: string): Row | undefined {
  const [first, ...cells] = line.split(CELL);
  if (first === undefined || 0 === cells.length) {
    return undefined;
  }
  const space = first.lastIndexOf(' ');
  const id = first.slice(space + 1);
  return space < 0 || !INTEGER.test(id) ? undefined : { table: first.slice(0, space), id, cells };
}

/** The ids each table has in a snapshot. */
function idsOf(lines: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of lines) {
    const row = parse(line);
    if (row !== undefined) {
      const ids = out.get(row.table) ?? new Set<string>();
      ids.add(row.id);
      out.set(row.table, ids);
    }
  }
  return out;
}

const keyOf = (table: string, cells: readonly string[]): string => [table, ...cells].join(CELL);

export function renumber(
  removed: readonly string[],
  added: readonly string[],
  reference: readonly string[],
  candidate: readonly string[],
): { removed: string[]; added: string[]; renumbered: number } {
  const before = idsOf(reference);
  const after = idsOf(candidate);
  const newId = new Map<string, string>();
  const left = removed.map(parse);
  const right = added.map(parse);
  const gone = new Set<number>();
  const come = new Set<number>();
  let progress = true;
  while (progress) {
    progress = false;
    const open = new Map<string, number[]>();
    right.forEach((row, j) => {
      if (row !== undefined && !come.has(j)) {
        const key = keyOf(row.table, row.cells);
        open.set(key, [...(open.get(key) ?? []), j]);
      }
    });
    left.forEach((row, i) => {
      if (row === undefined || gone.has(i) || (after.get(row.table)?.has(row.id) ?? false)) {
        return;
      }
      const key = keyOf(
        row.table,
        row.cells.map((cell) => newId.get(cell) ?? cell),
      );
      const j = (open.get(key) ?? []).find((k) => {
        const id = right[k]?.id ?? '';
        return !come.has(k) && !(before.get(row.table)?.has(id) ?? false);
      });
      const to = j === undefined ? undefined : right[j]?.id;
      if (j === undefined || to === undefined || (newId.get(row.id) ?? to) !== to) {
        return;
      }
      newId.set(row.id, to);
      gone.add(i);
      come.add(j);
      progress = true;
    });
  }
  return {
    removed: removed.filter((_, i) => !gone.has(i)),
    added: added.filter((_, j) => !come.has(j)),
    renumbered: gone.size,
  };
}
