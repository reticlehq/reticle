/**
 * `reticle grade`: grade a finished run of an app from snapshots of its stored data.
 *
 * - `snapshot` reads the declared state sources (and the page the run ended on) into a file.
 * - `judge` compares a candidate snapshot with two reference snapshots, and checks the final answer
 *   against a source read at grade time.
 * - `tables` writes a state declaration with one source for each table of a database.
 * - `suggest` removes the sources that change between two runs of the same correct steps.
 *
 * It needs no daemon and no browser. The rules are in `@/features/grade/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MSG_READ_FAILED,
  readStateSources,
  sourceRows,
  StateDeclarationSchema,
  type StateIo,
  type StateSource,
} from '@/features/compare/outside/state-sources.js';
import { checkAnswer, ExpectSchema, type AnswerCheck } from '@/features/grade/grade-answer.js';
import {
  GradeVerdict,
  gradeState,
  SnapshotSchema,
  urlLine,
  type Snapshot,
} from '@/features/grade/grade-state.js';
import { quietSources, tableSources } from '@/features/grade/grade-suggest.js';
import { GradeStep, type GradeArgs } from '../cli-parse-grade.js';
import { hostStateIo } from '../two-builds/compare-command.js';

export const GradeExit = { PASS: 0, FAIL: 1, UNVERIFIED: 2 } as const;
const EXIT: Record<GradeVerdict, number> = {
  [GradeVerdict.PASS]: GradeExit.PASS,
  [GradeVerdict.FAIL]: GradeExit.FAIL,
  [GradeVerdict.UNVERIFIED]: GradeExit.UNVERIFIED,
};
/** The most difference lines printed as text. `--json` gives every line. */
export const MAX_TEXT_LINES = 10;
const UTF8 = 'utf8';
const COLUMN = '\t';
const LINE_BREAK = /\r?\n/;

type Ok = Extract<GradeArgs, { kind: 'ok' }>;
export interface GradeOut {
  line: (text: string) => void;
  exit: (code: number) => void;
}
export interface GradeIo {
  state: StateIo;
  readText: (path: string) => Promise<string>;
  writeText: (path: string, text: string) => void;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const defaultIo: GradeIo = {
  state: hostStateIo,
  readText: (path) => readFile(path, UTF8),
  writeText: writeFile,
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function readSnapshot(io: GradeIo, path: string): Promise<Snapshot> {
  const parsed = SnapshotSchema.safeParse(JSON.parse(await io.readText(path)));
  if (!parsed.success) {
    throw new Error(`${path} is not a grade snapshot: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** The sources of a state declaration file, or why they could not be read. */
async function declarationOf(
  io: GradeIo,
  path: string,
): Promise<StateSource[] | { error: string }> {
  try {
    const parsed = StateDeclarationSchema.safeParse(JSON.parse(await io.readText(path)));
    return parsed.success ? parsed.data.sources : { error: parsed.error.message };
  } catch (error) {
    return { error: reasonOf(error) };
  }
}

/** At most `MAX_TEXT_LINES` lines, then a line that says how many were left out. */
function capped(sign: string, lines: readonly string[]): string[] {
  const shown = lines.slice(0, MAX_TEXT_LINES).map((line) => `  ${sign} ${line}`);
  const rest = lines.length - shown.length;
  return rest > 0 ? [...shown, `  ... and ${String(rest)} more (--json lists every line)`] : shown;
}

async function snapshot(args: Ok, io: GradeIo, out: GradeOut): Promise<void> {
  const sources = await declarationOf(io, args.state ?? '');
  if ('error' in sources) {
    out.line(`Could not read the state sources in ${args.state ?? ''}: ${sources.error}`);
    out.exit(GradeExit.UNVERIFIED);
    return;
  }
  // No row cap: the grade diff is linear, and a cut row would not name its record.
  const lines = await readStateSources(sources, io.state, Number.POSITIVE_INFINITY);
  if (args.url !== undefined) {
    lines.push(urlLine(args.url));
  }
  io.writeText(args.out ?? '', json({ lines }));
  const failed = lines.filter((line) => line.startsWith(MSG_READ_FAILED));
  out.line(`Snapshot: ${args.out ?? ''}: ${String(lines.length)} lines`);
  failed.forEach((line) => out.line(`  ${line}`));
  out.exit(failed.length > 0 ? GradeExit.UNVERIFIED : GradeExit.PASS);
}

async function answerOf(args: Ok, io: GradeIo): Promise<{ check?: AnswerCheck; unread?: string }> {
  if (args.expect === undefined) {
    return {};
  }
  const parsed = ExpectSchema.safeParse(JSON.parse(await io.readText(args.expect)));
  if (!parsed.success) {
    return { unread: `${args.expect}: ${parsed.error.message}` };
  }
  const spec = parsed.data.answer;
  let rows: string[];
  try {
    rows = await sourceRows(spec.source, io.state);
  } catch (error) {
    return { unread: `answer source ${spec.source.label}: ${reasonOf(error)}` };
  }
  return { check: checkAnswer(rows, args.answer, spec) };
}

async function judge(args: Ok, io: GradeIo, out: GradeOut): Promise<void> {
  const [reference, again, candidate] = await Promise.all(
    [args.reference, args.again, args.candidate].map((p) => readSnapshot(io, p ?? '')),
  );
  if (reference === undefined || again === undefined || candidate === undefined) {
    throw new Error('a snapshot is missing');
  }
  const state = gradeState(reference, again, candidate);
  const answer = await answerOf(args, io);
  const unread = [...state.unread, ...(answer.unread === undefined ? [] : [answer.unread])];
  let verdict: GradeVerdict = GradeVerdict.PASS;
  if (unread.length > 0) {
    verdict = GradeVerdict.UNVERIFIED;
  } else if (state.verdict === GradeVerdict.FAIL || false === answer.check?.ok) {
    verdict = GradeVerdict.FAIL;
  }
  const result = {
    verdict,
    state: { removed: state.removed, added: state.added, ignored: state.ignored },
    ...(answer.check === undefined ? {} : { answer: answer.check }),
    unread,
  };
  if (args.json) {
    out.line(JSON.stringify(result));
  } else {
    out.line(verdict.toUpperCase());
    unread.forEach((line) => out.line(`  unread: ${line}`));
    if (answer.check !== undefined) {
      out.line(
        answer.check.ok
          ? `  answer: correct (${answer.check.expected})`
          : `  answer: wrong: ${answer.check.reason ?? ''}`,
      );
    }
    out.line(
      `  state: ${String(state.removed.length + state.added.length)} lines differ, ${String(state.ignored)} ignored as noise`,
    );
    capped('-', state.removed).forEach(out.line);
    capped('+', state.added).forEach(out.line);
  }
  out.exit(EXIT[verdict]);
}

async function tables(args: Ok, io: GradeIo, out: GradeOut): Promise<void> {
  const listed = await io.state.run(args.list ?? '', args.container);
  const names = listed.split(LINE_BREAK).map((line) => line.split(COLUMN)[0] ?? '');
  const result = tableSources(names, args.rows ?? '', args.container);
  io.writeText(args.out ?? '', json({ sources: result.sources }));
  out.line(`Declaration: ${args.out ?? ''}: ${String(result.sources.length)} sources`);
  result.skipped.forEach((s) => out.line(`  skipped ${s.label}: ${s.reason}`));
  out.exit(GradeExit.PASS);
}

async function suggest(args: Ok, io: GradeIo, out: GradeOut): Promise<void> {
  const sources = await declarationOf(io, args.state ?? '');
  if ('error' in sources) {
    out.line(`Could not read the state sources in ${args.state ?? ''}: ${sources.error}`);
    out.exit(GradeExit.UNVERIFIED);
    return;
  }
  const reference = await readSnapshot(io, args.reference ?? '');
  const again = await readSnapshot(io, args.again ?? '');
  const result = quietSources(sources, reference.lines, again.lines);
  io.writeText(args.out ?? '', json({ sources: result.sources }));
  out.line(
    `Declaration: ${args.out ?? ''}: kept ${String(result.sources.length)} of ${String(sources.length)} sources`,
  );
  result.dropped.forEach((d) => out.line(`  dropped ${d.label}: ${d.reason}`));
  out.exit(GradeExit.PASS);
}

const STEPS: Record<GradeStep, (args: Ok, io: GradeIo, out: GradeOut) => Promise<void>> = {
  [GradeStep.SNAPSHOT]: snapshot,
  [GradeStep.JUDGE]: judge,
  [GradeStep.TABLES]: tables,
  [GradeStep.SUGGEST]: suggest,
};

export async function handleGrade(args: Ok, out: GradeOut, io: GradeIo = defaultIo): Promise<void> {
  try {
    await STEPS[args.step](args, io, out);
  } catch (error) {
    out.line(`UNVERIFIED\n  ${reasonOf(error)}`);
    out.exit(GradeExit.UNVERIFIED);
  }
}
