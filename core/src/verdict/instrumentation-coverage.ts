/**
 * How much of an app Reticle can see, and the prompt that asks a coding agent to close the rest.
 *
 * Built only from what a page announced (its HELLO channels, plus the `source` / `testid` markers in
 * the same list) and the gaps its verdicts actually recorded, never from a survey of the page: the
 * rule `instrumentation-gap.ts` keeps. The platform derives the same three states from the same
 * report, so the HUD, `doctor` and the dashboard agree:
 *
 *   missing       a verdict recorded the gap that names it (or a channel every SDK has is absent);
 *                 a gap about one control does not outrank its channel seen elsewhere
 *   seen          its channel or marker was announced
 *   not seen yet  neither — never counted as covered
 */
import { z } from 'zod';
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
  /**
   * Gap kinds about ONE control. Its channel seen anywhere outranks them: one unmapped button is not
   * an app with no source mapping, and reporting it as one hid every file:line a verdict did give.
   */
  perControl?: readonly InstrumentationGapKind[];
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
    perControl: [InstrumentationGapKind.NO_SOURCE_MAPPING],
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
    const announced = rule.channel === undefined ? connected : channels.has(rule.channel);
    const recorded = input.gaps.find(
      (gap) =>
        rule.gaps.some((kind) => kind === gap.kind) &&
        !(announced && true === rule.perControl?.some((kind) => kind === gap.kind)),
    );
    if (recorded !== undefined) {
      missing.push({
        capability: rule.capability,
        cost: recorded.cost ?? rule.cost,
        fix: recorded.fix ?? rule.fix,
      });
      continue;
    }
    if (announced) seen.push(rule.capability);
    else if (!connected || true === rule.always)
      missing.push({ capability: rule.capability, cost: rule.cost, fix: rule.fix });
    else notSeenYet.push(rule.capability);
  }
  return { seen, missing, notSeenYet, total: RULES.length, covered: seen.length };
}

/**
 * The gaps that would close these capabilities: the ones verdicts recorded (they name the control
 * and file), else the capability's own fix, so a capability never checked is still named. Pure.
 */
export function gapsToClose(
  gaps: readonly CoverageGap[],
  capabilities: readonly CoverageCapability[],
): CoverageGap[] {
  return RULES.filter((rule) => capabilities.includes(rule.capability)).flatMap((rule) => {
    const recorded = gaps.filter((gap) => rule.gaps.some((kind) => kind === gap.kind));
    return 0 < recorded.length
      ? recorded
      : [{ kind: rule.capability, missing: rule.capability, fix: rule.fix }];
  });
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

// ── The Harness coverage gate ─────────────────────────────────────────────────────────────────
/*
 * When the Reticle Harness may drive an app: only once Reticle can see enough of it.
 *
 * A Harness drive decides on the platform and spends credits; on an app Reticle half sees, it pays
 * for verdicts that can only infer from the DOM. So the Harness unlocks at a coverage score, and the
 * coding agent (which can use every other tool at any coverage) is how an app gets there.
 *
 * THE RULE, one definition; the platform mirrors it exactly:
 *
 *   capabilities  the eight `CoverageCapability` entries, as `coverageOf` reads them
 *   applicable    capabilities minus those that do not apply to this app (excluded from both sides;
 *                 the daemon reports them as `notApplicable` on each local-apps app)
 *   seen          applicable capabilities `coverageOf` lists as seen; "not seen yet" is NOT seen
 *   score         seen ÷ applicable, 0 when nothing applies
 *   percent       floor(score × 100), so a shown percent is below 80 exactly when the gate is shut
 *   unlocked      score ≥ HARNESS_UNLOCK_COVERAGE (0.8)
 *
 * The gate is the Harness's alone. Pure: coverage in, a decision and its sentence out.
 */
/** The capabilities an app reports as not applying to it, on the wire. Closed: core's eight only. */
export const NotApplicableSchema = z.array(z.nativeEnum(CoverageCapability)).max(8);

/** The score at which the Harness unlocks. */
export const HARNESS_UNLOCK_COVERAGE = 0.8;

/** Floating-point slack, so 0.29 × 100 floors to 29 and not 28. */
const PERCENT_EPSILON = 1e-9;

/** Seen ÷ applicable over the eight capabilities. See the header for the exact rule. */
export function coverageScore(
  coverage: Pick<Coverage, 'seen'>,
  notApplicable: readonly CoverageCapability[] = [],
): number {
  const applicable = Object.values(CoverageCapability).filter((c) => !notApplicable.includes(c));
  if (0 === applicable.length) return 0;
  return applicable.filter((c) => coverage.seen.includes(c)).length / applicable.length;
}

export interface HarnessGate {
  /** seen ÷ applicable, 0..1. */
  score: number;
  /** floor(score × 100). */
  percent: number;
  unlocked: boolean;
  /** The applicable capabilities not seen, in the order a reader climbs them. */
  unseen: CoverageCapability[];
  /** The one sentence a refusal says. Absent when unlocked. */
  reason?: string;
}

/** The one sentence a locked Harness answers with. */
export const harnessLockedReason = (percent: number, unseen: readonly string[]): string =>
  `Harness unlocks at ${String(Math.round(HARNESS_UNLOCK_COVERAGE * 100))}% instrumentation. ` +
  `This app is at ${String(percent)}%: missing ${unseen.join(', ')}.`;

/** Whether the Harness may drive an app with this coverage, and the sentence when it may not. */
export function harnessGateOf(
  coverage: Pick<Coverage, 'seen'>,
  notApplicable: readonly CoverageCapability[] = [],
): HarnessGate {
  const score = coverageScore(coverage, notApplicable);
  const percent = Math.floor(score * 100 + PERCENT_EPSILON);
  const unseen = Object.values(CoverageCapability).filter(
    (c) => !notApplicable.includes(c) && !coverage.seen.includes(c),
  );
  const unlocked = HARNESS_UNLOCK_COVERAGE <= score;
  return {
    score,
    percent,
    unlocked,
    unseen,
    ...(unlocked ? {} : { reason: harnessLockedReason(percent, unseen) }),
  };
}

/**
 * The prompt for the coding agent that closes the gate: each unseen capability with how to close it
 * (the control and file when a verdict named one), then the one flow that proves it. Pure.
 */
export function harnessUnlockPrompt(input: {
  coverage: Pick<Coverage, 'seen'>;
  gaps: readonly CoverageGap[];
  appName: string;
  url: string;
  notApplicable?: readonly CoverageCapability[];
}): string {
  const { unseen } = harnessGateOf(input.coverage, input.notApplicable);
  return agentPromptFor({
    gaps: gapsToClose(input.gaps, unseen),
    appName: input.appName,
    url: input.url,
  });
}
