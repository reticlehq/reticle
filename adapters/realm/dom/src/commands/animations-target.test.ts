/**
 * Nine concurrent animations came back as nine indistinguishable objects.
 *
 * Reported from the field, diagnosed to the line by the reporter:
 *
 * > `reticle_animations` advertises 'targets/timing' but the payload carries no target.
 * > `listAnimations()` reads `a.effect` only for `getTiming()` and never reads
 * > `(effect as KeyframeEffect).target`, so a page with nine concurrent animations returns nine
 * > indistinguishable `{playState, currentTime, duration}` rows with no way to tell which element
 * > each belongs to.
 *
 * A list you cannot index is not a list. The tool's whole purpose is answering "is THAT thing still
 * animating", and every row was identical shape with nothing naming the subject.
 */

import { describe as vitestDescribe, expect, it, beforeEach } from 'vitest';
import { createCommandRegistry } from './commands.js';
import { ReticleCommand } from '@reticlehq/core';

type Handler = (args: Record<string, unknown>) => unknown;

function animationsHandler(): Handler {
  const handler = createCommandRegistry().get(ReticleCommand.ANIMATIONS);
  if (handler === undefined) throw new Error('ANIMATIONS command is not registered');
  return handler;
}

/** A fake Animation whose effect targets a real element, the way KeyframeEffect does. */
function fakeAnimation(target: Element | null, playState: string): Animation {
  return {
    playState,
    currentTime: 100,
    effect: {
      target,
      getTiming: () => ({ duration: 300 }),
    },
  } as unknown as Animation;
}

vitestDescribe('reticle_animations names the element each animation drives', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button id="a">Save</button><button id="b">Cancel</button><div id="c"></div>';
  });

  const rowsFor = (animations: Animation[]): Record<string, unknown>[] => {
    (document as unknown as { getAnimations: () => Animation[] }).getAnimations = () => animations;
    const out = animationsHandler()({}) as { animations: Record<string, unknown>[] };
    return out.animations;
  };

  it('carries a target descriptor per row', () => {
    const save = document.getElementById('a');
    const rows = rowsFor([fakeAnimation(save, 'running')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['target'], 'no target — the row names nothing').toBeDefined();
  });

  it('two animations on two elements are distinguishable', () => {
    const rows = rowsFor([
      fakeAnimation(document.getElementById('a'), 'running'),
      fakeAnimation(document.getElementById('b'), 'running'),
    ]);
    const targets = rows.map((r) => JSON.stringify(r['target']));
    expect(new Set(targets).size, 'both rows describe the same thing').toBe(2);
  });

  it('the descriptor carries a ref the agent can act on, and the accessible name', () => {
    const rows = rowsFor([fakeAnimation(document.getElementById('a'), 'running')]);
    const target = rows[0]?.['target'] as Record<string, unknown> | undefined;
    expect(target?.['ref'], 'a target you cannot pass to reticle_act is half an answer').toEqual(
      expect.any(String),
    );
    expect(target?.['name']).toBe('Save');
  });

  it('an effect with no target reports null, not an omitted key', () => {
    // A KeyframeEffect legitimately can have `target: null`. Omitting the key would make "no target"
    // look identical to the bug this fixes.
    const rows = rowsFor([fakeAnimation(null, 'running')]);
    expect('target' in (rows[0] ?? {})).toBe(true);
    expect(rows[0]?.['target']).toBeNull();
  });

  it('still reports the timing it always did', () => {
    const rows = rowsFor([fakeAnimation(document.getElementById('a'), 'paused')]);
    expect(rows[0]?.['playState']).toBe('paused');
    expect(rows[0]?.['duration']).toBe(300);
  });
});
