import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findStaleResponses } from './stale-response.js';

/**
 * The negatives matter more than the positive here. A race is reported as a hard contradiction, so a
 * rule that fires on ordinary traffic would train agents to ignore the field — which costs more than
 * never having built it.
 */
let seq = 0;
const pending = (t: number, url: string, id = `r${String((seq += 1))}`, method = 'GET') =>
  ({ type: EventType.NET_PENDING, t, data: { id, url, method } }) as unknown as ReticleEvent;
const settled = (t: number, id: string) =>
  ({ type: EventType.NET_REQUEST, t, data: { id, status: 200 } }) as unknown as ReticleEvent;
/**
 * The app REACTING — something user-visible moving because a response landed.
 *
 * Stamped at the completion time rather than after it, deliberately: the app's handler runs on the
 * microtask that resolves the fetch, so in real traffic the state write lands at or a millisecond
 * BEFORE the completion event that caused it. A fixture that places the reaction strictly after the
 * cause is not a recording of anything a browser does.
 */
const applied = (t: number) =>
  ({ type: EventType.STATE_CHANGE, t, data: { store: 'list' } }) as unknown as ReticleEvent;

describe('stale response detection', () => {
  it('reports overlapping reads of one endpoint that settled out of order', () => {
    const events = [
      pending(0, '/api/shipments?status=all', 'a'),
      pending(60, '/api/shipments?status=held', 'b'),
      settled(150, 'b'), // the newer query answered first
      settled(700, 'a'), // the superseded one landed last…
      applied(700), // …and the app rendered it, which is what makes this a defect
    ];
    const found = findStaleResponses(events);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.STALE_RESPONSE_APPLIED);
    expect(found[0]?.counter).toContain('550ms AFTER');
    expect(found[0]?.counter).toContain('status=all');
  });

  it('stays silent when the responses settled in order', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/shipments?status=all', 'a'),
        pending(60, '/api/shipments?status=held', 'b'),
        settled(200, 'a'),
        settled(300, 'b'),
      ]),
    ).toEqual([]);
  });

  it('stays silent for SEQUENTIAL requests — no overlap means no race', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/shipments?status=all', 'a'),
        settled(100, 'a'),
        pending(200, '/api/shipments?status=held', 'b'),
        settled(250, 'b'),
      ]),
    ).toEqual([]);
  });

  it('stays silent for a retry — same query is a duplicate, not a supersede', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/shipments?status=all', 'a'),
        pending(10, '/api/shipments?status=all', 'b'),
        settled(50, 'b'),
        settled(400, 'a'),
      ]),
    ).toEqual([]);
  });

  it('stays silent for two DIFFERENT endpoints racing', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/shipments?page=1', 'a'),
        pending(10, '/api/carriers?page=1', 'b'),
        settled(50, 'b'),
        settled(400, 'a'),
      ]),
    ).toEqual([]);
  });

  it('ignores writes — two overlapping POSTs are a different problem', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/dispatch?id=1', 'a', 'POST'),
        pending(10, '/api/dispatch?id=2', 'b', 'POST'),
        settled(50, 'b'),
        settled(400, 'a'),
      ]),
    ).toEqual([]);
  });

  it('ignores a request whose start is outside the window — its ordering is unknowable', () => {
    expect(
      findStaleResponses([
        pending(60, '/api/shipments?status=held', 'b'),
        settled(150, 'b'),
        settled(700, 'a'), // no pending for 'a' in this window
      ]),
    ).toEqual([]);
  });

  it('stays silent on a quiet window', () => {
    expect(findStaleResponses([])).toEqual([]);
  });
});

describe('parallel fan-out is not a race', () => {
  // Measured on a synthetic dashboard fetching pages in parallel: every run reported a race, because
  // the requests genuinely overlap and genuinely settle out of order. They are not superseding each
  // other — the app wants both results — and accusing every paginating app would be worse than the
  // detection is worth.
  it('stays silent when two overlapping reads differ only by page', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/list?status=all&page=1', 'a'),
        pending(5, '/api/list?status=all&page=2', 'b'),
        settled(100, 'b'),
        settled(900, 'a'),
      ]),
    ).toEqual([]);
  });

  it.each(['offset=0/offset=50', 'cursor=x/cursor=y', 'limit=10/limit=20'])(
    'stays silent for %s',
    (pair) => {
      const [one, two] = pair.split('/');
      expect(
        findStaleResponses([
          pending(0, `/api/list?${String(one)}`, 'a'),
          pending(5, `/api/list?${String(two)}`, 'b'),
          settled(100, 'b'),
          settled(900, 'a'),
        ]),
      ).toEqual([]);
    },
  );

  // #1677: the set held `pageSize` and `per_page` verbatim, so `page_size` counted as selecting and a
  // page query racing its own count query was reported. Each pair below is applied, so it is silent
  // only because the parameter enumerates.
  describe('an enumerating parameter in any of its spellings', () => {
    const race = (one: string, two: string) =>
      findStaleResponses([
        pending(0, `/api/items?page=1&${one}`, 'a'),
        pending(60, `/api/items?page=1&${two}`, 'b'),
        settled(100, 'b'),
        settled(900, 'a'),
        applied(900),
      ]);

    it.each([
      ['page_size=25', 'page_size=1'],
      ['page-size=25', 'page-size=1'],
      ['pagesize=25', 'pagesize=1'],
      ['PageSize=25', 'PageSize=1'],
      ['page[size]=25', 'page[size]=1'],
      ['per-page=25', 'per-page=1'],
      ['pageNumber=1', 'pageNumber=2'],
      ['page[number]=1', 'page[number]=2'],
      ['take=25', 'take=1'],
      ['skip=0', 'skip=25'],
      ['$skip=0', '$skip=25'],
      ['$top=25', '$top=1'],
      ['first=25', 'first=1'],
    ])('stays silent for %s against %s', (one, two) => {
      expect(race(one, two)).toEqual([]);
    });

    it('still reports a race when a selecting parameter changed alongside it', () => {
      const found = race('status=open&page_size=25', 'status=held&page_size=1');
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe(ContradictionKind.STALE_RESPONSE_APPLIED);
    });

    // A window selects: `last=30d` makes `last=7d` obsolete, so it is left out of the set on purpose.
    it('still reports a race on `last`, which names a window rather than a page', () => {
      expect(race('last=7d', 'last=30d')).toHaveLength(1);
    });

    // The names alone used to decide it, so a filter that happened to use one of them was paging.
    it.each([
      ['first=John', 'first=Jane'],
      ['size=S', 'size=XL'],
      ['start=2026-01-01', 'start=2026-02-01'],
      ['start=2026-01-01&end=2026-01-31', 'start=2026-02-01&end=2026-02-28'],
      ['after=2026-01-01', 'after=2026-02-01'],
      ['before=2026-01-01T00:00:00Z', 'before=2026-02-01T00:00:00Z'],
    ])('still reports a race when %s becomes %s, a filter in a paging name', (one, two) => {
      const found = race(one, two);
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe(ContradictionKind.STALE_RESPONSE_APPLIED);
    });

    it.each([
      ['start=0&end=25', 'start=25&end=50'],
      ['after=eyJpZCI6MTB9', 'after=eyJpZCI6MjB9'],
      ['before=cur_9', 'before=cur_19'],
      ['cursor=x', 'cursor=y'],
    ])('stays silent for %s against %s, a position or a cursor', (one, two) => {
      expect(race(one, two)).toEqual([]);
    });
  });

  it('STILL reports a race when a selecting parameter changed alongside the page', () => {
    // Changing the filter is what makes the older request obsolete; that the page moved too is
    // incidental, and treating the pair as enumeration would hide a real race.
    const found = findStaleResponses([
      pending(0, '/api/list?status=all&page=1', 'a'),
      pending(5, '/api/list?status=held&page=2', 'b'),
      settled(100, 'b'),
      settled(900, 'a'),
      applied(900),
    ]);
    expect(found).toHaveLength(1);
  });

  it('stays silent when the app IGNORED the superseded response', () => {
    // The difference between a defect and a correctly-handled race, and the reason the rule needs to
    // ask at all. An app that guards against out-of-order responses still RACES — two requests overlap
    // and settle backwards exactly as below. What it does not do is act on the loser. Firing on both
    // is worse than not having the rule: a detector that accuses correct code teaches people to
    // ignore it, and it takes the true positives down with it.
    expect(
      findStaleResponses([
        pending(0, '/api/shipments?status=all', 'a'),
        pending(60, '/api/shipments?status=held', 'b'),
        settled(150, 'b'),
        settled(700, 'a'), // the loser landed last and the app did nothing with it
      ]),
    ).toEqual([]);
  });

  it('counts a reaction stamped a moment BEFORE the completion it followed', () => {
    // Not a tolerance for sloppiness — a correction for which of the two is stamped first. The
    // observer emits NET_REQUEST when its wrapper sees the fetch settle, and the app's own handler
    // runs on that same microtask, so the state write routinely carries the EARLIER timestamp. A
    // strictly-forward window cannot see the application at all, and the rule could then never fire on
    // real traffic however plainly the app misbehaved — which is exactly what it did.
    const found = findStaleResponses([
      pending(0, '/api/shipments?status=all', 'a'),
      pending(60, '/api/shipments?status=held', 'b'),
      settled(150, 'b'),
      settled(700, 'a'),
      applied(699),
    ]);
    expect(found).toHaveLength(1);
  });

  it("does not read the newer response's own render as applying the older one", () => {
    // Seen on a fixture bench, intermittently, on the CORRECT twin of a quote race: the app dropped
    // the superseded answer, but the newer one had rendered 50ms before it landed, inside the slack
    // the rule allows for a reaction stamped early. That render belongs to the response that caused
    // it, the nearest completion, not to the loser that happened to land within the window.
    expect(
      findStaleResponses([
        pending(0, '/api/quote?symbol=AAPL', 'a'),
        pending(60, '/api/quote?symbol=MSFT', 'b'),
        settled(650, 'b'),
        applied(650), // the NEWER quote rendered…
        settled(700, 'a'), // …and the older one landed after it, and was dropped
      ]),
    ).toEqual([]);
  });

  it('ignores a reaction far enough after to be unrelated', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/shipments?status=all', 'a'),
        pending(60, '/api/shipments?status=held', 'b'),
        settled(150, 'b'),
        settled(700, 'a'),
        applied(9000), // seconds later: whatever moved the page, it was not this response
      ]),
    ).toEqual([]);
  });

  it('compares only within one endpoint — two different paths never race', () => {
    expect(
      findStaleResponses([
        pending(0, '/api/list?status=all', 'a'),
        pending(5, '/api/other?status=held', 'b'),
        settled(100, 'b'),
        settled(900, 'a'),
      ]),
    ).toEqual([]);
  });

  // #1225: three shapes that are not a race were reported as one, so a working page got `no`.
  describe('reads that never superseded each other', () => {
    const race = (one: string, two: string, gapMs: number) =>
      findStaleResponses([
        pending(0, `/api/x?${one}`, 'a'),
        pending(gapMs, `/api/x?${two}`, 'b'),
        settled(100, 'b'),
        settled(900, 'a'),
        applied(900),
      ]);

    it('a fan-out over ids, each rendering its own tile', () => {
      expect(race('id=1', 'id=2', 60)).toEqual([]);
    });

    it('two effects that fired in the same task with different filters', () => {
      expect(race('type=a', 'type=b', 1)).toEqual([]);
    });

    it('two projections of one collection, whose key sets differ', () => {
      expect(race('status=open&q=x&limit=50', 'status=open&count=1', 60)).toEqual([]);
    });

    it('while a filter changed by a later action is still a race', () => {
      expect(race('type=a', 'type=b', 60)).toHaveLength(1);
    });
  });
});

describe('projection-aware stale response detection', () => {
  const race = (one: string, two: string) =>
    findStaleResponses([
      pending(0, `/rest/v1/items?${one}`, 'a'),
      pending(10, `/rest/v1/items?${two}`, 'b'),
      settled(100, 'b'),
      applied(100),
      settled(900, 'a'),
      applied(900),
    ]);

  describe.each(['select', 'fields', 'columns', 'include', 'expand'])('%s', (projection) => {
    it('stays silent for different projections of the same collection', () => {
      expect(race(`${projection}=a&parent=eq.1`, `${projection}=b&parent=eq.1`)).toEqual([]);
    });

    it('still reports a filter race with the same projection', () => {
      const found = race(`${projection}=a&status=eq.open`, `${projection}=a&status=eq.held`);
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe(ContradictionKind.STALE_RESPONSE_APPLIED);
    });

    it('stays silent when the projection and filter both change', () => {
      expect(race(`${projection}=a&status=eq.open`, `${projection}=b&status=eq.held`)).toEqual([]);
    });
  });

  it.each([
    ['a missing projection', 'select=id&status=open', 'status=held'],
    ['an added empty projection', 'status=open', 'select=&status=held'],
    ['different empty and nonempty projections', 'select=&status=open', 'select=id&status=held'],
    [
      'different first repeated values',
      'select=id&select=notes&status=open',
      'select=notes&select=id&status=held',
    ],
    ['different field-list order', 'select=id,status&status=open', 'select=status,id&status=held'],
  ])('stays silent for %s', (_name, one, two) => {
    expect(race(one, two)).toEqual([]);
  });

  // Match the existing URLSearchParams.get comparisons: decoded first values, with no field-list
  // normalization. Every positive changes a filter so it cannot depend on raw-query retry handling.
  it.each([
    ['no projection on either request', 'status=open', 'status=held'],
    ['bare and empty projection values', 'select&status=open', 'select=&status=held'],
    [
      'percent-encoded projection values',
      'select=id,status&status=open',
      'select=id%2Cstatus&status=held',
    ],
    ['percent-encoded projection keys', 'select=id&status=open', '%73elect=id&status=held'],
    [
      'equivalent space encodings',
      'select=display+name&status=open',
      'select=display%20name&status=held',
    ],
    ['reordered query keys', 'select=id&status=open', 'status=held&select=id'],
    [
      'different later repeated values',
      'select=id&select=notes&status=open',
      'select=id&select=status&status=held',
    ],
  ])('still reports a filter race with %s', (_name, one, two) => {
    const found = race(one, two);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.STALE_RESPONSE_APPLIED);
  });

  it.each([
    ['identity', 'select=id&id=1&status=open', 'select=id&id=2&status=held'],
    ['enumeration only', 'select=id&status=open&page=1', 'select=id&status=open&page=2'],
  ])('preserves the %s exclusion with matching projections', (_name, one, two) => {
    expect(race(one, two)).toEqual([]);
  });

  it('still reports a filter race when pagination also changes', () => {
    expect(race('select=id&status=open&page=1', 'select=id&status=held&page=2')).toHaveLength(1);
  });

  it.each([
    ['same-task fan-out', 1, 900, 100, 900, 0],
    ['the fan-out threshold', 2, 900, 100, 900, 1],
    ['no overlap', 900, 900, 1000, 900, 0],
    ['responses settling in order', 10, 100, 900, 100, 0],
    ['no application of the old response', 10, 900, 100, undefined, 0],
    ['a reaction before the apply slack', 10, 900, 100, 799, 0],
    ['a reaction at the apply slack', 10, 900, 100, 800, 1],
    ['a reaction at the apply window', 10, 900, 100, 1400, 1],
    ['a reaction after the apply window', 10, 900, 100, 1401, 0],
  ])(
    'preserves %s with matching projections',
    (_name, gap, firstEnd, secondEnd, reaction, count) => {
      const events = [
        pending(0, '/rest/v1/items?select=id&status=open', 'a'),
        pending(gap, '/rest/v1/items?select=id&status=held', 'b'),
        settled(secondEnd, 'b'),
        settled(firstEnd, 'a'),
      ];
      if (reaction !== undefined) events.push(applied(reaction));
      expect(findStaleResponses(events)).toHaveLength(count);
    },
  );
});
