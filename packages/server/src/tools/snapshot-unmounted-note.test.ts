/**
 * The third reason an empty tree is not an empty page.
 *
 * `noteEmptyLeanTree` and `noteHiddenPage` both explain `{ tree: "", nodes: 0 }` by what the WALK
 * passed over. Neither can explain the case where there was nothing to walk: the app unmounted. That
 * is what a react-three-fiber crash produced in the field — the source-mapping stamp threw inside
 * R3F's commit phase, React tore the tree down, the page went white — and the snapshot's answer was
 * identical to the one a page gives before it has rendered. A diagnosis pass went on telling them
 * apart.
 */
import { describe, expect, it } from 'vitest';
import { SnapshotMode } from '@reticlehq/core';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';

const snapshot = TOOLS.find((t) => t.name === ReticleTool.SNAPSHOT);

const noteFor = async (
  raw: Record<string, unknown>,
  mode: SnapshotMode = SnapshotMode.FULL,
): Promise<string> => {
  const deps = {
    sessions: {
      resolve: () => ({
        id: 's1',
        command: () => Promise.resolve({ ok: true, result: raw }),
      }),
    },
  } as never;
  const out = (await snapshot?.handler(deps, { mode })) as Record<string, unknown> | undefined;
  return 'string' === typeof out?.['note'] ? out['note'] : '';
};

describe('an empty tree over an unmounted app', () => {
  it('says the app is unmounted rather than slow', async () => {
    const note = await noteFor({ tree: '', nodes: 0, domElements: 1 });
    expect(note).toMatch(/unmounted/i);
    expect(note).toMatch(/waiting will not change it/i);
  });

  it('sends the reader to the console, which is where the cause is', async () => {
    expect(await noteFor({ tree: '', nodes: 0, domElements: 1 })).toContain('reticle_console');
  });

  it('stays silent when the page is full of DOM — that is the hidden case, not this one', async () => {
    const note = await noteFor({ tree: '', nodes: 0, domElements: 44, hiddenSkipped: 12 });
    expect(note).not.toMatch(/unmounted/i);
  });

  it('never overrides a more specific note that is already there', async () => {
    const note = await noteFor(
      { tree: '', nodes: 0, domElements: 1, note: 'the leanness explanation' },
      SnapshotMode.INTERACTIVE,
    );
    expect(note).toBe('the leanness explanation');
  });

  it('says nothing when the snapshot actually found something', async () => {
    expect(await noteFor({ tree: 'button "Save"', nodes: 1 })).toBe('');
  });

  it('says nothing on a status read, which never walks', async () => {
    expect(await noteFor({ tree: '', nodes: 0, domElements: 0 }, SnapshotMode.STATUS)).toBe('');
  });
});
