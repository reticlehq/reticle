import { describe, expect, it } from 'vitest';
import { buildDictionary } from './outside/value-dictionary.js';
import {
  EDGE_TEXT,
  MAX_CHAIN,
  MAX_SEQUENCES,
  MAX_TEXT_PROBES,
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

const busy = (tree: string | undefined) => () =>
  Promise.resolve(tree === undefined ? undefined : { tree, active: true });

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
  it('fills a field with two values chosen by the shape of its value, and one edge value', () => {
    expect(valuesFor('09:30')).toEqual(['09:15', '17:45', '23:59']);
    expect(valuesFor('2024-01-01')).toEqual(['2024-02-03', '2024-11-28', '2024-02-29']);
    expect(valuesFor('12')).toEqual(['0', '7', '-1']);
    expect(valuesFor('Ada')).toEqual(['', 'Reticle 42', EDGE_TEXT]);
    expect(EDGE_TEXT).toBe(`${'W'.repeat(120)} <b>&amp;</b> "q" ✓`);
  });

  it('also fills a field with the values the app compares its name with', () => {
    const route = planControls('- textbox "Route" (ref=e1)')[0];
    const dict = buildDictionary([['route', 'progress']]);
    expect(route === undefined ? [] : actionsOf(route, dict).map(stepLabel)).toContain(
      'fill textbox "Route" with "progress"',
    );
  });

  it('selects every option, clicks a button, and does nothing to a disabled control', () => {
    const [, , , gone, name, size] = planControls(START);
    expect(gone === undefined ? [] : actionsOf(gone)).toEqual([]);
    expect(name === undefined ? [] : actionsOf(name).map(stepLabel)).toEqual([
      'fill textbox "Name" with ""',
      'fill textbox "Name" with "Reticle 42"',
      `fill textbox "Name" with "${EDGE_TEXT}"`,
    ]);
    expect(size === undefined ? [] : actionsOf(size).map(stepLabel)).toEqual([
      'select "Small" in combobox "Size"',
      'select "Large" in combobox "Size"',
    ]);
  });
});

describe('buildPlan', () => {
  it('plans the start page, every single action, a wait after each click, and each action under each option', async () => {
    const { sequences: plan } = await buildPlan(START, busy(START));
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
    const { sequences: plan } = await buildPlan(START, (seq) =>
      Promise.resolve({
        tree: 'click [testid=add]' === seq.map(stepLabel).join() ? dialog : START,
        active: true,
      }),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels).toContain('click [testid=add] > click button "Confirm"');
  });

  it('goes deeper only into what the last action made appear, not into what was already there', async () => {
    const login = '- button "Log in" (ref=e1)';
    const home = '- button "Compose" (ref=e2)\n- button "Settings" (ref=e3)';
    const compose = `${home}\n- button "Generate" (ref=e4)`;
    const trees: Record<string, string> = {
      'click button "Log in"': home,
      'click button "Log in",click button "Compose"': compose,
    };
    const { sequences: plan } = await buildPlan(login, (seq) =>
      Promise.resolve({ tree: trees[seq.map(stepLabel).join()] ?? home, active: true }),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels).toContain(
      'click button "Log in" > click button "Compose" > click button "Generate"',
    );
    expect(labels).not.toContain(
      'click button "Log in" > click button "Compose" > click button "Settings"',
    );
  });

  it('follows a form past depth 3 while each press brings new fields, up to a chain limit', async () => {
    const login = [
      '- textbox "Email" (ref=e1)',
      '- textbox "Password" (ref=e2)',
      '- button "Log in" (ref=e3)',
    ].join('\n');
    const deployForm = '- textbox "Service" (ref=e4)\n- button "Deploy" (ref=e5) [disabled]';
    const regionForm = '- textbox "Region" (ref=e6)\n- button "Confirm" (ref=e7) [disabled]';
    const tree = (seq: Sequence): string => {
      const labels = seq.map(stepLabel);
      const pressed = (b: string): boolean =>
        labels.some(
          (l, i) =>
            l === `click button "${b}"` && true === labels[i - 1]?.startsWith('fill every field'),
        );
      if (pressed('Deploy')) {
        return regionForm;
      }
      return pressed('Log in') ? deployForm : login;
    };
    const { sequences: plan } = await buildPlan(login, (seq) =>
      Promise.resolve({ tree: tree(seq), active: true }),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    const chain = labels.find((l) => l.endsWith('> click button "Confirm"'));
    expect(chain, 'the third form step is planned').toBeDefined();
    expect(chain?.split(' > ').length).toBeGreaterThan(3);
    expect(chain).toContain('fill every field (textbox "Service"=');
    expect(plan.every((seq) => seq.length <= MAX_CHAIN)).toBe(true);
  });

  it('plans the submit of a form step before presses of the buttons that were already there', async () => {
    const login =
      '- textbox "Email" (ref=e1)\n- textbox "Password" (ref=e2)\n- button "Log in" (ref=e3)';
    const nav = '- button "Home" (ref=e4)\n- button "Reports" (ref=e5)';
    const home = `${nav}\n- textbox "Search" (ref=e6)\n- button "New" (ref=e7)`;
    const dialog = `${home}\n- textbox "Name" (ref=e8)\n- button "Submit" (ref=e9) [disabled]`;
    const tree = (seq: Sequence): string => {
      const labels = seq.map(stepLabel);
      if (labels.includes('click button "New"')) {
        return dialog;
      }
      return labels.includes('click button "Log in"') ? home : login;
    };
    const { sequences: plan } = await buildPlan(login, (seq) =>
      Promise.resolve({ tree: tree(seq), active: true }),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    const inDialog = (button: string): number =>
      labels.findIndex(
        (l) =>
          l.includes('click button "New" > fill every field') &&
          l.endsWith(`click button "${button}"`),
      );
    expect(inDialog('Submit')).toBeGreaterThanOrEqual(0);
    expect(inDialog('Home') < 0 || inDialog('Submit') < inDialog('Home')).toBe(true);
  });

  it('plans the submit of a form that opens on a busy page before the cap runs out', async () => {
    const busyPage = [
      ...Array.from({ length: 150 }, (_, i) => `- button "B${String(i)}" (ref=b${String(i)})`),
      '- button "Open form" (ref=e1)',
    ].join('\n');
    const form = `${busyPage}\n- textbox "Name" (ref=e2)\n- textbox "Mail" (ref=e3)\n- button "Submit" (ref=e4) [disabled]`;
    const { sequences: plan } = await buildPlan(busyPage, (seq) =>
      Promise.resolve({
        tree: seq.map(stepLabel).includes('click button "Open form"') ? form : busyPage,
        active: true,
      }),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels.some((l) => l.endsWith('> click button "Submit"'))).toBe(true);
  });

  it('presses a button that is disabled until the fields are filled, after filling them', async () => {
    const form = [
      '- textbox "Title" (ref=e1)',
      '- textbox "Prompt" (ref=e2)',
      '- button "Generate" (ref=e3) [disabled]',
    ].join('\n');
    const { sequences: plan } = await buildPlan(form, busy(form));
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels.some((l) => l.endsWith('> click button "Generate"'))).toBe(true);
  });

  it('fills every field with its own value, then presses each button, when a page has two fields', async () => {
    const form = [
      '- textbox "Start" (ref=e1) [value="09:00"]',
      '- textbox "End" (ref=e2) [value="10:00"]',
      '- button "Save" (ref=e3)',
    ].join('\n');
    const { sequences: plan } = await buildPlan(form, busy(form));
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels).toContain(
      'wait 4 s > fill every field (textbox "Start"="09:15", textbox "End"="18:45") > click button "Save"',
    );
  });

  it('keeps a wait after a click only when the reference showed delayed activity there', async () => {
    const { sequences: plan } = await buildPlan(START, (seq) =>
      Promise.resolve({
        tree: START,
        active: 'click [testid=add],wait 4 s' === seq.map(stepLabel).join(),
      }),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels).toContain('click [testid=add] > wait 4 s');
    expect(labels).not.toContain('click button "Open" > wait 4 s');
    expect(labels).not.toContain('wait 4 s');
  });

  it('fills every field with the value the app compares it with first', async () => {
    const form = '- textbox "Route" (ref=e1)\n- textbox "Note" (ref=e2)';
    const { sequences: plan } = await buildPlan(
      form,
      busy(form),
      buildDictionary([['route', 'progress']]),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(
      labels.some((l) =>
        l.includes('fill every field (textbox "Route"="progress", textbox "Note"='),
      ),
    ).toBe(true);
  });

  it('stops at the sequence cap', async () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => `- button "B${String(i)}" (ref=e${String(i)})`,
    ).join('\n');
    const { sequences: plan, dropped } = await buildPlan(many, busy(many));
    expect(plan).toHaveLength(MAX_SEQUENCES);
    expect(dropped.sequences).toBeGreaterThan(0);
  });

  it('clicks visible text with no control role, and keeps it only when the screen changes', async () => {
    const page = [
      '- text "Details"',
      '- generic "Row one" (ref=e1)',
      '- text "Details"',
      '- text "Static note"',
    ].join('\n');
    const opened = `${page}\n- heading "More"`;
    const { sequences: plan } = await buildPlan(page, (seq) =>
      Promise.resolve({
        tree: 'click text "Details"' === seq.map(stepLabel).join() ? opened : page,
        active: true,
      }),
    );
    const labels = plan.map((seq) => seq.map(stepLabel).join(' > '));
    expect(labels).toContain('click text "Details"');
    expect(labels).not.toContain('click text "Row one"');
    expect(labels).not.toContain('click text "Static note"');
    expect(labels.filter((l) => 'click text "Details"' === l)).toHaveLength(1);
  });

  it('clicks at most MAX_TEXT_PROBES distinct texts, and reports the rest', async () => {
    const many = Array.from({ length: MAX_TEXT_PROBES + 5 }, (_, i) => `- text "T${String(i)}"`);
    const page = many.join('\n');
    const { sequences: plan, dropped } = await buildPlan(page, (seq) =>
      Promise.resolve({ tree: `${page}\n- text "${seq.map(stepLabel).join()}"`, active: false }),
    );
    expect(plan.filter((seq) => 1 === seq.length)).toHaveLength(MAX_TEXT_PROBES);
    expect(dropped.textProbes).toBe(5);
  });

  it('does not go deeper after a probe that could not be done', async () => {
    const { sequences: plan } = await buildPlan(START, busy(undefined));
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
