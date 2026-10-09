import { describe, expect, it } from 'vitest';
import { ChannelId } from 'open-verification';
import { CoverageMarker } from '../wire/platform-link.js';
import { InstrumentationGapKind, fixForGap } from './instrumentation-gap.js';
import {
  AGENT_PROMPT_LEAD,
  CoverageCapability,
  HARNESS_UNLOCK_COVERAGE,
  coverageOf,
  coverageScore,
  harnessGateOf,
  harnessUnlockPrompt,
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

describe('harnessGateOf', () => {
  it('unlocks at 80%, and says nothing about a lock it does not have', () => {
    const gate = harnessGateOf(coverageOf({ channels: SEVEN, gaps: [] }));
    expect(HARNESS_UNLOCK_COVERAGE).toBe(0.8);
    expect(gate).toMatchObject({ percent: 87, unlocked: true });
    expect(gate.reason).toBeUndefined();
  });

  it('refuses below 80% in one sentence naming the percent and every missing capability', () => {
    const gate = harnessGateOf(coverageOf({ channels: FIVE, gaps: [] }));
    expect(gate.unlocked).toBe(false);
    expect(gate.percent).toBe(62);
    expect(gate.reason).toBe(
      `Harness unlocks at 80% instrumentation. This app is at 62%: missing ${CoverageCapability.APP_STATE}, ${CoverageCapability.SOURCE_MAPPING}, ${CoverageCapability.TEST_IDS}.`,
    );
  });

  it('never shows 80% on a score below it, nor below 80% on one at it', () => {
    for (let seen = 0; seen <= 8; seen++) {
      const gate = harnessGateOf({ seen: Object.values(CoverageCapability).slice(0, seen) });
      expect(gate.unlocked).toBe(80 <= gate.percent);
    }
  });
});

describe('harnessUnlockPrompt', () => {
  it('names every unseen capability with its fix, then the flow that proves it', () => {
    const coverage = coverageOf({ channels: FIVE, gaps: [] });
    const prompt = harnessUnlockPrompt({ coverage, gaps: [], appName: 'app', url: 'http://x' });
    expect(prompt.startsWith(AGENT_PROMPT_LEAD)).toBe(true);
    expect(prompt).toContain(fixForGap(InstrumentationGapKind.NO_STORE_REGISTERED));
    expect(prompt).toContain(fixForGap(InstrumentationGapKind.MISSING_TESTID));
    expect(prompt).toContain('reticle verify http://x --expect');
  });

  it('keeps the control and file a recorded gap named', () => {
    const gaps = [
      {
        kind: InstrumentationGapKind.MISSING_TESTID,
        missing: 'testid',
        fix: 'add data-testid',
        ref: 'e7',
        source: 'src/Form.tsx:12',
      },
    ];
    const coverage = coverageOf({ channels: SEVEN, gaps });
    const prompt = harnessUnlockPrompt({ coverage, gaps, appName: 'app', url: 'http://x' });
    expect(prompt).toContain('control e7, at src/Form.tsx:12');
  });
});
