/**
 * Declared state sources: the data an app keeps, read as lines that `reticle compare` diffs like a
 * page read. A page read sees only the pages a sequence opens. A change to another record (the
 * price of another product) was not seen, and the candidate passed.
 *
 * The user declares each source as data. Nothing here knows one app:
 * - `command`: the output rows of a shell command on the host, or in `container` through
 *   `docker exec <container> sh -c`. A database dump goes through the database's own client.
 * - `http`: the records of a JSON endpoint. `path` is a dotted path to the array.
 * - `file`: a file of JSON records (`at` is a dotted path to the array), or of plain lines. With
 *   `container`, it is read in that container.
 *
 * `ignore` holds field names to remove from JSON records, or regular expressions to remove from text
 * rows (a time, an id that changes on each run). Each row becomes `state <label> <row>`, sorted. A
 * row that identifies a record starts with the record id, so a changed row names its record.
 *
 * I/O is injected (`StateIo`), so this file is pure.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const StateSourceKind = {
  COMMAND: 'command',
  HTTP: 'http',
  FILE: 'file',
} as const;

/**
 * Rows kept for each source. More are cut, and a line declares the cut and a digest of the cut rows.
 *
 * ponytail: the line diff is an O(n*m) table, so a source of thousands of rows makes each compared
 * sequence slow. Raise this only with a faster diff.
 */
export const STATE_ROW_CAP = 1000;

export const STATE_PREFIX = 'state';
export const MSG_READ_FAILED = 'state read failed:';
export const MSG_ROWS_CUT = 'state rows cut:';
const DIGEST_ALGORITHM = 'sha256';
const DIGEST_LENGTH = 16;

/** A short digest of the rows past the cap, so a change to one of them changes the cut line. */
const digestOf = (rows: readonly string[]): string =>
  createHash(DIGEST_ALGORITHM).update(rows.join('\n')).digest('hex').slice(0, DIGEST_LENGTH);
const PATH_SEPARATOR = '.';
const LINE_BREAK = /\r?\n/;
const ANY_LINE_BREAK = /\s*\r?\n\s*/g;

const label = z.string().min(1).describe('The name each row of this source starts with.');
const ignore = z.array(z.string()).optional();
const container = z.string().min(1).optional();

export const StateSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(StateSourceKind.COMMAND),
    label,
    command: z.string().min(1),
    container,
    ignore,
  }),
  z.strictObject({
    kind: z.literal(StateSourceKind.HTTP),
    label,
    url: z.string().min(1),
    path: z.string().optional(),
    ignore,
  }),
  z.strictObject({
    kind: z.literal(StateSourceKind.FILE),
    label,
    path: z.string().min(1),
    at: z.string().optional(),
    container,
    ignore,
  }),
]);
export type StateSource = z.infer<typeof StateSourceSchema>;

/** The `--state` file. */
export const StateDeclarationSchema = z.strictObject({
  sources: z.array(StateSourceSchema).min(1),
});

/** How the sources are read. Each method throws when the read fails. */
export interface StateIo {
  /** The standard output of `command`, run on the host, or in `container` when one is given. */
  run(command: string, container?: string): Promise<string>;
  fetchJson(url: string): Promise<unknown>;
  readFile(path: string): Promise<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && 'object' === typeof value && !Array.isArray(value);

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
};

const at = (value: unknown, path: string | undefined): unknown =>
  path === undefined
    ? value
    : path
        .split(PATH_SEPARATOR)
        .reduce<unknown>((v, key) => (isRecord(v) ? v[key] : undefined), value);

function recordRows(value: unknown, dropped: readonly string[] = []): string[] {
  const records = Array.isArray(value) ? value : [value];
  return records.map((record: unknown) => {
    if (!isRecord(record)) {
      return JSON.stringify(record);
    }
    const kept = Object.fromEntries(Object.entries(record).filter(([k]) => !dropped.includes(k)));
    return JSON.stringify(sortKeys(kept));
  });
}

function textRows(text: string, patterns: readonly string[] = []): string[] {
  const res = patterns.map((p) => new RegExp(p, 'g'));
  return text
    .split(LINE_BREAK)
    .filter((line) => '' !== line.trim())
    .map((line) => res.reduce((row, re) => row.replace(re, ''), line));
}

/** A shell word that holds `text` as it is. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** JSON records when the text is JSON, else plain lines. */
function fileRows(text: string, path: string | undefined, patterns?: readonly string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return textRows(text, patterns);
  }
  return recordRows(at(parsed, path), patterns);
}

/** The rows of one source, unsorted and without the `state <label>` prefix. Throws when the read fails. */
export async function sourceRows(source: StateSource, io: StateIo): Promise<string[]> {
  switch (source.kind) {
    case StateSourceKind.COMMAND:
      return textRows(await io.run(source.command, source.container), source.ignore);
    case StateSourceKind.HTTP:
      return recordRows(at(await io.fetchJson(source.url), source.path), source.ignore);
    case StateSourceKind.FILE: {
      const text =
        source.container === undefined
          ? await io.readFile(source.path)
          : await io.run(`cat ${shellQuote(source.path)}`, source.container);
      return fileRows(text, source.at, source.ignore);
    }
  }
}

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).trim().replace(ANY_LINE_BREAK, ' ');

/**
 * Every source, read and turned into sorted `state <label> <row>` lines, in declared order. A read
 * that fails is one `state read failed: <label>: <reason>` line. A source with more than
 * `cap` rows (`STATE_ROW_CAP` by default) keeps the first rows in sorted order, then a `state rows cut:` line. That line
 * holds a digest of the rows it cuts, so a change to a cut row still makes the reading differ.
 */
export async function readStateSources(
  sources: readonly StateSource[],
  io: StateIo,
  cap: number = STATE_ROW_CAP,
): Promise<string[]> {
  const out: string[] = [];
  for (const source of sources) {
    let rows: string[];
    try {
      rows = (await sourceRows(source, io)).sort();
    } catch (error) {
      out.push(`${MSG_READ_FAILED} ${source.label}: ${reasonOf(error)}`);
      continue;
    }
    for (const row of rows.slice(0, cap)) {
      out.push(`${STATE_PREFIX} ${source.label} ${row}`);
    }
    if (rows.length > cap) {
      out.push(
        `${MSG_ROWS_CUT} ${source.label}: kept ${String(cap)} of ${String(rows.length)}, rest ${digestOf(rows.slice(cap))}`,
      );
    }
  }
  return out;
}
