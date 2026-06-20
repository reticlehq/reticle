import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { STATUS_PATH } from './http-server.js';

/**
 * CLI launch + status helpers — the daemon-introspection (`iris status`) and the one-command
 * "show me the app" flow (`iris open`). Split out of cli.ts so that file stays under the size cap.
 * The decision logic is pure (unit-tested); the IO (fetch, OS browser launch) is injected/isolated.
 */

/** One connected tab as `iris status` reports it — the at-a-glance health line. */
export interface StatusSession {
  sessionId: string;
  url: string;
  throttled: boolean;
  stale: boolean;
  pendingMarks: number;
}

/**
 * Reduce the daemon's /status JSON to the compact view `iris status` prints. Pure: narrows the
 * untrusted wire payload (never `any`) and tolerates a missing/partial body so a malformed response
 * degrades to "running, 0 sessions" instead of throwing.
 */
export function summarizeStatus(payload: unknown): {
  sessionCount: number;
  sessions: StatusSession[];
} {
  if (typeof payload !== 'object' || payload === null) return { sessionCount: 0, sessions: [] };
  const obj = payload as Record<string, unknown>;
  const raw = Array.isArray(obj['sessions']) ? obj['sessions'] : [];
  const sessions = raw
    .map((s): StatusSession | null => {
      if (typeof s !== 'object' || s === null) return null;
      const r = s as Record<string, unknown>;
      const sessionId = typeof r['sessionId'] === 'string' ? r['sessionId'] : '';
      if (sessionId === '') return null;
      return {
        sessionId,
        url: typeof r['url'] === 'string' ? r['url'] : '',
        throttled: r['throttled'] === true,
        stale: r['stale'] === true,
        pendingMarks: typeof r['pendingMarks'] === 'number' ? r['pendingMarks'] : 0,
      };
    })
    .filter((s): s is StatusSession => s !== null);
  const sessionCount =
    typeof obj['sessionCount'] === 'number' ? obj['sessionCount'] : sessions.length;
  return { sessionCount, sessions };
}

/** GET the daemon's /status JSON. Resolves to the parsed body, or undefined on any failure. */
export function fetchStatus(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: STATUS_PATH, timeout: 1000 }, (res) => {
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
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/** What `iris open` should do: reuse an already-connected tab, open a new one, or ask for a url. */
export type OpenDecision =
  | { action: 'reuse'; url: string }
  | { action: 'open'; url: string }
  | { action: 'need-url' };

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Decide what `iris open [url]` does, given the currently-connected tabs. Pure.
 * - no url + a tab connected → reuse it (the app is already open; don't spawn a duplicate).
 * - no url + nothing connected → ask for one.
 * - url + a tab already on that origin → reuse it (idempotent — re-running never piles up tabs).
 * - url + no matching tab → open it.
 */
export function decideOpen(sessions: { url: string }[], url: string | undefined): OpenDecision {
  if (url === undefined) {
    const first = sessions[0];
    return first !== undefined ? { action: 'reuse', url: first.url } : { action: 'need-url' };
  }
  const match = sessions.find((s) => s.url === url || sameOrigin(s.url, url));
  return match !== undefined ? { action: 'reuse', url: match.url } : { action: 'open', url };
}

/** The OS command that opens a URL in the default browser, per platform. Pure — unit-tested. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** Launch the default browser at `url` (detached). The spawn is injected so tests stay hermetic. */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = defaultRun,
): void {
  const { cmd, args } = openCommand(url, platform);
  run(cmd, args);
}

function defaultRun(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}
