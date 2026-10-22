/**
 * The instrumentation gaps each session's verdicts actually recorded, kept for the surfaces that
 * describe an app rather than one verdict: the platform's app report, the HUD's coverage line and
 * `doctor`. Fed from the one function every verdict's gaps already pass through (`withGapNovelty`),
 * so nothing here surveys a page: a gap is listed only because a verdict paid for it.
 *
 * Deduped by kind + missing, newest first, bounded per session.
 */
import { withRunningDrive } from '@/features/harness/drive-runs.js';
import { agentLinkOf } from './agent-link.js';
import type { InboxMessage } from './human/live-control.js';
import {
  CoverageMarker,
  InstrumentationGapKind,
  LINK_APP_GAPS_MAX,
  ReticleCommand,
  agentPromptFor,
  coverageOf,
  coveragePercent,
  type Coverage,
  CoverageCapability,
  type ImpactSnapshot,
  ENGINE_BLIND_SPOTS_FIELD,
  computesComparison,
  engineBlindSpots,
  type EngineBlindSpot,
  type Predicate,
} from '@reticlehq/core';

export interface RecordedGap {
  kind: string;
  missing: string;
  fix: string;
  seenAt: number;
  cost?: string;
  ref?: string;
  source?: string;
}

const bySession = new Map<string, RecordedGap[]>();

const text = (value: unknown): string | undefined =>
  'string' === typeof value && 0 < value.length ? value : undefined;

/** Remember gaps a verdict on this session just reported. Malformed entries are skipped. */
export function recordGaps(sessionId: string, gaps: readonly object[], now: number): void {
  let list = bySession.get(sessionId) ?? [];
  for (const raw of gaps) {
    const gap = raw as Record<string, unknown>;
    const kind = text(gap['kind']);
    const missing = text(gap['missing']);
    const fix = text(gap['fix']);
    if (kind === undefined || missing === undefined || fix === undefined) continue;
    const cost = text(gap['cost']);
    const ref = text(gap['ref']);
    const source = text(gap['source']);
    list = [
      {
        kind,
        missing,
        fix,
        seenAt: now,
        ...(cost === undefined ? {} : { cost }),
        ...(ref === undefined ? {} : { ref }),
        ...(source === undefined ? {} : { source }),
      },
      ...list.filter((g) => g.kind !== kind || g.missing !== missing),
    ].slice(0, LINK_APP_GAPS_MAX);
  }
  if (0 < list.length) bySession.set(sessionId, list);
}

/** A tab as the notes below key it: its session, and the app it shows. */
export interface NotedTab {
  readonly id: string;
  readonly projectId?: string | undefined;
  readonly url?: string | undefined;
}

/**
 * The app a tab shows, as a key: its project, else its origin. What one tab of an app has shown
 * (a file:line, a test id) is a fact about the app, and a fresh tab of it has not acted yet: keyed
 * by session alone, every new lease reported the app at 75% and the platform locked a Harness run
 * mid-drive that it had let start at 87.5%.
 */
function appKeyOf(tab: NotedTab): string | undefined {
  if (tab.projectId !== undefined && 0 < tab.projectId.length) return `project:${tab.projectId}`;
  if (tab.url === undefined) return undefined;
  try {
    return `origin:${new URL(tab.url).origin}`;
  } catch {
    return undefined;
  }
}

/** Sessions, and apps, where at least one verdict mapped a control to its file:line. */
const sourceSeen = new Set<string>();

/** Mark a tab, and the app it shows, in a seen-set. */
function markSeen(seen: Set<string>, tab: NotedTab): void {
  seen.add(tab.id);
  const app = appKeyOf(tab);
  if (app !== undefined) seen.add(app);
}

/** Whether this tab, or any tab of its app, was marked. */
function wasSeen(seen: ReadonlySet<string>, tab: NotedTab): boolean {
  const app = appKeyOf(tab);
  return seen.has(tab.id) || (app !== undefined && seen.has(app));
}

/** A verdict on this tab named a file:line: source mapping is seen, whatever else lacks one. */
export function noteSourceSeen(tab: NotedTab, source: string | undefined): void {
  if (source !== undefined) markSeen(sourceSeen, tab);
}

/** Sessions, and apps, where an acted element carried a `data-testid`. */
const testidSeen = new Set<string>();

/** An acted element carried a test id: the app uses them, whatever one control lacks. */
export function noteTestidSeen(tab: NotedTab, testid: string | undefined): void {
  if (testid !== undefined && 0 < testid.length) markSeen(testidSeen, tab);
}

/** What an act result says about the element it reached: its test id and its source stamp. */
export function noteActedElement(tab: NotedTab, result: unknown): void {
  if ('object' !== typeof result || null === result) return;
  const acted = result as Record<string, unknown>;
  noteTestidSeen(tab, text(acted['testid']));
  // An action that ran with a canvas on screen: its pixels go unobserved for this run.
  const effect = acted['effect'];
  const canvases =
    'object' === typeof effect && null !== effect
      ? (effect as Record<string, unknown>)['canvases']
      : undefined;
  if ('number' === typeof canvases && 0 < canvases) canvasSeen.add(tab.id);
  const source = acted['source'];
  if ('object' === typeof source && null !== source) {
    const file = text((source as Record<string, unknown>)['file']);
    if (file !== undefined) markSeen(sourceSeen, tab);
  }
}

/**
 * An act's result, passed through after noting what it says about the element it reached. Every act
 * dispatches through one function, so coverage sees test ids and source stamps from the first
 * control acted on rather than only from a verdict.
 */
export function notedAct<T extends { ok: boolean; result?: unknown }>(tab: NotedTab, done: T): T {
  if (done.ok) noteActedElement(tab, done.result);
  return done;
}

/** The markers a page said it carries (`ReticleCommand.MARKERS`), marked for its tab and its app. */
function noteMarkers(tab: NotedTab, result: unknown): void {
  if ('object' !== typeof result || null === result) return;
  const markers = (result as Record<string, unknown>)['markers'];
  if (!Array.isArray(markers)) return;
  if (markers.includes(CoverageMarker.SOURCE)) markSeen(sourceSeen, tab);
  if (markers.includes(CoverageMarker.TESTID)) markSeen(testidSeen, tab);
  const notApplicable = (result as Record<string, unknown>)['notApplicable'];
  if (Array.isArray(notApplicable) && notApplicable.includes(CoverageCapability.SOURCE_MAPPING))
    markSeen(sourceNotApplicable, tab);
}

/** Apps whose page said file:line cannot apply (plain HTML: no plugin, no framework, no stamp). */
const sourceNotApplicable = new Set<string>();

/** A tab the daemon can ask. Absent `command`: a test double or a tab with no page to ask. */
export interface ProbedTab extends NotedTab {
  command?(
    name: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; result?: unknown }>;
}

/** How long a page gets to say what it carries. Silent and cheap, so a page that cannot is skipped. */
const MARKERS_PROBE_MS = 2_000;

/**
 * Ask each page whose app has not shown both markers yet what it carries. What an act happens to
 * reach decides nothing then: an app with test ids is seen to have them before anything acted, and a
 * hidden tab of it says the same. A page that cannot answer (an older SDK, a closed tab) is skipped.
 * True when a page showed something not known before.
 */
export async function probeMarkers(tabs: readonly ProbedTab[]): Promise<boolean> {
  const before = sourceSeen.size + testidSeen.size;
  await Promise.all(
    tabs
      .filter(
        (tab) =>
          !(wasSeen(sourceSeen, tab) || wasSeen(sourceNotApplicable, tab)) ||
          !wasSeen(testidSeen, tab),
      )
      .map(async (tab) => {
        const done = await tab
          .command?.(ReticleCommand.MARKERS, {}, MARKERS_PROBE_MS)
          .catch(() => undefined);
        if (true === done?.ok) noteMarkers(tab, done.result);
      }),
  );
  return before < sourceSeen.size + testidSeen.size;
}

/**
 * Sessions where an action ran with a canvas on screen, and sessions where a verdict ran a computed
 * comparison. Facts about a RUN, so a reload (a new HELLO under the same id) does not clear them.
 */
const canvasSeen = new Set<string>();
const comparedSeen = new Set<string>();

/**
 * The `engineBlindSpots` field for a verdict result: what this engine could not observe in the
 * session so far. Notes this verdict's own comparison first, so a `compare` clears the arithmetic
 * spot on the result that ran it. `claims`: the inline intent, then the run's declared intents.
 */
export function engineBlindSpotsField(
  sessionId: string,
  predicate: Predicate | undefined,
  intent: unknown,
  declared: readonly { statement: string }[],
): { [ENGINE_BLIND_SPOTS_FIELD]: EngineBlindSpot[] } {
  if (computesComparison(predicate)) comparedSeen.add(sessionId);
  const claims = [text(intent), ...declared.map((each) => each.statement)];
  return {
    [ENGINE_BLIND_SPOTS_FIELD]: engineBlindSpots({
      canvasSeen: canvasSeen.has(sessionId),
      compared: comparedSeen.has(sessionId),
      claims,
    }),
  };
}

/** What this session's verdicts recorded, newest first. */
export function recordedGaps(sessionId: string): readonly RecordedGap[] {
  return bySession.get(sessionId) ?? [];
}

/** Forget a session that ended. What its app has shown is kept: it is still that app's. */
export function forgetRecordedGaps(sessionId: string): void {
  bySession.delete(sessionId);
  sourceSeen.delete(sessionId);
  testidSeen.delete(sessionId);
}

/** Forget everything, apps included. For tests. */
export function forgetAllRecordedGaps(): void {
  bySession.clear();
  sourceSeen.clear();
  testidSeen.clear();
  sourceNotApplicable.clear();
  canvasSeen.clear();
  comparedSeen.clear();
}

/** What instrumentation coverage reads off a connected tab. */
export interface InstrumentedTab extends NotedTab {
  readonly channels?: readonly string[] | undefined;
  readonly sourceMapping?: boolean | undefined;
  /** What the person said to the agent from this tab. Absent on a test double. */
  inboxHistory?(): readonly InboxMessage[];
}

/**
 * The tab's HELLO channels, plus the `source` marker when an act or verdict mapped a control to
 * its file:line (seen anywhere is seen) or its page said it carries source mapping, and the
 * `testid` marker once an acted element carried one — the list the platform report sends and
 * coverage reads. A build that turned the stamp off has no source marker, whatever was seen.
 */
export function announcedChannels(tab: InstrumentedTab): string[] {
  const channels = [...(tab.channels ?? [])];
  const gaps = recordedGaps(tab.id);
  // Only the build turning the stamp off overrules the page: one unmapped control does not mean
  // the app has no source mapping (core's per-control rule).
  const off = gaps.some((gap) => InstrumentationGapKind.SOURCE_MAPPING_OFF === gap.kind);
  if (!off && (wasSeen(sourceSeen, tab) || true === tab.sourceMapping))
    channels.push(CoverageMarker.SOURCE);
  // Nothing announces test ids, so they are seen on an acted element — and a control the agent
  // could only reach without one keeps the capability missing.
  const noTestid = gaps.some((gap) => InstrumentationGapKind.MISSING_TESTID === gap.kind);
  if (!noTestid && wasSeen(testidSeen, tab)) channels.push(CoverageMarker.TESTID);
  return channels;
}

/** The app a tab shows, named for a prompt: its host, else its url. */
const appNameOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The coverage capabilities that do not apply to this tab's app, excluded from both sides of the
 * score: file:line on a page that said it cannot apply there (plain HTML), until a stamp shows up.
 * The platform reads the same list from the local-apps report, so both sides move together.
 */
export function notApplicableOf(tab: NotedTab): CoverageCapability[] {
  return wasSeen(sourceNotApplicable, tab) && !wasSeen(sourceSeen, tab)
    ? [CoverageCapability.SOURCE_MAPPING]
    : [];
}

/**
 * This tab's coverage and its setup score (see core's `instrumentation-coverage.ts`), with the
 * coding-agent prompt when its verdicts recorded any gap. The score is information: it never gates
 * the Harness.
 */
export function instrumentationOf(
  tab: InstrumentedTab,
  /** The app's other tabs: what any of them has seen or recorded counts, as on the platform. */
  siblings: readonly InstrumentedTab[] = [],
): Coverage & { prompt?: string; setupScore: number } {
  const tabs = [tab, ...siblings];
  const gaps = [
    ...new Map(
      tabs.flatMap((each) => recordedGaps(each.id)).map((g) => [`${g.kind}\u0000${g.missing}`, g]),
    ).values(),
  ];
  const channels = [...new Set(tabs.flatMap((each) => announcedChannels(each)))];
  const coverage = coverageOf({ channels, gaps });
  const url = tab.url ?? '';
  const appName = appNameOf(url);
  const notApplicable = notApplicableOf(tab);
  const setupScore = coveragePercent(coverage, notApplicable);
  return 0 === gaps.length
    ? { ...coverage, setupScore }
    : { ...coverage, setupScore, prompt: agentPromptFor({ gaps, appName, url }) };
}

/**
 * The impact snapshot a tab is pushed, carrying that tab's own coverage, running drive and agent
 * link (who is attached, and this tab's notes to them). Every
 * push needs the drive: one without it reads as "no drive", and the drive's own tool calls push.
 */
export function withInstrumentation(
  tab: InstrumentedTab,
  snapshot: ImpactSnapshot,
): ImpactSnapshot {
  const pushed = {
    ...snapshot,
    instrumentation: { ...instrumentationOf(tab) },
    agent: agentLinkOf(tab.inboxHistory?.() ?? []),
  };
  return withRunningDrive(pushed, tab.id) ?? pushed;
}
