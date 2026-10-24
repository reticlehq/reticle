import { describe, expect, it } from 'vitest';
import { ChannelId } from 'open-verification';
import { CoverageMarker } from '../wire/platform-link.js';
import * as coverageModule from './instrumentation-coverage.js';
import {
  CoverageCapability,
  coverageOf,
  coveragePercent,
  coverageScore,
} from './instrumentation-coverage.js';

/** What every connected SDK announces, plus a store and source mapping: everything but test ids. */
const SEVEN = [
  ChannelId.UI,
  ChannelId.NET,
  ChannelId.LOG,
  ChannelId.STATE,
  ChannelId.SIGNAL,
  CoverageMarker.SOURCE,
];
/** No store and no source mapping: a plain page with the SDK. */
const FIVE = [ChannelId.UI, ChannelId.NET, ChannelId.LOG, ChannelId.SIGNAL];

describe('coverageScore', () => {
  it('is seen over applicable, with "not seen yet" counted as not seen', () => {
    expect(coverageScore(coverageOf({ channels: SEVEN, gaps: [] }))).toBe(7 / 8);
    expect(coverageScore(coverageOf({ channels: FIVE, gaps: [] }))).toBe(5 / 8);
    expect(coverageScore(coverageOf({ channels: [], gaps: [] }))).toBe(0);
  });

  it('excludes a capability that does not apply from both sides', () => {
    const coverage = coverageOf({ channels: FIVE, gaps: [] });
    expect(coverageScore(coverage, [CoverageCapability.APP_STATE])).toBe(5 / 7);
  });

  it('is 0, not NaN, when nothing applies', () => {
    expect(coverageScore({ seen: [] }, Object.values(CoverageCapability))).toBe(0);
  });
});

describe('coveragePercent', () => {
  it('floors the score to a whole percent', () => {
    expect(coveragePercent(coverageOf({ channels: SEVEN, gaps: [] }))).toBe(87);
    expect(coveragePercent(coverageOf({ channels: FIVE, gaps: [] }))).toBe(62);
    expect(coveragePercent({ seen: [] })).toBe(0);
  });
});

describe('the setup score is information, not a gate', () => {
  it('exports no Harness threshold or lock, so no score can block a Harness run', () => {
    const exported = Object.keys(coverageModule);
    for (const name of ['HARNESS_UNLOCK_COVERAGE', 'harnessGateOf', 'harnessLockedReason'])
      expect(exported).not.toContain(name);
  });
});
