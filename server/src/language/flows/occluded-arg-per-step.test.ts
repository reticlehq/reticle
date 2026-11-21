/**
 * A step recorded with `allowOccluded` keeps it on replay; one recorded without it does not get it.
 *
 * The covered-click check can be wrong: a transparent overlay or a sticky header over the centre of
 * a button reads as a cover. An agent that clicked through such a cover on purpose made a choice
 * about that one control. Stripped on replay, the saved step would be refused on every run, and
 * nothing in the flow could fix it. So the opt-in is per step, and only where it was recorded.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOW_OCCLUDED_ARG, ActionType } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from './flows.js';
import { compileActStep, replayActionArgs } from './replay.js';

describe('the covered-click opt-in on replay', () => {
  it('is kept on the step that was recorded with it', () => {
    const args = replayActionArgs({ [ALLOW_OCCLUDED_ARG]: true, holdMs: 10 });
    expect(args[ALLOW_OCCLUDED_ARG]).toBe(true);
    expect(args['holdMs']).toBe(10);
  });

  it('is never added to a step that was recorded without it', () => {
    const args = replayActionArgs({ holdMs: 10 }, true);
    expect(args).not.toHaveProperty(ALLOW_OCCLUDED_ARG);
  });

  it('survives the save, so the flow file carries the choice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reticle-occluded-step-'));
    try {
      const store = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
      const step = compileActStep(
        { ref: 'e3', action: ActionType.CLICK, args: { [ALLOW_OCCLUDED_ARG]: true } },
        { ok: true, role: 'button', name: 'Save' },
      );
      const res = await store.save({ name: 'covered', version: 1, steps: [step] });
      expect(res.ok).toBe(true);
      const text = await readFile(join(root, 'flows', 'covered.json'), 'utf8');
      expect(text).toContain(ALLOW_OCCLUDED_ARG);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
