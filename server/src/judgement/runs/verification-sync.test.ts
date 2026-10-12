import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asProjectId,
  ReplayStatus,
  RunAgentKind,
  RunTrigger,
  type FlowReplayResult,
} from '@reticlehq/core';
import {
  CLI_CLIENT_NAME,
  persistAndSyncVerificationRun,
  type TimedReplay,
} from './verification-sync.js';
import { RunStore } from './artifact/run-store.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import type { RunId } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { forgetAgents, noteAgentAttached, runAsAgent } from '@/hooks/coding-agents.js';
import { runDrivenBy } from '@/hooks/driven-by.js';
import {
  clearMcpClientIdentityHook,
  setMcpClientIdentityHook,
} from '@/surface/mcp/peer/client-identity.js';

const timed = (name: string, status: ReplayStatus): TimedReplay => ({
  replay: { name, status, steps: [] } satisfies FlowReplayResult,
  durationMs: 50,
});

/** Install a fake global fetch that records calls and returns (or rejects) a response. */
type FetchInit = { method: string; headers: Record<string, string>; body: string };
type FetchArgs = [string, FetchInit];
const stubFetch = (mode: 'ok' | 'fail' | 'throw'): { calls: FetchArgs[] } => {
  const calls: FetchArgs[] = [];
  globalThis.fetch = ((url: string, init: FetchInit) => {
    calls.push([url, init]);
    if ('throw' === mode) return Promise.reject(new Error('network down'));
    return Promise.resolve({ ok: 'ok' === mode, status: 'ok' === mode ? 201 : 500 } as Response);
  }) as unknown as typeof fetch;
  return { calls };
};

const URL_ENV = 'RETICLE_CLOUD_URL';
const KEY_ENV = 'RETICLE_CLOUD_KEY';

describe('persistAndSyncVerificationRun — MCP verification → Runs-tab artifact', () => {
  let root: string;
  let fs: FileSystemPort;
  let deps: ToolDeps;
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-vsync-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    // Only fs, reticleRoot, now are touched by the helper.
    deps = { fs, reticleRoot: root, now: () => 1000 } as unknown as ToolDeps;
    delete process.env[URL_ENV];
    delete process.env[KEY_ENV];
  });
  afterEach(async () => {
    globalThis.fetch = origFetch;
    delete process.env[URL_ENV];
    delete process.env[KEY_ENV];
    await removeTempDir(join(root, '..'));
  });

  it('writes the run artifact to disk even when not logged in (no phone-home)', async () => {
    const { calls } = stubFetch('ok');

    const runId = await persistAndSyncVerificationRun(deps, [timed('checkout', ReplayStatus.OK)], {
      projectId: asProjectId('shop'),
    });

    expect(runId).toBeDefined();
    expect(calls).toHaveLength(0); // no creds → nothing leaves the machine
    const stored = await new RunStore(fs, root).read(runId as RunId);
    expect(stored.ok).toBe(true);
  });

  it('pushes the artifact to POST /v1/runs when cloud creds are set', async () => {
    process.env[URL_ENV] = 'https://cloud.test';
    process.env[KEY_ENV] = 'rk_live_abc';
    const { calls } = stubFetch('ok');

    const runId = await persistAndSyncVerificationRun(
      deps,
      [timed('checkout', ReplayStatus.OK), timed('signup', ReplayStatus.DRIFT)],
      { projectId: asProjectId('shop') },
    );

    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [url, init] = first;
    expect(url).toBe('https://cloud.test/v1/runs');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as {
      runId: string;
      flows: unknown[];
      verdict: { status: string };
    };
    expect(body.runId).toBe(runId);
    expect(body.flows).toHaveLength(2);
    // a drift flow collapses to a fail; one pass + one fail = a mixed 'partial' verdict (never a false green).
    expect(body.verdict.status).toBe('partial');
  });

  it('never throws on a cloud failure and returns the runId (verdict unaffected)', async () => {
    process.env[URL_ENV] = 'https://cloud.test';
    process.env[KEY_ENV] = 'rk_live_abc';
    stubFetch('throw');

    const runId = await persistAndSyncVerificationRun(deps, [timed('checkout', ReplayStatus.OK)], {
      projectId: asProjectId('shop'),
    });
    expect(runId).toBeDefined(); // swallowed; local artifact still written
  });

  /*
   * A dashboard Re-verify was credited to `claude-code` — the last MCP client that had connected to
   * that daemon, not the one that asked — and its project named "reticle" instead of the project the
   * checkout is linked to.
   */
  it('credits only the client that made the call, never the last one that connected', async () => {
    forgetAgents();
    noteAgentAttached('a1', 'claude-code');
    setMcpClientIdentityHook(() => ({ name: 'claude-code', version: '1' }));
    const asked = await persistAndSyncVerificationRun(deps, [timed('c', ReplayStatus.OK)], {
      projectId: undefined,
    });
    const byAgent = await runAsAgent('a1', () =>
      persistAndSyncVerificationRun(deps, [timed('c', ReplayStatus.OK)], { projectId: undefined }),
    );
    forgetAgents();
    clearMcpClientIdentityHook();
    const store = new RunStore(fs, root);
    const platform = await store.read(asked as RunId);
    const agent = await store.read(byAgent as RunId);
    expect(platform.ok && platform.run.agent.id).toBe('reticle-mcp');
    expect(agent.ok && agent.run.agent.id).toBe('claude-code');
  });

  /*
   * Persona drive (a CI pipeline): `reticle verify` against a running daemon replays the saved
   * flows over MCP as the client `reticle-cli`, and every CI run was recorded as an ordinary coding
   * agent, trigger manual, credited to whoever minted the key. The command line is the pipeline,
   * exactly as the path that boots its own daemon records it.
   */
  it('records the Reticle command line as the pipeline, not as a coding agent', async () => {
    forgetAgents();
    noteAgentAttached('ci', CLI_CLIENT_NAME);
    const id = await runAsAgent('ci', () =>
      persistAndSyncVerificationRun(deps, [timed('c', ReplayStatus.OK)], { projectId: undefined }),
    );
    forgetAgents();
    const read = await new RunStore(fs, root).read(id as RunId);
    expect(read.ok && read.run.agent).toEqual({
      id: CLI_CLIENT_NAME,
      kind: RunAgentKind.OEM_PIPELINE,
    });
    expect(read.ok && read.run.trigger.kind).toBe(RunTrigger.OEM);
  });

  /*
   * Persona drive: a replay inside a Harness plan run was pushed as its own run ("Passed · Flow
   * replay · Your agent") beside the plan run ("Failed · Run the saved plan"): one run, two rows,
   * two verdicts. A replay the Harness makes is part of the Harness's run, never a run of its own.
   */
  it('writes no separate run for a replay the Harness made inside its own drive', async () => {
    const id = await runDrivenBy({ harness: 'h1', driver: 'server' }, () =>
      persistAndSyncVerificationRun(deps, [timed('c', ReplayStatus.OK)], { projectId: undefined }),
    );
    expect(id).toBeUndefined();
  });

  it('names the run after the project the checkout is linked to', async () => {
    await fs.mkdir(root);
    await fs.writeFile(
      join(root, 'cloud.json'),
      JSON.stringify({ url: 'https://cloud.test', projectId: 'bench-checkout' }),
    );
    const runId = await persistAndSyncVerificationRun(deps, [timed('c', ReplayStatus.OK)], {
      projectId: undefined,
    });
    const stored = await new RunStore(fs, root).read(runId as RunId);
    expect(stored.ok && stored.run.project.name).toBe('bench-checkout');
  });

  it('is a no-op for an empty suite (nothing to verify)', async () => {
    const runId = await persistAndSyncVerificationRun(deps, [], { projectId: asProjectId('shop') });
    expect(runId).toBeUndefined();
  });
});
