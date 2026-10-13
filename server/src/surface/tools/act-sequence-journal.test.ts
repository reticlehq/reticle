/**
 * A journey's checks reach the record: `reticle_act { steps }` → journal → session end → run.
 *
 * Reported from a live re-drive: a journey with one held and one failed `expect` ended "not proved ·
 * nothing was checked", and no run reached `.reticle/runs/` or the dashboard. The journey call is
 * the documented default for multi-step work, so the failed check was lost on the common path.
 * Driven here through the same handler, the same end tool and the same fold the daemon uses.
 */
import { describe, expect, it } from 'vitest';
import {
  JOURNAL_FILE_VERSION,
  ReticleTool,
  SessionState,
  VerdictStatus,
  Verified,
  type CommandResult,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { LIVE_CONTROL_TOOLS } from '@/portal/session/live-control-tools.js';
import { driveRunsFrom } from '@/judgement/runs/drive-run.js';
import { buildVerificationRun } from '@/judgement/runs/artifact/build-verification-run.js';
import { JOURNEY_RECORDING } from './act/sequence-grade.js';

const ROOT = '/tmp/reticle-act-sequence-journal/.reticle';

function journalingSession(id: string, journal: JournalAction[]): Session {
  const noEvents: ReticleEvent[] = [];
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: {
        ref: 'e1',
        action: 'click',
        dispatched: true,
        settled: true,
        settleReason: null,
        source: { file: 'src/Checkout.tsx', line: 12 },
      },
    });
  const stub: Partial<Session> = {
    id,
    url: 'http://localhost:5173/shop',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a0',
    finishAction: () => undefined,
    recordAction: (tool: string, args: Record<string, unknown>, effect?: unknown) => {
      const actionId = `a${String(journal.length + 1)}`;
      journal.push({
        v: JOURNAL_FILE_VERSION,
        actionId,
        tool,
        args,
        effect,
        tRange: { from: 0, to: 0 },
        at: 0,
      });
      return actionId;
    },
    readJournalActions: () => Promise.resolve(journal),
    setState: () => undefined,
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
  };
  return stub as Session;
}

function depsFor(session: Session, recordings = new RecordingStore()): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    get: () => session,
    count: () => 1,
    departed: () => undefined,
  };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: ROOT,
    now: () => 0,
  };
}

function tool(name: string) {
  const found = [...TOOLS, ...LIVE_CONTROL_TOOLS].find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

const HELD = { ref: 'e1', action: 'click', expect: { kind: 'settled' } };
const MISSED = { ref: 'e2', action: 'click', expect: { kind: 'signal', name: 'order:placed' } };

describe('a journey`s expects are checks on the record', () => {
  it('journals one check per declared step, in act_and_wait`s shape', async () => {
    const journal: JournalAction[] = [];
    const session = journalingSession('s-journal-1', journal);
    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(depsFor(session), {
      steps: [HELD, MISSED],
      timeout_ms: 0,
    })) as { verified?: string };
    expect(result.verified).toBe(Verified.NO);
    const effects = journal.map((a) => a.effect as Record<string, unknown>);
    expect(effects.map((e) => e['verified'])).toEqual([Verified.YES, Verified.NO]);
    expect(effects[1]).toMatchObject({
      declaredBeforeActing: true,
      kind: 'signal',
      source: 'src/Checkout.tsx:12',
    });
  });

  it('folds into the session result and a run whose verdict is not a pass', async () => {
    const journal: JournalAction[] = [];
    const session = journalingSession('s-journal-2', journal);
    const deps = depsFor(session);
    await tool(ReticleTool.ACT_SEQUENCE).handler(deps, { steps: [HELD, MISSED], timeout_ms: 0 });
    const ended = (await tool(ReticleTool.END_SESSION).handler(deps, {
      sessionId: 's-journal-2',
      claim: VerdictStatus.PASS,
    })) as Record<string, unknown>;
    // Vacuity: before the fix this read "no claims this session, so nothing was verified".
    expect(ended['gap']).toEqual(expect.arrayContaining(['1 of 2 claims held']));
    expect(String(ended['reticleResult'])).not.toMatch(/nothing was checked/i);
    // The agent claimed pass; grading says otherwise, and the two are said side by side. A failed
    // check grades the claim FAIL, the word its reticleResult and the dashboard say: "partial" beside
    // "Reticle result: failed" gave one answer two verdicts.
    expect(ended['claim']).toEqual({
      claimed: VerdictStatus.PASS,
      graded: VerdictStatus.FAIL,
      agrees: false,
    });
    const runs = driveRunsFrom(journal, {
      runId: 'drive-s-journal-2',
      agentEnds: [journal.length],
      agentClaims: [VerdictStatus.PASS],
    });
    expect(runs).toHaveLength(1);
    const run = buildVerificationRun(runs[0] as (typeof runs)[number], () => 0);
    expect(run.checks).toHaveLength(2);
    expect(run.verdict.status).toBe(VerdictStatus.PARTIAL);
    expect(run.agentClaim).toBe(VerdictStatus.PASS);
  });
});

describe('the keep offer can be taken', () => {
  it('holds the proved journey as a stopped recording the offer names', async () => {
    const recordings = new RecordingStore();
    const session = journalingSession('s-journal-3', []);
    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(depsFor(session, recordings), {
      steps: [HELD],
      timeout_ms: 0,
    })) as { verified?: string; keep?: string };
    expect(result.verified).toBe(Verified.YES);
    expect(result.keep).toContain(`flowName: "${JOURNEY_RECORDING}"`);
    expect(recordings.getCompiled(JOURNEY_RECORDING)?.steps).toHaveLength(1);
  });

  it('does not hold a journey that failed', async () => {
    const recordings = new RecordingStore();
    const session = journalingSession('s-journal-4', []);
    await tool(ReticleTool.ACT_SEQUENCE).handler(depsFor(session, recordings), {
      steps: [HELD, MISSED],
      timeout_ms: 0,
    });
    expect(recordings.getCompiled(JOURNEY_RECORDING)).toBeUndefined();
  });
});
