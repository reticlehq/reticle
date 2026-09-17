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
  events?: { type: string; data?: Record<string, unknown> }[],
): Promise<string> => {
  const deps = {
    sessions: {
      resolve: () => ({
        id: 's1',
        command: () => Promise.resolve({ ok: true, result: raw }),
        // Only present when a test supplies a buffer, so the sessions that cannot answer for
        // theirs go down the same path a real one without `eventsSince` would.
        ...(events === undefined ? {} : { eventsSince: () => events }),
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

/**
 * An unmounted root has two readings — "has not started" and "started and threw" — and they want
 * opposite next moves. The count of DOM elements settles that it is unmounted and cannot settle
 * which; the session's own error buffer usually can, and the server is already holding it (#899).
 */
describe('an unmounted root with uncaught errors beside it', () => {
  const EMPTY = { tree: '', nodes: 0, domElements: 1 };
  const crash = [
    {
      type: 'error.uncaught',
      data: { message: 'Rendered more hooks than during the previous render' },
    },
    { type: 'error.uncaught', data: { message: 'The above error occurred in <Payables>' } },
  ];

  it('says the app CRASHED, not merely that it is unmounted', async () => {
    const note = await noteFor(EMPTY, SnapshotMode.FULL, crash);
    expect(note).toMatch(/CRASHED/);
    expect(note).toContain('2 uncaught error(s)');
  });

  it('quotes the first error, so the cause arrives with the symptom', async () => {
    const note = await noteFor(EMPTY, SnapshotMode.FULL, crash);
    expect(note).toContain('Rendered more hooks than during the previous render');
  });

  it('does not tell the reader to load the app again — that reproduces it', async () => {
    const note = await noteFor(EMPTY, SnapshotMode.FULL, crash);
    expect(note).not.toMatch(/has genuinely not started yet/);
    expect(note).toMatch(/reproduce it rather than fix it/);
  });

  it('counts console errors too, which is where a framework logs its own teardown', async () => {
    const note = await noteFor(EMPTY, SnapshotMode.FULL, [
      { type: 'console.error', data: { message: 'Uncaught Error: boom' } },
    ]);
    expect(note).toContain('1 uncaught error(s)');
    expect(note).toContain('Uncaught Error: boom');
  });

  it('ignores events that are not errors', async () => {
    const note = await noteFor(EMPTY, SnapshotMode.FULL, [
      { type: 'console.log', data: { message: 'hello' } },
      { type: 'dom.added', data: {} },
    ]);
    expect(note).not.toMatch(/CRASHED/);
    expect(note).toMatch(/has genuinely not started yet/);
  });

  it('keeps the unmounted note when the session cannot answer for its buffer', async () => {
    const note = await noteFor(EMPTY);
    expect(note).toMatch(/unmounted/i);
    expect(note).not.toMatch(/CRASHED/);
  });

  it('stays out of the way when the tree is not empty', async () => {
    expect(await noteFor({ tree: 'button "Save"', nodes: 1 }, SnapshotMode.FULL, crash)).toBe('');
  });

  it('still defers to a more specific note that is already there', async () => {
    const note = await noteFor(
      { ...EMPTY, note: 'the leanness explanation' },
      SnapshotMode.INTERACTIVE,
      crash,
    );
    expect(note).toBe('the leanness explanation');
  });
});
