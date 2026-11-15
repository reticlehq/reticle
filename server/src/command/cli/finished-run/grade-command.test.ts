import { describe, expect, it } from 'vitest';
import { parseGradeArgs } from '../cli-parse-grade.js';
import { GradeExit, handleGrade, type GradeIo } from './grade-command.js';

const DECLARATION = JSON.stringify({
  sources: [{ kind: 'command', label: 'orders', command: 'dump orders' }],
});

/** A fake app: `rows` is what the orders query gives now; files live in a map. */
function fakeIo(files: Record<string, string>, app: { rows: string; answer?: string }): GradeIo {
  return {
    state: {
      run: (command) => Promise.resolve(command.includes('answer') ? (app.answer ?? '') : app.rows),
      fetchJson: () => Promise.resolve([]),
      readFile: () => Promise.resolve(''),
    },
    readText: (path) => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`no file ${path}`))
        : Promise.resolve(text);
    },
    writeText: (path, text) => {
      files[path] = text;
    },
  };
}

async function run(argv: string[], io: GradeIo): Promise<{ code: number; lines: string[] }> {
  const parsed = parseGradeArgs(argv);
  if ('error' === parsed.kind) {
    throw new Error(parsed.message);
  }
  const lines: string[] = [];
  let code = -1;
  await handleGrade(parsed, { line: (t) => lines.push(t), exit: (c) => (code = c) }, io);
  return { code, lines };
}

describe('reticle grade', () => {
  const snapshotOf = async (
    files: Record<string, string>,
    rows: string,
    out: string,
    url?: string,
  ) =>
    run(
      [
        'snapshot',
        '--state',
        'state.json',
        '--out',
        out,
        ...(url === undefined ? [] : ['--url', url]),
      ],
      fakeIo(files, { rows }),
    );

  it('passes a run that left the same data, and fails one that changed another record', async () => {
    const files: Record<string, string> = { 'state.json': DECLARATION };
    await snapshotOf(files, '1\tcanceled\n2\tpending', 'ref.json');
    await snapshotOf(files, '1\tcanceled\n2\tpending', 'again.json');
    await snapshotOf(files, '1\tcanceled\n2\tpending', 'good.json');
    await snapshotOf(files, '1\tcanceled\n2\tcanceled', 'bad.json');
    const judge = (candidate: string) =>
      run(
        ['judge', '--reference', 'ref.json', '--again', 'again.json', '--candidate', candidate],
        fakeIo(files, { rows: '' }),
      );
    expect((await judge('good.json')).code).toBe(GradeExit.PASS);
    const bad = await judge('bad.json');
    expect(bad.code).toBe(GradeExit.FAIL);
    expect(bad.lines).toContain('  + state orders 2\tcanceled');
  });

  it('fails a run that ended on another page', async () => {
    const files: Record<string, string> = { 'state.json': DECLARATION };
    await snapshotOf(files, '1', 'ref.json', 'http://x/report/q3');
    await snapshotOf(files, '1', 'again.json', 'http://x/report/q3/');
    await snapshotOf(files, '1', 'cand.json', 'http://x/report/q2');
    const result = await run(
      ['judge', '--reference', 'ref.json', '--again', 'again.json', '--candidate', 'cand.json'],
      fakeIo(files, { rows: '' }),
    );
    expect(result.code).toBe(GradeExit.FAIL);
  });

  it('checks the answer against the source at grade time, and a task that cannot be done', async () => {
    const files: Record<string, string> = {
      'state.json': DECLARATION,
      'expect.json': JSON.stringify({
        answer: { source: { kind: 'command', label: 'a', command: 'answer' }, match: 'number' },
      }),
    };
    await snapshotOf(files, '1', 's.json');
    const judge = (answer: string, app: { rows: string; answer?: string }) =>
      run(
        [
          'judge',
          '--reference',
          's.json',
          '--again',
          's.json',
          '--candidate',
          's.json',
          '--expect',
          'expect.json',
          '--answer',
          answer,
          '--json',
        ],
        fakeIo(files, app),
      );
    expect((await judge('3', { rows: '', answer: '3\n' })).code).toBe(GradeExit.PASS);
    expect((await judge('4', { rows: '', answer: '3\n' })).code).toBe(GradeExit.FAIL);
    expect((await judge('N/A', { rows: '', answer: '' })).code).toBe(GradeExit.PASS);
  });

  it('is unverified when a snapshot is missing, never a pass', async () => {
    const result = await run(
      ['judge', '--reference', 'r', '--again', 'a', '--candidate', 'c'],
      fakeIo({}, { rows: '' }),
    );
    expect(result.code).toBe(GradeExit.UNVERIFIED);
  });

  it('writes a declaration for each table, then keeps only the quiet ones', async () => {
    const files: Record<string, string> = {};
    const io = fakeIo(files, { rows: 'orders\nsessions\n' });
    await run(
      ['tables', '--list', 'show tables', '--rows', 'dump {table}', '--out', 'wide.json'],
      io,
    );
    expect(JSON.parse(files['wide.json'] ?? '')).toMatchObject({
      sources: [{ label: 'orders', command: 'dump orders' }, { label: 'sessions' }],
    });
    files['ref.json'] = JSON.stringify({ lines: ['state orders 1', 'state sessions a'] });
    files['again.json'] = JSON.stringify({ lines: ['state orders 1', 'state sessions b'] });
    const result = await run(
      [
        'suggest',
        '--state',
        'wide.json',
        '--reference',
        'ref.json',
        '--again',
        'again.json',
        '--out',
        'state.json',
      ],
      io,
    );
    expect(result.lines[0]).toBe('Declaration: state.json: kept 1 of 2 sources');
    expect(JSON.parse(files['state.json'] ?? '')).toMatchObject({ sources: [{ label: 'orders' }] });
  });

  it('skips the tables whose name starts with one of the --skip prefixes', async () => {
    const files: Record<string, string> = {};
    const result = await run(
      [
        'tables',
        '--list',
        'show tables',
        '--rows',
        'dump {table}',
        '--skip',
        'queue_,cron_',
        '--out',
        'wide.json',
      ],
      fakeIo(files, { rows: 'queue_message\norders\ncron_schedule\n' }),
    );
    expect(JSON.parse(files['wide.json'] ?? '')).toEqual({
      sources: [{ kind: 'command', label: 'orders', command: 'dump orders' }],
    });
    expect(result.lines.filter((line) => line.includes('skipped'))).toHaveLength(2);
  });
});
