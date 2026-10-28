/**
 * A page-needing call on an app nobody wired opens that app instead of refusing.
 *
 * The MCP-only install never runs `init`, and the first `reticle_look` answered "no browser session
 * connected" — the dead end the agent stopped at. The dispatcher now asks the zero-install opener
 * once, and the call runs against the tab it opened, with one line saying what that tab is.
 * A call that does not need a page never opens a browser.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool, type CommandResult } from '@reticlehq/core';
import { createFakeSession } from '@/portal/session/fake-session.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { type ToolDef, type ToolDeps } from './tools.js';
import { EnvelopeKey } from './tool-kit.js';
import { runTool } from './invoke-tool.js';

const ROOT = '/tmp/reticle-dispatch-opens-unwired/.reticle';
const NOTICE = 'opened http://localhost:5173 zero-install';
const OFFER = 'This web app can be checked now with no install.';

function leased(): Session {
  return createFakeSession(
    {
      command: (): Promise<CommandResult> =>
        Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
      health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      bufferHealth: () => ({ total: 0, dropped: 0 }),
    },
    { sessionId: 'lease-1', url: 'http://localhost:5173/' },
  );
}

/** Nothing connected until the opener runs; then the leased tab is the one session. */
function unwired(): { deps: ToolDeps; opens: () => number } {
  let tab: Session | undefined;
  let opens = 0;
  const sessions: Partial<SessionManager> = {
    resolve: () => {
      if (tab === undefined) throw new Error('no browser session connected');
      return tab;
    },
    list: () =>
      (tab === undefined ? [] : [{ sessionId: tab.id, url: tab.url }]) as ReturnType<
        SessionManager['list']
      >,
  };
  const fs = createNodeFileSystem();
  const now = (): number => 0;
  const deps: ToolDeps = {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now }),
    project: new ProjectStore(fs, ROOT, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now,
    openUnwiredApp: () => {
      opens += 1;
      tab = leased();
      return Promise.resolve({ url: 'http://localhost:5173', notice: NOTICE });
    },
  };
  return { deps, opens: () => opens };
}

function tool(name: string, seen: Record<string, unknown>[]): ToolDef {
  return {
    name,
    description: '',
    inputSchema: {},
    handler: (_deps, args) => {
      seen.push(args);
      return Promise.resolve({ ok: true });
    },
  };
}

describe('a page-needing call on an unwired app', () => {
  it('opens the app, runs the call against that tab, and says what it opened', async () => {
    const { deps, opens } = unwired();
    const seen: Record<string, unknown>[] = [];
    const result = (await runTool(tool(ReticleTool.LOOK, seen), deps, {})) as Record<
      string,
      unknown
    >;
    expect(opens()).toBe(1);
    expect(seen[0]?.['sessionId']).toBe('lease-1');
    expect(result[EnvelopeKey.ZERO_INSTALL]).toBe(NOTICE);
  });

  it('never opens a browser for a call that does not need a page', async () => {
    const { deps, opens } = unwired();
    await runTool(tool(ReticleTool.TOOLS, []), deps, {});
    expect(opens()).toBe(0);
  });

  it('says the first-session offer on the first call of a connection, once, and changes no verdict', async () => {
    const { deps } = unwired();
    const asked: string[] = [];
    const offerDeps: ToolDeps = {
      ...deps,
      attachId: 'attach-1',
      firstSessionOffer: (attachId) => {
        const first = !asked.includes(attachId);
        asked.push(attachId);
        return first ? OFFER : undefined;
      },
    };
    const verdict: ToolDef = {
      name: ReticleTool.TOOLS,
      description: '',
      inputSchema: {},
      handler: () => Promise.resolve({ verified: 'yes', because: 'b' }),
    };
    const first = (await runTool(verdict, offerDeps, {})) as Record<string, unknown>;
    expect(first[EnvelopeKey.FIRST_SESSION_OFFER]).toBe(OFFER);
    expect(first['verified']).toBe('yes');
    expect(first['because']).toBe('b');
    const second = (await runTool(verdict, offerDeps, {})) as Record<string, unknown>;
    expect(second[EnvelopeKey.FIRST_SESSION_OFFER]).toBeUndefined();
    expect(asked).toEqual(['attach-1', 'attach-1']);
  });

  it('does not say the offer twice when the call opened the app and said so', async () => {
    const { deps } = unwired();
    const offerDeps: ToolDeps = { ...deps, attachId: 'attach-1', firstSessionOffer: () => OFFER };
    const result = (await runTool(tool(ReticleTool.LOOK, []), offerDeps, {})) as Record<
      string,
      unknown
    >;
    // An agent's own call folds the notice into `notices`; it is still said.
    expect(JSON.stringify(result)).toContain(NOTICE);
    expect(result[EnvelopeKey.FIRST_SESSION_OFFER]).toBeUndefined();
  });

  it('leaves a call that named its own session alone', async () => {
    const { deps, opens } = unwired();
    await runTool(tool(ReticleTool.LOOK, []), deps, { sessionId: 'tab-x' }).catch(() => undefined);
    expect(opens()).toBe(0);
  });
});
