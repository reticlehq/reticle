import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiskSurface, type CapabilitiesContract } from '@reticlehq/core';
import { reticleDirPaths, readContract, writeContract } from './reticle-dir.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';

const FROZEN = 1_700_000_000_000;

const withGovernance: CapabilitiesContract = {
  testids: ['pay'],
  signals: ['order:saved'],
  stores: ['cart'],
  flows: [],
  governance: {
    owner: 'payments@acme.com',
    safety: ['never touches the production database'],
    redact: ['cart.paymentToken'],
    risk: [{ surface: RiskSurface.PAYMENT, paths: ['src/checkout/**'], note: 'PCI surface' }],
  },
};

describe('contract persistence preserves declared governance', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-gov-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('round-trips governance through write + read', async () => {
    await writeContract(fs, root, withGovernance, () => FROZEN);
    const read = await readContract(fs, root);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.capabilities.governance?.owner).toBe('payments@acme.com');
      expect(read.capabilities.governance?.risk?.[0]?.surface).toBe(RiskSurface.PAYMENT);
    }
  });

  it('serializes byte-stably (two writes produce identical bytes)', async () => {
    await writeContract(fs, root, withGovernance, () => FROZEN);
    const first = await readFile(reticleDirPaths(root).contract, 'utf8');
    await writeContract(fs, root, withGovernance, () => FROZEN);
    const second = await readFile(reticleDirPaths(root).contract, 'utf8');
    expect(first).toBe(second);
  });
});
