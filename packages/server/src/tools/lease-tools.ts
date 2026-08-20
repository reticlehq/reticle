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
import { leaseNotConnectedHint, type LeaseEvidence } from './lease-hint.js';
import { readProjectFramework, readProjectId } from '../cli/cli-port.js';
import { hasConnectedBefore } from '../session/connection-memory.js';
import { reticleStateHome } from '../daemon/daemon.js';
import { RETICLE_URL_PARAM, RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import { asString } from './tools-helpers.js';
import { chromiumHint } from '../cli/chromium-hint.js';

/**
 * Everything the daemon already knows about why a leased tab might not have dialled in.
 *
 * Gathered here rather than guessed in the hint, because the daemon HAD this evidence all along and
 * printed a static differential over the top of it — telling one agent in `reticle_sessions` that
 * the wiring was proven correct and telling it seconds later that the port was probably wrong.
 */
function leaseEvidence(deps: ToolDeps, port: number): LeaseEvidence {
  const cwd = process.cwd();
  const projectId = readProjectId(cwd);
  const refusal = deps.sessions.lastClosure()?.reason;
  const framework = readProjectFramework(cwd);
  return {
    ...(refusal === undefined ? {} : { refusal }),
    ...(framework === undefined ? {} : { framework }),
    previouslyConnected: hasConnectedBefore(reticleStateHome(), port, projectId),
    initialized: projectId !== undefined,
  };
}

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
    'function' === typeof globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${String(Date.now())}-${String(performance.now())}`;
  return `lease-${uuid}`;
}

/**
 * The session a lease's tab actually registered as, or undefined while nothing has.
 *
 * Normally that is the lease id: `appendReticleParams` stamps `__reticle_session` on the URL and the
 * SDK adopts it. An app that passes an explicit `session` to `connect()` keeps its own name instead,
 * which is legitimate — a single-app fixture does it deliberately so a battery can address it by a
 * known id. Matching on the lease id alone could never see those tabs, so the lease reported
 * `ready: false` and a hint blaming a port mismatch while the session was connected and driveable.
 *
 * The URL marker is the evidence, and it is what makes this safe: two concurrent leases on one origin
 * carry different markers, so neither can adopt the other's tab. Parsed rather than substring-matched,
 * so `lease-abc` cannot claim `lease-abcdef`.
 */
export function resolveLeasedSessionId(
  sessions: { get: (id: string) => unknown; all: () => { id: string; url?: string }[] },
  leaseId: string,
): string | undefined {
  if (sessions.get(leaseId) !== undefined) return leaseId;
  return sessions.all().find((s) => sessionParamOf(s.url) === leaseId)?.id;
}

function sessionParamOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).searchParams.get(RETICLE_URL_PARAM.SESSION) ?? undefined;
  } catch {
    return undefined;
  }
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
/**
 * Acquire a leased, SDK-connected context for a caller that is not the lease TOOL (the parallel suite).
 * Returns the session id plus its release; the caller must release in a finally so a crashed flow never
 * leaks a pool slot and starves the rest of the suite.
 */
export async function acquireLeasedSession(
  pool: {
    acquire: (
      url: string,
      opts: { sessionId: string },
    ) => Promise<{ sessionId: string; release: () => Promise<void> }>;
    /** Optional so a test double need not implement it; the real pool always does. */
    alias?: (registeredId: string, leaseId: string) => void;
  },
  sessions: { get: (id: string) => unknown; all: () => { id: string; url?: string }[] },
  url: string,
  projectId?: string,
): Promise<{ sessionId: string; release: () => Promise<void> }> {
  const sessionId = newLeaseId();
  const lease = await pool.acquire(appendReticleParams(url, sessionId, projectId), { sessionId });
  // Resolved, not assumed — see resolveLeasedSessionId. The parallel suite replays against whatever
  // id comes back, so handing it the lease id for an app that named its own session sent every flow
  // in the run at a session that does not exist.
  let registeredId: string | undefined;
  await waitForLeasedSession(() => {
    registeredId = resolveLeasedSessionId(sessions, lease.sessionId);
    return registeredId !== undefined;
  });
  if (registeredId !== undefined) pool.alias?.(registeredId, lease.sessionId);
  return { sessionId: registeredId ?? lease.sessionId, release: () => lease.release() };
}

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

/**
 * Named on its own because `reticle drive <url>` runs it too.
 *
 * When a daemon already owns the bridge port, `drive` asks that daemon for a browser instead of
 * competing for the port (see cli/drive-attach.ts), and the browser it should get is exactly the one
 * an agent gets: same pool, same isolation, same reporting. Sharing the ToolDef rather than the
 * handler keeps that literal — the drive route dispatches through `runTool`, so it is counted like
 * any other call instead of being a second, invisible dispatch path.
 */
export const LEASE_ACQUIRE_TOOL: ToolDef = {
  name: ReticleTool.LEASE_ACQUIRE,
  description:
    'Lease a fresh isolated headless browser context from the shared pool and navigate it to the app URL (the app must already be running and embed @reticlehq/core). Returns the sessionId the leased tab registers — pass it to other tools. The pool keeps all leases in ONE browser and caps concurrency; if at capacity this waits for a free slot. Release with reticle_lease{action:"release"} when the flow is done.',
  inputSchema: {
    url: z
      .string()
      .describe('URL of the already-running app to drive (e.g. http://localhost:3000/dashboard).'),
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
    expiresInMs: z
      .number()
      .describe(
        'Milliseconds until this lease expires if untouched. Each tool call that targets this session resets the clock. Plan your work to finish or re-acquire before this runs out.',
      ),
    leased: z.number().describe('How many contexts are currently leased from the pool.'),
    queued: z.number().describe('How many acquires are waiting for a free slot.'),
    hint: z.string().optional(),
  },
  handler: async (deps: ToolDeps, args) => {
    const pool = deps.pool;
    if (pool === undefined) throw new Error(POOL_UNAVAILABLE);
    const url = asString(args['url']);
    if (url === undefined || 0 === url.length)
      throw new Error('reticle_lease{action:"acquire"} requires a url');
    // Preflight the browser before spending the round trip. Without it a missing Playwright Chromium
    // only surfaces inside pool.acquire, where the launch failure is caught and reported as
    // "could not open <url> — is the app running?" — sending the caller to debug an app that is
    // fine. Say the real thing at the first refusal instead. The phrasing carries "Chromium is not
    // installed" so error-recovery routes it to the NO_POOL fix (install + drive a human tab).
    if (deps.browserProbe !== undefined) {
      const probe = await deps.browserProbe();
      if (!probe.exists) {
        throw new Error(`Chromium is not installed for Playwright — ${chromiumHint(probe)}`);
      }
    }
    const projectId = asString(args['projectId']);
    const sessionId = newLeaseId();
    const navUrl = appendReticleParams(url, sessionId, projectId);
    let lease;
    try {
      lease = await pool.acquire(navUrl, { sessionId });
    } catch (err) {
      // A raw page.goto failure is noisy and leaks the internal URL params — surface a clean,
      // actionable message instead.
      throw new Error(`could not open ${url} — is the app running there? (${cleanNavError(err)})`);
    }
    // Wait for the leased tab's SDK to connect so the returned sessionId is usable right away.
    // Resolved rather than assumed: an app that names its own session registers under that name,
    // and the id we hand back has to be the one the agent can actually drive.
    let registeredId: string | undefined;
    const ready = await waitForLeasedSession(() => {
      registeredId = resolveLeasedSessionId(deps.sessions, lease.sessionId);
      return registeredId !== undefined;
    });
    // Tell the pool the other name this lease answers to. Every later touch and release arrives
    // under the id we are about to hand back, and the pool is keyed by the id it navigated with;
    // without this the touches miss, the lease ages out despite continuous activity, and the
    // reaper closes the context mid-flow. See BrowserPool.alias and #157.
    if (registeredId !== undefined) pool.alias(registeredId, lease.sessionId);
    return {
      sessionId: registeredId ?? lease.sessionId,
      url,
      ready,
      expiresInMs: pool.leaseTtlMs(),
      leased: pool.activeCount(),
      queued: pool.queuedCount(),
      ...(ready
        ? {}
        : (() => {
            const bridgePort = deps.bridgePort ?? RETICLE_DEFAULT_PORT;
            return {
              hint: leaseNotConnectedHint(url, bridgePort, leaseEvidence(deps, bridgePort)),
            };
          })()),
    };
  },
};

export const LEASE_RELEASE_TOOL: ToolDef = {
  name: ReticleTool.LEASE_RELEASE,
  description:
    'Release a leased browser context by sessionId, closing it and freeing the pool slot for a queued acquire. Call this when a flow finishes so the pool stays within its concurrency cap.',
  inputSchema: {
    sessionId: z
      .string()
      .describe('The leased sessionId returned by reticle_lease{action:"acquire"}.'),
  },
  outputSchema: {
    released: z.boolean(),
    leased: z.number(),
  },
  handler: async (deps: ToolDeps, args) => {
    const pool = deps.pool;
    if (pool === undefined) throw new Error(POOL_UNAVAILABLE);
    const sessionId = asString(args['sessionId']);
    if (sessionId === undefined || 0 === sessionId.length) {
      throw new Error('reticle_lease{action:"release"} requires a sessionId');
    }
    await pool.release(sessionId);
    return { released: true, leased: pool.activeCount() };
  },
};

export const LEASE_TOOLS: ToolDef[] = [LEASE_ACQUIRE_TOOL, LEASE_RELEASE_TOOL];
