/**
 * The instrumentation gaps each session's verdicts actually recorded, kept for the surfaces that
 * describe an app rather than one verdict: the platform's app report, the HUD's coverage line and
 * `doctor`. Fed from the one function every verdict's gaps already pass through (`withGapNovelty`),
 * so nothing here surveys a page: a gap is listed only because a verdict paid for it.
 *
 * Deduped by kind + missing, newest first, bounded per session.
 */
import { withRunningDrive } from '@/features/harness/drive-runs.js';
import {
  CoverageMarker,
  InstrumentationGapKind,
  LINK_APP_GAPS_MAX,
  agentPromptFor,
  coverageOf,
  type Coverage,
  type ImpactSnapshot,
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

/** What this session's verdicts recorded, newest first. */
export function recordedGaps(sessionId: string): readonly RecordedGap[] {
  return bySession.get(sessionId) ?? [];
}

/** Forget a session that ended. */
export function forgetRecordedGaps(sessionId: string): void {
  bySession.delete(sessionId);
}

/** What instrumentation coverage reads off a connected tab. */
export interface InstrumentedTab {
  readonly id: string;
  readonly url?: string | undefined;
  readonly channels?: readonly string[] | undefined;
  readonly sourceMapping?: boolean | undefined;
}

const SOURCE_GAPS: ReadonlySet<string> = new Set([
  InstrumentationGapKind.NO_SOURCE_MAPPING,
  InstrumentationGapKind.SOURCE_MAPPING_OFF,
]);

/**
 * The tab's HELLO channels, plus the `source` marker when its page said it carries source mapping
 * and no verdict recorded otherwise — the list the platform report sends and coverage reads.
 */
export function announcedChannels(tab: InstrumentedTab): string[] {
  const channels = [...(tab.channels ?? [])];
  const contradicted = recordedGaps(tab.id).some((gap) => SOURCE_GAPS.has(gap.kind));
  if (true === tab.sourceMapping && !contradicted) channels.push(CoverageMarker.SOURCE);
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

/** This tab's coverage, with the coding-agent prompt when its verdicts recorded any gap. */
export function instrumentationOf(tab: InstrumentedTab): Coverage & { prompt?: string } {
  const gaps = recordedGaps(tab.id);
  const coverage = coverageOf({ channels: announcedChannels(tab), gaps });
  const url = tab.url ?? '';
  return 0 === gaps.length
    ? coverage
    : { ...coverage, prompt: agentPromptFor({ gaps, appName: appNameOf(url), url }) };
}

/**
 * The impact snapshot a tab is pushed, carrying that tab's own coverage and running drive. Every
 * push needs the drive: one without it reads as "no drive", and the drive's own tool calls push.
 */
export function withInstrumentation(
  tab: InstrumentedTab,
  snapshot: ImpactSnapshot,
): ImpactSnapshot {
  const pushed = { ...snapshot, instrumentation: { ...instrumentationOf(tab) } };
  return withRunningDrive(pushed, tab.id) ?? pushed;
}
