/**
 * `reticle_intent` must never write a ledger into a checkout nobody drove.
 *
 * Reported three times against 2.14.0 (#994): an app connected carrying its own projectId, and
 * `reticle_intent { declare }` over the daemon HTTP transport wrote `intent.json` under the
 * DAEMON's startup cwd — a different project — "instead of refusing or using the connected app
 * project". `.reticle/intent.json` is a git-checked file, so this is uncommanded data loss in
 * somebody's repository, and the one reporter who caught it caught it with `git diff`.
 *
 * The routing half of that cluster is this: an agent that passes `sessionId` has named the project
 * too, and when the id resolves to nothing `sessionRoot` used to swallow the refusal and answer
 * with `deps.reticleRoot`. Driven here through the real tool handler rather than the helper,
 * because the property that matters is about BYTES — `createMemoryFs` exposes where they landed,
 * which is the only way to state "and nothing else was touched".
 */
import { describe, expect, it } from 'vitest';
import { INTENT_TOOLS } from './intent-tools.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

const DAEMON_ROOT = '/other-repo/.reticle';
const APP_ROOT = '/connected-app/.reticle';
const APP_PROJECT = 'acme-4b21';
const LIVE_ID = 'live-7';
/** The id the agent still holds after the tab came back under a new one. Names nothing now. */
const GONE_ID = 'gone-42';

const tool = INTENT_TOOLS.find((t) => ReticleTool.INTENT === t.name);

/** Two intents already in the other project's committed ledger, as a reporter's repo had. */
const EXISTING_LEDGER = `${JSON.stringify(
  {
    version: 1,
    intents: {
      'other-a': { id: 'other-a', statement: 'A', state: 'declared', declaredAt: 1 },
      'other-b': { id: 'other-b', statement: 'B', state: 'declared', declaredAt: 2 },
    },
  },
  null,
  2,
)}\n`;

function scene(options: { liveId?: string; connected?: boolean }) {
  const { fs, written } = createMemoryFs();
  written.set(reticleDirPaths(DAEMON_ROOT).intent, EXISTING_LEDGER);
  const session = { id: options.liveId ?? LIVE_ID, projectId: APP_PROJECT };
  const deps = {
    fs,
    reticleRoot: DAEMON_ROOT,
    now: () => 1_000,
    sessions: {
      resolve: (sessionId?: string) => {
        if (false === options.connected) throw new Error('no browser session connected');
        if (sessionId !== undefined && sessionId !== session.id) {
          throw new Error(`no connected session with id '${sessionId}'`);
        }
        return session;
      },
    },
    artifactRootFor: (projectId: string | undefined) =>
      APP_PROJECT === projectId
        ? { root: APP_ROOT, reason: ArtifactRootReason.MATCHED_PROJECT }
        : { root: DAEMON_ROOT, reason: ArtifactRootReason.NO_MATCH },
  } as unknown as ToolDeps;
  return { deps, written };
}

const declare = {
  action: 'declare',
  intents: [
    { id: 'cfp-delete-submission', statement: 'an author can delete their own submission' },
  ],
};

describe('reticle_intent against a session id that names nothing', () => {
  it("refuses instead of writing the ledger into the daemon's own checkout", async () => {
    const { deps } = scene({});

    await expect(tool?.handler(deps, { ...declare, sessionId: GONE_ID })).rejects.toThrow(GONE_ID);
  });

  it("leaves the other project's committed ledger byte-for-byte unchanged", async () => {
    const { deps, written } = scene({});

    await expect(tool?.handler(deps, { ...declare, sessionId: GONE_ID })).rejects.toThrow();

    expect(
      written.get(reticleDirPaths(DAEMON_ROOT).intent),
      'the pre-call ledger of a repo nobody drove',
    ).toBe(EXISTING_LEDGER);
    expect([...written.keys()], 'a refused call writes nothing at all').toEqual([
      reticleDirPaths(DAEMON_ROOT).intent,
    ]);
  });

  it('reads nothing from the wrong project either — `list` refuses the same way', async () => {
    const { deps } = scene({});

    await expect(tool?.handler(deps, { action: 'list', sessionId: GONE_ID })).rejects.toThrow(
      GONE_ID,
    );
  });
});

describe('reticle_intent still routes the cases that were never broken', () => {
  it("writes into the connected app's project when the named session is live", async () => {
    const { deps, written } = scene({});

    await tool?.handler(deps, { ...declare, sessionId: LIVE_ID });

    expect(written.has(reticleDirPaths(APP_ROOT).intent)).toBe(true);
    expect(written.get(reticleDirPaths(DAEMON_ROOT).intent)).toBe(EXISTING_LEDGER);
  });

  it("writes into the connected app's project when no session was named", async () => {
    const { deps, written } = scene({});

    await tool?.handler(deps, declare);

    expect(written.has(reticleDirPaths(APP_ROOT).intent)).toBe(true);
    expect(written.get(reticleDirPaths(DAEMON_ROOT).intent)).toBe(EXISTING_LEDGER);
  });

  /**
   * The offline case stays a write, deliberately. Declaring an intent is something an agent does
   * while it is still building, often before an app is running at all — refusing that would retire
   * the tool for the moment it is most useful. Nothing was named, so nothing was mis-addressed.
   */
  it('falls back to the daemon root when nothing is connected and nothing was named', async () => {
    const { deps, written } = scene({ connected: false });

    await tool?.handler(deps, declare);

    const ledger = written.get(reticleDirPaths(DAEMON_ROOT).intent) ?? '';
    expect(ledger).toContain('cfp-delete-submission');
    expect(written.has(reticleDirPaths(APP_ROOT).intent)).toBe(false);
  });
});
