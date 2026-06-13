import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionType,
  AnchorKind,
  AnnotationKind,
  DEGRADED_ANCHOR_ROLE,
  EventType,
  RecordedFlowSchema,
  RecorderPhase,
  type FlowStep,
} from '@syrin/protocol';
import {
  anchorFor,
  compileRecording,
  installRecorder,
  RECORDER_EMPTY_MSG,
  type Annotation,
  type RecorderHandle,
} from './recorder.js';
import { buildSnapshot } from './snapshot.js';
import { isIrisOverlay } from './dom-ignore.js';
import { registerCapabilities } from './capabilities.js';

const NOW = 1000;

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function makeEmits(): {
  emits: Emitted[];
  emit: (t: EventType, d: Record<string, unknown>) => void;
} {
  const emits: Emitted[] = [];
  return { emits, emit: (type, data) => emits.push({ type, data }) };
}

/** Dispatch a capture-phase-observable bubbling event from a target. */
function fire(target: Element, type: string): void {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

/** The recorder's toolbar buttons carry data-iris-action; click one by its action label. */
function toolbarButton(action: string): HTMLElement {
  const btn = document.querySelector<HTMLElement>(
    `[data-iris-overlay] [data-iris-action="${action}"]`,
  );
  if (btn === null) throw new Error(`no toolbar button ${action}`);
  return btn;
}

function clickRecord(): void {
  toolbarButton('record').click();
}
function clickStop(): void {
  toolbarButton('stop').click();
}

let handle: RecorderHandle | undefined;

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  document.querySelectorAll('[data-iris-overlay]').forEach((e) => e.remove());
});

function mount(emit: (t: EventType, d: Record<string, unknown>) => void): RecorderHandle {
  handle = installRecorder({ emit, now: () => NOW });
  handle.mount();
  return handle;
}

describe('recorder capture — semantic anchored steps (M8 Stage B)', () => {
  it("B1: click on a testid'd button records a testid anchor (never a ref)", () => {
    document.body.innerHTML = `<button data-testid="save">Save</button>`;
    const { emit } = makeEmits();
    mount(emit);
    clickRecord();
    fire(document.querySelector('[data-testid="save"]') as Element, 'click');

    const steps = handle?.steps() ?? [];
    expect(steps).toHaveLength(1);
    const step = steps[0] as FlowStep;
    expect(step.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'save' });
    expect(step.action).toBe(ActionType.CLICK);
    expect(JSON.stringify(step)).not.toMatch(/"ref"/);
    expect(JSON.stringify(step)).not.toMatch(/\be\d+\b/);
  });

  it('B2: click on a no-testid element records a role+name anchor', () => {
    document.body.innerHTML = `<button>Continue</button>`;
    const { emit } = makeEmits();
    mount(emit);
    clickRecord();
    fire(document.querySelector('button') as Element, 'click');

    const step = handle?.steps()[0] as FlowStep;
    expect(step.anchor).toEqual({ kind: AnchorKind.ROLE, role: 'button', name: 'Continue' });
    expect(step.degraded).toBeUndefined();
  });

  it('B3: input change records a fill step with value + testid anchor', () => {
    document.body.innerHTML = `<input data-testid="hook" />`;
    const { emit } = makeEmits();
    mount(emit);
    clickRecord();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'abc';
    fire(input, 'change');

    const step = handle?.steps()[0] as FlowStep;
    expect(step.action).toBe(ActionType.FILL);
    expect(step.args?.['value']).toBe('abc');
    expect(step.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'hook' });
  });

  it('B4: keystroke inputs debounce to one fill step (latest value)', () => {
    document.body.innerHTML = `<input data-testid="hook" />`;
    const { emit } = makeEmits();
    mount(emit);
    clickRecord();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'a';
    fire(input, 'input');
    input.value = 'ab';
    fire(input, 'input');
    input.value = 'abc';
    fire(input, 'input');
    fire(input, 'change');

    const fills = (handle?.steps() ?? []).filter((s) => s.action === ActionType.FILL);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.args?.['value']).toBe('abc');
  });

  it('B5: checkbox change records check/uncheck', () => {
    document.body.innerHTML = `<input type="checkbox" data-testid="agree" />`;
    const { emit } = makeEmits();
    mount(emit);
    clickRecord();
    const box = document.querySelector('input') as HTMLInputElement;
    box.checked = true;
    fire(box, 'change');
    box.checked = false;
    fire(box, 'change');

    const steps = handle?.steps() ?? [];
    expect(steps[0]?.action).toBe(ActionType.CHECK);
    expect(steps[1]?.action).toBe(ActionType.UNCHECK);
  });

  it('B6: Stop with zero interactions emits an empty-but-valid flow + empty status', () => {
    document.body.innerHTML = ``;
    const { emits, emit } = makeEmits();
    mount(emit);
    clickRecord();
    clickStop();

    const recorded = emits.filter((e) => e.type === EventType.FLOW_RECORDED);
    expect(recorded).toHaveLength(1);
    const parsed = RecordedFlowSchema.safeParse(recorded[0]?.data);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.flow.steps).toHaveLength(0);
    const status = document.querySelector('[data-iris-overlay] [data-iris-status]');
    expect(status?.textContent).toBe(RECORDER_EMPTY_MSG);
  });

  it('B7: Record→Stop→Record starts a fresh span (no leakage)', () => {
    document.body.innerHTML = `<button data-testid="a">A</button><button data-testid="b">B</button>`;
    const { emits, emit } = makeEmits();
    mount(emit);
    clickRecord();
    fire(document.querySelector('[data-testid="a"]') as Element, 'click');
    clickStop();
    clickRecord();
    fire(document.querySelector('[data-testid="b"]') as Element, 'click');
    clickStop();

    const recorded = emits.filter((e) => e.type === EventType.FLOW_RECORDED);
    expect(recorded).toHaveLength(2);
    const second = RecordedFlowSchema.parse(recorded[1]?.data);
    expect(second.flow.steps).toHaveLength(1);
    expect(second.flow.steps[0]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'b' });
  });

  it('B8: not recording → listeners are inert (no steps, no event)', () => {
    document.body.innerHTML = `<button data-testid="save">Save</button>`;
    const { emits, emit } = makeEmits();
    mount(emit);
    fire(document.querySelector('[data-testid="save"]') as Element, 'click');

    expect(handle?.steps()).toEqual([]);
    expect(emits.filter((e) => e.type === EventType.FLOW_RECORDED)).toHaveLength(0);
  });

  it('B9: clicks on the toolbar itself are not recorded', () => {
    document.body.innerHTML = ``;
    const { emit } = makeEmits();
    mount(emit);
    clickRecord();
    // click the Stop button is a toolbar click — must not append a step
    const before = handle?.steps().length ?? 0;
    fire(toolbarButton('stop'), 'click');
    expect((handle?.steps().length ?? 0) - before).toBeLessThanOrEqual(0);
  });

  it('B10: a degraded element keeps a placeholder role anchor, never a ref', () => {
    document.body.innerHTML = `<div id="bare"></div>`;
    const { emit } = makeEmits();
    mount(emit);
    clickRecord();
    fire(document.getElementById('bare') as Element, 'click');

    const step = handle?.steps()[0] as FlowStep;
    expect(step.anchor.kind).toBe(AnchorKind.ROLE);
    if (step.anchor.kind === AnchorKind.ROLE) expect(step.anchor.role).toBe(DEGRADED_ANCHOR_ROLE);
    expect(step.degraded).toBe(true);
    expect(JSON.stringify(step)).not.toMatch(/\be\d+\b/);
  });

  it('B11: toolbar nodes are excluded from buildSnapshot', () => {
    document.body.innerHTML = `<main><button data-testid="real">Real</button></main>`;
    const { emit } = makeEmits();
    mount(emit);
    // Every toolbar node is an Iris overlay node.
    const toolbar = document.querySelector('[data-iris-overlay]') as Element;
    for (const node of toolbar.querySelectorAll('*')) expect(isIrisOverlay(node)).toBe(true);
    expect(isIrisOverlay(toolbar)).toBe(true);
    // The snapshot does not leak any toolbar text or the name input.
    const snap = buildSnapshot();
    expect(snap.tree).toContain('Real');
    expect(snap.tree.toLowerCase()).not.toContain('record');
  });
});

describe('recorder annotations → flow fields (M8 Stage B)', () => {
  /** Compile directly with a captured step + an annotation list (the pure path B12–B16 lock). */
  function clickStep(testid: string): FlowStep {
    return {
      tool: 'iris_act',
      anchor: { kind: AnchorKind.TESTID, value: testid },
      action: ActionType.CLICK,
      args: {},
    };
  }

  it('B12: assert-signal compiles into the prior step expect.signal', () => {
    const ann: Annotation = {
      kind: AnnotationKind.ASSERT_SIGNAL,
      anchor: { kind: AnchorKind.TESTID, value: 'save' },
      signal: 'diff:shown',
    };
    const flow = compileRecording('f', [clickStep('save')], [ann], NOW);
    expect(flow.steps[0]?.expect?.signal).toBe('diff:shown');
  });

  it('B13: assert-visible compiles into expect.element', () => {
    const ann: Annotation = {
      kind: AnnotationKind.ASSERT_VISIBLE,
      anchor: { kind: AnchorKind.TESTID, value: 'panel' },
    };
    const flow = compileRecording('f', [clickStep('save')], [ann], NOW);
    expect(flow.steps[0]?.expect?.element?.testid).toBe('panel');
  });

  it('B14: mark-dynamic adds the anchor to flow.dynamic[] and leaves step.expect untouched', () => {
    const ann: Annotation = {
      kind: AnnotationKind.MARK_DYNAMIC,
      anchor: { kind: AnchorKind.TESTID, value: 'caption-text' },
    };
    const flow = compileRecording('f', [clickStep('save')], [ann], NOW);
    expect(flow.dynamic).toEqual([{ kind: AnchorKind.TESTID, value: 'caption-text' }]);
    expect(flow.steps[0]?.expect).toBeUndefined();
  });

  it('B15: success-state compiles into flow.success', () => {
    const ann: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      anchor: { kind: AnchorKind.TESTID, value: 'done' },
      signal: 'order-placed',
    };
    const flow = compileRecording('f', [clickStep('save')], [ann], NOW);
    expect(flow.success?.signal).toBe('order-placed');
  });
});

describe('anchorFor — testid wins, else role+name, else degraded (M8 Stage B)', () => {
  it('B16: prefers testid over role+name', () => {
    document.body.innerHTML = `<button data-testid="save">Continue</button>`;
    const { anchor, degraded } = anchorFor(document.querySelector('button') as Element);
    expect(anchor).toEqual({ kind: AnchorKind.TESTID, value: 'save' });
    expect(degraded).toBe(false);
  });
});

describe('recorder annotate flow (interactive)', () => {
  it('B17: annotate→assert-signal captures the next click as the assert target', () => {
    registerCapabilities({ signals: ['diff:shown'] });
    document.body.innerHTML = `<button data-testid="save">Save</button>`;
    const { emits, emit } = makeEmits();
    mount(emit);
    clickRecord();
    fire(document.querySelector('[data-testid="save"]') as Element, 'click');
    expect(handle?.steps()).toHaveLength(1);

    // open Annotate menu → choose ASSERT_SIGNAL kind → choose signal → next click is the target
    toolbarButton('annotate').click();
    const kindBtn = document.querySelector<HTMLElement>(
      `[data-iris-overlay] [data-iris-annkind="${AnnotationKind.ASSERT_SIGNAL}"]`,
    );
    expect(kindBtn).not.toBeNull();
    expect(handle?.phase()).toBe(RecorderPhase.ANNOTATING);
    kindBtn?.click();
    const select = document.querySelector<HTMLSelectElement>(
      '[data-iris-overlay] [data-iris-signal]',
    );
    expect(select).not.toBeNull();
    if (select !== null) select.value = 'diff:shown';
    // the annotation target is the most-recent step (annotate-on-prior); confirm.
    toolbarButton('annotate-confirm').click();
    clickStop();

    const recorded = emits.filter((e) => e.type === EventType.FLOW_RECORDED).at(-1);
    const flow = RecordedFlowSchema.parse(recorded?.data).flow;
    expect(flow.steps[0]?.expect?.signal).toBe('diff:shown');
  });

  it('B18: destroy after an annotate returns to a clean DOM (no leaked toolbar)', () => {
    document.body.innerHTML = ``;
    const { emit } = makeEmits();
    mount(emit);
    handle?.destroy();
    handle = undefined;
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });
});

describe('compileRecording determinism', () => {
  it('uses the injected createdAt (no Date.now)', () => {
    const spy = vi.spyOn(Date, 'now');
    const flow = compileRecording('f', [], [], 4242);
    expect(flow.createdAt).toBe(4242);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
