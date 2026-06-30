import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
  type ReticleEvent,
} from '@reticle/protocol';
import type { Clock, EvalResult, FileSystemPort } from '@reticle/server';
import { FLOW_LOAD_ERROR_PREFIX, SpecMessage } from './constants.js';
import { registerFlowSpecs } from './register.js';

const FIXED_MS = 1_700_000_000_000;
const fixedClock: Clock = { now: () => FIXED_MS };
const ROOT = '/tmp/reticle-root/.reticle';
const FLOWS_DIR = '/tmp/reticle-root/.reticle/flows';

function memoryFs(files: Record<string, string>): FileSystemPort {
  const store = new Map<string, string>(Object.entries(files));
  return {
    readFile: (path) => {
      const v = store.get(path);
      if (v === undefined)
        return Promise.reject(Object.assign(new Error('enoent'), { code: 'ENOENT' }));
      return Promise.resolve(v);
    },
    writeFile: (path, data) => {
      store.set(path, data);
      return Promise.resolve();
    },
    readFileBytes: (path) => {
      const v = store.get(path);
      if (v === undefined)
        return Promise.reject(Object.assign(new Error('enoent'), { code: 'ENOENT' }));
      return Promise.resolve(new TextEncoder().encode(v));
    },
    writeFileBytes: (path, data) => {
      store.set(path, new TextDecoder().decode(data));
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    exists: (path) =>
      Promise.resolve(store.has(path) || [...store.keys()].some((k) => k.startsWith(`${path}/`))),
    readdir: (path) =>
      Promise.resolve(
        [...store.keys()]
          .filter((k) => k.startsWith(`${path}/`))
          .map((k) => k.slice(path.length + 1))
          .filter((k) => !k.includes('/')),
      ),
    rename: (from, to) => {
      const v = store.get(from);
      if (v !== undefined) {
        store.set(to, v);
        store.delete(from);
      }
      return Promise.resolve();
    },
    rm: (path) => {
      store.delete(path);
      return Promise.resolve();
    },
    isNotFound: (error) => (error as { code?: string } | undefined)?.code === 'ENOENT',
  };
}

interface SessionLike {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  elapsed(): number;
}

function ok(result: unknown): CommandResult {
  return { kind: 'command_result', id: 'x', ok: true, result };
}

function fakeSession(testids: string[]): SessionLike {
  const present = new Set(testids);
  return {
    command: (name, args) => {
      if (name === ReticleCommand.QUERY) {
        const raw = args?.['value'];
        const value = typeof raw === 'string' ? raw : '';
        const has = present.has(value);
        return Promise.resolve(
          ok({
            elements: has ? [{ ref: `e-${value}` }] : [],
            hint: has ? undefined : { route: '/', presentTestids: testids, knownEmptyState: false },
          }),
        );
      }
      return Promise.resolve(ok({}));
    },
    eventsSince: () => [],
    onEvent: () => () => {},
    elapsed: () => 0,
  };
}

const alwaysPass = (): Promise<EvalResult> => Promise.resolve({ pass: true });

/** A stub `it` collector recording (name, fn) so we test registration without real vitest nesting. */
function collector(): {
  reg: (name: string, fn: () => Promise<void> | void) => void;
  cases: { name: string; fn: () => Promise<void> | void }[];
} {
  const cases: { name: string; fn: () => Promise<void> | void }[] = [];
  return { reg: (name, fn) => cases.push({ name, fn }), cases };
}

function flowFor(name: string, stepTestid: string): FlowFile {
  return {
    version: FLOW_FILE_VERSION,
    name,
    createdAt: FIXED_MS,
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: AnchorKind.TESTID, value: stepTestid },
        action: 'click',
      },
    ],
  };
}
function serialize(flow: FlowFile): string {
  return `${JSON.stringify(flow, null, 2)}\n`;
}

describe('registerFlowSpecs', () => {
  it('#7 empty dir -> registers zero cases, no throw', async () => {
    const fs = memoryFs({});
    const c = collector();
    await registerFlowSpecs(ROOT, () => fakeSession([]), {
      fs,
      clock: fixedClock,
      waitForSignal: alwaysPass,
      register: c.reg,
    });
    expect(c.cases).toHaveLength(0);
  });

  it('#11 mixed dir -> both register; ERROR throws when run, runnable passes', async () => {
    const fs = memoryFs({
      [`${FLOWS_DIR}/good.json`]: serialize(flowFor('good', 'save-btn')),
      [`${FLOWS_DIR}/bad.json`]: '{ not json',
    });
    const c = collector();
    await registerFlowSpecs(ROOT, () => fakeSession(['save-btn']), {
      fs,
      clock: fixedClock,
      waitForSignal: alwaysPass,
      register: c.reg,
    });
    expect(c.cases.map((x) => x.name).sort()).toEqual(['bad', 'good']);

    const bad = c.cases.find((x) => x.name === 'bad');
    await expect(Promise.resolve().then(() => bad?.fn())).rejects.toThrow(FLOW_LOAD_ERROR_PREFIX);

    const good = c.cases.find((x) => x.name === 'good');
    await expect(Promise.resolve().then(() => good?.fn())).resolves.toBeUndefined();
  });

  it('a runnable spec whose success fails throws SUCCESS_NOT_MET when run', async () => {
    const flow = flowFor('save-draft', 'save-btn');
    flow.success = { signal: 'flow:done' };
    const fs = memoryFs({ [`${FLOWS_DIR}/save-draft.json`]: serialize(flow) });
    const c = collector();
    await registerFlowSpecs(ROOT, () => fakeSession(['save-btn']), {
      fs,
      clock: fixedClock,
      waitForSignal: () => Promise.resolve({ pass: false, failureReason: 'no signal' }),
      register: c.reg,
    });
    const only = c.cases[0];
    await expect(Promise.resolve().then(() => only?.fn())).rejects.toThrow(
      SpecMessage.SUCCESS_NOT_MET,
    );
  });
});
