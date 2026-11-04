import { describe, expect, it } from 'vitest';
import { BehaviourFindingKind } from '@reticlehq/core';
import {
  checkDeterministic,
  checkRepeat,
  checkReloadKeeps,
  checkShownMatchesSent,
  checkUndo,
  failureFindings,
  Invariant,
} from './invariants.js';
import { EdgeAction } from './edge-cases.js';

const SAVE = { action: EdgeAction.CLICK, key: 'button "Save"' };
const UNDO = { action: EdgeAction.CLICK, key: 'button "Undo"' };
const page = (lines: string[], route = '/list') => ({ route, tree: lines.join('\n') });

describe('checkUndo', () => {
  it('passes when undo returns the page it started from, refs and focus aside', () => {
    const before = page(['- listitem "Milk" (ref=e3)', '- button "Delete" (ref=e4)']);
    const after = page(['- listitem "Milk" (ref=e9)', '- button "Delete" (ref=e10) [focused]']);
    expect(checkUndo({ before, after, steps: [SAVE, UNDO] })).toEqual([]);
  });

  it('flags undo that leaves the page changed, with the steps and the source', () => {
    const before = page(['- listitem "Milk" (ref=e3)', '- listitem "Eggs" (ref=e5)']);
    const after = page(['- listitem "Milk" (ref=e3)']);
    const [finding] = checkUndo({
      before,
      after,
      steps: [SAVE, UNDO],
      source: { file: 'src/List.tsx', line: 42 },
    });
    expect(finding?.kind).toBe(BehaviourFindingKind.UNDO_NOT_RESTORED);
    expect(finding?.sequence).toEqual(['click button "Save"', 'click button "Undo"']);
    expect(finding?.source).toBe('src/List.tsx:42');
    expect(finding?.detail).toContain('listitem "Eggs"');
  });
});

describe('checkRepeat', () => {
  const before = page(['- text "0 orders"']);
  const shown = page(['- text "1 order"']);

  it('passes a toggle and a counter: each press shows its own change', () => {
    expect(
      checkRepeat({ before, afterFirst: shown, afterSecond: before, steps: [SAVE, SAVE] }),
    ).toEqual([]);
  });

  it('flags a second press that sends a write which creates something new while the screen stays the same', () => {
    const [finding] = checkRepeat({
      before,
      afterFirst: shown,
      afterSecond: shown,
      steps: [SAVE, SAVE],
      firstWrites: [{ key: 'POST /api/orders', status: 201, response: '{"id":1}' }],
      secondWrites: [{ key: 'POST /api/orders', status: 201, response: '{"id":2}' }],
    });
    expect(finding?.kind).toBe(BehaviourFindingKind.REPEAT_CHANGED_STATE);
    expect(finding?.detail).toContain('POST /api/orders');
  });

  it('passes a repeated save the server answers the same way both times', () => {
    expect(
      checkRepeat({
        before,
        afterFirst: shown,
        afterSecond: shown,
        steps: [SAVE, SAVE],
        firstWrites: [{ key: 'POST /api/settings', status: 200, response: '{"ok":true}' }],
        secondWrites: [{ key: 'POST /api/settings', status: 200, response: '{"ok":true}' }],
      }),
    ).toEqual([]);
  });

  it('flags a second press that changes the page when the first changed nothing', () => {
    const [finding] = checkRepeat({
      before,
      afterFirst: before,
      afterSecond: shown,
      steps: [SAVE, SAVE],
    });
    expect(finding?.kind).toBe(BehaviourFindingKind.REPEAT_CHANGED_STATE);
  });
});

describe('checkReloadKeeps', () => {
  it('passes when the saved value is still shown after reload', () => {
    const after = page(['- textbox "Name" (ref=e1) [value="Zoë"]']);
    expect(checkReloadKeeps({ value: 'Zoë', afterReload: after, steps: [SAVE] })).toEqual([]);
  });

  it('passes when the app says the value was not saved', () => {
    expect(
      checkReloadKeeps({ value: 'Zoë', afterReload: page([]), appSaidNotSaved: true, steps: [] }),
    ).toEqual([]);
  });

  it('flags a saved value that is gone after reload', () => {
    const [finding] = checkReloadKeeps({
      value: 'Zoë',
      afterReload: page(['- textbox "Name" (ref=e1)']),
      steps: [SAVE],
    });
    expect(finding?.kind).toBe(BehaviourFindingKind.LOST_AFTER_RELOAD);
    expect(finding?.sequence.at(-1)).toBe('reload');
  });
});

describe('checkShownMatchesSent', () => {
  it('ignores padding, case and digit grouping', () => {
    expect(
      checkShownMatchesSent({ sent: ' 1000 ', shown: '1,000', field: 'Amount', steps: [] }),
    ).toEqual([]);
    expect(
      checkShownMatchesSent({ sent: 'A@B.io', shown: 'a@b.io', field: 'Email', steps: [] }),
    ).toEqual([]);
  });

  it('flags a shown value that is not the value the write sent', () => {
    const [finding] = checkShownMatchesSent({
      sent: '5',
      shown: '50',
      field: 'Quantity',
      steps: [SAVE],
    });
    expect(finding?.kind).toBe(BehaviourFindingKind.SHOWN_DIFFERS_FROM_SENT);
    expect(finding?.detail).toContain('"5"');
    expect(finding?.detail).toContain('"50"');
  });
});

describe('checkDeterministic', () => {
  it('passes two drives that differ only in numbers such as times and ids', () => {
    const first = page(['- text "Saved 3 seconds ago"']);
    const second = page(['- text "Saved 4 seconds ago"']);
    expect(checkDeterministic({ first, second, steps: [SAVE] })).toEqual([]);
  });

  it('flags two identical drives that show different pages, as intermittent', () => {
    const [finding] = checkDeterministic({
      first: page(['- alert "Saved"']),
      second: page(['- alert "Something went wrong"']),
      steps: [SAVE],
    });
    expect(finding?.kind).toBe(BehaviourFindingKind.INTERMITTENT_RESULT);
    expect(finding?.intermittent).toBe(true);
  });
});

describe('failureFindings', () => {
  it('turns an unhandled failure branch into a finding with the path that fires the write', () => {
    const findings = failureFindings(
      {
        branched: ['POST /api/items'],
        unhandled: [{ key: 'POST /api/items', detail: 'claimed' }],
        indistinguishable: [],
      },
      [
        {
          key: 'POST /api/items',
          method: 'POST',
          urlPath: '/api/items',
          path: [SAVE],
          beforeState: 'a',
          successState: 'b',
        },
      ],
    );
    expect(findings).toEqual([
      {
        kind: BehaviourFindingKind.FAILURE_UNHANDLED,
        invariant: Invariant.FAILURE_HANDLED,
        detail: 'claimed',
        sequence: ['click button "Save"', 'fail POST /api/items'],
      },
    ]);
  });
});
