import { describe, expect, it } from 'vitest';
import {
  MAX_SEQUENCES,
  WAIT_AFTER_CLICK_MS,
  actionsOf,
  buildPlan,
  longestRuns,
  planControls,
  refFor,
  sequenceKey,
  stepLabel,
  valuesFor,
  type Sequence,
} from './action-plan.js';

const START = [
  '- heading "Shop"',
  '  - button "Add" (ref=e1) [testid=add]',
  '  - button "Open" (ref=e2)',
  '  - button "Open" (ref=e3)',
  '  - button "Gone" (ref=e4) [disabled]',
  '  - textbox "Name" (ref=e5) [value="Ada"]',
  '  - combobox "Size" (ref=e6)',
  '    - option "Small" (ref=e7)',
  '    - option "Large" (ref=e8)',
].join('\n');

describe('planControls', () => {
  it('targets a control by testid when it has one, else by role and name, numbered by page order', () => {
    const controls = planControls(START);
    expect(controls.map((c) => c.target)).toEqual([
      { testid: 'add', nth: 0 },
      { role: 'button', name: 'Open', nth: 0 },
      { role: 'button', name: 'Open', nth: 1 },
      { role: 'button', name: 'Gone', nth: 0 },
      { role: 'textbox', name: 'Name', nth: 0 },
      { role: 'combobox', name: 'Size', nth: 0 },
    ]);
    expect(controls[3]?.disabled).toBe(true);
    expect(controls[5]?.options).toEqual(['Small', 'Large']);
  });

  it('finds the ref of a numbered target on the live tree', () => {
    expect(refFor(START, { role: 'button', name: 'Open', nth: 1 })).toBe('e3');
    expect(refFor(START, { testid: 'add', nth: 0 })).toBe('e1');
    expect(refFor(START, { role: 'button', name: 'Missing', nth: 0 })).toBeUndefined();
  });

  it('reads a disabled state inside a state group', () => {
    expect(planControls('- checkbox "Agree" (ref=e1) [disabled,checked]')[0]?.disabled).toBe(true);
  });
});

describe('actionsOf', () => {
  it('fills a field with two values chosen by the shape of its value', () => {
    expect(valuesFor('09:30')).toEqual(['09:15', '17:45']);
    expect(valuesFor('2024-01-01')).toEqual(['2024-02-03', '2024-11-28']);
    expect(valuesFor('12')).toEqual(['0', '7']);
    expect(valuesFor('Ada')).toEqual(['', 'Reticle 42']);
  });

  it('selects every option, clicks a button, and does nothing to a disabled control', () => {
    const [, , , gone, name, size] = planControls(START);
    expect(gone === undefined ? [] : actionsOf(gone)).toEqual([]);
    expect(name === undefined ? [] : actionsOf(name).map(stepLabel)).toEqual([
      'fill textbox "Name" with ""',
      'fill textbox "Name" with "Reticle 42"',
    ]);
    expect(size === undefined ? [] : actionsOf(size).map(stepLabel)).toEqual([
      'select "Small" in combobox "Size"',
      'select "Large" in combobox "Size"',
    ]);
  });
});

describe('buildPlan', () => {
  it('plans the start page, every single action, a wait after each click, and each action under each option', async () => {
    const plan = await buildPlan(START, () => Promise.resolve(START));
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels[0]).toBe('');
    expect(labels).toContain(`wait ${String(WAIT_AFTER_CLICK_MS / 1000)} s`);
    expect(labels).toContain('click [testid=add]');
    expect(labels).toContain('click button "Open" #2');
    expect(labels).toContain(`click [testid=add] > wait ${String(WAIT_AFTER_CLICK_MS / 1000)} s`);
    expect(labels).toContain('select "Large" in combobox "Size" > click [testid=add]');
    expect(labels.some((l) => l.includes('Gone'))).toBe(false);
  });

  it('goes one level deeper into the controls an action made appear', async () => {
    const dialog = `${START}\n  - button "Confirm" (ref=e9)`;
    const plan = await buildPlan(START, (seq) =>
      Promise.resolve('click [testid=add]' === seq.map(stepLabel).join() ? dialog : START),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels).toContain('click [testid=add] > click button "Confirm"');
  });

  it('fills every field with its own value, then presses each button, when a page has two fields', async () => {
    const form = [
      '- textbox "Start" (ref=e1) [value="09:00"]',
      '- textbox "End" (ref=e2) [value="10:00"]',
      '- button "Save" (ref=e3)',
    ].join('\n');
    const plan = await buildPlan(form, () => Promise.resolve(form));
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels).toContain(
      'wait 4 s > fill every field (textbox "Start"="09:15", textbox "End"="18:45") > click button "Save"',
    );
  });

  it('stops at the sequence cap', async () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => `- button "B${String(i)}" (ref=e${String(i)})`,
    ).join('\n');
    const plan = await buildPlan(many, () => Promise.resolve(many));
    expect(plan).toHaveLength(MAX_SEQUENCES);
  });

  it('does not go deeper after a probe that could not be done', async () => {
    const plan = await buildPlan(START, () => Promise.resolve(undefined));
    expect(plan.every((seq) => seq.length <= 2)).toBe(true);
  });
});

describe('longestRuns', () => {
  it('keeps only the sequences that are not the start of another planned sequence', () => {
    const a = { action: 'click', target: { testid: 'a', nth: 0 } } as const;
    const b = { action: 'click', target: { testid: 'b', nth: 0 } } as const;
    const plan: Sequence[] = [[], [a], [b], [a, b]];
    expect(longestRuns(plan).map(sequenceKey)).toEqual([[b], [a, b]].map(sequenceKey));
    expect(longestRuns([[]]).map(sequenceKey)).toEqual([sequenceKey([])]);
  });
});
