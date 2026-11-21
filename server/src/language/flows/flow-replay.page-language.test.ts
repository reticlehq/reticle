/**
 * A flow recorded in English replays on the same page in Arabic (#2278).
 *
 * The step looks for its English copy, finds no match, and drifts. The drift must name the language
 * change and suggest a locale-free anchor, instead of advice about the route or a lost element.
 */
import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  QueryBy,
  ReplayStatus,
  ReticleTool,
  type CommandResult,
  type FlowReplayResult,
} from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore, type CompiledProgram } from './recording/tape/recordings.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from './stores/annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { notePageLanguage } from '@/portal/session/hello-identity.js';

const clock = { now: (): number => 1234 };

/** A page where no query matches, because its copy is in another language. */
function translatedPage(lang: string): Partial<Session> {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'q', ok: true, result: { elements: [] } });
  const page: Partial<Session> = {
    id: 'demo',
    command,
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  notePageLanguage(page, { lang });
  return page;
}

function deps(fs: FileSystemPort, root: string, session: Partial<Session>): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, root, clock),
    project: new ProjectStore(fs, root, clock),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: root,
    now: clock.now,
  };
}

const replay = TOOLS.find((t) => t.name === ReticleTool.FLOW_REPLAY);

const recordedInEnglish: CompiledProgram = {
  name: 'checkout',
  version: 1,
  startLang: 'en',
  steps: [
    {
      tool: ReticleTool.ACT,
      stable: true,
      args: { by: QueryBy.ROLE, value: 'button', name: 'Pay', action: ActionType.CLICK, args: {} },
    },
  ],
};

describe('a replay on a page in another language', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-replay-lang-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    const saved = await new FlowStore(fs, root, clock).save(recordedInEnglish);
    if (!saved.ok) {
      throw new Error(`save failed: ${saved.code}`);
    }
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  async function replayOn(lang: string): Promise<FlowReplayResult> {
    return (await replay?.handler(deps(fs, root, translatedPage(lang)), {
      flowName: 'checkout',
    })) as FlowReplayResult;
  }

  // The first step misses, so nothing ran and the replay is unverifiable. Its reason is what the
  // agent reads, and it said only "start the replay from the state this step needs".
  it('names the language change and suggests a locale-free anchor', async () => {
    const res = await replayOn('ar');
    expect(res.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(res.unverifiable?.reason).toContain('the page language changed');
    expect(res.unverifiable?.reason).toContain('"ar"');
    expect(res.unverifiable?.reason).toContain('test id');
  });

  it('says nothing about language when the page is in the recorded language', async () => {
    const res = await replayOn('en');
    expect(res.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(res.unverifiable?.reason).not.toContain('the page language changed');
  });
});
