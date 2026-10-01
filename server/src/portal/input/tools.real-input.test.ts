import { describe, expect, it, vi } from 'vitest';
import { LastAct } from '@/portal/session/last-act.js';
import {
  ActionType,
  ActionWarning,
  InputMode,
  InputModeReason,
  SessionState,
} from '@reticlehq/core';
import type { CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { ReticleTool } from '@reticlehq/core';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { boxCenter, type ElementBox, type RealInputProvider } from './real-input.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { BrowserPool } from '@/portal/pool/browser-pool.js';
import { HOVER_NEEDS_POINTER_MSG } from '@/surface/tools/real-input-attempt.js';

const SESSION_URL = 'http://localhost:5173/app';
const SOURCE_BOX: ElementBox = { x: 0, y: 0, width: 200, height: 100 };
const TARGET_BOX: ElementBox = { x: 400, y: 200, width: 40, height: 20 };

interface FakeSessionState {
  actCalls: number;
  inspectRefs: string[];
  inspectName?: string;
  /** When set, INSPECT for this ref returns no box (stale ref). */
  staleRef?: string;
  /** When set, INSPECT returns a zero-area box for this ref. */
  zeroAreaRef?: string;
  /** When set, the session is under version skew (the page and daemon disagree on protocol). */
  versionSkew?: string;
}

function fakeSession(state: FakeSessionState): Session {
  const command = (name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    if ('inspect' === name) {
      const ref = 'string' === typeof args['ref'] ? args['ref'] : '';
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
      const box = 'eTarget' === ref ? TARGET_BOX : SOURCE_BOX;
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { box, ...(state.inspectName === undefined ? {} : { name: state.inspectName }) },
      });
    }
    if ('act' === name) {
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
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    // Live-control: a clean active session — no pause short-circuit, no piggyback.
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    // Spread rather than assigned: `exactOptionalPropertyTypes` rejects an explicit `undefined`
    // for an optional field, and an absent skew is exactly what every other case wants.
    ...(state.versionSkew === undefined ? {} : { versionSkew: state.versionSkew }),
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
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
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
    args: Record<string, unknown>;
  }[];
}

function makeProvider(available: boolean, options: { throws?: boolean } = {}): RecordingProvider {
  const calls: RecordingProvider['calls'] = [];
  return {
    calls,
    isAvailableFor: () => Promise.resolve(available),
    perform: (_url, action, box, args) => {
      if (true === options.throws) return Promise.reject(new Error('cdp gone'));
      const center = boxCenter(box);
      const call: RecordingProvider['calls'][number] = {
        action,
        box,
        center,
        args: { ...args },
      };
      if (args.toBox !== undefined) call.toBox = args.toBox;
      calls.push(call);
      return Promise.resolve({ performed: true, center, inputMode: InputMode.REAL });
    },
  };
}

function actTool() {
  const tool = TOOLS.find((t) => t.name === ReticleTool.ACT);
  if (tool === undefined) throw new Error('no reticle_act tool');
  return tool;
}

interface ActResult {
  inputMode: string;
  inputModeReason?: string;
  warning?: string;
  result: unknown;
}

async function runAct(deps: ToolDeps, args: Record<string, unknown>): Promise<ActResult> {
  return (await actTool().handler(deps, args)) as ActResult;
}

describe('reticle_act real-input routing', () => {
  it('runs a click on the synthetic path by default even with a provider available', async () => {
    // "Don't click, run the code": the occlusion-honest synthetic path is the default for clicks.
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.SYNTHETIC_CLICK_PREFERRED);
    expect(provider.calls).toHaveLength(0); // no native gesture
    expect(state.actCalls).toBe(1); // synthetic ACT sent
  });

  it('routes a native:true click to real input (trusted-click opt-in)', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls).toHaveLength(1);
    expect(state.actCalls).toBe(0); // synthetic ACT never sent
    expect(provider.calls[0]?.center).toEqual({ cx: 100, cy: 50 });
  });

  it('blocks a destructive native click until explicitly confirmed', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = {
      actCalls: 0,
      inspectRefs: [],
      inspectName: 'Delete account',
    };
    await expect(
      runAct(fakeDeps(provider, state), {
        ref: 'e1',
        action: 'click',
        args: { native: true },
      }),
    ).rejects.toThrow(/confirmDangerous/);
    expect(provider.calls).toHaveLength(0);

    await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true, confirmDangerous: true },
    });
    expect(provider.calls).toHaveLength(1);
  });

  it('routes hover to real input with the hover action', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls[0]?.action).toBe('hover');
    expect(state.actCalls).toBe(0);
  });

  /**
   * The false-success this product exists to catch: a synthetic mouseover reports dispatched and
   * settled while CSS :hover never applies. Same shape as a coordinate-less drag reporting done.
   * Hover without a real pointer must refuse, not fall through to the in-page dispatch.
   */
  it('refuses hover when no real pointer is available, rather than reporting synthetic dispatch as done', async () => {
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await expect(
      runAct(fakeDeps(undefined, state), { ref: 'e1', action: 'hover' }),
    ).rejects.toThrow(HOVER_NEEDS_POINTER_MSG);
    expect(state.actCalls).toBe(0);
  });

  it('hovers a leased tab through the pool when no real-input provider is configured', async () => {
    const hoverLease = vi.fn(() => Promise.resolve(true));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(undefined, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    const res = await runAct(deps, { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(hoverLease).toHaveBeenCalledWith('demo', 100, 50);
    expect(state.actCalls).toBe(0);
  });

  it('prefers a configured real-input provider over the pool for hover', async () => {
    const provider = makeProvider(true);
    const hoverLease = vi.fn(() => Promise.resolve(true));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(provider, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    const res = await runAct(deps, { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls).toHaveLength(1);
    expect(hoverLease).not.toHaveBeenCalled();
  });

  it('hovers through the pool when the real-input provider throws', async () => {
    const provider = makeProvider(true, { throws: true });
    const hoverLease = vi.fn(() => Promise.resolve(true));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(provider, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    const res = await runAct(deps, { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(hoverLease).toHaveBeenCalledWith('demo', 100, 50);
    expect(state.actCalls).toBe(0);
  });

  it('refuses hover when the provider throws and no lease pointer is available', async () => {
    const provider = makeProvider(true, { throws: true });
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await expect(runAct(fakeDeps(provider, state), { ref: 'e1', action: 'hover' })).rejects.toThrow(
      HOVER_NEEDS_POINTER_MSG,
    );
    expect(state.actCalls).toBe(0);
  });

  it('refuses hover when the pool cannot drive a pointer on this session', async () => {
    const hoverLease = vi.fn(() => Promise.resolve(false));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(undefined, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    await expect(runAct(deps, { ref: 'e1', action: 'hover' })).rejects.toThrow(
      HOVER_NEEDS_POINTER_MSG,
    );
    expect(state.actCalls).toBe(0);
  });

  it('falls back to synthetic when the provider has no matching page', async () => {
    const provider = makeProvider(false);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    // native:true so we exercise the native pipeline (correlation check), not the click default.
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.PAGE_NOT_CORRELATED);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('uses synthetic, and stays SILENT, when no provider is configured and none was asked for', async () => {
    // Deliberately no reason. Without a provider every action is synthetic, and reticle_act is the
    // most-called tool in the product — a reason on all of them is noise, not information.
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(undefined, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBeUndefined();
    expect(state.actCalls).toBe(1);
  });

  /**
   * Reported from the field: on a session with `realInputAvailable:false`, `native:true` came back
   * `inputMode:"synthetic"` with no reason and no warning, and the agent could not tell "your
   * request was honoured" from "this session will never do that". It spent the rest of the task
   * probing `realInputAvailable` by hand. The tool description promises the opposite in as many
   * words: "inputModeReason explains any real→synthetic choice so it is never silent."
   *
   * Silence stays the default (the test above). Asking explicitly is what earns an answer.
   */
  it('explains itself when native:true is asked for and no provider exists', async () => {
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(undefined, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.NOT_CONFIGURED);
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
    expect(res.inputModeReason).toBe(InputModeReason.NOT_POINTER);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic for a drag without a toRef', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'drag', args: {} });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.DRAG_TARGET_UNRESOLVED);
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
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.ELEMENT_NOT_LOCATABLE);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic for a zero-area box', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [], zeroAreaRef: 'e1' };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.ELEMENT_NOT_LOCATABLE);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic and warns when perform throws', async () => {
    const provider = makeProvider(true, { throws: true });
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.PROVIDER_ERROR);
    expect(res.warning).toBe(ActionWarning.REAL_INPUT_FELL_BACK);
    expect(state.actCalls).toBe(1);
  });

  it('computes the perform center from the SDK-resolved box', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click', args: { native: true } });

    expect(provider.calls[0]?.center).toEqual(boxCenter(provider.calls[0]?.box ?? SOURCE_BOX));
  });
});

/**
 * A document key — `press` with no ref — through real input.
 *
 * A synthetic `KeyboardEvent` does not move focus, so Tab order cannot be verified through the
 * synthetic path however faithfully the events are dispatched. This is the case the routing
 * exists for, and it is also the one that must NOT resolve a box: Tab addresses whatever holds
 * focus, and INSPECT on an empty ref is the wrong question to ask.
 */
describe('reticle_act routes a document press through real input', () => {
  it('drives Tab through the provider without inspecting anything', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { action: 'press', args: { text: 'Tab' } });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.action).toBe(ActionType.PRESS);
    // No center is published: a key addresses focus, and the placeholder box's zero happened
    // nowhere. The provider's own reading is absent for the same reason.
    expect(res.result).toEqual({ performed: true, action: ActionType.PRESS, inputMode: 'real' });
    // A key press has no element to resolve, so nothing was inspected and no synthetic ACT ran.
    expect(state.inspectRefs).toEqual([]);
    expect(state.actCalls).toBe(0);
  });

  it('forwards the key and its modifiers to the provider', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await runAct(fakeDeps(provider, state), {
      action: 'press',
      args: { text: 'k', modifiers: ['Meta'] },
    });

    expect(provider.calls[0]?.args).toEqual({ text: 'k', modifiers: ['Meta'] });
  });

  it('forwards holdMs, so a held key holds through the driver too', async () => {
    // Without this the real path is the WEAKER one: the synthetic dispatcher has held a key for
    // `holdMs` all along, and a hold-to-confirm control driven through the driver would see an
    // instant tap reported as a success. Escape because a document key is the only press that
    // reaches the driver at all — a named element stays synthetic by design.
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await runAct(fakeDeps(provider, state), {
      action: 'press',
      args: { text: 'Escape', holdMs: 1200 },
    });

    expect(provider.calls[0]?.args).toEqual({ text: 'Escape', holdMs: 1200 });
  });

  it('reports the ACHIEVED hold on the result, not only sending the request', async () => {
    // #1296. `reticle_act` promises `effect.heldMs` reports what was achieved, and on the real path
    // the act result IS the effect block. Sending `holdMs` and dropping the measurement made that
    // promise true on the synthetic path and silently false on this one, so an agent checking for
    // an armed hold-to-confirm control read `undefined` — the hold it was confirming had just been
    // added to this path.
    const provider: RealInputProvider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, inputMode: InputMode.REAL, heldMs: 1_204 }),
    };
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      action: 'press',
      args: { text: 'Escape', holdMs: 1200 },
    });

    expect((res.result as Record<string, unknown>)['heldMs']).toBe(1_204);
  });

  it('omits heldMs on the result when the press held nothing', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { action: 'press', args: { text: 'Tab' } });

    // Absent, not 0 — the same rule the synthetic effect block uses.
    expect('heldMs' in (res.result as Record<string, unknown>)).toBe(false);
  });

  it('routes an explicit code away BEFORE inspecting, naming the key-level reason', async () => {
    // The driver presses by KEY name; `code` is the caller saying the physical key differs. A ref is
    // given here so both candidates apply — `code` names the KEY and wins, because "you passed a
    // ref" would hide the request that actually could not be honoured.
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'press',
      args: { text: 'z', code: 'KeyY' },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.SYNTHETIC_KEY_CODE_PRESS_PREFERRED);
    expect(state.inspectRefs).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('routes a multi-key press with no ref at all — it never reaches INSPECT', async () => {
    // `keys` counts as a document press, so no ref is demanded; the router then hands it to the
    // synthetic dispatcher because only the page can hold several keys down at once.
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      action: 'press',
      args: { keys: ['Control', 'k'] },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.SYNTHETIC_MULTI_KEY_PRESS_PREFERRED);
    expect(state.inspectRefs).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('still drives a document key under version skew, instead of taking the action away', async () => {
    // Skew means CDP is unusable, and for every POINTER action that is a refusal (the code below
    // throws the skew sentence). A document key is dispatched in the page and never needed CDP, so
    // throwing here would turn a press that has always worked into a hard failure.
    const provider = makeProvider(true);
    const state: FakeSessionState = {
      actCalls: 0,
      inspectRefs: [],
      versionSkew: 'page 2.14.0 / daemon 3.2.0',
    };
    const res = await runAct(fakeDeps(provider, state), { action: 'press', args: { text: 'Tab' } });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls).toHaveLength(1);
  });

  it('falls back to synthetic when the driver throws under skew, rather than re-throwing', async () => {
    // The pointer path re-throws the skew sentence because it has nowhere else to go. This action
    // does: the synthetic route is right there, so the fallback is the honest answer.
    const provider = makeProvider(true, { throws: true });
    const state: FakeSessionState = {
      actCalls: 0,
      inspectRefs: [],
      versionSkew: 'page 2.14.0 / daemon 3.2.0',
    };
    const res = await runAct(fakeDeps(provider, state), { action: 'press', args: { text: 'Tab' } });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.PROVIDER_ERROR);
    expect(state.actCalls).toBe(1);
  });

  it('keeps a press WITH a ref on the synthetic path — a real keyboard cannot address an element', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'press',
      args: { text: 'Enter' },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic when no provider is configured', async () => {
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(undefined, state), {
      action: 'press',
      args: { text: 'Tab' },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(state.actCalls).toBe(1);
  });

  it('reports a declined press as provider-declined rather than a silent synthetic success', async () => {
    const provider = makeProvider(true);
    provider.perform = () =>
      Promise.resolve({
        performed: false,
        inputMode: InputMode.SYNTHETIC,
      });
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      action: 'press',
      args: { text: 'Tab' },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.PROVIDER_DECLINED);
  });
});
