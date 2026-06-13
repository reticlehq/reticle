import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@iris/protocol';
import { ActionType, FlowErrorCode, QueryBy } from '@iris/protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import { AnnotationStore } from './annotation-store.js';
import type { FileSystemPort } from './fs-port.js';
import type { Session, SessionManager } from './session.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';

const ROOT = '/virtual/.iris';

/** In-memory FileSystemPort — proves the tool wiring without touching the real disk. */
function memoryFs(): FileSystemPort {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    readFile(path) {
      const v = files.get(path);
      if (v === undefined) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(v);
    },
    writeFile(path, data) {
      files.set(path, data);
      return Promise.resolve();
    },
    mkdir(path) {
      dirs.add(path);
      return Promise.resolve();
    },
    exists(path) {
      return Promise.resolve(files.has(path) || dirs.has(path));
    },
    readdir(path) {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0] ?? '');
      }
      return Promise.resolve([...names]);
    },
    isNotFound(error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    },
  };
}

function fakeDeps(fs: FileSystemPort, recordings: RecordingStore): ToolDeps {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const session: Partial<Session> = { id: 'demo', command };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows: new FlowStore(fs, ROOT, { now: () => 1234 }),
    annotations: new AnnotationStore(),
    fs,
    irisRoot: ROOT,
    now: () => 1234,
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

function program(name: string, steps: RecordedStep[]): CompiledProgram {
  return { name, version: 1, steps };
}

describe('iris_flow_save / iris_flow_load handlers (M8 Stage A FLOWFMT)', () => {
  it('19: iris_flow_save with no compiled recording returns NO_RECORDING', async () => {
    const deps = fakeDeps(memoryFs(), new RecordingStore());
    const res = (await tool(IrisTool.FLOW_SAVE).handler(deps, { name: 'missing' })) as {
      error?: string;
      code?: string;
    };
    expect(res.code).toBe(FlowErrorCode.NO_RECORDING);
    expect(res.error).toBeDefined();
  });

  it('20: iris_flow_save then iris_flow_load via handlers round-trips', async () => {
    const recordings = new RecordingStore();
    recordings.saveCompiled(
      program('checkout', [
        {
          tool: IrisTool.ACT,
          stable: true,
          args: { by: QueryBy.TESTID, value: 'pay', action: ActionType.CLICK, args: {} },
        },
      ]),
    );
    const deps = fakeDeps(memoryFs(), recordings);
    const saved = (await tool(IrisTool.FLOW_SAVE).handler(deps, { name: 'checkout' })) as {
      name: string;
      stepCount: number;
    };
    expect(saved).toMatchObject({ name: 'checkout', stepCount: 1 });

    const loaded = (await tool(IrisTool.FLOW_LOAD).handler(deps, { name: 'checkout' })) as {
      name: string;
      steps: { anchor: { kind: string; value?: string } }[];
    };
    expect(loaded.name).toBe('checkout');
    expect(loaded.steps[0]?.anchor).toEqual({ kind: 'testid', value: 'pay' });

    const list = (await tool(IrisTool.FLOW_LIST).handler(deps, {})) as { flows: string[] };
    expect(list.flows).toEqual(['checkout']);
  });

  it('3: a recorded expect.signal survives the round-trip', async () => {
    const recordings = new RecordingStore();
    recordings.saveCompiled(
      program('withexpect', [
        {
          tool: IrisTool.ACT,
          stable: true,
          args: { by: QueryBy.TESTID, value: 'go', action: ActionType.CLICK, args: {} },
          expect: { signal: 'diff:shown' },
        },
      ]),
    );
    const deps = fakeDeps(memoryFs(), recordings);
    await tool(IrisTool.FLOW_SAVE).handler(deps, { name: 'withexpect' });
    const loaded = (await tool(IrisTool.FLOW_LOAD).handler(deps, { name: 'withexpect' })) as {
      steps: { expect?: { signal?: string } }[];
    };
    expect(loaded.steps[0]?.expect?.signal).toBe('diff:shown');
  });
});
