/**
 * Lease tools — the agent-facing surface of the BrowserPool.
 *
 * `iris_lease_acquire` opens a fresh isolated headless context navigated to the app URL and returns
 * the sessionId the app's SDK will register (stamped via __iris_session so the lease and the session
 * correlate 1:1). This is the "one of 10 flows" entry point: 10 agents acquire 10 leases, the pool
 * keeps them in ONE browser, capped and queued. `iris_lease_release` frees the slot.
 *
 * Attach-only: the pool drives a browser against an already-running dev server — it never starts one.
 */

import { z } from 'zod';
import { IRIS_URL_PARAM } from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import { asString } from './tools-helpers.js';

const POOL_UNAVAILABLE =
  'browser pool unavailable — the lease tools need the daemon-managed pool (start Iris via `iris mcp`).';

/**
 * Append Iris identity params (__iris_session, optional __iris_project) to a URL so the app's own SDK
 * adopts them on connect. Pure; falls back to plain concatenation if the URL can't be parsed.
 */
export function appendIrisParams(url: string, session: string, projectId?: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(IRIS_URL_PARAM.SESSION, session);
    if (projectId !== undefined && projectId.length > 0) {
      u.searchParams.set(IRIS_URL_PARAM.PROJECT, projectId);
    }
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    const proj =
      projectId !== undefined && projectId.length > 0
        ? `&${IRIS_URL_PARAM.PROJECT}=${encodeURIComponent(projectId)}`
        : '';
    return `${url}${sep}${IRIS_URL_PARAM.SESSION}=${encodeURIComponent(session)}${proj}`;
  }
}

/** A fresh, collision-resistant lease id. Uses crypto at the I/O boundary (not pure logic). */
function newLeaseId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${String(Date.now())}-${String(performance.now())}`;
  return `lease-${uuid}`;
}

export const LEASE_TOOLS: ToolDef[] = [
  {
    name: IrisTool.LEASE_ACQUIRE,
    description:
      'Lease a fresh isolated headless browser context from the shared pool and navigate it to the app URL (the app must already be running and embed @syrin/iris). Returns the sessionId the leased tab registers — pass it to other tools. The pool keeps all leases in ONE browser and caps concurrency; if at capacity this waits for a free slot. Release with iris_lease_release when the flow is done.',
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
      leased: z.number().describe('How many contexts are currently leased from the pool.'),
      queued: z.number().describe('How many acquires are waiting for a free slot.'),
    },
    handler: async (deps: ToolDeps, args) => {
      const pool = deps.pool;
      if (pool === undefined) throw new Error(POOL_UNAVAILABLE);
      const url = asString(args['url']);
      if (url === undefined || url.length === 0)
        throw new Error('iris_lease_acquire requires a url');
      const projectId = asString(args['projectId']);
      const sessionId = newLeaseId();
      const navUrl = appendIrisParams(url, sessionId, projectId);
      const lease = await pool.acquire(navUrl, { sessionId });
      return {
        sessionId: lease.sessionId,
        url,
        leased: pool.activeCount(),
        queued: pool.queuedCount(),
      };
    },
  },
  {
    name: IrisTool.LEASE_RELEASE,
    description:
      'Release a leased browser context by sessionId, closing it and freeing the pool slot for a queued acquire. Call this when a flow finishes so the pool stays within its concurrency cap.',
    inputSchema: {
      sessionId: z.string().describe('The leased sessionId returned by iris_lease_acquire.'),
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
        throw new Error('iris_lease_release requires a sessionId');
      }
      await pool.release(sessionId);
      return { released: true, leased: pool.activeCount() };
    },
  },
];
