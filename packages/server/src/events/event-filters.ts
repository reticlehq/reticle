import { EventType, type IrisEvent } from '@syrin/iris-protocol';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Match a net.request event against optional method/url/status filters (iris_network). */
export function matchNet(
  e: IrisEvent,
  method: string | undefined,
  urlContains: string | undefined,
  status: number | undefined,
): boolean {
  const d = e.data;
  if (method !== undefined && asString(d['method'])?.toUpperCase() !== method.toUpperCase()) {
    return false;
  }
  if (urlContains !== undefined && !(asString(d['url']) ?? '').includes(urlContains)) {
    return false;
  }
  if (status !== undefined && asNumber(d['status']) !== status) return false;
  return true;
}

/**
 * Reconcile network events into completed calls + still-in-flight calls. A NET_PENDING whose
 * `id` never gets a matching NET_REQUEST is an unresolved/hung request — the case
 * completion-only logging is blind to. Pending events are annotated `{ status: 'pending',
 * pending: true }` so a numeric `status` filter excludes them but `urlContains`/`method` match.
 */
export function reconcileNet(events: IrisEvent[]): IrisEvent[] {
  const completed = events.filter((e) => e.type === EventType.NET_REQUEST);
  const doneIds = new Set(
    completed.map((e) => asString(e.data['id'])).filter((id): id is string => id !== undefined),
  );
  const unresolved = events
    .filter((e) => {
      if (e.type !== EventType.NET_PENDING) return false;
      const id = asString(e.data['id']);
      return id === undefined || !doneIds.has(id);
    })
    .map((e): IrisEvent => ({ ...e, data: { ...e.data, status: 'pending', pending: true } }));
  return [...completed, ...unresolved].sort((a, b) => a.t - b.t);
}

/** Compact network-call summary for iris_network output — drops event plumbing (t, type,
 * sessionId, ref, id, initiator, ok) the agent never needs, keeping only method/url/status/ms.
 * This is the bulk of the token cost: raw IrisEvent objects are ~5x larger than this. */
interface NetCallView {
  method: string;
  url: string;
  status?: number | string;
  ms?: number;
}
export function projectNetCall(e: IrisEvent): NetCallView {
  const status = e.data['status'];
  const ms = asNumber(e.data['durationMs']);
  const view: NetCallView = {
    method: asString(e.data['method']) ?? '',
    url: asString(e.data['url']) ?? '',
  };
  if (typeof status === 'number' || typeof status === 'string') view.status = status;
  if (ms !== undefined) view.ms = ms;
  return view;
}

/** Compact console-log summary for iris_console output — { level, text } only. */
interface ConsoleLogView {
  level: string;
  text: string;
}
export function projectConsoleLog(e: IrisEvent): ConsoleLogView {
  const level = e.type === EventType.ERROR_UNCAUGHT ? 'error' : e.type.replace('console.', '');
  return { level, text: asString(e.data['message']) ?? '' };
}

/** True for any console.* / uncaught-error event (the iris_console universe). */
export function isConsoleEvent(e: IrisEvent): boolean {
  return (
    e.type === EventType.CONSOLE_LOG ||
    e.type === EventType.CONSOLE_WARN ||
    e.type === EventType.CONSOLE_ERROR ||
    e.type === EventType.ERROR_UNCAUGHT
  );
}

/** Match a console/error event against an optional level filter (iris_console). */
export function matchConsole(e: IrisEvent, level: string | undefined): boolean {
  if (!isConsoleEvent(e)) return false;
  if (level === undefined) return true;
  return (
    e.type === `console.${level}` || (level === 'error' && e.type === EventType.ERROR_UNCAUGHT)
  );
}

/** How many present calls/levels a zero-match hint samples before truncating. */
const HINT_SAMPLE_MAX = 5;

/** One present network call summarized for a zero-match hint. */
interface NetCallSummary {
  method: string;
  url: string;
  status?: number;
}

/**
 * Near-miss for iris_network: when a filter matched zero calls, describe what DID fire so the
 * agent self-corrects ("POST /x 200 matched nothing, but these 3 requests happened") instead of
 * reading a bare []. `allNet` is every net.request in the window (pre-filter).
 */
interface NetEmptyHint {
  totalInWindow: number;
  /** Up to HINT_SAMPLE_MAX present calls (most-recent first). */
  present: NetCallSummary[];
}

export function netEmptyHint(allNet: IrisEvent[]): NetEmptyHint {
  const present = allNet
    .slice(-HINT_SAMPLE_MAX)
    .reverse()
    .map((e): NetCallSummary => {
      const status = asNumber(e.data['status']);
      const base = { method: asString(e.data['method']) ?? '', url: asString(e.data['url']) ?? '' };
      return status === undefined ? base : { ...base, status };
    });
  return { totalInWindow: allNet.length, present };
}

/** Per-level console counts in the window — the body of a zero-match console hint. */
interface ConsoleLevelCounts {
  log: number;
  warn: number;
  error: number;
}

/**
 * Near-miss for iris_console: when a level filter matched zero logs, report what levels ARE
 * present so the agent knows the page isn't silent ("0 errors, but 3 warns + 5 logs"). `allConsole`
 * is every console/error event in the window (pre-filter).
 */
interface ConsoleEmptyHint {
  totalInWindow: number;
  byLevel: ConsoleLevelCounts;
}

export function consoleEmptyHint(allConsole: IrisEvent[]): ConsoleEmptyHint {
  const byLevel: ConsoleLevelCounts = { log: 0, warn: 0, error: 0 };
  for (const e of allConsole) {
    if (e.type === EventType.CONSOLE_LOG) byLevel.log += 1;
    else if (e.type === EventType.CONSOLE_WARN) byLevel.warn += 1;
    else if (e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT) {
      byLevel.error += 1;
    }
  }
  return { totalInWindow: allConsole.length, byLevel };
}
