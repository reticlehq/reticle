import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@iris/protocol';
import { FROM_DISK_ARG } from '@iris/protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import type { Session, SessionManager } from './session.js';
import { irisDirPaths, readContract, writeContract, type ReadContractResult } from './iris-dir.js';
import type { FileSystemPort } from './fs-port.js';

const ROOT = '/virtual/.iris';
const FROZEN = 1_700_000_000_000;

// Pre-sorted to match the writer's stable (lexicographic) output, so a disk round-trip
// deep-equals the source. The sorting itself is exercised in iris-dir.test.ts (test 3).
const CAPS = {
  testids: ['cancel', 'save'],
  signals: ['saved'],
  stores: ['workspace'],
  flows: [{ name: 'checkout', steps: ['fill', 'submit'] }],
};

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
    readdir() {
      return Promise.resolve([]);
    },
    isNotFound(error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    },
  };
}

function fakeDeps(fs: FileSystemPort): ToolDeps {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: CAPS });
  const session: Partial<Session> = { id: 'demo', command };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now: () => FROZEN }),
    fs,
    irisRoot: ROOT,
    now: () => FROZEN,
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('iris_contract_save / iris_capabilities fromDisk (M8 Stage A)', () => {
  it('15: iris_contract_save writes session capabilities to disk', async () => {
    const fs = memoryFs();
    const deps = fakeDeps(fs);
    const res = (await tool(IrisTool.CONTRACT_SAVE).handler(deps, {})) as { path: string };
    expect(res.path).toBe(irisDirPaths(ROOT).contract);
    const r = await readContract(fs, ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.capabilities).toEqual(CAPS);
  });

  it('16: iris_capabilities({fromDisk:true}) reads contract.json', async () => {
    const fs = memoryFs();
    await writeContract(fs, ROOT, CAPS, () => FROZEN);
    const res = (await tool(IrisTool.CAPABILITIES).handler(fakeDeps(fs), {
      [FROM_DISK_ARG]: true,
    })) as { source: string; testids: string[]; generatedAt: number };
    expect(res.source).toBe('disk');
    expect(res.testids).toEqual(CAPS.testids);
    expect(res.generatedAt).toBe(FROZEN);
  });

  it('17: iris_capabilities({fromDisk:true}) with no file throws legible MISSING error', async () => {
    const fs = memoryFs();
    await expect(
      tool(IrisTool.CAPABILITIES).handler(fakeDeps(fs), { [FROM_DISK_ARG]: true }),
    ).rejects.toThrow(/iris_contract_save/);
  });

  it('18: iris_capabilities({fromDisk:true}) with malformed file throws legible MALFORMED error', async () => {
    const fs = memoryFs();
    await fs.mkdir(ROOT);
    await fs.writeFile(irisDirPaths(ROOT).contract, '{ broken');
    await expect(
      tool(IrisTool.CAPABILITIES).handler(fakeDeps(fs), { [FROM_DISK_ARG]: true }),
    ).rejects.toThrow(/malformed|regenerate/i);
  });

  it('19: iris_capabilities without fromDisk still hits the live session', async () => {
    const fs = memoryFs();
    const res = (await tool(IrisTool.CAPABILITIES).handler(fakeDeps(fs), {})) as {
      testids: string[];
    };
    expect(res.testids).toEqual(CAPS.testids);
    // disk untouched
    const r: ReadContractResult = await readContract(fs, ROOT);
    expect(r.ok).toBe(false);
  });

  it('20: iris_contract_save output is byte-stable across two runs with frozen clock', async () => {
    const fs1 = memoryFs();
    const fs2 = memoryFs();
    await tool(IrisTool.CONTRACT_SAVE).handler(fakeDeps(fs1), {});
    await tool(IrisTool.CONTRACT_SAVE).handler(fakeDeps(fs2), {});
    const a = await fs1.readFile(irisDirPaths(ROOT).contract);
    const b = await fs2.readFile(irisDirPaths(ROOT).contract);
    expect(a).toBe(b);
  });
});
