/**
 * How much of an app Reticle can see, and the prompt that asks a coding agent to close the rest.
 *
 * Built only from what a page announced (its HELLO channels, plus the `source` / `testid` markers in
 * the same list) and the gaps its verdicts actually recorded, never from a survey of the page: the
 * rule `instrumentation-gap.ts` keeps. The platform derives the same three states from the same
 * report, so the HUD, `doctor` and the dashboard agree:
 *
 *   missing       a verdict recorded the gap that names it (or a channel every SDK has is absent)
 *   seen          its channel or marker was announced
 *   not seen yet  neither — never counted as covered
 */
import { ChannelId } from 'open-verification';
import { InstrumentationGapKind, fixForGap } from './instrumentation-gap.js';
import { CoverageMarker } from '../wire/platform-link.js';

/** The eight things that decide how strong a verdict on this app can be. */
export const CoverageCapability = {
  PAGE_CONNECTED: 'page connected',
  DOM_ACTIONS: 'DOM actions',
  NETWORK: 'network',
  CONSOLE: 'console',
  APP_STATE: 'app state (store registered)',
  SIGNALS: 'signals on mutation',
  SOURCE_MAPPING: 'file:line source mapping',
  TEST_IDS: 'stable test ids',
} as const;
export type CoverageCapability = (typeof CoverageCapability)[keyof typeof CoverageCapability];

/** A recorded gap, as loosely as the daemon and the platform report carry it. */
export interface CoverageGap {
  kind: string;
  missing?: string;
  cost?: string;
  fix?: string;
  /** The control the gap is about, when it names one. */
  ref?: string;
  /** `file:line`, when the gap carries one. */
  source?: string;
}

export interface MissingCapability {
  capability: CoverageCapability;
  cost: string;
  fix: string;
}

export interface Coverage {
  seen: CoverageCapability[];
  missing: MissingCapability[];
  /** Neither seen nor reported missing: never counted as covered. */
  notSeenYet: CoverageCapability[];
  total: number;
  covered: number;
}

interface CapabilityRule {
  capability: CoverageCapability;
  /** The channel or marker a page announces when this is there. Absent: connected is enough. */
  channel?: string;
  /** Every connected SDK announces it, so its absence from a known list is a real absence. */
  always?: true;
  /** Gap kinds that, once recorded, mean this capability is missing. */
  gaps: readonly InstrumentationGapKind[];
  cost: string;
  fix: string;
}

const CONNECT_FIX =
  'run `npx @reticlehq/server init` in the app so its pages connect to Reticle in development';

/** Ordered as a reader climbs them: nothing works without the first, everything sharpens with the last. */
const RULES: readonly CapabilityRule[] = [
  {
    capability: CoverageCapability.PAGE_CONNECTED,
    gaps: [],
    cost: 'no page has connected, so nothing can be verified',
    fix: CONNECT_FIX,
  },
  {
    capability: CoverageCapability.DOM_ACTIONS,
    channel: ChannelId.UI,
    always: true,
    gaps: [],
    cost: 'controls cannot be driven or read',
    fix: CONNECT_FIX,
  },
  {
    capability: CoverageCapability.NETWORK,
    channel: ChannelId.NET,
    always: true,
    gaps: [],
    cost: 'requests cannot be asserted, so a save that never reached the server can pass',
    fix: 'update @reticlehq/browser so the page reports its network channel',
  },
  {
    capability: CoverageCapability.CONSOLE,
    channel: ChannelId.LOG,
    always: true,
    gaps: [],
    cost: 'errors thrown in the page are invisible to a verdict',
    fix: 'update @reticlehq/browser so the page reports its console channel',
  },
  {
    capability: CoverageCapability.APP_STATE,
    channel: ChannelId.STATE,
    gaps: [InstrumentationGapKind.NO_STORE_REGISTERED],
    cost: 'state predicates fall back to reading the DOM',
    fix: fixForGap(InstrumentationGapKind.NO_STORE_REGISTERED),
  },
  {
    capability: CoverageCapability.SIGNALS,
    channel: ChannelId.SIGNAL,
    gaps: [InstrumentationGapKind.NO_SIGNAL_ON_MUTATION],
    cost: 'the app never says it succeeded, so every verdict infers success from the DOM',
    fix: fixForGap(InstrumentationGapKind.NO_SIGNAL_ON_MUTATION),
  },
  {
    capability: CoverageCapability.SOURCE_MAPPING,
    channel: CoverageMarker.SOURCE,
    gaps: [InstrumentationGapKind.NO_SOURCE_MAPPING, InstrumentationGapKind.SOURCE_MAPPING_OFF],
    cost: 'a broken control is named, never the line that renders it',
    fix: fixForGap(InstrumentationGapKind.NO_SOURCE_MAPPING),
  },
  {
    capability: CoverageCapability.TEST_IDS,
    channel: CoverageMarker.TESTID,
    gaps: [InstrumentationGapKind.MISSING_TESTID],
    cost: 'a saved flow loses its controls after a refactor',
    fix: fixForGap(InstrumentationGapKind.MISSING_TESTID),
  },
];

/** What a page with these channels and these recorded gaps lets Reticle see. Pure. */
export function coverageOf(input: {
  channels: readonly string[];
  gaps: readonly CoverageGap[];
}): Coverage {
  const channels = new Set(input.channels);
  const connected = 0 < channels.size;
  const seen: CoverageCapability[] = [];
  const missing: MissingCapability[] = [];
  const notSeenYet: CoverageCapability[] = [];
  for (const rule of RULES) {
    const recorded = input.gaps.find((gap) => rule.gaps.some((kind) => kind === gap.kind));
    if (recorded !== undefined) {
      missing.push({
        capability: rule.capability,
        cost: recorded.cost ?? rule.cost,
        fix: recorded.fix ?? rule.fix,
      });
      continue;
    }
    const announced = rule.channel === undefined ? connected : channels.has(rule.channel);
    if (announced) seen.push(rule.capability);
    else if (!connected || true === rule.always)
      missing.push({ capability: rule.capability, cost: rule.cost, fix: rule.fix });
    else notSeenYet.push(rule.capability);
  }
  return { seen, missing, notSeenYet, total: RULES.length, covered: seen.length };
}

/** The first line of every coverage prompt. */
export const AGENT_PROMPT_LEAD =
  "Read https://reticle.sh/SKILL.md, then improve Reticle's coverage in this repo:";
/** The last line: what the agent hands back. */
export const AGENT_PROMPT_TAIL = 'Report the coverage line it prints.';
/** The placeholder the person replaces with the journey their change touched. */
const JOURNEY_PLACEHOLDER = '<one journey you changed>';

/**
 * The copy-paste prompt for a coding agent: only the gaps verdicts recorded, each with its fix and
 * what it is missing (and the control or file, when the gap names one), then the verify that proves
 * the change. The same text the platform builds from the same report. Pure.
 */
export function agentPromptFor(input: {
  gaps: readonly CoverageGap[];
  appName: string;
  url: string;
}): string {
  const items = input.gaps.map((gap) => {
    const where = [
      gap.missing === undefined ? undefined : `missing: ${gap.missing}`,
      gap.ref === undefined ? undefined : `control ${gap.ref}`,
      gap.source === undefined ? undefined : `at ${gap.source}`,
    ].filter((part): part is string => part !== undefined);
    return `- ${gap.fix ?? fixForKind(gap.kind)}${0 === where.length ? '' : ` (${where.join(', ')})`}`;
  });
  return [
    AGENT_PROMPT_LEAD,
    `App: ${input.appName} at ${input.url}`,
    ...new Set(items),
    `Then run: reticle verify ${input.url} --expect "${JOURNEY_PLACEHOLDER}"`,
    AGENT_PROMPT_TAIL,
  ].join('\n');
}

/** The vocabulary's fix for a kind this build knows, else nothing invented. */
function fixForKind(kind: string): string {
  const known = Object.values(InstrumentationGapKind).find((k) => k === kind);
  return known === undefined ? kind : fixForGap(known);
}
