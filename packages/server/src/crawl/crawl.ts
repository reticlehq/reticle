import {
  ActionType,
  CRAWL_DEFAULTS,
  CrawlAnomalyKind,
  DANGEROUS_ACTION_CONFIRM_ARG,
  EventType,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/protocol';
import { parseInteractive, asRecord, asNumber, asString } from '../tools/tools-helpers.js';

/** The slice of Session the crawler needs — so tests inject a fake without a live browser. */
export interface CrawlSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  elapsed(): number;
  eventsSince(cursor: number): ReticleEvent[];
}

type CrawlSleep = (ms: number) => Promise<void>;

export interface CrawlAnomaly {
  kind: CrawlAnomalyKind;
  /** The control that triggered it. */
  ref: string;
  desc: string;
  detail: string;
}

export interface CrawlReport {
  interactiveFound: number;
  stepsRun: number;
  anomalies: CrawlAnomaly[];
  counts: { consoleErrors: number; failedRequests: number; deadControls: number };
  /** Descriptions of the controls actually clicked. */
  visited: string[];
  /** True when there were more controls than maxSteps allowed (coverage was bounded). */
  truncated: boolean;
}

export interface CrawlOptions {
  maxSteps?: number;
  settleMs?: number;
  scope?: string;
  confirmDangerous?: boolean;
}

/** Any buffer event that proves the app reacted to a click (vs a dead/no-op control). */
function isActivity(e: ReticleEvent): boolean {
  return (
    e.type === EventType.NET_REQUEST ||
    e.type === EventType.DOM_ADDED ||
    e.type === EventType.DOM_REMOVED ||
    e.type === EventType.DOM_ATTR ||
    e.type === EventType.DOM_TEXT ||
    e.type === EventType.ROUTE_CHANGE ||
    e.type === EventType.SIGNAL ||
    e.type === EventType.ANIM_START ||
    e.type === EventType.ANIM_END
  );
}

function isConsoleError(e: ReticleEvent): boolean {
  return e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT;
}

function failedRequests(events: ReticleEvent[], floor: number): ReticleEvent[] {
  return events.filter((e) => {
    if (e.type !== EventType.NET_REQUEST) return false;
    const status = asNumber(e.data['status']);
    return status !== undefined && status >= floor;
  });
}

/**
 * The autonomous "smart monkey". Discovers every reachable interactive control once,
 * then clicks each (bounded by maxSteps) and classifies the reaction into anomalies — console
 * errors, failed requests, and DEAD controls (dispatched but the app did nothing). Pure
 * orchestration over a CrawlSession: no browser/Node imports, fully unit-testable with a fake.
 * Single-pass by design (no re-discovery) so it always terminates and never explodes on navigation.
 */
export async function crawl(
  session: CrawlSession,
  opts: CrawlOptions,
  sleep: CrawlSleep,
): Promise<CrawlReport> {
  const maxSteps = opts.maxSteps ?? CRAWL_DEFAULTS.MAX_STEPS;
  const settleMs = opts.settleMs ?? CRAWL_DEFAULTS.SETTLE_MS;

  const snap = await session.command(ReticleCommand.SNAPSHOT, {
    mode: 'interactive',
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  });
  const tree = snap.ok ? (((snap.result ?? {}) as { tree?: string }).tree ?? '') : '';
  const items = parseInteractive(tree);

  const anomalies: CrawlAnomaly[] = [];
  const visited: string[] = [];
  const counts = { consoleErrors: 0, failedRequests: 0, deadControls: 0 };
  const seen = new Set<string>();

  let stepsRun = 0;
  for (const item of items) {
    if (stepsRun >= maxSteps) break;
    if (seen.has(item.desc)) continue; // don't re-click an identical control
    seen.add(item.desc);
    stepsRun += 1;
    visited.push(item.desc);

    const since = session.elapsed();
    const act = await session.command(ReticleCommand.ACT, {
      ref: item.ref,
      action: ActionType.CLICK,
      args: opts.confirmDangerous === true ? { [DANGEROUS_ACTION_CONFIRM_ARG]: true } : {},
    });
    await sleep(settleMs);
    const events = session.eventsSince(since);

    const errs = events.filter(isConsoleError);
    for (const e of errs) {
      counts.consoleErrors += 1;
      anomalies.push({
        kind: CrawlAnomalyKind.CONSOLE_ERROR,
        ref: item.ref,
        desc: item.desc,
        detail: asString(e.data['message']) ?? e.type,
      });
    }

    for (const e of failedRequests(events, CRAWL_DEFAULTS.FAILED_STATUS)) {
      counts.failedRequests += 1;
      const method = asString(e.data['method']) ?? '';
      const url = asString(e.data['url']) ?? '';
      const status = asNumber(e.data['status']);
      anomalies.push({
        kind: CrawlAnomalyKind.FAILED_REQUEST,
        ref: item.ref,
        desc: item.desc,
        detail: `${method} ${url} → ${status ?? ''}`.trim(),
      });
    }

    // DEAD: the click dispatched but the app produced no activity and no error to explain it.
    const dispatched = asRecord(act.result)['dispatched'] !== false && act.ok;
    if (dispatched && errs.length === 0 && !events.some(isActivity)) {
      counts.deadControls += 1;
      anomalies.push({
        kind: CrawlAnomalyKind.DEAD_CONTROL,
        ref: item.ref,
        desc: item.desc,
        detail: 'clicked but the app did nothing (no DOM/network/route/signal change)',
      });
    }
  }

  return {
    interactiveFound: items.length,
    stepsRun,
    anomalies,
    counts,
    visited,
    truncated: items.length > stepsRun,
  };
}
