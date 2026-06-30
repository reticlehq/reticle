import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@reticlehq/protocol';
import { FROM_DISK_ARG } from '@reticlehq/protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';
import {
  reticleDirPaths,
  readContract,
  writeContract,
  type ReadContractResult,
} from '../project/reticle-dir.js';
import type { FileSystemPort } from '../project/fs-port.js';

const ROOT = '/virtual/.reticle';
const FROZEN = 1_700_000_000_000;

// Pre-sorted to match the writer's stable (lexicographic) output, so a disk round-trip
// deep-equals the source. The sorting itself is exercised in reticle-dir.test.ts (test 3).
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
    readFileBytes(path) {
      const v = files.get(path);
      if (v === undefined) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(new TextEncoder().encode(v));
    },
    writeFileBytes(path, data) {
      files.set(path, new TextDecoder().decode(data));
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
    rename(from, to) {
      const v = files.get(from);
      if (v !== undefined) {
        files.set(to, v);
        files.delete(from);
      }
      return Promise.resolve();
    },
    rm(path) {
      files.delete(path);
      return Promise.resolve();
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
    project: new ProjectStore(fs, ROOT, { now: () => FROZEN }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now: () => FROZEN,
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('reticle_contract_save / reticle_capabilities fromDisk', () => {
  it('15: reticle_contract_save writes session capabilities to disk', async () => {
    const fs = memoryFs();
    const deps = fakeDeps(fs);
    const res = (await tool(ReticleTool.CONTRACT_SAVE).handler(deps, {})) as { path: string };
    expect(res.path).toBe(reticleDirPaths(ROOT).contract);
    const r = await readContract(fs, ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.capabilities).toEqual(CAPS);
  });

  it('16: reticle_capabilities({fromDisk:true}) reads contract.json', async () => {
    const fs = memoryFs();
    await writeContract(fs, ROOT, CAPS, () => FROZEN);
    const res = (await tool(ReticleTool.CAPABILITIES).handler(fakeDeps(fs), {
      [FROM_DISK_ARG]: true,
    })) as { source: string; testids: string[]; generatedAt: number };
    expect(res.source).toBe('disk');
    expect(res.testids).toEqual(CAPS.testids);
    expect(res.generatedAt).toBe(FROZEN);
  });

  it('17: reticle_capabilities({fromDisk:true}) with no file throws legible MISSING error', async () => {
    const fs = memoryFs();
    await expect(
      tool(ReticleTool.CAPABILITIES).handler(fakeDeps(fs), { [FROM_DISK_ARG]: true }),
    ).rejects.toThrow(/reticle_contract_save/);
  });

  it('18: reticle_capabilities({fromDisk:true}) with malformed file throws legible MALFORMED error', async () => {
    const fs = memoryFs();
    await fs.mkdir(ROOT);
    await fs.writeFile(reticleDirPaths(ROOT).contract, '{ broken');
    await expect(
      tool(ReticleTool.CAPABILITIES).handler(fakeDeps(fs), { [FROM_DISK_ARG]: true }),
    ).rejects.toThrow(/malformed|regenerate/i);
  });

  it('19: reticle_capabilities without fromDisk still hits the live session', async () => {
    const fs = memoryFs();
    const res = (await tool(ReticleTool.CAPABILITIES).handler(fakeDeps(fs), {})) as {
      testids: string[];
    };
    expect(res.testids).toEqual(CAPS.testids);
    // disk untouched
    const r: ReadContractResult = await readContract(fs, ROOT);
    expect(r.ok).toBe(false);
  });

  it('20: reticle_contract_save output is byte-stable across two runs with frozen clock', async () => {
    const fs1 = memoryFs();
    const fs2 = memoryFs();
    await tool(ReticleTool.CONTRACT_SAVE).handler(fakeDeps(fs1), {});
    await tool(ReticleTool.CONTRACT_SAVE).handler(fakeDeps(fs2), {});
    const a = await fs1.readFile(reticleDirPaths(ROOT).contract);
    const b = await fs2.readFile(reticleDirPaths(ROOT).contract);
    expect(a).toBe(b);
  });
});
