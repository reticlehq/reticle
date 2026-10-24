import { afterEach, describe, expect, it } from 'vitest';
import { CoverageCapability, CoverageMarker, LINK_APP_GAPS_MAX } from '@reticlehq/core';
import {
  announcedChannels,
  forgetAllRecordedGaps,
  forgetRecordedGaps,
  instrumentationOf,
  noteSourceSeen,
  noteActedElement,
  notApplicableOf,
  probeMarkers,
  recordGaps,
  recordedGaps,
} from './recorded-gaps.js';

const gap = (missing: string) => ({ kind: 'no-source-mapping', missing, fix: 'add the plugin' });

afterEach(() => {
  forgetAllRecordedGaps();
});

describe('recorded gaps', () => {
  it('keeps one entry per kind and missing, newest first, stamped when last seen', () => {
    recordGaps('s1', [gap('e1'), gap('e2')], 10);
    recordGaps('s1', [gap('e1')], 20);
    expect(recordedGaps('s1').map((g) => [g.missing, g.seenAt])).toEqual([
      ['e1', 20],
      ['e2', 10],
    ]);
  });

  it('keeps only the newest few', () => {
    recordGaps(
      's1',
      Array.from({ length: LINK_APP_GAPS_MAX + 5 }, (_, i) => gap(`e${String(i)}`)),
      1,
    );
    expect(recordedGaps('s1')).toHaveLength(LINK_APP_GAPS_MAX);
  });

  it('skips a compact repeat that carries no remedy', () => {
    recordGaps('s1', [{ kind: 'no-source-mapping', repeat: true }], 1);
    expect(recordedGaps('s1')).toEqual([]);
  });
});

describe('a tab’s coverage', () => {
  const tab = {
    id: 's1',
    url: 'http://localhost:3000/',
    channels: ['ui', 'net', 'log'],
    sourceMapping: true,
  };

  /**
   * One unmapped control does not mean the app has no source mapping (core's own rule for the
   * per-control gap); only the build turning the stamp off overrules the page's claim.
   */
  it('keeps the source marker a page claims until the stamp is turned off', () => {
    expect(announcedChannels(tab)).toContain(CoverageMarker.SOURCE);
    recordGaps('s1', [gap('e1')], 1);
    expect(announcedChannels(tab)).toContain(CoverageMarker.SOURCE);
    recordGaps('s1', [{ kind: 'source-mapping-off', missing: 'off', fix: 'turn it on' }], 2);
    expect(announcedChannels(tab)).not.toContain(CoverageMarker.SOURCE);
  });

  /** Test ids were never announced by anything, so coverage could never count them as seen. */
  it('adds the test-id marker once an acted element carried one, unless a test-id gap is recorded', () => {
    expect(announcedChannels(tab)).not.toContain(CoverageMarker.TESTID);
    noteActedElement(tab, {
      testid: 'auth-email',
      source: { file: 'src/ui/input.tsx', line: 26 },
    });
    expect(announcedChannels(tab)).toContain(CoverageMarker.TESTID);
    recordGaps('s1', [{ kind: 'missing-testid', missing: 'e9', fix: 'add a data-testid' }], 3);
    expect(announcedChannels(tab)).not.toContain(CoverageMarker.TESTID);
  });

  /** A verdict mapped to src/App.jsx:24 and coverage still listed "File and line" as not seen. */
  it('adds the source marker once any verdict mapped to a file:line, whatever else was recorded', () => {
    const plain = { id: 's1', channels: ['ui', 'net', 'log'] };
    expect(announcedChannels(plain)).not.toContain(CoverageMarker.SOURCE);
    noteSourceSeen(plain, 'src/App.jsx:24');
    recordGaps('s1', [gap('e1')], 1);
    expect(announcedChannels(plain)).toContain(CoverageMarker.SOURCE);
    expect(instrumentationOf(plain).seen).toContain(CoverageCapability.SOURCE_MAPPING);
    recordGaps('s1', [{ kind: 'source-mapping-off', missing: 'off', fix: 'turn it on' }], 2);
    expect(announcedChannels(plain)).not.toContain(CoverageMarker.SOURCE);
  });

  /** Every channel but test ids: 7 of 8. */
  const open = {
    id: 's1',
    url: 'http://localhost:3000/',
    channels: ['ui', 'net', 'log', 'state', 'signal'],
    sourceMapping: true,
  };

  it('carries a prompt only once a verdict recorded a gap, naming only that gap', () => {
    expect(instrumentationOf(open).setupScore).toBe(87);
    expect(instrumentationOf(open).prompt).toBeUndefined();
    recordGaps('s1', [gap('e1')], 1);
    const prompt = instrumentationOf(open).prompt ?? '';
    expect(prompt).toContain('missing: e1');
    expect(prompt).toContain('@reticlehq/server verify http://localhost:3000/');
  });

  it('reports a low score as information only: no lock, no reason, and no prompt without a gap', () => {
    const low = instrumentationOf(tab);
    expect(low.setupScore).toBe(62);
    expect(low).not.toHaveProperty('harnessGate');
    expect(low.prompt).toBeUndefined();
  });
});

/**
 * The daemon's own refusal named a different missing item from the platform's, because it read one
 * tab while the platform read the app's merged report. It reads every tab of the app now.
 */
describe('an app with several tabs', () => {
  it('counts what any of its tabs has seen, and every gap any of them recorded', () => {
    const fresh = { id: 's1', url: 'http://localhost:3000/', channels: ['ui', 'net'] };
    const driven = { id: 's2', url: 'http://localhost:3000/x', channels: ['ui', 'net', 'log'] };
    noteActedElement(driven, { testid: 'save' });
    recordGaps('s2', [gap('e7')], 1);
    const merged = instrumentationOf(fresh, [driven]);
    expect(merged.seen).toContain(CoverageCapability.TEST_IDS);
    expect(merged.prompt ?? '').toContain('e7');
  });

  /**
   * A fresh leased tab had not acted yet, so it reported the app at 75% ("File and line, Stable
   * test ids" missing) and the platform locked a Harness run mid-drive that it had let start at
   * 87.5%. What one tab of an app showed is the app's, after that tab is gone too.
   */
  it('keeps what an ended tab of the app showed for the next fresh tab of it', () => {
    const before = { id: 's1', url: 'http://localhost:3000/a', projectId: 'shop' };
    noteActedElement(before, { testid: 'save', source: { file: 'src/a.tsx', line: 3 } });
    forgetRecordedGaps('s1');
    const fresh = {
      id: 's2',
      url: 'http://localhost:3000/404',
      projectId: 'shop',
      channels: ['ui', 'net', 'log', 'state', 'signal'],
    };
    expect(instrumentationOf(fresh).setupScore).toBe(100);
    // Another app on the same daemon does not inherit it.
    const other = { ...fresh, id: 's3', url: 'http://localhost:4000/', projectId: 'blog' };
    expect(instrumentationOf(other).seen).not.toContain(CoverageCapability.TEST_IDS);
  });

  it('keys an app with no project by its origin', () => {
    noteActedElement({ id: 's1', url: 'http://localhost:3000/a' }, { testid: 'save' });
    expect(announcedChannels({ id: 's2', url: 'http://localhost:3000/b' })).toContain(
      CoverageMarker.TESTID,
    );
    expect(announcedChannels({ id: 's3', url: 'http://localhost:3001/' })).not.toContain(
      CoverageMarker.TESTID,
    );
  });
});

/**
 * The Harness gate scored bench-app at 75% ("missing file:line source mapping, stable test ids")
 * while the page carried 55 test ids and a source stamp on every element: markers were learned only
 * from a control an agent acted on, so a tab nobody acted on — a hidden one `reticle connect` opened
 * — spoke for the app. The daemon now asks the page what it carries.
 */
describe('what the page itself carries', () => {
  const FULL = ['ui', 'net', 'log', 'state', 'signal'];
  const answering = (markers: string[], asked: string[] = []) => ({
    command: (name: string) => {
      asked.push(name);
      return Promise.resolve({ ok: true, result: { markers } });
    },
  });

  it('unlocks an app whose page carries test ids and file:line stamps before anything acted', async () => {
    const tab = { id: 's1', url: 'http://localhost:4312/', projectId: 'bench', channels: FULL };
    expect(instrumentationOf(tab).setupScore).toBe(75);
    await probeMarkers([{ ...tab, ...answering(['source', 'testid']) }]);
    expect(instrumentationOf(tab).setupScore).toBe(100);
  });

  it("is the app's: a hidden tab of the same project that was never asked reports it too", async () => {
    await probeMarkers([
      { id: 's1', url: 'http://localhost:4312/', projectId: 'bench', ...answering(['testid']) },
    ]);
    expect(
      announcedChannels({ id: 's9', url: 'http://localhost:4312/login', projectId: 'bench' }),
    ).toContain(CoverageMarker.TESTID);
  });

  // A plain-HTML app was held at 75% ("File and line") for ever: no plugin stamps a page with no
  // components. The page says file:line does not apply, and the gate leaves it out of both sides.
  it('leaves file:line out of a plain-HTML app, which unlocks the gate', async () => {
    const tab = { id: 's1', url: 'http://localhost:8080/', projectId: 'plain', channels: FULL };
    await probeMarkers([
      {
        ...tab,
        command: () =>
          Promise.resolve({
            ok: true,
            result: { markers: ['testid'], notApplicable: [CoverageCapability.SOURCE_MAPPING] },
          }),
      },
    ]);
    expect(notApplicableOf(tab)).toEqual([CoverageCapability.SOURCE_MAPPING]);
    expect(instrumentationOf(tab).setupScore).toBe(100);
  });

  it('asks a page once both are known, and survives a page that cannot answer', async () => {
    const asked: string[] = [];
    const tab = { id: 's1', url: 'http://localhost:4312/', projectId: 'bench' };
    await probeMarkers([{ ...tab, ...answering(['source', 'testid'], asked) }]);
    await probeMarkers([{ ...tab, ...answering(['source', 'testid'], asked) }]);
    expect(asked).toEqual(['markers']);
    await expect(
      probeMarkers([
        { id: 's2', url: 'http://x/', command: () => Promise.reject(new Error('gone')) },
      ]),
    ).resolves.toBe(false);
  });
});
