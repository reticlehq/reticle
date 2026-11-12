import { describe, expect, it } from 'vitest';
import { quietSources, tableSources, TIME_PATTERN } from './grade-suggest.js';

const cmd = (label: string) => ({ kind: 'command' as const, label, command: `dump ${label}` });

describe('tableSources', () => {
  it('gives one command source for each table, and skips a name that is not safe in a shell', () => {
    const result = tableSources(
      ['sales_order', '', 'x; rm -rf /'],
      "mysql -N -e 'SELECT * FROM {table}' shop",
      'db',
    );
    expect(result.sources).toEqual([
      {
        kind: 'command',
        label: 'sales_order',
        command: "mysql -N -e 'SELECT * FROM sales_order' shop",
        container: 'db',
      },
    ]);
    expect(result.skipped.map((s) => s.label)).toEqual(['x; rm -rf /']);
  });
});

describe('quietSources', () => {
  it('keeps a source that reads the same on both runs, also one the steps did not change', () => {
    const lines = ['state orders 1\tcanceled', 'state customers 7\tJane'];
    expect(quietSources([cmd('orders'), cmd('customers')], lines, lines).sources).toHaveLength(2);
  });

  it('keeps a source that differs only by a time, with the time removed', () => {
    const result = quietSources(
      [cmd('orders')],
      ['state orders 1\tcanceled\t2026-11-12 06:00:01'],
      ['state orders 1\tcanceled\t2026-11-12 06:04:59'],
    );
    expect(result.sources).toEqual([{ ...cmd('orders'), ignore: [TIME_PATTERN] }]);
  });

  it('drops a source that gets other rows on each run, and says why', () => {
    const result = quietSources(
      [cmd('sessions'), cmd('orders')],
      ['state sessions a1f', 'state orders 1'],
      ['state sessions b72', 'state orders 1'],
    );
    expect(result.sources.map((s) => s.label)).toEqual(['orders']);
    expect(result.dropped).toEqual([
      { label: 'sessions', reason: expect.stringContaining('state sessions a1f') as string },
    ]);
  });

  it('drops a source that could not be read', () => {
    const failed = ['state read failed: orders: ECONNREFUSED'];
    expect(quietSources([cmd('orders')], failed, failed).dropped).toEqual([
      { label: 'orders', reason: 'state read failed: orders: ECONNREFUSED' },
    ]);
  });

  it('compares the cut line of a large source, so a change past the cap counts', () => {
    const result = quietSources(
      [cmd('big')],
      ['state rows cut: big: kept 1 of 3, rest aaaa'],
      ['state rows cut: big: kept 1 of 3, rest bbbb'],
    );
    expect(result.dropped.map((d) => d.label)).toEqual(['big']);
  });
});
