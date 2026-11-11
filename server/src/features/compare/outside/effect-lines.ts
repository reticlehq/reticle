/**
 * What the app DID, as lines that compare like page text. Pure.
 *
 * A wrong payload, a swallowed failure, a duplicate submit or a thrown error can leave the page the
 * same; it shows here. Each network call is its method, its path (the host removed, the query values
 * blanked, the keys kept), its status, and the start of its request body. Each console error or
 * warning is its level and text.
 *
 * A repeated identical GET is kept once. A list that loads one more page on one run is not a change
 * in behaviour, and a read changes nothing on the server. A repeated write is kept: a double submit
 * is a defect.
 *
 * A read that failed is written as an `effects failed` line, never dropped: an empty list must mean
 * that nothing happened.
 */

const NET = 'net:';
const CONSOLE = 'console';
const EFFECTS_FAILED = 'effects failed:';
const NETWORK_SOURCE = 'network';
const CONSOLE_SOURCE = 'console';
const NO_ANSWER = 'no answer';
/** The status a call still in flight carries. */
const PENDING = 'pending';
const KEPT_LEVELS: ReadonlySet<string> = new Set(['error', 'warn', 'warning']);
const BODY_CHARS = 120;
const TEXT_CHARS = 200;
const FAILURE_CHARS = 160;

const HOST = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i;
const QUERY_VALUE = /=[^&#]*/g;

const asText = (value: unknown): string | undefined =>
  'string' === typeof value ? value : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  'object' === typeof value && null !== value ? (value as Record<string, unknown>) : undefined;

const oneLine = (text: string, max: number): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, max);

/** The list under `key`, or the reason it is not there. */
function listOf(result: unknown, key: string): { items: unknown[] } | { failed: string } {
  const r = record(result);
  const items = r?.[key];
  if (Array.isArray(items)) {
    return { items };
  }
  const why = asText(r?.['error']) ?? (r === undefined ? NO_ANSWER : JSON.stringify(r));
  return { failed: oneLine(why, FAILURE_CHARS) };
}

/** The path of a url, with the host removed and the query values blanked. */
const pathOf = (url: string): string => url.replace(HOST, '').replace(QUERY_VALUE, '=');

const READ_METHOD = 'GET';
/** The lines of a `reticle_observe { action: "network" }` result. */
export function networkLines(result: unknown): string[] {
  const list = listOf(result, 'calls');
  if ('failed' in list) {
    return [`${EFFECTS_FAILED} ${NETWORK_SOURCE}: ${list.failed}`];
  }
  const reads = new Set<string>();
  return list.items.flatMap((item) => {
    const line = callLine(item);
    if (line.startsWith(`${NET} ${READ_METHOD} `)) {
      if (reads.has(line)) {
        return [];
      }
      reads.add(line);
    }
    return [line];
  });
}

/** One call as a line. */
function callLine(item: unknown): string {
  const call = record(item) ?? {};
  const status = call['status'];
  const parts = [
    NET,
    asText(call['method']) ?? READ_METHOD,
    pathOf(asText(call['url']) ?? ''),
    'number' === typeof status || 'string' === typeof status ? String(status) : '',
  ];
  const body = asText(call['requestBody']);
  if (body !== undefined && body.length > 0) {
    parts.push(oneLine(body, BODY_CHARS));
  }
  return parts.filter((p) => p.length > 0).join(' ');
}

/** The error and warning lines of a `reticle_observe { action: "console" }` result. */
export function consoleLines(result: unknown): string[] {
  const list = listOf(result, 'logs');
  if ('failed' in list) {
    return [`${EFFECTS_FAILED} ${CONSOLE_SOURCE}: ${list.failed}`];
  }
  const out: string[] = [];
  for (const item of list.items) {
    const log = record(item) ?? {};
    const level = asText(log['level']) ?? '';
    if (KEPT_LEVELS.has(level)) {
      out.push(`${CONSOLE} ${level}: ${oneLine(asText(log['text']) ?? '', TEXT_CHARS)}`);
    }
  }
  return out;
}

const LOADED_READ = /^net: GET \S+ [1-3]\d\d$/;

/**
 * A read that loaded. Compare does not count it as a difference: what it loaded shows on the page, and when a
 * read runs (a font, a refetch) changes from run to run. A read that failed, and every write, still count.
 */
export const isLoadedRead = (line: string): boolean => LOADED_READ.test(line);

/** A network line for a call that was still in flight when it was read. */
export const isPendingLine = (line: string): boolean =>
  line.startsWith(NET) && line.split(' ').includes(PENDING);
