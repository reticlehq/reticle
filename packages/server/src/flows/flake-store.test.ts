import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { FlakeStore } from './flake-store.js';

/**
 * A BOUND, not a measurement. Every `store.record()` reads and rewrites `flake.json` on the real
 * filesystem, so a five-iteration loop is ten syscalls, not five cheap calls — the cost is what is
 * inside the loop, not the iteration count. Cheap on macOS and Linux, much slower on a Windows
 * runner, and vitest's 5 s default would then report the runner rather than the ledger.
 */
const FLAKE_LEDGER_IO_TIMEOUT_MS = 30_000;

describe('FlakeStore', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-flake-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it(
    'accrues outcomes and quarantines a flow once it is intermittently failing',
    async () => {
      const store = new FlakeStore(fs, root);
      for (const passed of [true, false, true, true, false]) await store.record('checkout', passed);
      expect(await store.flakyFlows()).toEqual(['checkout']);
    },
    FLAKE_LEDGER_IO_TIMEOUT_MS,
  );

  it(
    'does not quarantine a consistently passing flow',
    async () => {
      const store = new FlakeStore(fs, root);
      for (let i = 0; i < 5; i += 1) await store.record('login', true);
      expect(await store.flakyFlows()).toEqual([]);
    },
    FLAKE_LEDGER_IO_TIMEOUT_MS,
  );

  it('degrades to an empty ledger on a malformed or wrong-version file', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'flake.json'), '{ bad', 'utf8');
    expect(await new FlakeStore(fs, root).load()).toEqual({});
    await writeFile(join(root, 'flake.json'), JSON.stringify({ version: 9, flows: {} }), 'utf8');
    expect(await new FlakeStore(fs, root).load()).toEqual({});
  });
  describe('the ledger an agent can finally see', () => {
    /**
     * `FlakeStore` was written only by `cli-flow-commands.ts`, so `reticle_flow_verify` — the tool sold
     * as "the autonomous regression check" — accrued nothing and could never tell an agent that a
     * failure was intermittent. A flake and a regression demand opposite responses: one is quarantined,
     * the other is chased. An agent that cannot tell them apart does the wrong one half the time.
     */
    it(
      'reports a flow that passed and then failed on unchanged code',
      async () => {
        // Five runs is the deliberate floor (DEFAULT_MIN_FLAKE_RUNS): calling a flow flaky off two
        // samples would quarantine real regressions, which is the more expensive mistake.
        const store = new FlakeStore(fs, root);
        for (const passed of [true, false, true, true, false]) {
          await store.record('checkout', passed);
        }
        expect(await store.flakyFlows()).toContain('checkout');
      },
      FLAKE_LEDGER_IO_TIMEOUT_MS,
    );

    it(
      'needs enough runs before judging — three samples is not evidence',
      async () => {
        const store = new FlakeStore(fs, root);
        for (const passed of [true, false, true]) await store.record('early', passed);
        expect(await store.flakyFlows()).not.toContain('early');
      },
      FLAKE_LEDGER_IO_TIMEOUT_MS,
    );

    it(
      'does NOT report a flow that always fails — that is a regression, not a flake',
      async () => {
        const store = new FlakeStore(fs, root);
        for (let i = 0; i < 5; i += 1) await store.record('broken', false);
        expect(await store.flakyFlows()).not.toContain('broken');
      },
      FLAKE_LEDGER_IO_TIMEOUT_MS,
    );

    it(
      'does NOT report a flow that always passes',
      async () => {
        const store = new FlakeStore(fs, root);
        for (let i = 0; i < 5; i += 1) await store.record('stable', true);
        expect(await store.flakyFlows()).not.toContain('stable');
      },
      FLAKE_LEDGER_IO_TIMEOUT_MS,
    );
  });
});
