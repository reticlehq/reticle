/**
 * `reticle_navigate { reload: true, hard: true }` bypasses the cache where it can, and says so (#1785).
 *
 * The hard reload sent the SDK a REFRESH with `hard`, which navigates to the page URL with a
 * cache-busting query parameter. That fetches the document again, and every script and module still
 * comes from the cache. A leased tab can do better: the browser reloads it with the cache ignored.
 * Any other tab gets the old reload, and the result says that only the document was fetched.
 */
import { describe, expect, it } from 'vitest';
import { ReticleCommand, ReticleTool } from '@reticlehq/core';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { createFakeSession } from '@/portal/session/fake-session.js';
import type { BrowserPool } from '@/portal/pool/browser-pool.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { HardReload } from './act/navigation/reload-result.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';

interface Harness {
  readonly commands: { name: string; args: Record<string, unknown> | undefined }[];
  readonly reloadedLeases: string[];
  readonly deps: ToolDeps;
}

/** A connected tab, and a pool that reloads it through the browser only when it is a lease. */
function harness(isLease: boolean): Harness {
  const commands: Harness['commands'] = [];
  const reloadedLeases: string[] = [];
  const session = createFakeSession({
    command(name: string, args?: Record<string, unknown>) {
      commands.push({ name, args });
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
    },
  });
  const pool = {
    hardReloadLease: (sessionId: string): Promise<boolean> => {
      if (!isLease) {
        return Promise.resolve(false);
      }
      reloadedLeases.push(sessionId);
      return Promise.resolve(true);
    },
  } as unknown as BrowserPool;
  const sessions = {
    resolve: () => session,
    get: () => session,
  } as unknown as SessionManager;
  const deps = {
    sessions,
    pool,
    recordings: new RecordingStore(),
    now: () => 0,
  } as unknown as ToolDeps;
  return { commands, reloadedLeases, deps };
}

const navigate = (
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  (TOOLS.find((t) => t.name === ReticleTool.NAVIGATE) as ToolDef).handler(deps, {
    reload: true,
    timeout_ms: 0,
    ...args,
  }) as Promise<Record<string, unknown>>;

const refreshes = (h: Harness): Harness['commands'] =>
  h.commands.filter((c) => ReticleCommand.REFRESH === c.name);

describe('a hard reload', () => {
  it('reloads a leased tab through the browser with the cache ignored', async () => {
    const h = harness(true);
    const result = await navigate(h.deps, { hard: true });

    expect(h.reloadedLeases).toHaveLength(1);
    // The page's own reload would fetch the document only; it is not sent as well.
    expect(refreshes(h)).toHaveLength(0);
    expect(result['hardReload']).toBe(HardReload.CACHE_IGNORED);
    expect(String(result['note'])).toContain('cache ignored');
  });

  it('falls back to the page reload on a tab that is not a lease, and says only the document was fetched', async () => {
    const h = harness(false);
    const result = await navigate(h.deps, { hard: true });

    expect(refreshes(h)).toEqual([{ name: ReticleCommand.REFRESH, args: { hard: true } }]);
    expect(result['hardReload']).toBe(HardReload.DOCUMENT_ONLY);
    expect(String(result['note'])).toContain('only the document was fetched again');
    expect(String(result['note'])).toContain('reticle_lease');
  });
});

describe('a plain reload', () => {
  it('is the page reload, and says nothing about the cache', async () => {
    const h = harness(true);
    const result = await navigate(h.deps, {});

    expect(h.reloadedLeases).toHaveLength(0);
    expect(refreshes(h)).toEqual([{ name: ReticleCommand.REFRESH, args: { hard: false } }]);
    expect(result['hardReload']).toBeUndefined();
  });
});

describe('a session double without a pool', () => {
  it('still reloads the page', async () => {
    const h = harness(false);
    const deps = { ...h.deps, pool: undefined } as unknown as ToolDeps;
    const result = await navigate(deps, { hard: true });

    expect(refreshes(h)).toHaveLength(1);
    expect(result['hardReload']).toBe(HardReload.DOCUMENT_ONLY);
  });
});
