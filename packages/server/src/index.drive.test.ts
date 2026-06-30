import { afterEach, describe, expect, it } from 'vitest';
import { DriveErrorCode, InputMode, SessionState } from '@reticle/protocol';
import type { CommandResult } from '@reticle/protocol';
import { start, type RunningServer } from './index.js';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import { ReticleTool } from './tools/tool-names.js';
import { BaselineStore } from './project/baselines.js';
import { createNodeFileSystem } from './project/fs-port.js';
import { RecordingStore } from './flows/recordings.js';
import { FlowStore } from './flows/flows.js';
import { ProjectStore } from './project/project-store.js';
import { AnnotationStore } from './flows/annotation-store.js';
import {
  DriveError,
  boxCenter,
  type ElementBox,
  type OwnedRealInputProvider,
  type RealInputProvider,
} from './input/real-input.js';
import type { Session, SessionManager } from './session/session.js';

const DRIVE_URL = 'http://localhost:3000/app';
const SOURCE_BOX: ElementBox = { x: 0, y: 0, width: 200, height: 100 };

let basePort = 8400;
function nextPort(): number {
  basePort += 1;
  return basePort;
}

interface FakeLaunched extends OwnedRealInputProvider {
  navigateCalls: number;
  disposeCalls: number;
  performCalls: number;
  navigateRejects?: DriveError;
}

function makeFakeLaunched(navigateRejects?: DriveError): FakeLaunched {
  const provider: FakeLaunched = {
    navigateCalls: 0,
    disposeCalls: 0,
    performCalls: 0,
    ...(navigateRejects !== undefined ? { navigateRejects } : {}),
    navigate() {
      this.navigateCalls += 1;
      if (this.navigateRejects !== undefined) return Promise.reject(this.navigateRejects);
      return Promise.resolve();
    },
    dispose() {
      this.disposeCalls += 1;
      return Promise.resolve();
    },
    isAvailableFor: () => Promise.resolve(true),
    perform(_url, _action, box) {
      this.performCalls += 1;
      return Promise.resolve({ performed: true, center: boxCenter(box) });
    },
  };
  return provider;
}

function fakeSession(state: { actCalls: number }): Session {
  const command = (name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    if (name === 'inspect') {
      const ref = typeof args['ref'] === 'string' ? args['ref'] : '';
      void ref;
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { box: SOURCE_BOX },
      });
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
    url: DRIVE_URL,
    elapsed: () => 0,
    markActCursor: () => undefined,
    lastActCursor: () => undefined,
    command,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    // Live-control: a clean active session — no pause short-circuit, no piggyback.
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
  };
  return stub as Session;
}

function depsWith(realInput: RealInputProvider | undefined, state: { actCalls: number }): ToolDeps {
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
  if (realInput !== undefined) deps.realInput = realInput;
  return deps;
}

interface ActResult {
  inputMode: string;
}

async function runClick(deps: ToolDeps): Promise<ActResult> {
  const tool = TOOLS.find((t) => t.name === ReticleTool.ACT);
  if (tool === undefined) throw new Error('no act tool');
  // native:true so the launched provider drives the gesture (clicks default to synthetic otherwise).
  return (await tool.handler(deps, {
    ref: 'e1',
    action: 'click',
    args: { native: true },
  })) as ActResult;
}

let running: RunningServer | undefined;
afterEach(async () => {
  if (running !== undefined) {
    await running.close();
    running = undefined;
  }
});

describe('start({ driveUrl }) wiring', () => {
  it('start({driveUrl}) installs a realInput provider and navigates it', async () => {
    let factoryArgs: { driveUrl: string; headless: boolean } | undefined;
    const fake = makeFakeLaunched();
    running = await start({
      port: nextPort(),
      mcp: false,
      driveUrl: DRIVE_URL,
      realInputFactory: (opts) => {
        factoryArgs = opts;
        return fake;
      },
    });

    expect(factoryArgs).toEqual({ driveUrl: DRIVE_URL, headless: true });
    expect(fake.navigateCalls).toBe(1);
    expect(running.realInput).toBe(fake);
  });

  it('reticle_act pointer action routes to the launched provider with inputMode real', async () => {
    const fake = makeFakeLaunched();
    running = await start({
      port: nextPort(),
      mcp: false,
      driveUrl: DRIVE_URL,
      realInputFactory: () => fake,
    });
    const state = { actCalls: 0 };
    const res = await runClick(depsWith(running.realInput, state));

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(fake.performCalls).toBe(1);
    expect(state.actCalls).toBe(0);
  });

  it('start() with neither driveUrl nor RETICLE_CDP_URL leaves realInput undefined', async () => {
    const prev = process.env['RETICLE_CDP_URL'];
    delete process.env['RETICLE_CDP_URL'];
    let factoryCalled = false;
    running = await start({
      port: nextPort(),
      mcp: false,
      realInputFactory: () => {
        factoryCalled = true;
        return makeFakeLaunched();
      },
    });
    if (prev !== undefined) process.env['RETICLE_CDP_URL'] = prev;

    expect(factoryCalled).toBe(false);
    expect(running.realInput).toBeUndefined();

    const state = { actCalls: 0 };
    const res = await runClick(depsWith(running.realInput, state));
    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(state.actCalls).toBe(1);
  });

  it('driveUrl takes precedence and CDP is not connected when both are set', async () => {
    const prev = process.env['RETICLE_CDP_URL'];
    process.env['RETICLE_CDP_URL'] = 'http://localhost:9222';
    const fake = makeFakeLaunched();
    running = await start({
      port: nextPort(),
      mcp: false,
      driveUrl: DRIVE_URL,
      realInputFactory: () => fake,
    });
    if (prev === undefined) delete process.env['RETICLE_CDP_URL'];
    else process.env['RETICLE_CDP_URL'] = prev;

    expect(running.realInput).toBe(fake);
    expect(fake.navigateCalls).toBe(1);
  });

  it('close() disposes the launched provider then closes the bridge', async () => {
    const fake = makeFakeLaunched();
    const server = await start({
      port: nextPort(),
      mcp: false,
      driveUrl: DRIVE_URL,
      realInputFactory: () => fake,
    });
    await server.close();

    expect(fake.disposeCalls).toBe(1);
  });

  it('start() rejects with the DriveError when navigate fails', async () => {
    const err = new DriveError(DriveErrorCode.PLAYWRIGHT_MISSING, 'no playwright');
    const fake = makeFakeLaunched(err);
    await expect(
      start({
        port: nextPort(),
        mcp: false,
        driveUrl: DRIVE_URL,
        realInputFactory: () => fake,
      }),
    ).rejects.toMatchObject({ code: DriveErrorCode.PLAYWRIGHT_MISSING });
  });
});
