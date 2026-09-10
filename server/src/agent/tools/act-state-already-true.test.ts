import { describe, expect, it } from 'vitest';
import {
  PredicateKind,
  ReticleCommand,
  SessionState,
  Verified,
  VerifiedReason,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '../../connection/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from '@reticlehq/core';
import { BaselineStore } from '../../features/project/baselines.js';
import { createNodeFileSystem } from '../../features/project/fs-port.js';
import { RecordingStore } from '../../features/flows/recording/recordings.js';
import { FlowStore } from '../../features/flows/flows.js';
import { ProjectStore } from '../../features/project/project-store.js';
import { AnnotationStore } from '../../features/flows/annotation-store.js';
import type { Session, SessionManager } from '../../connection/session/session.js';

interface StateSessionOptions {
  initialStore?: Record<string, unknown>;
  onAct?: (setStore: (s: Record<string, unknown>) => void) => void;
  settled?: boolean;
  stateReadOk?: boolean;
}

function createStateSession(options: StateSessionOptions = {}) {
  const {
    initialStore = { app: { cart: { count: 3 } }, cart: { count: 3 } },
    onAct,
    settled = true,
    stateReadOk = true,
  } = options;

  const commandLog: { command: string; args: unknown; result?: unknown }[] = [];
  let currentStore = { ...initialStore };
  const setStore = (s: Record<string, unknown>) => {
    currentStore = s;
  };

  const command = (name: string, args: unknown): Promise<CommandResult> => {
    if (name === ReticleCommand.STATE_READ) {
      if (!stateReadOk) {
        commandLog.push({ command: name, args, result: { ok: false } });
        return Promise.resolve({
          kind: 'command_result',
          id: 'sr_err',
          ok: false,
          error: 'store unreadable',
        });
      }
      const recordArgs = (args ?? {}) as Record<string, unknown>;
      if (recordArgs['store'] !== undefined && recordArgs['path'] !== undefined) {
        // Scoped store read
        const storeName = recordArgs['store'] as string;
        const path = recordArgs['path'] as string;
        const store = currentStore[storeName] as Record<string, unknown> | undefined;
        const found = store !== undefined && path in store;
        const result = {
          found,
          value: found ? store[path] : undefined,
          storeNames: Object.keys(currentStore),
        };
        commandLog.push({ command: name, args, result });
        return Promise.resolve({
          kind: 'command_result',
          id: 'sr_scoped',
          ok: true,
          result,
        });
      }
      const result = {
        stores: { ...currentStore },
      };
      commandLog.push({ command: name, args, result });
      return Promise.resolve({
        kind: 'command_result',
        id: 'sr',
        ok: true,
        result,
      });
    }

    if (name === ReticleCommand.ACT) {
      onAct?.(setStore);
      const result = {
        dispatched: true,
        settled,
        effect: { domMutatedWithin: 1 },
      };
      commandLog.push({ command: name, args, result });
      return Promise.resolve({
        kind: 'command_result',
        id: 'act',
        ok: true,
        result,
      });
    }

    commandLog.push({ command: name, args });
    return Promise.resolve({
      kind: 'command_result',
      id: 'other',
      ok: true,
      result: {},
    });
  };

  const noEvents: ReticleEvent[] = [];
  const stub: Partial<Session> = {
    id: 'demo-state',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 10, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
  };

  const session = stub as Session;
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const deps: ToolDeps = {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  };

  return {
    session,
    deps,
    commandLog,
    setStore,
  };
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

describe('#864 — pre-existing STATE bypasses alreadyTrue in act_and_wait', () => {
  it('returns no-fault / already_true when STATE condition already holds before dispatch', async () => {
    const { deps, commandLog } = createStateSession({
      initialStore: { app: { cart: { count: 3 } } },
      settled: true,
    });

    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'btn-inert',
      action: 'click',
      timeout_ms: 0,
      until: {
        kind: PredicateKind.STATE,
        path: 'cart.count',
        equals: 3,
      },
    })) as Record<string, unknown>;

    // 1. Proves causal contract: pre-existing STATE does not receive causal PROVED credit
    expect(res['verified']).toBe(Verified.NO_FAULT);
    expect(res['verifiedReason']).toBe(VerifiedReason.ALREADY_TRUE);
    expect(res['because']).toContain('already true before this action');

    // 2. Proves baseline detection evaluated STATE before action dispatch
    const stateReadIndex = commandLog.findIndex((c) => c.command === ReticleCommand.STATE_READ);
    const actIndex = commandLog.findIndex((c) => c.command === ReticleCommand.ACT);
    expect(stateReadIndex).toBeGreaterThanOrEqual(0);
    expect(actIndex).toBeGreaterThanOrEqual(0);
    expect(stateReadIndex).toBeLessThan(actIndex);
  });

  it('works identically for scoped / named store state', async () => {
    const { deps, commandLog } = createStateSession({
      initialStore: { cart: { count: 3 } },
      settled: true,
    });

    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'btn-inert',
      action: 'click',
      timeout_ms: 0,
      until: {
        kind: PredicateKind.STATE,
        store: 'cart',
        path: 'count',
        equals: 3,
      },
    })) as Record<string, unknown>;

    expect(res['verified']).toBe(Verified.NO_FAULT);
    expect(res['verifiedReason']).toBe(VerifiedReason.ALREADY_TRUE);

    const firstStateReadIndex = commandLog.findIndex(
      (c) => c.command === ReticleCommand.STATE_READ,
    );
    const actIndex = commandLog.findIndex((c) => c.command === ReticleCommand.ACT);
    expect(firstStateReadIndex).toBeGreaterThanOrEqual(0);
    expect(firstStateReadIndex).toBeLessThan(actIndex);
  });

  it('awards causal YES when STATE was not already true and changed because of the action', async () => {
    const ctx = createStateSession({
      initialStore: { app: { cart: { count: 0 } }, cart: { count: 0 } },
      onAct: (setStore) => {
        // Action causes cart.count to become 3
        setStore({ app: { cart: { count: 3 } }, cart: { count: 3 } });
      },
      settled: true,
    });

    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(ctx.deps, {
      ref: 'btn-add-to-cart',
      action: 'click',
      timeout_ms: 0,
      until: {
        kind: PredicateKind.STATE,
        path: 'cart.count',
        equals: 3,
      },
    })) as Record<string, unknown>;

    expect(res['verified']).toBe(Verified.YES);
    expect(res['verifiedReason']).toBe(VerifiedReason.PROVED);

    // Pre-dispatch STATE_READ saw count: 0 -> alreadyTrue was false
    // Post-dispatch STATE_READ saw count: 3 -> pass was true
    const actIndex = ctx.commandLog.findIndex((c) => c.command === ReticleCommand.ACT);
    expect(actIndex).toBeGreaterThanOrEqual(0);

    const preActRead = ctx.commandLog
      .slice(0, actIndex)
      .find((c) => c.command === ReticleCommand.STATE_READ);
    const postActRead = ctx.commandLog
      .slice(actIndex + 1)
      .find((c) => c.command === ReticleCommand.STATE_READ);

    expect(preActRead).toBeDefined();
    const preStores = (preActRead?.result as { stores?: Record<string, unknown> })?.stores;
    const preCart = (preStores?.['app'] as { cart?: { count?: number } })?.cart;
    expect(preCart?.count).toBe(0);

    expect(postActRead).toBeDefined();
    const postStores = (postActRead?.result as { stores?: Record<string, unknown> })?.stores;
    const postCart = (postStores?.['app'] as { cart?: { count?: number } })?.cart;
    expect(postCart?.count).toBe(3);
  });

  it('preserves UNKNOWN when pre-existing STATE is true but the window never settled', async () => {
    const { deps } = createStateSession({
      initialStore: { app: { cart: { count: 3 } } },
      settled: false,
    });

    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'btn-inert',
      action: 'click',
      timeout_ms: 0,
      until: {
        kind: PredicateKind.STATE,
        path: 'cart.count',
        equals: 3,
      },
    })) as Record<string, unknown>;

    expect(res['verified']).toBe(Verified.UNKNOWN);
    expect(res['verifiedReason']).toBe(VerifiedReason.ALREADY_TRUE);
  });

  it('preserves INCONCLUSIVE when store is missing rather than claiming already_true', async () => {
    const { deps } = createStateSession({
      initialStore: {},
      settled: true,
    });

    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'btn-inert',
      action: 'click',
      timeout_ms: 0,
      until: {
        kind: PredicateKind.STATE,
        path: 'cart.count',
        equals: 3,
      },
    })) as Record<string, unknown>;

    expect(res['verified']).toBe(Verified.UNKNOWN);
    expect(res['verifiedReason']).toBe(VerifiedReason.INCONCLUSIVE);
  });
});
