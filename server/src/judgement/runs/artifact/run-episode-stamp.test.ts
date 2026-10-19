/**
 * A run artifact names the episode that produced it and the commit it ran against.
 *
 * Joining a run to the agent's trajectory was guesswork by time and file: the run carried no
 * episode id, and `project.commit` was never filled in. Now the run store stamps both, from the
 * episode the calling agent connection writes (or, outside a call, the one that drove the run's tab).
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunAgentKind, RunFramework, RunProfile, RunTrigger } from '@reticlehq/core';
import { noteAgentAttached, runAsAgent } from '@/hooks/coding-agents.js';
import { noteEpisode } from '@/hooks/episode-stamp.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { buildVerificationRun } from './build-verification-run.js';
import { RunStore } from './run-store.js';

const run = (runId: string, commit?: string) =>
  buildVerificationRun(
    {
      runId,
      durationMs: 1,
      profile: RunProfile.DEV,
      project: {
        name: 'demo',
        framework: RunFramework.REACT,
        ...(commit === undefined ? {} : { commit }),
      },
      agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
      trigger: { kind: RunTrigger.EDIT },
      changedFiles: [],
      flows: [],
      checks: [],
      risks: [],
      evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
    },
    () => 1,
  );

async function written(root: string, runId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, 'runs', `${runId}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('the episode stamp on a run', () => {
  it("names the calling connection's episode and its HEAD", async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-episode-'));
    noteEpisode(root, 'conn-a', { head: 'aaa111' });
    noteEpisode(root, 'conn-b', { head: 'bbb222' });
    noteAgentAttached('conn-a', 'claude-code');
    const store = new RunStore(createNodeFileSystem(), root);
    await runAsAgent('conn-a', () => store.write(run('r1')));
    expect(await written(root, 'r1')).toMatchObject({
      episodeId: 'conn-a',
      project: { commit: 'aaa111' },
    });
  });

  /*
   * Outside a call (a session's end), the run used to take the NEWEST episode in the project: with
   * two agents in one project, the wrong one whenever the other had called last. It now takes the
   * episode whose calls drove the run's tab, with that connection's agent session.
   */
  it('outside a call, names the episode that drove its tab, not the newest one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-episode-'));
    // Two agents, interleaved: A drives tab-1, B drives tab-2, then each calls again.
    noteEpisode(root, 'conn-a', { sessionId: 'tab-1', agentSession: 'claude-a' });
    noteEpisode(root, 'conn-b', { sessionId: 'tab-2', agentSession: 'claude-b' });
    noteEpisode(root, 'conn-a', { head: 'aaa111' });
    noteEpisode(root, 'conn-a', { sessionId: 'tab-1' });
    noteEpisode(root, 'conn-b', { sessionId: 'tab-2' });
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(run('r-tab1', 'given'), { sessionId: 'tab-1' });
    expect(await written(root, 'r-tab1')).toMatchObject({
      episodeId: 'conn-a',
      agentSession: 'claude-a',
      project: { commit: 'given' },
    });
    await store.write(run('r-tab2'), { sessionId: 'tab-2' });
    expect(await written(root, 'r-tab2')).toMatchObject({
      episodeId: 'conn-b',
      agentSession: 'claude-b',
    });
    // Nothing says which: two episodes, no call, no tab. Unknown, never a guess.
    await store.write(run('r-none'));
    expect((await written(root, 'r-none'))['episodeId']).toBeUndefined();
  });

  it('outside a call, a project with one episode is that episode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-episode-'));
    noteEpisode(root, 'conn-a', { head: 'aaa111' });
    await new RunStore(createNodeFileSystem(), root).write(run('r2'));
    expect(await written(root, 'r2')).toMatchObject({
      episodeId: 'conn-a',
      project: { commit: 'aaa111' },
    });
  });

  it('stamps nothing where no episode was written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-episode-'));
    await new RunStore(createNodeFileSystem(), root).write(run('r3'));
    const out = await written(root, 'r3');
    expect(out['episodeId']).toBeUndefined();
    expect((out['project'] as Record<string, unknown>)['commit']).toBeUndefined();
  });
});
