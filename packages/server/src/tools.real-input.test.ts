import { describe, expect, it } from 'vitest';
import { ActionWarning, InputMode } from '@syrin/protocol';
import type { CommandResult } from '@syrin/protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import { BaselineStore } from './baselines.js';
import { createNodeFileSystem } from './fs-port.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import { AnnotationStore } from './annotation-store.js';
import { boxCenter, type ElementBox, type RealInputProvider } from './real-input.js';
import type { Session, SessionManager } from './session.js';

const SESSION_URL = 'http://localhost:5173/app';
const SOURCE_BOX: ElementBox = { x: 0, y: 0, width: 200, height: 100 };
const TARGET_BOX: ElementBox = { x: 400, y: 200, width: 40, height: 20 };

interface FakeSessionState {
  actCalls: number;
  inspectRefs: string[];
  /** When set, INSPECT for this ref returns no box (stale ref). */
  staleRef?: string;
  /** When set, INSPECT returns a zero-area box for this ref. */
  zeroAreaRef?: string;
}

function fakeSession(state: FakeSessionState): Session {
  const command = (name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    if (name === 'inspect') {
      const ref = typeof args['ref'] === 'string' ? args['ref'] : '';
      state.inspectRefs.push(ref);
      if (ref === state.staleRef) {
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
      }
      if (ref === state.zeroAreaRef) {
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { box: { x: 5, y: 5, width: 0, height: 0 } },
        });
      }
      const box = ref === 'eTarget' ? TARGET_BOX : SOURCE_BOX;
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { box } });
    }
    if (name === 'act') {
      state.actCalls += 1;
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { dispatched: true, settled: true },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  };
  const stub: Partial<Session> = {
    id: 'demo',
    url: SESSION_URL,
    elapsed: () => 0,
    command,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
  };
  return stub as Session;
}

function fakeDeps(provider: RealInputProvider | undefined, state: FakeSessionState): ToolDeps {
  const session = fakeSession(state);
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const deps: ToolDeps = {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    irisRoot: '/tmp/iris-test/.iris',
    now: () => 0,
  };
  if (provider !== undefined) deps.realInput = provider;
  return deps;
}

interface RecordingProvider extends RealInputProvider {
  calls: {
    action: string;
    box: ElementBox;
    center: { cx: number; cy: number };
    toBox?: ElementBox;
  }[];
}

function makeProvider(available: boolean, options: { throws?: boolean } = {}): RecordingProvider {
  const calls: RecordingProvider['calls'] = [];
  return {
    calls,
    isAvailableFor: () => Promise.resolve(available),
    perform: (_url, action, box, args) => {
      if (options.throws === true) return Promise.reject(new Error('cdp gone'));
      const center = boxCenter(box);
      const call: RecordingProvider['calls'][number] = { action, box, center };
      if (args.toBox !== undefined) call.toBox = args.toBox;
      calls.push(call);
      return Promise.resolve({ performed: true, center });
    },
  };
}

function actTool() {
  const tool = TOOLS.find((t) => t.name === IrisTool.ACT);
  if (tool === undefined) throw new Error('no iris_act tool');
  return tool;
}

interface ActResult {
  inputMode: string;
  warning?: string;
  result: unknown;
}

async function runAct(deps: ToolDeps, args: Record<string, unknown>): Promise<ActResult> {
  return (await actTool().handler(deps, args)) as ActResult;
}

describe('R1 iris_act real-input routing', () => {
  it('routes a pointer click to real input when a provider is available', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls).toHaveLength(1);
    expect(state.actCalls).toBe(0); // synthetic ACT never sent
    expect(provider.calls[0]?.center).toEqual({ cx: 100, cy: 50 });
  });

  it('routes hover to real input with the hover action', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls[0]?.action).toBe('hover');
  });

  it('falls back to synthetic when the provider has no matching page', async () => {
    const provider = makeProvider(false);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('uses synthetic when no provider is configured', async () => {
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(undefined, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(state.actCalls).toBe(1);
  });

  it('keeps fill synthetic even with a provider present', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'fill',
      args: { value: 'hi' },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic for a drag without a toRef', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'drag', args: {} });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('drives a real drag, resolving both source and target boxes', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'drag',
      args: { toRef: 'eTarget' },
    });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(state.inspectRefs).toEqual(['e1', 'eTarget']);
    expect(provider.calls[0]?.toBox).toEqual(TARGET_BOX);
    expect(provider.calls[0]?.center).toEqual(boxCenter(SOURCE_BOX));
  });

  it('falls back to synthetic when the ref is stale (no box)', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [], staleRef: 'e1' };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic for a zero-area box', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [], zeroAreaRef: 'e1' };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic and warns when perform throws', async () => {
    const provider = makeProvider(true, { throws: true });
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.warning).toBe(ActionWarning.REAL_INPUT_FELL_BACK);
    expect(state.actCalls).toBe(1);
  });

  it('computes the perform center from the SDK-resolved box', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(provider.calls[0]?.center).toEqual(boxCenter(provider.calls[0]?.box ?? SOURCE_BOX));
  });
});
