import * as http from 'node:http';
import { NodePlatform } from '../platform.js';
import { spawn } from 'node:child_process';
import { isOpaqueOrigin, LOOPBACK_HOST, SESSION_PROBE_PATH, STATUS_PATH } from '@reticlehq/core';
import { daemonFix, describeSkew } from '../version/version-skew.js';
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { SERVER_VERSION } from '../version/server-version.js';
import { log } from '../log.js';

/**
 * CLI launch + status helpers — the daemon-introspection (`reticle status`) and the one-command
 * "show me the app" flow (`reticle open`). Split out of cli.ts so that file stays under the size cap.
 * The decision logic is pure (unit-tested); the IO (fetch, OS browser launch) is injected/isolated.
 */

/** One connected tab as `reticle status` reports it — the at-a-glance health line. */
interface StatusSession {
  sessionId: string;
  url: string;
  throttled: boolean;
  stale: boolean;
  pendingMarks: number;
}

/**
 * Reduce the daemon's /status JSON to the compact view `reticle status` prints. Pure: narrows the
 * untrusted wire payload (never `any`) and tolerates a missing/partial body so a malformed response
 * degrades to "running, 0 sessions" instead of throwing.
 */
export function summarizeStatus(payload: unknown): {
  sessionCount: number;
  sessions: StatusSession[];
  why?: string;
} {
  if (typeof payload !== 'object' || null === payload) return { sessionCount: 0, sessions: [] };
  const obj = payload as Record<string, unknown>;
  // Carried through to the printed line: with no sessions this is the whole answer, and dropping it
  // here would silently undo the reason it is on the wire.
  const why = 'string' === typeof obj['why'] ? obj['why'] : undefined;
  const raw = Array.isArray(obj['sessions']) ? obj['sessions'] : [];
  const sessions = raw
    .map((s): StatusSession | null => {
      if (typeof s !== 'object' || null === s) return null;
      const r = s as Record<string, unknown>;
      const sessionId = 'string' === typeof r['sessionId'] ? r['sessionId'] : '';
      if ('' === sessionId) return null;
      return {
        sessionId,
        url: 'string' === typeof r['url'] ? r['url'] : '',
        throttled: true === r['throttled'],
        stale: true === r['stale'],
        pendingMarks: 'number' === typeof r['pendingMarks'] ? r['pendingMarks'] : 0,
      };
    })
    .filter((s): s is StatusSession => s !== null);
  const sessionCount =
    'number' === typeof obj['sessionCount'] ? obj['sessionCount'] : sessions.length;
  return { sessionCount, sessions, ...(why === undefined ? {} : { why }) };
}

/** A string field off the /status body, or undefined on a daemon too old to report it. */
function statusField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || null === payload) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return 'string' === typeof value && value.length > 0 ? value : undefined;
}

/**
 * Warn when the daemon already on this port is a different version than this CLI, and attach anyway.
 *
 * Attaching to whatever owns the port is the point of a daemon — but it means an upgrade does not
 * take effect until that daemon dies, and nothing used to say so. Killing it here would take out
 * another agent's session on a version bump, which is worse than a loud line.
 */
export async function warnOnDaemonSkew(port: number): Promise<void> {
  const status = await fetchStatus(port);
  const daemonVersion = statusField(status, 'version');
  const skew = describeSkew(
    {
      what: 'the daemon already running on this port',
      version: daemonVersion,
      contract: statusField(status, 'contract'),
      // The daemon is the peer here and this process is the agent side.
      fix: daemonFix(daemonVersion, SERVER_VERSION),
    },
    { version: SERVER_VERSION, contract: CONTRACT_FINGERPRINT },
  );
  if (skew !== undefined) log('reticle_daemon_skew', { port, warning: skew });
}

/** How long the daemon /status probe waits before giving up — a local loopback call is near-instant. */
const STATUS_PROBE_TIMEOUT_MS = 1000;

/** GET the daemon's /status JSON. Resolves to the parsed body, or undefined on any failure. */
export function fetchStatus(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: LOOPBACK_HOST, port, path: STATUS_PATH, timeout: STATUS_PROBE_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/** What `reticle open` should do: reuse an already-connected tab, open a new one, or ask for a url. */
type OpenDecision =
  | { action: 'reuse'; url: string }
  /** A tab on that origin exists, but on another page — kept, and NOT reported as done. */
  | { action: 'left-as-is'; url: string; requested: string }
  | { action: 'open'; url: string; replacing?: string }
  | { action: 'need-url' };

/** A connected tab as `decideOpen` sees it. `alive` is omitted when the caller has not probed. */
export interface OpenSession {
  url: string;
  /** False only when a probe proved the tab is not answering. Omitted / true → treat as live. */
  alive?: boolean;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const origin = new URL(a).origin;
    // Two opaque origins (desktop webviews, file:// docs) BOTH stringify to "null", so comparing them
    // would call every desktop app the same app and reuse the wrong session. Never match on opaque.
    if (isOpaqueOrigin(origin)) return false;
    return origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function isLive(session: OpenSession): boolean {
  return false !== session.alive;
}

/**
 * Decide what `reticle open [url]` does, given the currently-connected tabs. Pure.
 * - no url + a LIVE tab connected → reuse it (the app is already open; don't spawn a duplicate).
 * - no url + nothing connected → ask for one.
 * - no url + only silent tabs → open the one we know about (`replacing`), rather than ask.
 * - url + a LIVE tab already AT that url → reuse it (idempotent — re-running never piles up tabs).
 * - url + a LIVE tab on that origin but another page → keep it, and say so (`left-as-is`).
 * - url + no live matching tab → open it. If a silent tab was on that origin, `replacing` names it.
 *
 * The origin match is why re-running this never piles up tabs, and it stays — but only for tabs that
 * still answer. A connected-but-silent tab is how `open` became a dead end (#593): every later
 * command timed out, and `reticle_session end` only dropped the bookkeeping while the daemon's page
 * stayed stuck. Those tabs are treated as absent so `open` can recover without a daemon restart.
 */
export function decideOpen(sessions: OpenSession[], url: string | undefined): OpenDecision {
  const live = sessions.filter(isLive);
  if (url === undefined) {
    const firstLive = live[0];
    if (firstLive !== undefined) return { action: 'reuse', url: firstLive.url };
    const silent = sessions[0];
    return silent !== undefined
      ? { action: 'open', url: silent.url, replacing: silent.url }
      : { action: 'need-url' };
  }
  const exact = live.find((s) => s.url === url);
  if (exact !== undefined) return { action: 'reuse', url: exact.url };
  const onOrigin = live.find((s) => sameOrigin(s.url, url));
  if (onOrigin !== undefined) return { action: 'left-as-is', url: onOrigin.url, requested: url };
  const silentOnOrigin = sessions.find(
    (s) => !isLive(s) && (s.url === url || sameOrigin(s.url, url)),
  );
  return silentOnOrigin !== undefined
    ? { action: 'open', url, replacing: silentOnOrigin.url }
    : { action: 'open', url };
}

/** How long the CLI waits for the daemon's session probe — longer than the command budget inside it. */
const SESSION_PROBE_HTTP_TIMEOUT_MS = 2500;

type ProbePost = (port: number, sessionId: string) => Promise<{ status: number; body: string }>;

/**
 * POST `{sessionId}` to the daemon's probe route. The path is the named constant, never an
 * argument — a parameterised path on `http.request` is what CodeQL reads as file data leaving
 * the host, and this call is loopback-only to a route we named.
 */
function postSessionProbe(
  port: number,
  sessionId: string,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ sessionId });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: LOOPBACK_HOST,
        port,
        path: SESSION_PROBE_PATH,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: SESSION_PROBE_HTTP_TIMEOUT_MS,
      },
      (res) => {
        let received = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (received += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: received }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('probe timed out'));
    });
    req.end(body);
  });
}

function aliveFromProbeBody(body: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if ('object' !== typeof parsed || null === parsed) return undefined;
    const alive = (parsed as Record<string, unknown>)['alive'];
    return true === alive ? true : false === alive ? false : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this session is safe to reuse. True when the tab answered, and also when we cannot tell
 * (older daemon 404s, transport blip) — a duplicate tab is worse than a reuse that might still work.
 * False only when this daemon proved the tab is silent.
 */
export async function sessionAnswers(
  port: number,
  sessionId: string,
  post: ProbePost = postSessionProbe,
): Promise<boolean> {
  try {
    const res = await post(port, sessionId);
    if (404 === res.status) return true;
    if (200 !== res.status) return true;
    const alive = aliveFromProbeBody(res.body);
    return alive !== false;
  } catch {
    return true;
  }
}

/**
 * Probe the tab `decideOpen` would reuse, and if it is silent, try again without it.
 *
 * Only the candidate is probed, so a live tab is a millisecond snapshot and a silent extra tab on
 * another origin does not tax every `open`. `sessionAnswers` is injected so this stays hermetic.
 */
export async function resolveOpen(
  sessions: { sessionId: string; url: string }[],
  url: string | undefined,
  probe: (sessionId: string) => Promise<boolean>,
): Promise<OpenDecision> {
  const remaining = [...sessions];
  const silent: { url: string }[] = [];
  for (;;) {
    const decision = decideOpen(
      remaining.map((s) => ({ url: s.url })),
      url,
    );
    if (decision.action !== 'reuse' && decision.action !== 'left-as-is') {
      return decideOpen(
        [
          ...remaining.map((s) => ({ url: s.url })),
          ...silent.map((s) => ({ url: s.url, alive: false as const })),
        ],
        url,
      );
    }
    const target = remaining.find((s) => s.url === decision.url);
    if (target === undefined) return decision;
    if (await probe(target.sessionId)) return decision;
    silent.push({ url: target.url });
    remaining.splice(remaining.indexOf(target), 1);
  }
}

/**
 * Percent-encode the cmd.exe metacharacters that `start` re-parses so a URL can't break out into
 * command execution on Windows (`?next=x&calc` → command chaining). `%` is left untouched so an
 * already-encoded URL isn't double-encoded; the browser decodes the escapes back to the real URL.
 */
function encodeForWindowsStart(url: string): string {
  return url.replace(/[&^|<>()"'!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The OS command that opens a URL in the default browser, per platform. Pure — unit-tested. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } {
  if (NodePlatform.MACOS === platform) return { cmd: 'open', args: [url] };
  if (NodePlatform.WINDOWS === platform) {
    return { cmd: 'cmd', args: ['/c', 'start', '', encodeForWindowsStart(url)] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Launch the default browser at `url` (detached). The spawn is injected so tests stay hermetic.
 *
 * Resolves to whether the launch COMMAND started — not to whether a page appeared. It used to return
 * nothing at all and the caller printed `{"opened": url}` unconditionally, so a launcher that failed
 * outright still reported success. Reported from the field as twenty minutes lost chasing a phantom
 * port problem while nothing had ever opened.
 */
export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => Promise<string | null> = defaultRun,
): Promise<string | null> {
  const { cmd, args } = openCommand(url, platform);
  return run(cmd, args);
}

/** null when the launcher started; the failure message when it could not be run at all. */
function defaultRun(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // An unhandled 'error' on a ChildProcess throws — and ENOENT on the launcher is exactly the case
    // this function exists to report, so it must be listened for either way.
    child.on('error', (err: Error) => resolve(err.message));
    child.on('spawn', () => {
      child.unref();
      resolve(null);
    });
  });
}
