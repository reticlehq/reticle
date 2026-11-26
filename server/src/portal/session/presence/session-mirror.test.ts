import { COMPUTER_RUNTIME } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { tellDesktops } from './session-mirror.js';

/** A session that only records what it is told. */
function tab(id: string, runtime: string | undefined) {
  const told: string[] = [];
  return {
    id,
    runtime,
    told,
    pushNarration: (text: string, mirror?: boolean) => {
      told.push(`${text}${false === mirror ? '' : ' (mirrored)'}`);
    },
  };
}

// While computer use was live, the HUD of the desktop showed its own actions and none of the
// browser's: the person saw half of what the agent did.
describe('tellDesktops', () => {
  it('tells each desktop session what was done in a page, and no page', () => {
    const page = tab('s1', 'web');
    const desktop = tab('cu-dia', COMPUTER_RUNTIME);
    const other = tab('s2', 'web');
    tellDesktops(page, [desktop, other], { action: 'click', role: 'button', name: 'Save' });
    expect(desktop.told).toEqual(['s1 → click button "Save"']);
    expect(other.told).toEqual([]);
  });

  it('says nothing for an act of a desktop session, which shows its own', () => {
    const desktop = tab('cu-dia', COMPUTER_RUNTIME);
    const second = tab('cu-finder', COMPUTER_RUNTIME);
    tellDesktops(desktop, [second], { action: 'click', role: 'button', name: 'Save' });
    expect(second.told).toEqual([]);
  });

  it('says the action alone when the reply names no element', () => {
    const desktop = tab('cu-dia', COMPUTER_RUNTIME);
    tellDesktops(tab('s1', 'web'), [desktop], { action: 'press' });
    expect(desktop.told).toEqual(['s1 → press']);
  });
});
