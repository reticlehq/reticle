/**
 * A CLI older than the daemon that saved a flow cannot parse it. The gate dropped such a flow with no
 * message and then reported it as `deletedCoverage`, about a file that exists. It is named as
 * unreadable with the parse error, and the gate fails closed on that.
 */

import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType, QueryBy, ReticleDir } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from '@/language/flows/flows.js';
import { AssertionTiersStore } from '@/language/flows/stores/assertion-tiers-store.js';
import { handleGate } from './cli-flow-commands.js';

describe('handleGate when a saved flow cannot be read', () => {
  let dir: string;
  let root: string;
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-gate-unreadable-'));
    root = join(dir, ReticleDir.ROOT);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    process.exitCode = undefined;

    const store = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
    await store.save({
      name: 'readable',
      version: 1,
      steps: [
        {
          tool: 'reticle_act',
          stable: true,
          args: { by: QueryBy.TESTID, value: 'a', action: ActionType.CLICK, args: {} },
        },
      ],
    });
    await mkdir(join(root, 'flows'), { recursive: true });
    await writeFile(join(root, 'flows', 'newer.json'), JSON.stringify({ version: 99 }));
    // `newer` passed before while covering the changed file: what made it read as deleted.
    vi.spyOn(AssertionTiersStore.prototype, 'load').mockResolvedValue({
      newer: { sources: ['src/App.tsx'], steps: [] },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await removeTempDir(dir);
  });

  const gateJson = (): Record<string, unknown> => {
    const line = stderr.map((s) => s.trim()).find((s) => s.includes('"event":"reticle_gate"'));
    expect(line).toBeDefined();
    return JSON.parse(line ?? '{}') as Record<string, unknown>;
  };

  it('names it with the parse error, not as deleted coverage, and fails', async () => {
    await handleGate(['src/App.tsx'], undefined);
    const json = gateJson();
    expect(json).not.toHaveProperty('deletedCoverage');
    expect(json).toMatchObject({
      pass: false,
      unreadableFlows: [{ flow: 'newer' }],
    });
    const named = JSON.stringify(json['unreadableFlows']);
    expect(named).toContain('version 99');
    expect(named).toContain('reticle update');
    expect(process.exitCode).toBe(1);
  });

  it('tells a stop hook which flow could not be read', async () => {
    await handleGate(['src/App.tsx'], undefined, true);
    const out = stderr.join('');
    expect(out).toContain('cannot be read: newer');
    expect(out).not.toContain('coverage deleted');
    expect(process.exitCode).toBe(1);
  });

  it('fails even when the changed files touch no readable flow', async () => {
    await handleGate(['README.md'], undefined);
    expect(gateJson()).toMatchObject({ pass: false, unreadableFlows: [{ flow: 'newer' }] });
    expect(process.exitCode).toBe(1);
  });
});
