/**
 * Write the state declaration for an app, so nobody writes one by hand. Pure.
 *
 * Two steps:
 * 1. `tableSources`: one `command` source for each table of a database, from a list of table names
 *    and a command template with `{table}` in it. `skip` removes the tables that hold no task data,
 *    such as a message queue that a background worker empties at its own time.
 * 2. `quietSources`: keep the sources that read the same on two runs of the same correct steps.
 *    A source that changes between those two runs (a session table, a log) would make every
 *    candidate fail, because the candidate's own new rows are lines that neither reference has. Such
 *    a source is kept with a time pattern removed when that makes it read the same, else dropped.
 *    Each dropped source is reported with the reason.
 *
 * A source the reference does not change is kept too: a change to it by the candidate is a
 * change to a record the task did not name.
 */
import {
  MSG_READ_FAILED,
  MSG_ROWS_CUT,
  STATE_PREFIX,
  StateSourceKind,
  type StateSource,
} from '../compare/outside/state-sources.js';

/** The word in a command template that the table name replaces. */
export const TABLE_SLOT = '{table}';
/** A table name that is safe in a shell command and in SQL without quotes. */
const TABLE_NAME = /^[A-Za-z0-9_$]+$/;
/** A date and time, with optional fractions of a second: the most common noise in a row. */
export const TIME_PATTERN = '\\d{4}-\\d\\d-\\d\\d[ T]\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?';

export interface Skipped {
  label: string;
  reason: string;
}

export function tableSources(
  names: readonly string[],
  template: string,
  container?: string,
  skip?: RegExp,
): { sources: StateSource[]; skipped: Skipped[] } {
  const sources: StateSource[] = [];
  const skipped: Skipped[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if ('' === name) {
      continue;
    }
    if (true === skip?.test(name)) {
      skipped.push({ label: name, reason: 'the name matches --skip' });
      continue;
    }
    if (!TABLE_NAME.test(name)) {
      skipped.push({ label: name, reason: 'the name has a character other than A-Z, 0-9, _ or $' });
      continue;
    }
    sources.push({
      kind: StateSourceKind.COMMAND,
      label: name,
      command: template.replaceAll(TABLE_SLOT, name),
      ...(container === undefined ? {} : { container }),
    });
  }
  return { sources, skipped };
}

/** The rows of one source in a snapshot, and the read failure when there is one. */
function rowsOf(lines: readonly string[], label: string): { rows: string[]; failed?: string } {
  const row = `${STATE_PREFIX} ${label} `;
  const cut = `${MSG_ROWS_CUT} ${label}: `;
  const failed = lines.find((line) => line.startsWith(`${MSG_READ_FAILED} ${label}: `));
  const rows = lines.filter((line) => line.startsWith(row) || line.startsWith(cut));
  return failed === undefined ? { rows } : { rows, failed };
}

function sameRows(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((line, i) => line === y[i]);
}

/** The first row that only one of the two runs has, to show why a source was dropped. */
function firstDifference(a: readonly string[], b: readonly string[]): string {
  const inA = new Set(a);
  const inB = new Set(b);
  return a.find((line) => !inB.has(line)) ?? b.find((line) => !inA.has(line)) ?? '';
}

export function quietSources(
  sources: readonly StateSource[],
  reference: readonly string[],
  again: readonly string[],
): { sources: StateSource[]; dropped: Skipped[] } {
  const kept: StateSource[] = [];
  const dropped: Skipped[] = [];
  const time = new RegExp(TIME_PATTERN, 'g');
  for (const source of sources) {
    const a = rowsOf(reference, source.label);
    const b = rowsOf(again, source.label);
    const failed = a.failed ?? b.failed;
    if (failed !== undefined) {
      dropped.push({ label: source.label, reason: failed });
      continue;
    }
    if (sameRows(a.rows, b.rows)) {
      kept.push(source);
      continue;
    }
    const untimed = (rows: string[]): string[] => rows.map((r) => r.replace(time, ''));
    if (StateSourceKind.COMMAND === source.kind && sameRows(untimed(a.rows), untimed(b.rows))) {
      kept.push({ ...source, ignore: [...(source.ignore ?? []), TIME_PATTERN] });
      continue;
    }
    dropped.push({
      label: source.label,
      reason: `it changes between two runs of the same steps: ${firstDifference(a.rows, b.rows)}`,
    });
  }
  return { sources: kept, dropped };
}
