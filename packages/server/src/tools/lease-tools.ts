/**
 * Lease tools — the agent-facing surface of the BrowserPool.
 *
 * `reticle_lease_acquire` opens a fresh isolated headless context navigated to the app URL and returns
 * the sessionId the app's SDK will register (stamped via __reticle_session so the lease and the session
 * correlate 1:1). This is the "one of 10 flows" entry point: 10 agents acquire 10 leases, the pool
 * keeps them in ONE browser, capped and queued. `reticle_lease_release` frees the slot.
 *
 * Attach-only: the pool drives a browser against an already-running dev server — it never starts one.
 */

import { z } from 'zod';
import { RETICLE_URL_PARAM } from '@reticlehq/protocol';
import { ReticleTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import { asString } from './tools-helpers.js';

const POOL_UNAVAILABLE =
  'browser pool unavailable — the lease tools need the daemon-managed pool (start Reticle via `reticle mcp`).';

/**
 * Append Reticle identity params (__reticle_session, optional __reticle_project) to a URL so the app's own SDK
 * adopts them on connect. Pure; falls back to plain concatenation if the URL can't be parsed.
 */
export function appendReticleParams(url: string, session: string, projectId?: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(RETICLE_URL_PARAM.SESSION, session);
    if (projectId !== undefined && projectId.length > 0) {
      u.searchParams.set(RETICLE_URL_PARAM.PROJECT, projectId);
    }
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    const proj =
      projectId !== undefined && projectId.length > 0
        ? `&${RETICLE_URL_PARAM.PROJECT}=${encodeURIComponent(projectId)}`
        : '';
    return `${url}${sep}${RETICLE_URL_PARAM.SESSION}=${encodeURIComponent(session)}${proj}`;
  }
}

/**
 * Turn a raw navigation failure (Playwright's `page.goto: net::ERR_… at <url>\nCall log:…`, often
 * with ANSI codes) into a short, clean reason — so the agent/user sees "is the app running?" instead
 * of an internals-leaking wall of text.
 */
export function cleanNavError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Strip ANSI color codes (ESC[…m) Playwright emits — built via fromCharCode to keep the
  // control character out of a regex literal (no-control-regex).
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const firstLine = (msg.split('\n')[0] ?? msg).replace(ansi, '');
  const netCode = /net::[A-Z_]+/.exec(firstLine);
  if (netCode !== null) return netCode[0];
  if (/timeout/i.test(firstLine)) return 'navigation timed out';
  return firstLine
    .replace(/^page\.goto:\s*/, '')
    .replace(/\s+at\s+https?:\/\/\S+.*$/, '')
    .trim()
    .slice(0, 100);
}

/** A fresh, collision-resistant lease id. Uses crypto at the I/O boundary (not pure logic). */
function newLeaseId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${String(Date.now())}-${String(performance.now())}`;
  return `lease-${uuid}`;
}

const LEASE_READY_ATTEMPTS = 100;
const LEASE_READY_POLL_MS = 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the leased tab's SDK has actually registered on the bridge, so the sessionId we return
 * is immediately usable (the page navigates first, then connects a moment later — without this wait
 * an agent's very next call could race and hit "no connected session"). Returns whether it connected
 * in time. `isConnected`, `sleeper`, and `attempts` are injected so this is fast to unit-test.
 */
export async function waitForLeasedSession(
  isConnected: () => boolean,
  sleeper: (ms: number) => Promise<void> = sleep,
  attempts: number = LEASE_READY_ATTEMPTS,
  pollMs: number = LEASE_READY_POLL_MS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (isConnected()) return true;
    await sleeper(pollMs);
  }
  return isConnected();
}

export const LEASE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.LEASE_ACQUIRE,
    description:
      'Lease a fresh isolated headless browser context from the shared pool and navigate it to the app URL (the app must already be running and embed @reticlehq/core). Returns the sessionId the leased tab registers — pass it to other tools. The pool keeps all leases in ONE browser and caps concurrency; if at capacity this waits for a free slot. Release with reticle_lease_release when the flow is done.',
    inputSchema: {
      url: z
        .string()
        .describe(
          'URL of the already-running app to drive (e.g. http://localhost:3000/dashboard).',
        ),
      projectId: z
        .string()
        .optional()
        .describe('Stable project id to stamp on the leased tab so the agent can scope to it.'),
    },
    outputSchema: {
      sessionId: z.string(),
      url: z.string(),
      ready: z
        .boolean()
        .describe(
          'Whether the leased tab connected — false ⇒ the app may not embed @reticlehq/core.',
        ),
      leased: z.number().describe('How many contexts are currently leased from the pool.'),
      queued: z.number().describe('How many acquires are waiting for a free slot.'),
      hint: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const pool = deps.pool;
      if (pool === undefined) throw new Error(POOL_UNAVAILABLE);
      const url = asString(args['url']);
      if (url === undefined || url.length === 0)
        throw new Error('reticle_lease_acquire requires a url');
      const projectId = asString(args['projectId']);
      const sessionId = newLeaseId();
      const navUrl = appendReticleParams(url, sessionId, projectId);
      let lease;
      try {
        lease = await pool.acquire(navUrl, { sessionId });
      } catch (err) {
        // A raw page.goto failure is noisy and leaks the internal URL params — surface a clean,
        // actionable message instead.
        throw new Error(
          `could not open ${url} — is the app running there? (${cleanNavError(err)})`,
        );
      }
      // Wait for the leased tab's SDK to connect so the returned sessionId is usable right away.
      const ready = await waitForLeasedSession(
        () => deps.sessions.get(lease.sessionId) !== undefined,
      );
      return {
        sessionId: lease.sessionId,
        url,
        ready,
        leased: pool.activeCount(),
        queued: pool.queuedCount(),
        ...(ready
          ? {}
          : {
              hint: `leased tab did not connect — is ${url} running with @reticlehq/core enabled?`,
            }),
      };
    },
  },
  {
    name: ReticleTool.LEASE_RELEASE,
    description:
      'Release a leased browser context by sessionId, closing it and freeing the pool slot for a queued acquire. Call this when a flow finishes so the pool stays within its concurrency cap.',
    inputSchema: {
      sessionId: z.string().describe('The leased sessionId returned by reticle_lease_acquire.'),
    },
    outputSchema: {
      released: z.boolean(),
      leased: z.number(),
    },
    handler: async (deps: ToolDeps, args) => {
      const pool = deps.pool;
      if (pool === undefined) throw new Error(POOL_UNAVAILABLE);
      const sessionId = asString(args['sessionId']);
      if (sessionId === undefined || sessionId.length === 0) {
        throw new Error('reticle_lease_release requires a sessionId');
      }
      await pool.release(sessionId);
      return { released: true, leased: pool.activeCount() };
    },
  },
];
