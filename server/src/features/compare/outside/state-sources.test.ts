import { describe, expect, it } from 'vitest';
import { CompareVerdict, compareBehaviour } from '../behaviour-diff.js';
import type { BuildReadings } from '../build-readings.js';
import {
  STATE_ROW_CAP,
  StateDeclarationSchema,
  readStateSources,
  type StateIo,
  type StateSource,
} from './state-sources.js';

const io = (over: Partial<StateIo> = {}): StateIo => ({
  run: () => Promise.resolve(''),
  fetchJson: () => Promise.resolve([]),
  readFile: () => Promise.resolve(''),
  ...over,
});

describe('readStateSources', () => {
  it('runs a command source on the host and gives one sorted line for each output row', async () => {
    const calls: unknown[] = [];
    const lines = await readStateSources(
      [{ kind: 'command', label: 'orders', command: 'dump' }],
      io({
        run: (command, container) => {
          calls.push([command, container]);
          return Promise.resolve('2\tcanceled\n1\tpending\n\n');
        },
      }),
    );
    expect(calls).toEqual([['dump', undefined]]);
    expect(lines).toEqual(['state orders 1\tpending', 'state orders 2\tcanceled']);
  });

  it('runs a command source in its container when one is given', async () => {
    const calls: unknown[] = [];
    await readStateSources(
      [{ kind: 'command', label: 'p', command: 'q', container: 'db' }],
      io({
        run: (command, container) => {
          calls.push([command, container]);
          return Promise.resolve('');
        },
      }),
    );
    expect(calls).toEqual([['q', 'db']]);
  });

  it('gives one line for each http record, with keys sorted and ignored fields removed', async () => {
    const lines = await readStateSources(
      [{ kind: 'http', label: 'contacts', url: 'http://x/contacts', ignore: ['updatedAt'] }],
      io({
        fetchJson: (url) => {
          expect(url).toBe('http://x/contacts');
          return Promise.resolve([
            { name: 'Bo', id: 2, updatedAt: 'now' },
            { id: 1, name: 'Al', updatedAt: 'then' },
          ]);
        },
      }),
    );
    expect(lines).toEqual([
      'state contacts {"id":1,"name":"Al"}',
      'state contacts {"id":2,"name":"Bo"}',
    ]);
  });

  it('reads the http records at a dotted path', async () => {
    const lines = await readStateSources(
      [{ kind: 'http', label: 'p', url: 'http://x/', path: 'data.items' }],
      io({ fetchJson: () => Promise.resolve({ data: { items: [{ a: 1 }] } }) }),
    );
    expect(lines).toEqual(['state p {"a":1}']);
  });

  it('reads a file on the host as JSON records, or as plain lines', async () => {
    const json = await readStateSources(
      [{ kind: 'file', label: 'db', path: '/data/db.json' }],
      io({ readFile: () => Promise.resolve('[{"b":2,"a":1}]') }),
    );
    expect(json).toEqual(['state db {"a":1,"b":2}']);
    const text = await readStateSources(
      [{ kind: 'file', label: 'log', path: '/x' }],
      io({ readFile: () => Promise.resolve('b\na\n') }),
    );
    expect(text).toEqual(['state log a', 'state log b']);
  });

  it('reads a file in a container through cat, with the path quoted', async () => {
    const calls: unknown[] = [];
    const lines = await readStateSources(
      [{ kind: 'file', label: 'db', path: "/d/it's.json", container: 'app', at: 'rows' }],
      io({
        run: (command, container) => {
          calls.push([command, container]);
          return Promise.resolve('{"rows":[{"id":1}]}');
        },
      }),
    );
    expect(calls).toEqual([[`cat '/d/it'\\''s.json'`, 'app']]);
    expect(lines).toEqual(['state db {"id":1}']);
  });

  it('removes the parts of a text row that an ignore pattern matches', async () => {
    const lines = await readStateSources(
      [
        {
          kind: 'command',
          label: 'p',
          command: 'q',
          ignore: ['\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d'],
        },
      ],
      io({ run: () => Promise.resolve('1\tJacket\t2026-11-09 06:00:01\n') }),
    );
    expect(lines).toEqual(['state p 1\tJacket\t']);
  });

  // The defect: a pattern that matched a whole row left an empty row, so a row that one build
  // deleted and the other kept still made the readings differ.
  it('removes a row that an ignore pattern removes all of', async () => {
    const lines = await readStateSources(
      [{ kind: 'command', label: 'p', command: 'q', ignore: ['^\\d+\\tNULL$'] }],
      io({ run: () => Promise.resolve('1\tJacket\n2\tNULL\n') }),
    );
    expect(lines).toEqual(['state p 1\tJacket']);
  });

  it('cuts a source over the cap, and declares the cut on a line of its own', async () => {
    const total = STATE_ROW_CAP + 3;
    const rows = Array.from({ length: total }, (_, i) => String(i).padStart(6, '0')).join('\n');
    const lines = await readStateSources(
      [{ kind: 'command', label: 'big', command: 'q' }],
      io({ run: () => Promise.resolve(rows) }),
    );
    expect(lines.filter((l) => l.startsWith('state big 0'))).toHaveLength(STATE_ROW_CAP);
    expect(lines.at(-1)).toMatch(
      new RegExp(`^state rows cut: big: kept ${String(STATE_ROW_CAP)} of ${String(total)}, rest `),
    );
  });

  // The defect: the cut line said only how many rows were kept. A change to a row past the cap (the
  // price of product 237 when ids sort as text and the source has 2,040 products) gave the same lines
  // on both builds, so compare passed a candidate that changed another record.
  it('gives a different cut line when a row past the cap changes', async () => {
    const read = (last: string) =>
      readStateSources(
        [{ kind: 'command', label: 'big', command: 'q' }],
        io({
          run: () =>
            Promise.resolve(
              [...Array.from({ length: STATE_ROW_CAP }, (_, i) => `a${String(i)}`), last].join(
                '\n',
              ),
            ),
        }),
      );
    const before = await read('z\t10.00');
    const after = await read('z\t9.00');
    expect(before.at(-1)).not.toBe(after.at(-1));
    expect(before.slice(0, -1)).toEqual(after.slice(0, -1));
  });

  it('gives a line that names a read that failed, never an empty list', async () => {
    const lines = await readStateSources(
      [
        { kind: 'http', label: 'api', url: 'http://x/' },
        { kind: 'command', label: 'ok', command: 'q' },
      ],
      io({
        fetchJson: () => Promise.reject(new Error('ECONNREFUSED\nat socket')),
        run: () => Promise.resolve('1'),
      }),
    );
    expect(lines).toEqual(['state read failed: api: ECONNREFUSED at socket', 'state ok 1']);
  });
});

describe('StateDeclarationSchema', () => {
  it('takes the three kinds, and refuses an unknown kind or a source with no label', () => {
    const sources: StateSource[] = [
      { kind: 'command', label: 'a', command: 'q', container: 'c' },
      { kind: 'http', label: 'b', url: 'http://x/', path: 'items' },
      { kind: 'file', label: 'c', path: '/x', ignore: ['id'] },
    ];
    expect(StateDeclarationSchema.safeParse({ sources }).success).toBe(true);
    expect(
      StateDeclarationSchema.safeParse({ sources: [{ kind: 'ftp', label: 'x' }] }).success,
    ).toBe(false);
    expect(
      StateDeclarationSchema.safeParse({ sources: [{ kind: 'command', command: 'q' }] }).success,
    ).toBe(false);
  });
});

describe('state lines in a comparison', () => {
  const PRICES = [{ kind: 'command', label: 'prices', command: 'q' }] as const;
  const readingOf = async (rows: string): Promise<BuildReadings> =>
    new Map([
      [
        'a',
        {
          actions: ['open the start page'],
          lines: [
            'saved',
            ...(await readStateSources(PRICES, io({ run: () => Promise.resolve(rows) }))),
          ],
        },
      ],
    ]);

  it('is different when the candidate changed a record that no page shows', async () => {
    const reference = await readingOf('1\tJacket\t10\n2\tShirt\t20');
    const result = compareBehaviour({
      order: ['a'],
      reference,
      again: reference,
      candidate: await readingOf('1\tJacket\t10\n2\tShirt\t25'),
    });
    expect(result.verdict).toBe(CompareVerdict.DIFFERENT);
    expect(result.differences[0]).toMatchObject({
      removed: ['state prices 2\tShirt\t20'],
      added: ['state prices 2\tShirt\t25'],
    });
  });

  it('ignores a state row that differs between the two reference runs', async () => {
    const result = compareBehaviour({
      order: ['a'],
      reference: await readingOf('1\tJacket\t10\nseen\tmonday'),
      again: await readingOf('1\tJacket\t10\nseen\ttuesday'),
      candidate: await readingOf('1\tJacket\t10\nseen\twednesday'),
    });
    expect(result.verdict).toBe(CompareVerdict.SAME);
    expect(result.ignored).toBeGreaterThan(0);
  });
});
