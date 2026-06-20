import { EventType } from '@syrin/iris-protocol';
import { resolveMarkAnchor } from './mark-anchor.js';

/**
 * The human "annotate the bug where you see it" surface. A dev toggles annotate mode, clicks the
 * element that looks wrong, types what's wrong, and Iris pins a numbered marker + emits a HUMAN_MARK
 * event the agent drains (iris_review). The mark carries the element's re-resolvable anchor and —
 * when available — the source file:line, so the agent fixes the exact element/code, not a guess.
 *
 * Self-contained and dev-only: every node carries a `data-iris-mark` attribute so Iris's own
 * observers ignore it (see dom-ignore.ts), and clicks on its own UI never become marks.
 */

/** Injected so the SDK wires the real emit/clock and tests can drive both. */
export interface AnnotatorDeps {
  emit: (type: EventType, data: Record<string, unknown>) => void;
  now: () => number;
  /**
   * Optional: called after a mark is sent so the SDK can echo it into the live presenter panel — the
   * human sees their flag land in the same activity log they watch the agent in. No-op when the
   * presenter isn't mounted.
   */
  onMark?: (note: string, label: string) => void;
}

/** Single base attribute on every UI node (varied by VALUE) so `closest('[data-iris-mark]')`
 *  catches the FAB, popover, and pins in one check, and the SDK's observers ignore them all. */
const MARK_ATTR = 'data-iris-mark';
const ACTIVE_ATTR = 'data-iris-mark-active';
const Z = 2147483640;
const sel = (role: string): string => `[${MARK_ATTR}="${role}"]`;

const CSS = `
${sel('fab')}{position:fixed;left:18px;bottom:18px;z-index:${String(Z + 2)};
  font:500 13px/1 "Inter",system-ui,sans-serif;display:inline-flex;align-items:center;gap:7px;
  padding:9px 13px;border-radius:11px;cursor:pointer;color:#e9ebf2;
  background:linear-gradient(180deg,rgba(19,22,32,.92),rgba(13,15,22,.92));
  border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px -10px rgba(0,0,0,.6);
  -webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);transition:transform .12s,border-color .15s;}
${sel('fab')}:hover{transform:translateY(-1px);border-color:rgba(124,131,255,.55);}
${sel('fab')}[data-on="1"]{color:#fff;border-color:#7c83ff;background:linear-gradient(180deg,#6366f1,#4f46e5);}
${sel('dot')}{width:8px;height:8px;border-radius:50%;background:#ff7a7a;flex:none;}
${sel('fab')}[data-on="1"] ${sel('dot')}{background:#fff;}
html[${ACTIVE_ATTR}] *{cursor:crosshair !important;}
${sel('hi')}{position:fixed;z-index:${String(Z + 1)};pointer-events:none;display:none;box-sizing:border-box;
  border:2px solid #7c83ff;border-radius:6px;background:rgba(124,131,255,.12);
  box-shadow:0 0 0 2px rgba(124,131,255,.22);transition:left .04s ease,top .04s ease,width .04s ease,height .04s ease;}
${sel('hi')}[data-on="1"]{display:block;}
${sel('hilabel')}{position:absolute;top:-21px;left:-2px;background:#6366f1;color:#fff;
  font:600 10.5px/1 "Inter",system-ui,sans-serif;padding:3px 6px;border-radius:5px;white-space:nowrap;
  max-width:300px;overflow:hidden;text-overflow:ellipsis;}
${sel('pin')}{position:fixed;z-index:${String(Z + 1)};width:22px;height:22px;margin:-11px 0 0 -11px;
  border-radius:50% 50% 50% 2px;background:#ff5d5d;border:2px solid #fff;box-shadow:0 4px 12px -2px rgba(0,0,0,.5);
  color:#fff;font:700 11px/18px "Inter",system-ui,sans-serif;text-align:center;pointer-events:none;}
${sel('pop')}{position:fixed;z-index:${String(Z + 3)};width:280px;box-sizing:border-box;
  background:linear-gradient(180deg,rgba(19,22,32,.96),rgba(13,15,22,.96));border:1px solid rgba(255,255,255,.14);
  border-radius:14px;padding:12px;box-shadow:0 24px 60px -16px rgba(0,0,0,.7);
  -webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);font:13px/1.5 "Inter",system-ui,sans-serif;color:#e9ebf2;}
${sel('pop')} .iris-mark-where{color:#9aa0b2;font-size:11.5px;margin-bottom:7px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
${sel('pop')} textarea{width:100%;box-sizing:border-box;min-height:62px;resize:vertical;
  background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#e9ebf2;
  font:13px/1.45 "Inter",system-ui,sans-serif;padding:8px;outline:none;}
${sel('pop')} textarea:focus{border-color:#7c83ff;}
${sel('pop')} .iris-mark-row{display:flex;gap:8px;align-items:center;margin-top:9px;}
${sel('pop')} .iris-mark-hint{margin-right:auto;color:#6a7186;font-size:10.5px;letter-spacing:.02em;}
${sel('pop')} button{font:600 12px/1 "Inter",system-ui,sans-serif;padding:8px 12px;border-radius:9px;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#cdd2e2;}
${sel('pop')} button[data-send]{background:#6366f1;border-color:#7c83ff;color:#fff;}
${sel('pop')} button[data-send]:disabled{opacity:.5;cursor:default;}`;

export class Annotator {
  readonly #emit: AnnotatorDeps['emit'];
  readonly #now: AnnotatorDeps['now'];
  readonly #onMark: AnnotatorDeps['onMark'];
  #root: HTMLElement | undefined;
  #fab: HTMLElement | undefined;
  #pop: HTMLElement | undefined;
  /** Hover outline box that shows WHICH element a click would flag (agentation-style). */
  #hi: HTMLElement | undefined;
  #hiLabel: HTMLElement | undefined;
  #active = false;
  #markCount = 0;
  #onClick: ((ev: MouseEvent) => void) | undefined;
  #onKeydown: ((ev: KeyboardEvent) => void) | undefined;
  #onMove: ((ev: MouseEvent) => void) | undefined;

  constructor(deps: AnnotatorDeps) {
    this.#emit = deps.emit;
    this.#now = deps.now;
    this.#onMark = deps.onMark;
  }

  /** Whether annotate mode is currently capturing clicks. */
  get active(): boolean {
    return this.#active;
  }

  /** Number of marks sent this session (drives the pin numbering). */
  get markCount(): number {
    return this.#markCount;
  }

  mount(): void {
    if (this.#root !== undefined || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.setAttribute(MARK_ATTR, 'style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.setAttribute(MARK_ATTR, 'root');
    root.innerHTML = `<button type="button" ${MARK_ATTR}="fab" aria-label="Flag a bug for the agent">
      <span ${MARK_ATTR}="dot"></span><span>Flag a bug</span></button>
      <div ${MARK_ATTR}="hi"><span ${MARK_ATTR}="hilabel"></span></div>`;
    document.body.appendChild(root);
    this.#root = root;
    this.#fab = root.querySelector<HTMLElement>(sel('fab')) ?? undefined;
    this.#hi = root.querySelector<HTMLElement>(sel('hi')) ?? undefined;
    this.#hiLabel = root.querySelector<HTMLElement>(sel('hilabel')) ?? undefined;
    this.#fab?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // Capture-phase click: intercept the FIRST click on a real page element while active.
    this.#onClick = (ev: MouseEvent): void => this.#handleClick(ev);
    document.addEventListener('click', this.#onClick, { capture: true });

    // Hover outline: while active, box the element a click would flag — so you see what you're pointing at.
    this.#onMove = (ev: MouseEvent): void => this.#handleMove(ev);
    document.addEventListener('mousemove', this.#onMove, { passive: true, capture: true });

    // Escape is the universal "back out": close an open popover, else leave annotate mode.
    this.#onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !this.#active) return;
      if (this.#pop !== undefined) this.#closePopover();
      else this.toggle(false);
    };
    document.addEventListener('keydown', this.#onKeydown);
  }

  destroy(): void {
    if (this.#onClick !== undefined) {
      document.removeEventListener('click', this.#onClick, { capture: true });
      this.#onClick = undefined;
    }
    if (this.#onKeydown !== undefined) {
      document.removeEventListener('keydown', this.#onKeydown);
      this.#onKeydown = undefined;
    }
    if (this.#onMove !== undefined) {
      document.removeEventListener('mousemove', this.#onMove, { capture: true });
      this.#onMove = undefined;
    }
    this.#closePopover();
    document.documentElement.removeAttribute(ACTIVE_ATTR);
    this.#root?.remove();
    document.querySelectorAll(`style[${MARK_ATTR}="style"]`).forEach((s) => s.remove());
    this.#root = undefined;
    this.#fab = undefined;
    this.#active = false;
  }

  /** Turn annotate mode on/off. With no argument, flips the current state. */
  toggle(on?: boolean): void {
    this.#active = on ?? !this.#active;
    this.#fab?.setAttribute('data-on', this.#active ? '1' : '0');
    if (this.#active) document.documentElement.setAttribute(ACTIVE_ATTR, '1');
    else {
      document.documentElement.removeAttribute(ACTIVE_ATTR);
      this.#hideHighlight();
      this.#closePopover();
    }
  }

  #handleClick(ev: MouseEvent): void {
    if (!this.#active) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`[${MARK_ATTR}]`) !== null) return; // never mark our own UI
    ev.preventDefault();
    ev.stopPropagation();
    this.#openPopover(target, ev.clientX, ev.clientY);
  }

  /** Box the element under the cursor (when active, no popover open) so you see what a click flags. */
  #handleMove(ev: MouseEvent): void {
    if (this.#hi === undefined) return;
    const target = ev.target;
    const skip =
      !this.#active ||
      this.#pop !== undefined ||
      !(target instanceof Element) ||
      target.closest(`[${MARK_ATTR}]`) !== null;
    if (skip) {
      this.#hi.setAttribute('data-on', '0');
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.#hi.setAttribute('data-on', '0');
      return;
    }
    this.#hi.style.left = `${String(rect.left)}px`;
    this.#hi.style.top = `${String(rect.top)}px`;
    this.#hi.style.width = `${String(rect.width)}px`;
    this.#hi.style.height = `${String(rect.height)}px`;
    this.#hi.setAttribute('data-on', '1');
    if (this.#hiLabel !== undefined) this.#hiLabel.textContent = describeEl(target);
  }

  /** Hide the hover outline (annotate mode off, or a popover took over). */
  #hideHighlight(): void {
    this.#hi?.setAttribute('data-on', '0');
  }

  #openPopover(el: Element, x: number, y: number): void {
    this.#closePopover();
    this.#hideHighlight(); // the popover is now the focus; drop the hover box
    const resolved = resolveMarkAnchor(el);
    const pop = document.createElement('div');
    pop.setAttribute(MARK_ATTR, 'pop');
    const where =
      resolved.source !== undefined
        ? `${resolved.label} · ${resolved.source.file}:${String(resolved.source.line)}`
        : resolved.label;
    pop.innerHTML = `<div class="iris-mark-where"></div>
      <textarea placeholder="What's wrong here? The agent will read this and fix it."></textarea>
      <div class="iris-mark-row"><span class="iris-mark-hint">⌘↵ send · esc cancel</span><button type="button" data-cancel>Cancel</button>
      <button type="button" data-send disabled>Send to agent</button></div>`;
    const whereEl = pop.querySelector('.iris-mark-where');
    if (whereEl !== null) whereEl.textContent = where;
    const left = Math.min(x, window.innerWidth - 296);
    const top = Math.min(y + 12, window.innerHeight - 170);
    pop.style.left = `${String(Math.max(8, left))}px`;
    pop.style.top = `${String(Math.max(8, top))}px`;
    document.body.appendChild(pop);
    this.#pop = pop;

    const textarea = pop.querySelector('textarea');
    const send = pop.querySelector<HTMLButtonElement>('button[data-send]');
    const submit = (): void => {
      const note = textarea?.value.trim() ?? '';
      if (note.length === 0) return; // never send an empty mark
      this.#sendMark(note, resolved, x, y);
      this.#closePopover();
    };
    textarea?.addEventListener('input', () => {
      if (send !== null) send.disabled = textarea.value.trim().length === 0;
    });
    // Keyboard ergonomics devs expect: ⌘/Ctrl+Enter sends, Esc cancels — without leaving the textarea.
    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.#closePopover();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    textarea?.focus();
    pop.querySelector('button[data-cancel]')?.addEventListener('click', () => this.#closePopover());
    send?.addEventListener('click', submit);
  }

  #sendMark(
    note: string,
    resolved: ReturnType<typeof resolveMarkAnchor>,
    x: number,
    y: number,
  ): void {
    const data: Record<string, unknown> = {
      note,
      anchor: resolved.anchor,
      strategy: resolved.strategy,
      label: resolved.label,
      route: typeof location === 'undefined' ? '' : location.pathname + location.search,
    };
    if (resolved.source !== undefined) data['source'] = resolved.source;
    this.#emit(EventType.HUMAN_MARK, data);
    this.#onMark?.(note, resolved.label); // echo into the live panel so the human sees the flag land
    this.#markCount += 1;
    this.#dropPin(x, y, this.#markCount);
  }

  #dropPin(x: number, y: number, n: number): void {
    if (this.#root === undefined) return;
    const pin = document.createElement('div');
    pin.setAttribute(MARK_ATTR, 'pin');
    pin.style.left = `${String(x)}px`;
    pin.style.top = `${String(y)}px`;
    pin.textContent = String(n);
    this.#root.appendChild(pin);
    // The pin fades after a moment so it confirms the mark landed without cluttering the page.
    const ref = pin;
    this.#now(); // touch the injected clock (kept for parity with the SDK's timing seams)
    window.setTimeout(() => ref.remove(), 2600);
  }

  #closePopover(): void {
    this.#pop?.remove();
    this.#pop = undefined;
  }
}

/**
 * A short label for the hovered element — testid > aria-label > tag + text. Cheap on purpose (runs
 * on every mousemove, so it does NOT call resolveMarkAnchor; the full anchor is resolved on click).
 */
function describeEl(el: Element): string {
  const testid = el.getAttribute('data-testid');
  if (testid !== null && testid.length > 0) return testid;
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.length > 0) return `${tag} "${aria}"`;
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return text.length > 0 ? `${tag} "${text}"` : tag;
}

/** Construct + mount the annotator (mirrors installRecorder's ergonomics). */
export function installAnnotator(deps: AnnotatorDeps): Annotator {
  const annotator = new Annotator(deps);
  annotator.mount();
  return annotator;
}
