import { describe, it, expect, vi, afterEach } from 'vitest';
import { HumanControlKind, PresenterTone, SessionState } from '@reticlehq/core';
import { Presenter, type ControlIntent } from './presenter.js';
import { CONTROLS_CSS } from './presenter-controls.js';
import { buildSnapshot } from '@/dom/snapshot.js';
import { LOG_KIND } from './chrome/presenter-log.js';
import { isIgnored } from '@/dom/dom-ignore.js';
import { Annotator } from '@/review/annotator.js';

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

  it('9 end click emits {kind:end}, enters ended, shows banner', () => {
    const { onControl } = mount();
    click(endBtn());
    expect(onControl).toHaveBeenCalledWith({ kind: HumanControlKind.END });
    expect(stateAttr()).toBe('ended');
    const banner = q('[data-reticle-banner]');
    expect(banner?.textContent).toBe('Session ended');
  });

  it('10 replaces Pause and Stop with Copy and Export when ended', () => {
    mount();
    click(endBtn());
    expect(pauseBtn()?.hidden).toBe(true);
    expect(endBtn()?.hidden).toBe(true);
    expect(q('[data-reticle-copy]')?.hidden).toBe(false);
    expect(q('[data-reticle-export]')?.hidden).toBe(false);
    expect(q('[data-reticle-copy]')?.closest('.reticle-act-actions')).not.toBeNull();
    expect(q('[data-reticle-export]')?.closest('.reticle-act-actions')).not.toBeNull();
    expect(q('[data-reticle-copy]')?.closest('[data-reticle-hud]')).toBeNull();
  });

  it('11 clicking pause/end after ended emits nothing more', () => {
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
    expect(stateAttr()).toBe('ended');
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

  const pushFlows = (presenter: Presenter, flows: { name: string; start?: string }[]): void =>
    presenter.handlePush({ name: 'flows', args: { flows } });

  it('14e a FLOWS push renders ▶ chips; a click replays that flow (no agent)', () => {
    const { presenter, onControl } = mount();
    pushFlows(presenter, [{ name: 'checkout' }, { name: 'login' }]);
    const flows = q('[data-reticle-flows]');
    expect(flows?.getAttribute('data-has')).toBe('1');
    const chips = document.querySelectorAll<HTMLElement>(
      '[data-reticle-flow-strip] [data-reticle-replay]',
    );
    expect(chips.length).toBe(2);
    expect(chips[0]?.textContent).toBe('▶ checkout');
    click(chips[0]);
    expect(onControl).toHaveBeenCalledWith({ kind: HumanControlKind.REPLAY, text: 'checkout' });
  });

  it('14e2 the Saved flows page lists each flow as a readable row that still replays', () => {
    const { presenter, onControl } = mount();
    pushFlows(presenter, [
      { name: 'checkout-with-saved-card', start: 'not-on-this-page' },
      { name: 'login' },
    ]);
    const rows = document.querySelectorAll<HTMLButtonElement>(
      '[data-reticle-all-flows] [data-reticle-replay]',
    );
    expect(rows).toHaveLength(2);
    const blocked = Array.from(rows).find(
      (r) => 'checkout-with-saved-card' === r.getAttribute('data-reticle-replay'),
    );
    // The slug is read as words; the raw name stays the replay key and the tooltip.
    expect(blocked?.querySelector('.reticle-flow-name')?.textContent).toBe(
      'Checkout with saved card',
    );
    expect(blocked?.querySelector('.reticle-flow-meta')?.textContent).toBe(
      'Starts on another page',
    );
    expect(blocked?.disabled).toBe(true);
    const login = Array.from(rows).find((r) => 'login' === r.getAttribute('data-reticle-replay'));
    expect(login?.querySelector('.reticle-flow-meta')?.textContent).toBe('Replay without an agent');
    click(login);
    expect(onControl).toHaveBeenCalledWith({ kind: HumanControlKind.REPLAY, text: 'login' });
  });

  it('14f a FLOWS push with no flows hides the row and rebuilds cleanly', () => {
    const { presenter } = mount();
    pushFlows(presenter, [{ name: 'a' }, { name: 'b' }]);
    expect(
      document.querySelectorAll('[data-reticle-flow-strip] [data-reticle-replay]').length,
    ).toBe(2);
    pushFlows(presenter, []); // a re-push replaces, never appends
    expect(
      document.querySelectorAll('[data-reticle-flow-strip] [data-reticle-replay]').length,
    ).toBe(0);
    expect(q('[data-reticle-flows]')?.getAttribute('data-has')).toBe('0');
  });

  it('14g the flows preview is horizontally scrolling and cannot grow into the log', () => {
    const start = CONTROLS_CSS.indexOf('.reticle-flows{');
    const rule = CONTROLS_CSS.slice(start, CONTROLS_CSS.indexOf('}', start));
    expect(rule).toContain('flex:none');
    expect(CONTROLS_CSS).toContain('.reticle-flow-strip{display:flex;');
    expect(CONTROLS_CSS).toContain('overflow-x:auto');
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
      Array.from(document.querySelectorAll('[data-reticle-flow-strip] [data-reticle-replay]'))
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
      '[data-reticle-badge]',
      '[data-reticle-banner]',
    ]) {
      const el = q(sel);
      expect(el).not.toBeNull();
      expect(isIgnored(el as Element)).toBe(true);
    }
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).not.toContain('PAUSED');
    expect(snap.tree).not.toContain('Session ended');
    expect(snap.tree).not.toContain('reticle-brand-mini');
  });

  it('places run controls with status and annotation actions on their own page', () => {
    mount();
    const status = q('.reticle-act-strip');
    const annotations = q('[data-reticle-chat-view="annotations"]');
    expect(status?.contains(pauseBtn())).toBe(true);
    expect(status?.contains(endBtn())).toBe(true);
    expect(annotations?.querySelector('[data-reticle-markers-btn]')).not.toBeNull();
    expect(annotations?.querySelector('[data-reticle-clear-marks]')).not.toBeNull();
    expect(q('.reticle-chat-nav')).not.toBeNull();
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

  it('17 the human log well never leaks to snapshot', () => {
    // Was driven by typing into the composer. The composer is gone; what this actually guards is
    // that HUD log content stays out of the page's snapshot, so it drives the log directly.
    const { presenter } = mount();
    presenter.log(LOG_KIND.HUMAN, 'a sentence only the HUD should hold');
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).not.toContain('a sentence only the HUD should hold');
  });
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

describe('the replay row', () => {
  it('has a See all that opens the Flows page', () => {
    document.body.innerHTML = '';
    const presenter = new Presenter({});
    presenter.mount();
    const flowsTab = document.querySelector<HTMLElement>('[data-reticle-chat-view-btn="flows"]');
    let opened = false;
    flowsTab?.addEventListener('click', () => {
      opened = true;
    });
    document.querySelector<HTMLElement>('[data-reticle-flows-all]')?.click();
    expect(opened).toBe(true);
    presenter.destroy();
  });
});

describe('a replay started from a chip', () => {
  it('plays on the chip, step by step, and says how it ended', () => {
    document.body.innerHTML = '';
    const presenter = new Presenter({});
    presenter.mount();
    presenter.handlePush({ name: 'flows', args: { flows: [{ name: 'refund' }] } });
    const chip = (): HTMLElement | null =>
      document.querySelector('.reticle-flow[data-reticle-replay="refund"]');
    presenter.handlePush({
      name: 'flow.progress',
      args: { name: 'refund', done: 2, total: 4, status: 'playing' },
    });
    expect(chip()?.getAttribute('data-state')).toBe('playing');
    expect(chip()?.style.getPropertyValue('--reticle-flow-progress')).toBe('50%');
    const seeLogs = document.querySelector<HTMLElement>('[data-reticle-see-logs]');
    expect(seeLogs?.hidden).toBe(false);
    let opened = false;
    document
      .querySelector('[data-reticle-chat-view-btn="activity"]')
      ?.addEventListener('click', () => {
        opened = true;
      });
    seeLogs?.click();
    expect(opened).toBe(true);
    presenter.handlePush({
      name: 'flow.progress',
      args: { name: 'refund', done: 4, total: 4, status: 'passed' },
    });
    expect(chip()?.getAttribute('data-state')).toBe('passed');
    expect(chip()?.textContent).toBe('✓ refund');
    presenter.destroy();
  });
});
