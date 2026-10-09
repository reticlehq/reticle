import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextText, nextStep, resetNextStep } from './next-step.js';

const NOW = 1_800_000_000_000;
const root = (files: Record<string, unknown> = {}): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'reticle-next-')), '.reticle');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
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
    expect(verdict(r)).toBe(NextText.SYNC_PROBLEM('the platform answered 401'));
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
    mkdirSync(join(r, 'runs'));
    const run = join(r, 'runs', 'drive-1.json');
    writeFileSync(run, '{}');
    const tenMinutesAgo = (NOW - 10 * 60 * 1000) / 1000;
    utimesSync(run, tenMinutesAgo, tenMinutesAgo);
    expect(verdict(r)).toBe(NextText.SYNC_PROBLEM('1 run(s) written here were never sent'));
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
