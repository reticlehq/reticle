import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextText, nextStep, resetNextStep } from './next-step.js';
import { forgetAgents, noteAgentAttached, runAsAgent } from '@/hooks/coding-agents.js';

const NOW = 1_800_000_000_000;
const root = (files: Record<string, unknown> = {}): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'reticle-next-')), '.reticle');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
};
/** A run this session wrote, stamped at the session's own clock. */
const wroteNow = (r: string): void => {
  mkdirSync(join(r, 'runs'), { recursive: true });
  const run = join(r, 'runs', `drive-${String(Math.random()).slice(2)}.json`);
  writeFileSync(run, '{}');
  utimesSync(run, NOW / 1000, NOW / 1000);
};
const verdict = (r: string, tool = 'reticle_act_and_wait') =>
  nextStep({ tool, verdict: true, root: r, now: NOW });

beforeEach(() => resetNextStep());

describe('what the agent is told to do next', () => {
  it('asks for the user request first, until it has been declared', () => {
    const r = root();
    expect(verdict(r)).toBe(NextText.DECLARE);
    writeFileSync(join(r, 'request.json'), JSON.stringify({ at: NOW - 1000, statements: [] }));
    expect(verdict(r)).toBe(NextText.FINISH);
  });

  it('names a sync failure on a linked project, ahead of everything else', () => {
    const r = root({
      'cloud.json': { projectId: 'p' },
      'request.json': { at: NOW },
      'cloud-state.json': { lastError: 'the platform answered 401' },
    });
    wroteNow(r);
    expect(verdict(r)).toBe(NextText.SYNC_PROBLEM('the platform answered 401'));
  });

  /** One flow the platform refused was named on every answer of a whole session. */
  it('names a sync problem once, and again only when it changes', () => {
    const state = { lastError: 'drive-x: flow failed validation' };
    const r = root({ 'cloud.json': { projectId: 'p' }, 'request.json': { at: NOW } });
    writeFileSync(join(r, 'cloud-state.json'), JSON.stringify(state));
    expect(verdict(r)).toBe(NextText.FINISH_LINKED);
    // This session's own work is now among what the platform has not got.
    wroteNow(r);
    expect(verdict(r)).toBe(NextText.SYNC_PROBLEM(state.lastError));
    expect(verdict(r)).toBe(NextText.FINISH_LINKED);
    writeFileSync(join(r, 'cloud-state.json'), JSON.stringify({ lastError: 'answered 401' }));
    expect(verdict(r)).toBe(NextText.SYNC_PROBLEM('answered 401'));
  });

  /*
   * A daemon serving several agents appended "Runs are not reaching the platform (… flow
   * drive-runs-that-failed-overview …)" to every result of a session that had written no such flow.
   * A sync problem is said to the session whose own work it holds back; a refused key holds back all.
   */
  it('says nothing about work this session did not write', () => {
    const r = root({
      'cloud.json': { projectId: 'p' },
      'request.json': { at: NOW },
      'cloud-state.json': { lastError: '1 rejected — flow drive-runs-that-failed-overview' },
    });
    expect(verdict(r)).toBe(NextText.FINISH_LINKED);
    expect(verdict(r)).toBe(NextText.FINISH_LINKED);
  });

  it('says a refused key was refused, not the platform’s "valid API key required"', () => {
    const r = root({
      'cloud.json': { projectId: 'p' },
      'cloud-state.json': { lastError: 'status 401: valid API key required' },
      'request.json': { at: NOW },
    });
    expect(verdict(r)).toContain('refused this project');
  });

  /** A second checkout's evidence went to ~/.reticle/unmatched and the agent was told nothing. */
  it('names where unmatched evidence goes, the folders that claim it, and the fix — once', () => {
    const r = root({ 'request.json': { at: NOW } });
    const unmatched = {
      root: '/home/me/.reticle/unmatched/web-750871e8',
      contenders: ['/code/mono/apps/web', '/code/mono-clone/apps/web'],
    };
    const first = nextStep({
      tool: 'reticle_flow_save',
      verdict: false,
      root: r,
      now: NOW,
      unmatched,
    });
    expect(first).toBe(NextText.UNMATCHED(unmatched.root, unmatched.contenders));
    expect(first).toContain('/code/mono-clone/apps/web');
    expect(first).toContain('npx @reticlehq/server init');
    expect(
      nextStep({ tool: 'reticle_flow_save', verdict: false, root: r, now: NOW, unmatched }),
    ).not.toBe(first);
  });

  /*
   * The warning was said once per daemon: a fresh agent session in the clone drove, proved `yes`
   * and saved a flow into ~/.reticle/unmatched with nothing said, because an earlier session had
   * been told. Agents restart; the daemon stays. Each agent session is told once.
   */
  it('tells every agent session once, not the daemon once', async () => {
    forgetAgents();
    noteAgentAttached('first', 'claude-code');
    noteAgentAttached('second', 'claude-code');
    const r = root({ 'request.json': { at: NOW } });
    const unmatched = { root: '/home/me/.reticle/unmatched/web-1', contenders: [] };
    const ask = (): Promise<string | undefined> =>
      Promise.resolve(
        nextStep({ tool: 'reticle_flow_save', verdict: false, root: r, now: NOW, unmatched }),
      );
    const told = NextText.UNMATCHED(unmatched.root, []);
    expect(await runAsAgent('first', ask)).toBe(told);
    expect(await runAsAgent('first', ask)).not.toBe(told);
    expect(await runAsAgent('second', ask)).toBe(told);
    forgetAgents();
  });

  /*
   * It named the primary checkout's folders, never the clone actually serving the app, and advised
   * `reticle init` there, which rewrites the committed .reticle.json.
   */
  it('names the folder serving the app, and says what init would rewrite', () => {
    const said = NextText.UNMATCHED(
      '/home/me/.reticle/unmatched/web-1',
      ['/code/mono'],
      '/code/clone',
    );
    expect(said).toContain('/code/clone');
    expect(said).toContain('.reticle.json');
  });

  /*
   * A copied repository keeps the original's project id. The refusal advised `reticle init`, which
   * keeps the id already on disk, so following it changed nothing.
   */
  it('names both folders and the one command that gives the copy its own id', () => {
    const said = NextText.UNMATCHED(
      '/home/me/.reticle/unmatched/web-1',
      ['/code/mono', '/code/clone'],
      '/code/clone',
    );
    expect(said).toContain('/code/mono');
    expect(said).toContain('cd /code/clone && npx @reticlehq/server init --new-id');
  });

  it('on a linked project with nothing wrong, says the run syncs on its own', () => {
    const r = root({ 'cloud.json': { projectId: 'p' }, 'request.json': { at: NOW } });
    expect(verdict(r)).toBe(NextText.FINISH_LINKED);
  });

  /** The connect advice is the agent nudge's, said once per session: never repeated here. */
  it('on an unlinked project, says only how to hand the tab back', () => {
    const r = root({ 'request.json': { at: NOW } });
    expect(Array.from({ length: 6 }, () => verdict(r))).toEqual(Array(6).fill(NextText.FINISH));
  });

  it('stays quiet on a read with nothing pending, and never asks the intent tool to declare', () => {
    const r = root({ 'request.json': { at: NOW } });
    expect(nextStep({ tool: 'reticle_look', verdict: false, root: r, now: NOW })).toBeUndefined();
    expect(
      nextStep({ tool: 'reticle_intent', verdict: false, root: root(), now: NOW }),
    ).toBeUndefined();
  });
});

/**
 * From nine recorded runs on the merchant dashboard: no agent ever recorded the request, every
 * `next` line it saw was that same ask, and so none was told its runs were not reaching the platform.
 */
describe('the request ask does not hide everything else', () => {
  it('is asked twice, then gives the other lines their turn', () => {
    const r = root();
    expect(verdict(r)).toBe(NextText.DECLARE);
    expect(verdict(r)).toBe(NextText.DECLARE);
    expect(verdict(r)).not.toBe(NextText.DECLARE);
  });
});

describe('runs written and never sent', () => {
  it('are a sync problem even with no error and nothing refused', () => {
    const r = root({
      'cloud.json': { projectId: 'p' },
      'request.json': { at: NOW },
      'cloud-state.json': { lastPushAt: NOW - 60 * 60 * 1000 },
    });
    // The session starts, writes a run, and ten minutes later it has still not been sent.
    expect(verdict(r)).toBe(NextText.FINISH_LINKED);
    mkdirSync(join(r, 'runs'));
    const run = join(r, 'runs', 'drive-1.json');
    writeFileSync(run, '{}');
    utimesSync(run, NOW / 1000, NOW / 1000);
    const later = NOW + 10 * 60 * 1000;
    expect(nextStep({ tool: 'reticle_act_and_wait', verdict: true, root: r, now: later })).toBe(
      NextText.SYNC_PROBLEM('1 run(s) written here were never sent'),
    );
  });
});

describe('a project that sends through the key in the environment', () => {
  it('is told its run syncs on its own, not how to connect', () => {
    const previous = process.env['RETICLE_API_KEY'];
    process.env['RETICLE_API_KEY'] = 'k';
    try {
      const r = root({ 'request.json': { at: NOW } });
      expect(verdict(r)).toBe(NextText.FINISH_LINKED);
    } finally {
      if (previous === undefined) delete process.env['RETICLE_API_KEY'];
      else process.env['RETICLE_API_KEY'] = previous;
    }
  });
});

/** From a whole-app drive: the agent re-drove everything by hand while saved flows sat unreplayed. */
describe('an app with saved flows', () => {
  it('is told to replay them, once, on its first call', () => {
    const dir = root();
    mkdirSync(join(dir, 'flows', 'shop'), { recursive: true });
    writeFileSync(join(dir, 'flows', 'shop', 'checkout.json'), '{}');
    writeFileSync(join(dir, 'flows', 'shop', 'refund.json'), '{}');
    const first = nextStep({ tool: 'reticle_look', verdict: false, root: dir, now: 0 });
    expect(first).toBe(NextText.REPLAY(2));
    expect(nextStep({ tool: 'reticle_look', verdict: false, root: dir, now: 0 })).not.toBe(
      NextText.REPLAY(2),
    );
  });

  it('says nothing about flows that do not exist', () => {
    const line = nextStep({ tool: 'reticle_look', verdict: false, root: root(), now: 0 });
    expect(line ?? '').not.toContain('saved flow');
  });
});
