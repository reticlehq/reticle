/**
 * One tool call runs in ONE session — the one it is attributed to.
 *
 * `runTool` resolves a session up front and hangs everything the agent is told on it: the pool
 * lease it refreshes, the health envelope it splices, the tab a ref is recorded as minted in, the
 * project ledger the call is recorded against, and the session a verdict is reported under. Then it
 * handed the handler the caller's args UNTOUCHED — so a call that named no `sessionId` resolved a
 * second time inside the handler, against a registry that may have changed in between.
 *
 * Reported from the field (#983): a ref was taken while exactly one tab was connected, a parallel
 * job connected a second tab seconds later, and the click on that ref landed in the newcomer while
 * the response described the first. Nothing in either result looks wrong, which is what makes it a
 * false-verdict generator in both directions: the predicate is graded against a page that was never
 * driven.
 *
 * The wrong-tab guard cannot see this, and that is the sharpest way to state the defect: it is
 * asked "does this ref belong to the tab we chose?" about the tab `runTool` chose, while the drive
 * goes somewhere else. A guard answering a question about a different tab than the one being driven
 * is not a guard.
 *
 * Only the OMITTED case is pinned. An explicit `sessionId` already names the tab and is passed
 * through exactly as written — including one lifted off a sequence step — and a disk-only tool,
 * which `runTool` never resolves a session for, is left unscoped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ReticleCommand, ReticleTool, type CommandResult } from '@reticlehq/core';
import { createFakeSession } from '@/portal/session/fake-session.js';
import type { Session } from '@/portal/session/session.js';
import { SessionManager } from '@/portal/session/session-manager.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { forgetRefProvenance, noteRefsMinted } from '@/portal/session/facts/ref-provenance.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';

const ROOT = '/tmp/reticle-dispatch-session-pin/.reticle';
/** The tab that was connected when the agent took its ref. */
const FIRST = 'tab-first';
/** The tab a parallel job connects mid-call, which auto-selection then prefers. */
const NEWER = 'tab-newer';
const CLICK = { ref: 'e1', action: 'click' } as const;

interface TwoTabs {
  deps: ToolDeps;
  /** The sessions an ACT actually reached, in order. */
  driven: string[];
  /** The sessions whose pool lease was refreshed. */
  touched: string[];
  /** Every argument `resolve` was asked for. */
  asked: (string | undefined)[];
}

function tab(id: string, driven: string[], lastSeenMs = 0): Session {
  return createFakeSession(
    {
      command: (name: string): Promise<CommandResult> => {
        if (ReticleCommand.ACT === name) driven.push(id);
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { dispatched: true, settled: true, settleReason: null },
        });
      },
      // Heartbeat age is what auto-selection scores on, so it is the one health field a test about
      // WHICH tab gets picked has to be able to set.
      lastSeenMs: () => lastSeenMs,
      health: () => ({ lastSeenMs, throttled: false, focused: true }),
      bufferHealth: () => ({ total: 0, dropped: 0 }),
    },
    { sessionId: id, url: `http://localhost:5173/${id}` },
  );
}

/**
 * Two connected tabs, where auto-selection changes its mind between one resolution and the next.
 *
 * That is the reported race compressed into a fixture: the FIRST resolution of an omitted
 * `sessionId` answers with the tab that was already there, every later one with the newcomer that
 * has just become the freshest. A real `SessionManager` does this on its own — the newcomer's
 * heartbeat is younger — and nothing about the call changes in between.
 */
function twoTabs(): TwoTabs {
  const driven: string[] = [];
  const touched: string[] = [];
  const asked: (string | undefined)[] = [];
  const first = tab(FIRST, driven);
  const newer = tab(NEWER, driven);
  let omitted = 0;
  const sessions: Partial<SessionManager> = {
    resolve: (id?: string) => {
      asked.push(id);
      if (id !== undefined) {
        const found = [first, newer].find((s) => s.id === id);
        if (found === undefined) throw new Error(`no connected session with id '${id}'`);
        return found;
      }
      omitted += 1;
      return omitted <= 1 ? first : newer;
    },
    list: () =>
      [first, newer].map((s) => ({ sessionId: s.id, url: s.url })) as ReturnType<
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
  };
  (deps as { pool?: { touch(id: string): void } }).pool = {
    touch: (id: string) => touched.push(id),
  };
  return { deps, driven, touched, asked };
}

function toolNamed(name: string): ToolDef {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

const actTool = (): ToolDef => toolNamed(ReticleTool.ACT);

/** A handler that records the args it was dispatched with and answers nothing interesting. */
function recordingTool(name: string, seen: Record<string, unknown>[]): ToolDef {
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

describe('a tool call is dispatched into the session it is attributed to', () => {
  afterEach(() => {
    forgetRefProvenance();
  });

  it('drives the tab the call resolved to, not one that connected mid-call', async () => {
    const { deps, driven } = twoTabs();
    await runTool(actTool(), deps, { ...CLICK });
    expect(
      driven,
      'the act landed in a tab the response never names — the verdict would grade the wrong page',
    ).toEqual([FIRST]);
  });

  it('holds against a real SessionManager, whose own rule prefers the newcomer', async () => {
    // The fixture above asserts that resolution can change its mind mid-call. This one checks that
    // premise against the real resolver rather than trusting the double: a fresher heartbeat wins,
    // which is exactly what a tab a parallel job just opened has.
    const driven: string[] = [];
    const first = tab(FIRST, driven, 5_000);
    const newer = tab(NEWER, driven, 0);
    const manager = new SessionManager();
    manager.add(first);
    expect(manager.resolve().id, 'one connected tab is the only answer').toBe(FIRST);
    manager.add(newer);
    expect(manager.resolve().id, 'the fresher tab now wins auto-selection').toBe(NEWER);

    const raced = new SessionManager();
    raced.add(first);
    const registry: Partial<SessionManager> = {
      // The second tab connects between the dispatch chokepoint's resolution and the handler's.
      resolve: (id?: string) => {
        const answer = raced.resolve(id);
        raced.add(newer);
        return answer;
      },
      list: () => raced.list(),
    };
    const { deps } = twoTabs();
    deps.sessions = registry as SessionManager;
    await runTool(actTool(), deps, { ...CLICK });
    expect(driven, 'the call was answered about FIRST, so FIRST is where it must have run').toEqual(
      [FIRST],
    );
  });

  it('refreshes the lease of the tab it actually drove', async () => {
    const { deps, driven, touched } = twoTabs();
    await runTool(actTool(), deps, { ...CLICK });
    expect(
      { touched, driven },
      'the lease heartbeat and the drive named different tabs, so the reaper can reclaim the ' +
        'session under the action',
    ).toEqual({ touched: [FIRST], driven: [FIRST] });
  });

  it('spends a ref in the tab the wrong-tab guard was told about', async () => {
    const { deps, driven } = twoTabs();
    noteRefsMinted(FIRST);
    const result = await runTool(actTool(), deps, { ...CLICK });
    // The guard allows the call because the tab it was shown DID mint the ref. That permission is
    // only sound if the same tab is the one driven.
    expect(result).not.toHaveProperty('error');
    expect(driven).toEqual([FIRST]);
  });

  it('honours an explicit sessionId and asks for no other tab', async () => {
    const { deps, driven, asked } = twoTabs();
    await runTool(actTool(), deps, { ...CLICK, sessionId: NEWER });
    expect(driven).toEqual([NEWER]);
    expect(
      asked.filter((id) => id !== NEWER),
      'an explicit id must never be substituted, nor resolution widened to auto-selection',
    ).toEqual([]);
  });

  it('aims the call from a sequence step without rewriting the caller args', async () => {
    const { deps, driven } = twoTabs();
    const args = { steps: [{ ...CLICK, sessionId: NEWER }] };
    await runTool(toolNamed(ReticleTool.ACT_SEQUENCE), deps, args);
    expect(driven).toEqual([NEWER]);
    expect(args).toEqual({ steps: [{ ...CLICK, sessionId: NEWER }] });
  });

  it('does not write the pinned id back into the caller args object', async () => {
    const { deps } = twoTabs();
    const args: Record<string, unknown> = { ...CLICK };
    await runTool(actTool(), deps, args);
    expect(args, 'the caller owns its args; a dispatch decision must not leak into them').toEqual({
      ...CLICK,
    });
  });

  it('tells a provider-driven tool which tab it is working against', async () => {
    const { deps } = twoTabs();
    const seen: Record<string, unknown>[] = [];
    await runTool(recordingTool(ReticleTool.SCREENSHOT, seen), deps, {});
    expect(
      seen[0],
      'a CDP tool is resolved up front for the skew check and must use that tab',
    ).toEqual({ sessionId: FIRST });
  });

  it('leaves a disk-only tool unscoped when the caller named no session', async () => {
    const { deps } = twoTabs();
    const seen: Record<string, unknown>[] = [];
    await runTool(recordingTool(ReticleTool.PROJECT, seen), deps, {});
    expect(
      seen[0],
      'reticle_project reads the project on disk and must answer with nothing connected',
    ).toEqual({});
  });

  it('invents no session when none can be resolved', async () => {
    const { deps } = twoTabs();
    const REFUSAL = 'no browser session connected';
    const nothingConnected: Partial<SessionManager> = {
      resolve: () => {
        throw new Error(REFUSAL);
      },
    };
    deps.sessions = nothingConnected as SessionManager;
    const seen: Record<string, unknown>[] = [];
    const refusing: ToolDef = {
      name: ReticleTool.ACT,
      description: '',
      inputSchema: {},
      handler: (_deps, args) => {
        seen.push(args);
        return Promise.reject(new Error(REFUSAL));
      },
    };
    await expect(runTool(refusing, deps, { ref: 'e1' })).rejects.toThrow(REFUSAL);
    expect(seen[0], 'nothing resolved, so there is no id to pin').toEqual({ ref: 'e1' });
  });
});
