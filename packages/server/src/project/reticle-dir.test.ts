import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractReadError, type CapabilitiesContract } from '@reticle/protocol';
import {
  baselinePath,
  ensureReticleDir,
  flowPath,
  reticleDirPaths,
  readContract,
  writeContract,
} from './reticle-dir.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';

const FROZEN = 1_700_000_000_000;
const frozenClock = (): number => FROZEN;

const SAMPLE: CapabilitiesContract = {
  testids: ['a', 'b'],
  signals: ['s'],
  stores: ['w'],
  flows: [{ name: 'f', steps: ['x'] }],
};

describe('reticle-dir — temp-dir filesystem, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  // ---- VALID ----

  it('1: writeContract then readContract round-trips', async () => {
    await writeContract(fs, root, SAMPLE, frozenClock);
    const r = await readContract(fs, root);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.capabilities).toEqual(SAMPLE);
    expect(r.generatedAt).toBe(FROZEN);
  });

  it('2: contract.json is pretty-printed (2-space) + trailing newline', async () => {
    await writeContract(fs, root, SAMPLE, frozenClock);
    const text = await readFile(reticleDirPaths(root).contract, 'utf8');
    expect(text).toContain('\n  "version"');
    expect(text.endsWith('}\n')).toBe(true);
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
  });

  it('3: contract.json has stable key order regardless of input array order', async () => {
    const a: CapabilitiesContract = {
      testids: ['b', 'a'],
      signals: ['s'],
      stores: ['w'],
      flows: [
        { name: 'z', steps: ['x'] },
        { name: 'a', steps: ['y'] },
      ],
    };
    const dirA = await mkdtemp(join(tmpdir(), 'reticle-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'reticle-b-'));
    const rootA = join(dirA, '.reticle');
    const rootB = join(dirB, '.reticle');
    await writeContract(fs, rootA, a, frozenClock);
    await writeContract(fs, rootB, a, frozenClock);
    const textA = await readFile(reticleDirPaths(rootA).contract, 'utf8');
    const textB = await readFile(reticleDirPaths(rootB).contract, 'utf8');
    expect(textA).toBe(textB);
    expect(textA).toContain('"testids": [\n      "a",\n      "b"\n    ]');
    expect(textA.indexOf('"name": "a"')).toBeLessThan(textA.indexOf('"name": "z"'));
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('4: writeContract stamps version + generatedAt from injected clock', async () => {
    await writeContract(fs, root, SAMPLE, () => 42);
    const parsed = JSON.parse(await readFile(reticleDirPaths(root).contract, 'utf8')) as {
      version: number;
      generatedAt: number;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.generatedAt).toBe(42);
  });

  it('5: writeContract auto-creates .reticle/ when absent (no pre-ensure)', async () => {
    await writeContract(fs, root, SAMPLE, frozenClock);
    expect(await fs.exists(reticleDirPaths(root).contract)).toBe(true);
    const r = await readContract(fs, root);
    expect(r.ok).toBe(true);
  });

  // ---- EDGE ----

  it('6: readContract on missing dir returns MISSING (no throw)', async () => {
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MISSING });
  });

  it('7: readContract on missing file but present dir returns MISSING', async () => {
    await ensureReticleDir(fs, root);
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MISSING });
  });

  it('8: ensureReticleDir is idempotent', async () => {
    await ensureReticleDir(fs, root);
    await ensureReticleDir(fs, root);
    await ensureReticleDir(fs, root);
    const p = reticleDirPaths(root);
    expect(await fs.exists(p.flows)).toBe(true);
    expect(await fs.exists(p.baselines)).toBe(true);
  });

  it('9: ensureReticleDir creates flows/ and baselines/', async () => {
    await ensureReticleDir(fs, root);
    const p = reticleDirPaths(root);
    expect(await fs.exists(p.flows)).toBe(true);
    expect(await fs.exists(p.baselines)).toBe(true);
  });

  it('10: reticleDirPaths/flowPath/baselinePath compose correctly', () => {
    const p = reticleDirPaths(root);
    expect(p.contract.endsWith(join('.reticle', 'contract.json'))).toBe(true);
    expect(p.flows.endsWith(join('.reticle', 'flows'))).toBe(true);
    expect(p.baselines.endsWith(join('.reticle', 'baselines'))).toBe(true);
    expect(flowPath(root, 'checkout').endsWith(join('.reticle', 'flows', 'checkout.json'))).toBe(
      true,
    );
    expect(baselinePath(root, 'home').endsWith(join('.reticle', 'baselines', 'home.json'))).toBe(
      true,
    );
  });

  // ---- INVALID ----

  it('11: readContract on malformed JSON returns MALFORMED (no throw)', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(reticleDirPaths(root).contract, '{ not json', 'utf8');
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });

  it('12: readContract on valid JSON failing schema returns MALFORMED', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(
      reticleDirPaths(root).contract,
      '{"version":1,"generatedAt":1,"capabilities":{"testids":"oops","signals":[],"stores":[],"flows":[]}}',
      'utf8',
    );
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });

  it('13: readContract on empty file returns MALFORMED', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(reticleDirPaths(root).contract, '', 'utf8');
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });

  it('14: readContract on JSON of wrong top-level shape returns MALFORMED', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(reticleDirPaths(root).contract, '[]', 'utf8');
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });
});
