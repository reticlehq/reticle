import { describe, it, expect, vi, afterEach } from 'vitest';
import { HumanControlKind, PresenterTone, SessionState } from '@syrin/iris-protocol';
import { Presenter, type ControlIntent } from './presenter.js';
import { buildSnapshot } from '../dom/snapshot.js';
import { isIgnored } from '../dom/dom-ignore.js';

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
  const root = q('[data-iris-overlay]') as HTMLElement;
  return { presenter, onControl, root };
}

afterEach(() => {
  document.querySelectorAll('[data-iris-overlay]').forEach((e) => e.remove());
  document.body.innerHTML = '';
});

const pauseBtn = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-iris-pause]');
const endBtn = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-iris-end]');
const sendBtn = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-iris-send]');
const input = (): HTMLInputElement | null => q<HTMLInputElement>('[data-iris-input]');
const stateAttr = (): string | null =>
  q('[data-iris-overlay][data-iris-state]')?.getAttribute('data-iris-state') ?? null;
const logTexts = (): (string | null)[] =>
  Array.from(document.querySelectorAll('[data-iris-log] .iris-log-text')).map((e) => e.textContent);

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
    const badge = q('[data-iris-badge]');
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
    expect(pauseBtn()?.textContent).toBe('Pause');
  });

  it('4 pause button label flips to Resume when paused, back when active', () => {
    mount();
    click(pauseBtn());
    expect(pauseBtn()?.textContent).toBe('Resume');
    click(pauseBtn());
    expect(pauseBtn()?.textContent).toBe('Pause');
  });

  it('5 send with text emits message, appends 🧑 row, clears input', () => {
    const { onControl } = mount();
    const i = input();
    if (i === null) throw new Error('no input');
    i.value = 'try the dark theme';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    click(sendBtn());
    expect(onControl).toHaveBeenCalledWith({
      kind: HumanControlKind.MESSAGE,
      text: 'try the dark theme',
    });
    expect(logTexts().some((t) => t === '🧑 you: try the dark theme')).toBe(true);
    expect(i.value).toBe('');
  });

  it('6 Enter key in input sends', () => {
    const { onControl } = mount();
    const i = input();
    if (i === null) throw new Error('no input');
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

  it('8 send with whitespace-only emits nothing and appends no 🧑 row', () => {
    const { onControl } = mount();
    const i = input();
    if (i === null) throw new Error('no input');
    i.value = '   ';
    click(sendBtn());
    expect(onControl).not.toHaveBeenCalled();
    expect(logTexts().some((t) => t !== null && t.startsWith('🧑 you:'))).toBe(false);
  });

  it('9 end click emits {kind:end}, enters ended, shows banner', () => {
    const { onControl } = mount();
    click(endBtn());
    expect(onControl).toHaveBeenCalledWith({ kind: HumanControlKind.END });
    expect(stateAttr()).toBe('ended');
    const banner = q('[data-iris-banner]');
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
    expect(q('[data-iris-hud]')?.getAttribute('data-on')).toBe('1');
    await wait(20);
    await flush();
    expect(q('[data-iris-glow]')?.getAttribute('data-on')).toBe('0'); // border cleared (testing over)
    expect(q('[data-iris-hud]')?.getAttribute('data-on')).toBe('1'); // panel PERSISTS for analysis
    expect(stateAttr()).toBe('ended'); // → CSS reveals the Copy/Export row
    expect(q('[data-iris-copy]')).not.toBeNull();
    expect(q('[data-iris-export]')).not.toBeNull();
  });

  it('13 setState(paused) updates panel without emitting (server push)', () => {
    const { presenter, onControl } = mount();
    presenter.setState(SessionState.PAUSED);
    expect(stateAttr()).toBe('paused');
    expect(q('[data-iris-badge]')?.textContent).toBe('PAUSED');
    expect(onControl).not.toHaveBeenCalled();
  });

  it('14 setState(ended, summary) leads with "Session ended" and appends the summary', () => {
    const { presenter, onControl } = mount();
    presenter.setState(SessionState.ENDED, 'all green');
    expect(q('[data-iris-banner]')?.textContent).toBe('Session ended · all green');
    expect(onControl).not.toHaveBeenCalled();
  });

  it('14b warn tone (agent stopped) sets data-iris-tone and leads the banner with the notice', () => {
    const { presenter } = mount();
    const panelRoot = q('div[data-iris-overlay]') as HTMLElement; // the <div>, not the <style>
    presenter.setState(
      SessionState.ENDED,
      'Agent stopped — switch to your terminal',
      PresenterTone.WARN,
    );
    expect(panelRoot.getAttribute('data-iris-tone')).toBe('warn');
    // warn drops the calm "Session ended ·" prefix — the notice itself is the actionable headline
    expect(q('[data-iris-banner]')?.textContent).toBe('Agent stopped — switch to your terminal');
  });

  it('14c a calm end clears any prior warn tone', () => {
    const { presenter } = mount();
    const panelRoot = q('div[data-iris-overlay]') as HTMLElement;
    presenter.setState(SessionState.ENDED, 'Agent stopped', PresenterTone.WARN);
    expect(panelRoot.getAttribute('data-iris-tone')).toBe('warn');
    presenter.setState(SessionState.ACTIVE);
    expect(panelRoot.hasAttribute('data-iris-tone')).toBe(false);
  });

  it('15 setState is idempotent', () => {
    const { presenter } = mount();
    presenter.setState(SessionState.PAUSED);
    presenter.setState(SessionState.PAUSED);
    expect(document.querySelectorAll('[data-iris-overlay][data-iris-state="paused"]').length).toBe(
      1,
    );
    expect(q('[data-iris-badge]')?.textContent).toBe('PAUSED');
  });

  it('16 all control nodes are data-iris-* excluded from snapshot', () => {
    mount();
    for (const sel of [
      '[data-iris-pause]',
      '[data-iris-end]',
      '[data-iris-input]',
      '[data-iris-send]',
      '[data-iris-badge]',
      '[data-iris-banner]',
    ]) {
      const el = q(sel);
      expect(el).not.toBeNull();
      expect(isIgnored(el as Element)).toBe(true);
    }
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).not.toContain('Tell the agent something');
    expect(snap.tree).not.toContain('PAUSED');
    expect(snap.tree).not.toContain('Session ended');
    expect(snap.tree).not.toContain('🧑 you:');
  });

  it('17 human log text never leaks to snapshot', () => {
    mount();
    const i = input();
    if (i === null) throw new Error('no input');
    i.value = 'secret guidance text';
    click(sendBtn());
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).not.toContain('secret guidance text');
  });
});
