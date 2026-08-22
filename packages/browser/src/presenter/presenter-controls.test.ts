import { describe, it, expect, vi, afterEach } from 'vitest';
import { HumanControlKind, PresenterTone, SessionState } from '@reticlehq/core';
import { Presenter, type ControlIntent } from './presenter.js';
import { CONTROLS_CSS } from './presenter-controls.js';
import { buildSnapshot } from '../dom/snapshot.js';
import { isIgnored } from '../dom/dom-ignore.js';
import { Annotator } from '../review/annotator.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const click = (el: Element | null | undefined): void => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);

interface Mounted {
  presenter: Presenter;
  onControl: ReturnType<typeof vi.fn>;
  root: HTMLElement;
}

function mount(opts: { endedFadeMs?: number } = {}): Mounted {
  const onControl = vi.fn<(intent: ControlIntent) => void>();
  let t = 0;
  const presenter = new Presenter({
    paceMs: 0,
    onControl,
    now: () => (t += 1),
    ...(opts.endedFadeMs !== undefined ? { endedFadeMs: opts.endedFadeMs } : {}),
  });
  presenter.mount();
  presenter.sessionStart();
  const root = q('[data-reticle-overlay]') as HTMLElement;
  return { presenter, onControl, root };
}

afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((e) => e.remove());
  document.body.innerHTML = '';
});

const pauseBtn = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-reticle-pause]');
const endBtn = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-reticle-end]');
const sendBtn = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-reticle-send]');
const input = (): HTMLInputElement | null => q<HTMLInputElement>('[data-reticle-input]');
const stateAttr = (): string | null =>
  q('[data-reticle-overlay][data-reticle-state]')?.getAttribute('data-reticle-state') ?? null;
const logTexts = (): (string | null)[] =>
  Array.from(document.querySelectorAll('[data-reticle-log] .reticle-log-text')).map(
    (e) => e.textContent,
  );

describe('presenter-controls / live-control panel', () => {
  it('1 pause click emits {kind:pause} and enters paused', () => {
    const { presenter, onControl } = mount();
    click(pauseBtn());
    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onControl).toHaveBeenCalledWith({ kind: HumanControlKind.PAUSE });
    expect(stateAttr()).toBe('paused');
    expect(presenter.state).toBe(SessionState.PAUSED);
  });

  it('2 paused panel shows PAUSED badge', () => {
    mount();
    click(pauseBtn());
    const badge = q('[data-reticle-badge]');
    expect(badge).not.toBeNull();
    expect(stateAttr()).toBe('paused');
    expect(badge?.textContent).toBe('PAUSED');
  });

  it('3 resume click emits {kind:resume} and returns to active', () => {
    const { presenter, onControl } = mount();
    click(pauseBtn());
    click(pauseBtn());
    expect(onControl).toHaveBeenLastCalledWith({ kind: HumanControlKind.RESUME });
    expect(stateAttr()).toBe('active');
    expect(presenter.state).toBe(SessionState.ACTIVE);
    expect(pauseBtn()?.getAttribute('aria-label')).toBe('Pause');
  });

  it('3b pause and resume use different icons (play vs pause)', () => {
    mount();
    const pauseLabel = (): string | null => pauseBtn()?.getAttribute('aria-label') ?? null;
    expect(pauseLabel()).toBe('Pause');
    expect(pauseBtn()?.querySelectorAll('.reticle-hi-icon')).toHaveLength(1);
    click(pauseBtn());
    expect(pauseLabel()).toBe('Resume');
    click(pauseBtn());
    expect(pauseLabel()).toBe('Pause');
    expect(pauseBtn()?.querySelectorAll('.reticle-hi-icon')).toHaveLength(1);
  });

  it('4 pause button label flips to Resume when paused, back when active', () => {
    mount();
    click(pauseBtn());
    expect(pauseBtn()?.getAttribute('aria-label')).toBe('Resume');
    click(pauseBtn());
    expect(pauseBtn()?.getAttribute('aria-label')).toBe('Pause');
  });

  it('5 send with text emits message, appends human row, clears input', () => {
    const { onControl } = mount();
    const i = input();
    if (null === i) throw new Error('no input');
    i.value = 'try the dark theme';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    click(sendBtn());
    expect(onControl).toHaveBeenCalledWith({
      kind: HumanControlKind.MESSAGE,
      text: 'try the dark theme',
    });
    expect(logTexts().some((t) => 'try the dark theme' === t)).toBe(true);
    expect(q('[data-kind="human"]')).not.toBeNull();
    expect(i.value).toBe('');
  });

  it('6 Enter key in input sends', () => {
    const { onControl } = mount();
    const i = input();
    if (null === i) throw new Error('no input');
    i.value = 'press enter';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onControl).toHaveBeenCalledWith({
      kind: HumanControlKind.MESSAGE,
      text: 'press enter',
    });
    expect(i.value).toBe('');
  });

  it('7 send with empty input emits nothing', () => {
    const { onControl } = mount();
    const before = logTexts().length;
    click(sendBtn());
    expect(onControl).not.toHaveBeenCalled();
    expect(logTexts().length).toBe(before);
  });

  it('8 send with whitespace-only emits nothing and appends no human row', () => {
    const { onControl } = mount();
    const i = input();
    if (null === i) throw new Error('no input');
    i.value = '   ';
    click(sendBtn());
    expect(onControl).not.toHaveBeenCalled();
    expect(q('[data-kind="human"]')).toBeNull();
  });

  it('9 end click emits {kind:end}, enters ended, shows banner', () => {
    const { onControl } = mount();
    click(endBtn());
    expect(onControl).toHaveBeenCalledWith({ kind: HumanControlKind.END });
    expect(stateAttr()).toBe('ended');
    const banner = q('[data-reticle-banner]');
    expect(banner?.textContent).toBe('Session ended');
  });

  it('10 ended disables all controls', () => {
    mount();
    click(endBtn());
    expect(pauseBtn()?.disabled).toBe(true);
    expect(endBtn()?.disabled).toBe(true);
    expect(sendBtn()?.disabled).toBe(true);
    expect(input()?.disabled).toBe(true);
  });

  it('11 clicking pause/end/send after ended emits nothing more', () => {
    const { onControl } = mount();
    click(endBtn());
    const count = onControl.mock.calls.length;
    click(pauseBtn());
    click(endBtn());
    const i = input();
    if (i !== null) i.value = 'x';
    click(sendBtn());
    expect(onControl.mock.calls.length).toBe(count);
  });

  it('12 ending fades the page border but KEEPS the panel for analysis (+ export row)', async () => {
    mount({ endedFadeMs: 5 });
    click(endBtn());
    expect(q('[data-reticle-hud]')?.getAttribute('data-on')).toBe('1');
    await wait(20);
    await flush();
    expect(q('[data-reticle-glow]')?.getAttribute('data-on')).toBe('0'); // border cleared (testing over)
    expect(q('[data-reticle-hud]')?.getAttribute('data-on')).toBe('1'); // panel PERSISTS for analysis
    expect(stateAttr()).toBe('ended'); // → CSS reveals the Copy/Export row
    expect(q('[data-reticle-copy]')).not.toBeNull();
    expect(q('[data-reticle-export]')).not.toBeNull();
  });

  it('13 setState(paused) updates panel without emitting (server push)', () => {
    const { presenter, onControl } = mount();
    presenter.setState(SessionState.PAUSED);
    expect(stateAttr()).toBe('paused');
    expect(q('[data-reticle-badge]')?.textContent).toBe('PAUSED');
    expect(onControl).not.toHaveBeenCalled();
  });

  it('14 setState(ended, summary) leads with "Session ended" and appends the summary', () => {
    const { presenter, onControl } = mount();
    presenter.setState(SessionState.ENDED, 'all green');
    expect(q('[data-reticle-banner]')?.textContent).toBe('Session ended · all green');
    expect(onControl).not.toHaveBeenCalled();
  });

  it('14b warn tone (agent stopped) sets data-reticle-tone and leads the banner with the notice', () => {
    const { presenter } = mount();
    const panelRoot = q('div[data-reticle-overlay]') as HTMLElement; // the <div>, not the <style>
    presenter.setState(
      SessionState.ENDED,
      'Agent stopped - switch to your terminal',
      PresenterTone.WARN,
    );
    expect(panelRoot.getAttribute('data-reticle-tone')).toBe('warn');
    // warn drops the calm "Session ended ·" prefix - the notice itself is the actionable headline
    expect(q('[data-reticle-banner]')?.textContent).toBe('Agent stopped - switch to your terminal');
  });

  it('14c a calm end clears any prior warn tone', () => {
    const { presenter } = mount();
    const panelRoot = q('div[data-reticle-overlay]') as HTMLElement;
    presenter.setState(SessionState.ENDED, 'Agent stopped', PresenterTone.WARN);
    expect(panelRoot.getAttribute('data-reticle-tone')).toBe('warn');
    presenter.setState(SessionState.ACTIVE);
    expect(panelRoot.hasAttribute('data-reticle-tone')).toBe(false);
  });

  it('14d waiting and ask tones each set their own data-reticle-tone', () => {
    const { presenter } = mount();
    const panelRoot = q('div[data-reticle-overlay]') as HTMLElement;
    presenter.setState(SessionState.ENDED, 'your turn', PresenterTone.WAITING);
    expect(panelRoot.getAttribute('data-reticle-tone')).toBe('waiting');
    expect(q('[data-reticle-banner]')?.textContent).toBe('your turn');
    presenter.setState(SessionState.ENDED, 'Use Stripe?', PresenterTone.ASK);
    expect(panelRoot.getAttribute('data-reticle-tone')).toBe('ask');
  });

  const pushFlows = (presenter: Presenter, flows: { name: string }[]): void =>
    presenter.handlePush({ name: 'flows', args: { flows } });

  it('14e a FLOWS push renders ▶ chips; a click replays that flow (no agent)', () => {
    const { presenter, onControl } = mount();
    pushFlows(presenter, [{ name: 'checkout' }, { name: 'login' }]);
    const flows = q('[data-reticle-flows]');
    expect(flows?.getAttribute('data-has')).toBe('1');
    const chips = document.querySelectorAll<HTMLElement>('[data-reticle-replay]');
    expect(chips.length).toBe(2);
    expect(chips[0]?.textContent).toBe('▶ checkout');
    click(chips[0]);
    expect(onControl).toHaveBeenCalledWith({ kind: HumanControlKind.REPLAY, text: 'checkout' });
  });

  it('14f a FLOWS push with no flows hides the row and rebuilds cleanly', () => {
    const { presenter } = mount();
    pushFlows(presenter, [{ name: 'a' }, { name: 'b' }]);
    expect(document.querySelectorAll('[data-reticle-replay]').length).toBe(2);
    pushFlows(presenter, []); // a re-push replaces, never appends
    expect(document.querySelectorAll('[data-reticle-replay]').length).toBe(0);
    expect(q('[data-reticle-flows]')?.getAttribute('data-has')).toBe('0');
  });

  it('14g the flows row is height-capped + self-scrolling so a long list never hides the log/input', () => {
    // Regression: without flex:none + max-height + overflow-y, a long replay list grows and pushes the
    // composer (message input) past the panel's overflow:hidden clip, and squeezes the log to nothing.
    const start = CONTROLS_CSS.indexOf('.reticle-flows{');
    const rule = CONTROLS_CSS.slice(start, CONTROLS_CSS.indexOf('}', start));
    expect(rule).toContain('flex:none');
    expect(rule).toContain('max-height:');
    expect(rule).toContain('overflow-y:auto');
  });

  it('14h shows only flows whose start testid is present on the page; re-scopes on route change', () => {
    const { presenter } = mount();
    const host = document.createElement('div');
    host.innerHTML = '<button data-testid="task-input"></button>'; // this page has only task-input
    document.body.appendChild(host);

    presenter.handlePush({
      name: 'flows',
      args: {
        flows: [
          { name: 'add-task', start: 'task-input' }, // starts here → shown
          { name: 'checkout', start: 'pay-button' }, // starts elsewhere → hidden
          { name: 'global-search' }, // no start hint → always shown
        ],
      },
    });
    const shown = (): string[] =>
      Array.from(document.querySelectorAll('[data-reticle-replay]'))
        .map((b) => b.getAttribute('data-reticle-replay') ?? '')
        .sort();
    expect(shown()).toEqual(['add-task', 'global-search']);

    // navigate to checkout: pay-button appears, task-input goes away → list re-scopes
    host.innerHTML = '<button data-testid="pay-button"></button>';
    presenter.refilterFlows();
    expect(shown()).toEqual(['checkout', 'global-search']);
  });

  it('15 setState is idempotent', () => {
    const { presenter } = mount();
    presenter.setState(SessionState.PAUSED);
    presenter.setState(SessionState.PAUSED);
    expect(
      document.querySelectorAll('[data-reticle-overlay][data-reticle-state="paused"]').length,
    ).toBe(1);
    expect(q('[data-reticle-badge]')?.textContent).toBe('PAUSED');
  });

  it('16 all control nodes are data-reticle-* excluded from snapshot', () => {
    mount();
    for (const sel of [
      '[data-reticle-pause]',
      '[data-reticle-end]',
      '[data-reticle-input]',
      '[data-reticle-send]',
      '[data-reticle-badge]',
      '[data-reticle-banner]',
    ]) {
      const el = q(sel);
      expect(el).not.toBeNull();
      expect(isIgnored(el as Element)).toBe(true);
    }
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).not.toContain('Tell the agent something');
    expect(snap.tree).not.toContain('PAUSED');
    expect(snap.tree).not.toContain('Session ended');
    expect(snap.tree).not.toContain('reticle-brand-mini');
  });

  // Pause and End are instructions to the AGENT. Annotation is the person's own channel, so it
  // outlives both - a note is most often written about what just happened, i.e. after the run
  // stopped. Requiring an ACTIVE session here left the toggle lit with the annotator switched off.
  it('pause and end leave page annotation alone while the HUD stays expanded', () => {
    const { presenter } = mount();
    const ann = new Annotator({ emit: () => {}, now: () => 0 });
    ann.mount();
    presenter.bindAnnotator(ann);
    click(q('[data-reticle-fab]'));
    // Expanding no longer enters annotate mode on its own — it is a toolbar toggle now.
    click(q('[data-reticle-annotate-btn]'));
    expect(ann.active).toBe(true);
    click(pauseBtn());
    expect(ann.active, 'pausing the agent does not take away the pen').toBe(true);
    expect(stateAttr()).toBe('paused');
    click(pauseBtn());
    expect(ann.active).toBe(true);
    click(endBtn());
    expect(ann.active, 'a note about the run outlives the run').toBe(true);
    click(q('[data-reticle-annotate-btn]'));
    expect(ann.active, 'the toggle is still the way out').toBe(false);
    ann.destroy();
  });

  it('expanding the HUD while paused does not start annotation', () => {
    const { presenter } = mount();
    const ann = new Annotator({ emit: () => {}, now: () => 0 });
    ann.mount();
    presenter.bindAnnotator(ann);
    click(pauseBtn());
    click(q('[data-reticle-fab]'));
    expect(ann.active).toBe(false);
    ann.destroy();
  });

  it('17 human log text never leaks to snapshot', () => {
    mount();
    const i = input();
    if (null === i) throw new Error('no input');
    i.value = 'secret guidance text';
    click(sendBtn());
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).not.toContain('secret guidance text');
  });
});

/**
 * Teardown has to remove what mount added.
 *
 * All eight of this panel's listeners are anonymous closures over `this`, so there was no reference
 * to hand `removeEventListener` and teardown removed none of them.
 *
 * Asserting the MECHANISM rather than a side effect: a test that tears down, clicks, and checks
 * nothing happened passes either way once the HUD has left the DOM, so it measures the removal
 * rather than the fix. Recording each registration and checking its signal is what goes red.
 */
describe('control panel teardown', () => {
  it('registers its listeners with a signal, and aborts it on teardown', () => {
    document.body.innerHTML = '';
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener');

    const p = new Presenter({});
    p.mount();
    p.sessionStart();

    const signals = add.mock.calls
      .map(([, , options]) =>
        'object' === typeof options && null !== options ? options.signal : undefined,
      )
      .filter((s): s is AbortSignal => s !== undefined);
    add.mockRestore();

    // Guards the guard: if nothing registers with a signal, the loop below passes for free.
    expect(signals.length, 'the HUD should register listeners with a signal').toBeGreaterThan(0);
    expect(signals.some((s) => s.aborted)).toBe(false);

    p.destroy();

    expect(
      signals.every((s) => s.aborted),
      'a signalled listener outlived destroy()',
    ).toBe(true);
  });
});
