import { afterEach, describe, expect, it } from 'vitest';
import { CoverageCapability, CoverageMarker, LINK_APP_GAPS_MAX } from '@reticlehq/core';
import {
  announcedChannels,
  forgetRecordedGaps,
  instrumentationOf,
  noteSourceSeen,
  recordGaps,
  recordedGaps,
} from './recorded-gaps.js';

const gap = (missing: string) => ({ kind: 'no-source-mapping', missing, fix: 'add the plugin' });

afterEach(() => forgetRecordedGaps('s1'));

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

  it('adds the source marker only while no verdict recorded a source gap', () => {
    expect(announcedChannels(tab)).toContain(CoverageMarker.SOURCE);
    recordGaps('s1', [gap('e1')], 1);
    expect(announcedChannels(tab)).not.toContain(CoverageMarker.SOURCE);
  });

  /** A verdict mapped to src/App.jsx:24 and coverage still listed "File and line" as not seen. */
  it('adds the source marker once any verdict mapped to a file:line, whatever else was recorded', () => {
    const plain = { id: 's1', channels: ['ui', 'net', 'log'] };
    expect(announcedChannels(plain)).not.toContain(CoverageMarker.SOURCE);
    noteSourceSeen('s1', 'src/App.jsx:24');
    recordGaps('s1', [gap('e1')], 1);
    expect(announcedChannels(plain)).toContain(CoverageMarker.SOURCE);
    expect(instrumentationOf(plain).seen).toContain(CoverageCapability.SOURCE_MAPPING);
    recordGaps('s1', [{ kind: 'source-mapping-off', missing: 'off', fix: 'turn it on' }], 2);
    expect(announcedChannels(plain)).not.toContain(CoverageMarker.SOURCE);
  });

  it('carries a prompt only once a verdict recorded a gap, naming only that gap', () => {
    expect(instrumentationOf(tab).prompt).toBeUndefined();
    recordGaps('s1', [gap('e1')], 1);
    const prompt = instrumentationOf(tab).prompt ?? '';
    expect(prompt).toContain('missing: e1');
    expect(prompt).toContain('reticle verify http://localhost:3000/');
  });
});
