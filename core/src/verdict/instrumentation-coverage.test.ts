import { describe, expect, it } from 'vitest';
import { ChannelId } from 'open-verification';
import { InstrumentationGapKind, fixForGap } from './instrumentation-gap.js';
import { CoverageMarker } from '../wire/platform-link.js';
import {
  AGENT_PROMPT_LEAD,
  AGENT_PROMPT_TAIL,
  CoverageCapability,
  agentPromptFor,
  coverageOf,
} from './instrumentation-coverage.js';

const ALL_CHANNELS = [
  ChannelId.UI,
  ChannelId.NET,
  ChannelId.LOG,
  ChannelId.STATE,
  ChannelId.SIGNAL,
  ChannelId.ROUTE,
  CoverageMarker.SOURCE,
  CoverageMarker.TESTID,
];

describe('coverageOf', () => {
  it('counts all eight capabilities as seen for a page with every channel and no gap', () => {
    const coverage = coverageOf({ channels: ALL_CHANNELS, gaps: [] });
    expect(coverage.total).toBe(8);
    expect(coverage.covered).toBe(8);
    expect(coverage.missing).toEqual([]);
    expect(coverage.seen).toEqual(Object.values(CoverageCapability));
  });

  it('marks a channel every SDK has missing when absent, and the rest not seen yet', () => {
    const coverage = coverageOf({ channels: [ChannelId.UI], gaps: [] });
    const missing = coverage.missing.map((m) => m.capability);
    expect(missing).toContain(CoverageCapability.NETWORK);
    expect(missing).toContain(CoverageCapability.CONSOLE);
    expect(coverage.notSeenYet).toEqual([
      CoverageCapability.APP_STATE,
      CoverageCapability.SIGNALS,
      CoverageCapability.SOURCE_MAPPING,
      CoverageCapability.TEST_IDS,
    ]);
    expect(coverage.seen).toContain(CoverageCapability.DOM_ACTIONS);
  });

  it('marks a capability missing when a verdict recorded its gap, with that gap’s fix', () => {
    const coverage = coverageOf({
      channels: ALL_CHANNELS,
      gaps: [{ kind: InstrumentationGapKind.NO_STORE_REGISTERED, missing: 'no store' }],
    });
    expect(coverage.covered).toBe(7);
    expect(coverage.missing).toEqual([
      expect.objectContaining({
        capability: CoverageCapability.APP_STATE,
        fix: fixForGap(InstrumentationGapKind.NO_STORE_REGISTERED),
      }),
    ]);
  });

  /** A verdict mapped to src/App.jsx:24, one other control did not, and the HUD said "not seen". */
  it('counts source mapping seen anywhere, whatever one unmapped control recorded', () => {
    const coverage = coverageOf({
      channels: ALL_CHANNELS,
      gaps: [{ kind: InstrumentationGapKind.NO_SOURCE_MAPPING, missing: 'e3 has no source' }],
    });
    expect(coverage.seen).toContain(CoverageCapability.SOURCE_MAPPING);
    expect(coverage.missing).toEqual([]);
  });

  it('marks source mapping missing when the build turned it off, or none was ever seen', () => {
    const off = coverageOf({
      channels: ALL_CHANNELS,
      gaps: [{ kind: InstrumentationGapKind.SOURCE_MAPPING_OFF, missing: 'stamp off' }],
    });
    expect(off.missing.map((m) => m.capability)).toEqual([CoverageCapability.SOURCE_MAPPING]);
    const never = coverageOf({
      channels: ALL_CHANNELS.filter((c) => CoverageMarker.SOURCE !== c),
      gaps: [{ kind: InstrumentationGapKind.NO_SOURCE_MAPPING, missing: 'e3 has no source' }],
    });
    expect(never.missing.map((m) => m.capability)).toEqual([CoverageCapability.SOURCE_MAPPING]);
  });

  it('sees nothing for a page that never connected', () => {
    const coverage = coverageOf({ channels: [], gaps: [] });
    expect(coverage.seen).not.toContain(CoverageCapability.PAGE_CONNECTED);
  });
});

describe('agentPromptFor', () => {
  const gaps = [
    {
      kind: InstrumentationGapKind.NO_STORE_REGISTERED,
      missing: 'no store answers `cart.items`',
      fix: fixForGap(InstrumentationGapKind.NO_STORE_REGISTERED),
    },
    {
      kind: InstrumentationGapKind.NO_SOURCE_MAPPING,
      missing: 'e7 has no source mapping',
      fix: fixForGap(InstrumentationGapKind.NO_SOURCE_MAPPING),
      ref: 'e7',
      source: 'src/Cart.tsx:42',
    },
  ];

  it('starts with the skill link and ends with the verify step and the report line', () => {
    const prompt = agentPromptFor({ gaps, appName: 'shop', url: 'http://localhost:3000/' });
    expect(prompt.startsWith(AGENT_PROMPT_LEAD)).toBe(true);
    const lines = prompt.split('\n');
    expect(lines.at(-2)).toBe(
      'Then run: reticle verify http://localhost:3000/ --expect "<one journey you changed>"',
    );
    expect(lines.at(-1)).toBe(AGENT_PROMPT_TAIL);
  });

  it('lists only the gaps it was given, each with its fix and the control it names', () => {
    const prompt = agentPromptFor({ gaps, appName: 'shop', url: 'http://localhost:3000/' });
    expect(prompt).toContain('no store answers `cart.items`');
    expect(prompt).toContain(fixForGap(InstrumentationGapKind.NO_STORE_REGISTERED));
    expect(prompt).toContain('e7');
    expect(prompt).toContain('src/Cart.tsx:42');
    for (const kind of [
      InstrumentationGapKind.NO_SIGNAL_ON_MUTATION,
      InstrumentationGapKind.MISSING_TESTID,
      InstrumentationGapKind.UNDECLARED_CONTROL,
    ])
      expect(prompt).not.toContain(fixForGap(kind));
  });

  it('says one gap once, however many verdicts recorded it', () => {
    const first = gaps[0];
    if (first === undefined) throw new Error('fixture');
    const prompt = agentPromptFor({ gaps: [first, first], appName: 'shop', url: 'http://x/' });
    expect(prompt.split(first.missing).length - 1).toBe(1);
  });
});
