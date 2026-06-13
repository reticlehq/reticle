import {
  ActionType,
  AnchorKind,
  AnnotationKind,
  DEGRADED_ANCHOR_ROLE,
  EventType,
  FLOW_FILE_VERSION,
  RecorderPhase,
  type FlowAnchor,
  type FlowExpect,
  type FlowFile,
  type FlowStep,
} from '@iris/protocol';
import { getAccessibleName, getRole } from './a11y.js';
import { isIrisOverlay } from './dom-ignore.js';
import { getCapabilities } from './capabilities.js';

/**
 * M8 Stage B RECORDER — the human recorder. A floating toolbar (Record / Stop / Annotate) lets a
 * human click the golden path; capture-phase listeners map each real interaction to a SEMANTIC
 * anchor (testid → role+name → degraded placeholder, NEVER a volatile ref — invariant #1) and
 * append a FlowStep. Stop compiles a FlowFile in-page and emits ONE EventType.FLOW_RECORDED event
 * the server persists. Four structured annotation kinds compile into expect/dynamic/success.
 *
 * FIRST CUT scope: structured annotations only (the 4 AnnotationKind values via a menu + a signal
 * <select> drawn from registered capabilities). Explicitly FUTURE, not faked here:
 *   - NL annotation → predicate compiler (CO-OWNED-FLOWS invariant #2 best-UX path).
 *   - fixtures/preconditions (FlowFile.fixture stays a schema slot, never written).
 *   - wait-for / ignore-region annotation kinds (only the 4 requested ship).
 */

/** Browser-local UI text — never crosses the wire, mirrors presenter.ts CHIP_LABEL precedent. */
export const RECORDER_EMPTY_MSG = 'recorded 0 steps';
const STATUS_RECORDING = 'recording…';
const STATUS_IDLE = 'ready';
const STATUS_ANNOTATE = 'pick an annotation';
const TESTID_ATTR = 'data-testid';
const TOOL = 'iris_act';

const BUTTON_LABEL = {
  record: 'Record',
  stop: 'Stop',
  annotate: 'Annotate',
} as const;

const ANNOTATION_LABEL: Record<AnnotationKind, string> = {
  [AnnotationKind.ASSERT_SIGNAL]: 'assert signal',
  [AnnotationKind.ASSERT_VISIBLE]: 'assert visible',
  [AnnotationKind.MARK_DYNAMIC]: 'mark dynamic',
  [AnnotationKind.SUCCESS_STATE]: 'success state',
};

/** Annotation kinds whose compilation needs a signal name (from the capabilities <select>). */
const NEEDS_SIGNAL = new Set<AnnotationKind>([
  AnnotationKind.ASSERT_SIGNAL,
  AnnotationKind.SUCCESS_STATE,
]);

export interface RecorderDeps {
  /** Emit a wire event (Iris.#emit bound). */
  emit: (type: EventType, data: Record<string, unknown>) => void;
  /** Injected clock for FlowFile.createdAt — never Date.now() in pure logic (rule 7). */
  now: () => number;
  /** Default flow name when the toolbar field is blank. */
  defaultName?: string;
}

export interface RecorderHandle {
  mount(): void;
  destroy(): void;
  /** Test seam: current phase. */
  phase(): RecorderPhase;
  /** Test seam: steps captured so far in the active span. */
  steps(): FlowStep[];
}

/** A structured annotation captured while recording (compiled into flow fields at Stop). */
export interface Annotation {
  kind: AnnotationKind;
  anchor: FlowAnchor;
  /** Required for ASSERT_SIGNAL / SUCCESS_STATE; the chosen capability signal name. */
  signal?: string;
}

const DEFAULT_NAME = 'recorded-flow';

/**
 * Pure: map a clicked/typed element → semantic FlowAnchor. testid wins; else role+accessible-name;
 * else the DEGRADED_ANCHOR_ROLE placeholder + degraded:true (never a ref — invariant #1).
 */
export function anchorFor(el: Element): { anchor: FlowAnchor; degraded: boolean } {
  const testid = el.getAttribute(TESTID_ATTR);
  if (testid !== null && testid.length > 0) {
    return { anchor: { kind: AnchorKind.TESTID, value: testid }, degraded: false };
  }
  const role = getRole(el);
  const name = getAccessibleName(el);
  if (role !== 'generic' && (role.length > 0 || name.length > 0)) {
    const anchor: FlowAnchor =
      name.length > 0 ? { kind: AnchorKind.ROLE, role, name } : { kind: AnchorKind.ROLE, role };
    return { anchor, degraded: false };
  }
  // No resolvable testid/role/name — keep the step with a legible placeholder, never a ref.
  return { anchor: { kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE }, degraded: true };
}

function isTextbox(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && inputRole(el) === 'textbox';
}

function inputRole(el: HTMLInputElement): 'textbox' | 'checkbox' | 'radio' | 'other' {
  const type = el.type.toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (['text', 'email', 'tel', 'url', 'search', 'password', ''].includes(type)) return 'textbox';
  return 'other';
}

function buildStep(el: Element, action: ActionType, args?: Record<string, unknown>): FlowStep {
  const { anchor, degraded } = anchorFor(el);
  const step: FlowStep = { tool: TOOL, anchor, action };
  if (args !== undefined) step.args = args;
  if (degraded) step.degraded = true;
  return step;
}

/**
 * Pure: assemble the in-page FlowFile from captured steps + annotations.
 *  - ASSERT_SIGNAL  → the most-recent step's expect.signal.
 *  - ASSERT_VISIBLE → the most-recent step's expect.element (from the annotation anchor).
 *  - MARK_DYNAMIC   → push the anchor into flow.dynamic[].
 *  - SUCCESS_STATE  → flow.success = { signal }.
 * (FUTURE: per-step annotation targeting beyond the most-recent step.)
 */
export function compileRecording(
  name: string,
  steps: FlowStep[],
  annotations: Annotation[],
  createdAt: number,
): FlowFile {
  const out: FlowStep[] = steps.map((s) => ({ ...s }));
  const dynamic: FlowAnchor[] = [];
  let success: FlowExpect | undefined;

  for (const ann of annotations) {
    if (ann.kind === AnnotationKind.MARK_DYNAMIC) {
      dynamic.push(ann.anchor);
      continue;
    }
    if (ann.kind === AnnotationKind.SUCCESS_STATE) {
      if (ann.signal !== undefined) success = { signal: ann.signal };
      continue;
    }
    const target = out.at(-1);
    if (target === undefined) continue;
    if (ann.kind === AnnotationKind.ASSERT_SIGNAL && ann.signal !== undefined) {
      target.expect = { ...target.expect, signal: ann.signal };
    } else if (ann.kind === AnnotationKind.ASSERT_VISIBLE) {
      target.expect = { ...target.expect, element: anchorToElement(ann.anchor) };
    }
  }

  const flow: FlowFile = { version: FLOW_FILE_VERSION, name, createdAt, steps: out };
  if (dynamic.length > 0) flow.dynamic = dynamic;
  if (success !== undefined) flow.success = success;
  return flow;
}

function anchorToElement(anchor: FlowAnchor): { testid?: string; role?: string; name?: string } {
  if (anchor.kind === AnchorKind.TESTID) return { testid: anchor.value };
  if (anchor.kind === AnchorKind.ROLE) {
    return anchor.name !== undefined
      ? { role: anchor.role, name: anchor.name }
      : { role: anchor.role };
  }
  return {};
}

interface PendingFill {
  el: Element;
  value: string;
}

/** Live recorder instance: holds the capture buffer, toolbar DOM, and the phase machine. */
class Recorder implements RecorderHandle {
  readonly #deps: RecorderDeps;
  #phase: RecorderPhase = RecorderPhase.IDLE;
  #steps: FlowStep[] = [];
  #annotations: Annotation[] = [];
  #pendingFill: PendingFill | undefined;
  #teardowns: (() => void)[] = [];
  #root: HTMLElement | undefined;
  #statusEl: HTMLElement | undefined;
  #menuEl: HTMLElement | undefined;
  /** The annotation being assembled in ANNOTATING phase. */
  #draft: { kind: AnnotationKind } | undefined;

  constructor(deps: RecorderDeps) {
    this.#deps = deps;
  }

  phase(): RecorderPhase {
    return this.#phase;
  }

  steps(): FlowStep[] {
    return this.#steps.map((s) => ({ ...s }));
  }

  mount(): void {
    if (this.#root !== undefined) return;
    if (typeof document === 'undefined') return;
    this.#buildToolbar();
    this.#installCapture();
  }

  destroy(): void {
    for (const t of this.#teardowns) t();
    this.#teardowns = [];
    this.#root?.remove();
    this.#root = undefined;
    this.#statusEl = undefined;
    this.#menuEl = undefined;
    this.#phase = RecorderPhase.IDLE;
    this.#steps = [];
    this.#annotations = [];
    this.#draft = undefined;
    this.#pendingFill = undefined;
  }

  // ---- capture ----

  #installCapture(): void {
    const onClick = (ev: Event): void => this.#onClick(ev);
    const onInput = (ev: Event): void => this.#onInput(ev);
    const onChange = (ev: Event): void => this.#onChange(ev);
    const onSubmit = (ev: Event): void => this.#onSubmit(ev);
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('submit', onSubmit, true);
    this.#teardowns.push(() => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('submit', onSubmit, true);
    });
  }

  /** True if the event should be ignored (toolbar self-click or non-element target). */
  #ignore(ev: Event): Element | undefined {
    const target = ev.target;
    if (!(target instanceof Element)) return undefined;
    if (isIrisOverlay(target)) return undefined;
    return target;
  }

  #onClick(ev: Event): void {
    const target = this.#ignore(ev);
    if (target === undefined) return;
    if (this.#phase === RecorderPhase.ANNOTATING) {
      this.#captureAnnotationTarget(target);
      return;
    }
    if (this.#phase !== RecorderPhase.RECORDING) return;
    this.#flushPendingFill();
    this.#steps.push(buildStep(target, ActionType.CLICK));
  }

  #onInput(ev: Event): void {
    if (this.#phase !== RecorderPhase.RECORDING) return;
    const target = this.#ignore(ev);
    if (target === undefined || !isTextbox(target)) return;
    // Debounce per-keystroke input: keep the latest value, flush on change/blur/next-act.
    this.#pendingFill = { el: target, value: target.value };
  }

  #onChange(ev: Event): void {
    if (this.#phase !== RecorderPhase.RECORDING) return;
    const target = this.#ignore(ev);
    if (target === undefined) return;
    if (target instanceof HTMLInputElement && inputRole(target) === 'checkbox') {
      this.#flushPendingFill();
      this.#steps.push(buildStep(target, target.checked ? ActionType.CHECK : ActionType.UNCHECK));
      return;
    }
    if (target instanceof HTMLInputElement && inputRole(target) === 'radio') {
      this.#flushPendingFill();
      this.#steps.push(buildStep(target, ActionType.CHECK));
      return;
    }
    if (isTextbox(target)) {
      this.#pendingFill = { el: target, value: target.value };
      this.#flushPendingFill();
    }
  }

  #onSubmit(ev: Event): void {
    if (this.#phase !== RecorderPhase.RECORDING) return;
    const target = this.#ignore(ev);
    if (target === undefined) return;
    this.#flushPendingFill();
    this.#steps.push(buildStep(target, ActionType.SUBMIT));
  }

  #flushPendingFill(): void {
    const pending = this.#pendingFill;
    if (pending === undefined) return;
    this.#pendingFill = undefined;
    this.#steps.push(buildStep(pending.el, ActionType.FILL, { value: pending.value }));
  }

  // ---- annotation ----

  #captureAnnotationTarget(target: Element): void {
    const draft = this.#draft;
    if (draft === undefined) return;
    const { anchor } = anchorFor(target);
    const ann: Annotation = { kind: draft.kind, anchor };
    const signal = this.#selectedSignal();
    if (signal !== undefined) ann.signal = signal;
    this.#annotations.push(ann);
    this.#draft = undefined;
    this.#setPhase(RecorderPhase.RECORDING);
    this.#closeMenu();
  }

  /** Annotate-on-prior: confirm the most-recent step as the target (no extra click needed). */
  #confirmAnnotationOnPrior(): void {
    const draft = this.#draft;
    if (draft === undefined) return;
    const last = this.#steps.at(-1);
    if (last === undefined) {
      this.#draft = undefined;
      this.#setPhase(RecorderPhase.RECORDING);
      this.#closeMenu();
      return;
    }
    const ann: Annotation = { kind: draft.kind, anchor: last.anchor };
    const signal = this.#selectedSignal();
    if (signal !== undefined) ann.signal = signal;
    this.#annotations.push(ann);
    this.#draft = undefined;
    this.#setPhase(RecorderPhase.RECORDING);
    this.#closeMenu();
  }

  #selectedSignal(): string | undefined {
    const select = this.#menuEl?.querySelector<HTMLSelectElement>('[data-iris-signal]');
    const value = select?.value ?? '';
    return value.length > 0 ? value : undefined;
  }

  // ---- toolbar lifecycle actions ----

  #start(): void {
    // A fresh span — no leakage from a previous Record→Stop (B7).
    this.#steps = [];
    this.#annotations = [];
    this.#pendingFill = undefined;
    this.#draft = undefined;
    this.#setPhase(RecorderPhase.RECORDING);
    this.#setStatus(STATUS_RECORDING);
  }

  #stop(): void {
    this.#flushPendingFill();
    const name = this.#nameField() ?? this.#deps.defaultName ?? DEFAULT_NAME;
    const flow = compileRecording(name, this.#steps, this.#annotations, this.#deps.now());
    this.#deps.emit(EventType.FLOW_RECORDED, { name, flow });
    this.#setStatus(this.#steps.length === 0 ? RECORDER_EMPTY_MSG : STATUS_IDLE);
    this.#setPhase(RecorderPhase.IDLE);
    this.#closeMenu();
  }

  #openAnnotateMenu(): void {
    if (this.#phase !== RecorderPhase.RECORDING) return;
    this.#setPhase(RecorderPhase.ANNOTATING);
    this.#setStatus(STATUS_ANNOTATE);
    this.#renderMenu();
  }

  #setPhase(phase: RecorderPhase): void {
    this.#phase = phase;
  }

  // ---- toolbar DOM (all nodes data-iris-overlay → snapshot-excluded via dom-ignore.ts) ----

  #buildToolbar(): void {
    const root = document.createElement('div');
    root.setAttribute('data-iris-overlay', '');
    root.style.cssText = TOOLBAR_CSS;

    const name = document.createElement('input');
    name.setAttribute('data-iris-name', '');
    name.setAttribute('placeholder', 'flow name');
    name.style.cssText = NAME_CSS;
    root.appendChild(name);

    root.appendChild(this.#button('record', BUTTON_LABEL.record, () => this.#start()));
    root.appendChild(this.#button('stop', BUTTON_LABEL.stop, () => this.#stop()));
    root.appendChild(
      this.#button('annotate', BUTTON_LABEL.annotate, () => this.#openAnnotateMenu()),
    );

    const status = document.createElement('span');
    status.setAttribute('data-iris-status', '');
    status.style.cssText = STATUS_CSS;
    status.textContent = STATUS_IDLE;
    root.appendChild(status);

    const menu = document.createElement('div');
    menu.setAttribute('data-iris-menu', '');
    menu.style.cssText = MENU_CSS;
    root.appendChild(menu);

    document.body.appendChild(root);
    this.#root = root;
    this.#statusEl = status;
    this.#menuEl = menu;
  }

  #button(action: string, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.setAttribute('data-iris-action', action);
    btn.textContent = label;
    btn.style.cssText = BTN_CSS;
    btn.addEventListener('click', onClick);
    return btn;
  }

  #renderMenu(): void {
    const menu = this.#menuEl;
    if (menu === undefined) return;
    menu.textContent = '';
    for (const kind of Object.values(AnnotationKind)) {
      const item = document.createElement('button');
      item.setAttribute('data-iris-annkind', kind);
      item.textContent = ANNOTATION_LABEL[kind];
      item.style.cssText = BTN_CSS;
      item.addEventListener('click', () => this.#chooseKind(kind));
      menu.appendChild(item);
    }
  }

  #chooseKind(kind: AnnotationKind): void {
    this.#draft = { kind };
    const menu = this.#menuEl;
    if (menu === undefined) return;
    if (NEEDS_SIGNAL.has(kind)) {
      const select = document.createElement('select');
      select.setAttribute('data-iris-signal', '');
      select.style.cssText = NAME_CSS;
      for (const sig of getCapabilities().signals) {
        const opt = document.createElement('option');
        opt.value = sig;
        opt.textContent = sig;
        select.appendChild(opt);
      }
      menu.appendChild(select);
    }
    // "Confirm on prior step" path (annotate-on-prior); or the next click selects the target.
    const confirm = document.createElement('button');
    confirm.setAttribute('data-iris-action', 'annotate-confirm');
    confirm.textContent = 'on prior step';
    confirm.style.cssText = BTN_CSS;
    confirm.addEventListener('click', () => this.#confirmAnnotationOnPrior());
    menu.appendChild(confirm);
  }

  #closeMenu(): void {
    if (this.#menuEl !== undefined) this.#menuEl.textContent = '';
  }

  #setStatus(text: string): void {
    if (this.#statusEl !== undefined) this.#statusEl.textContent = text;
  }

  #nameField(): string | undefined {
    const input = this.#root?.querySelector<HTMLInputElement>('[data-iris-name]');
    const value = input?.value.trim() ?? '';
    return value.length > 0 ? value : undefined;
  }
}

const TOOLBAR_CSS = [
  'position:fixed',
  'top:8px',
  'left:50%',
  'transform:translateX(-50%)',
  'z-index:2147483647',
  'display:flex',
  'gap:6px',
  'align-items:center',
  'flex-wrap:wrap',
  'max-width:90vw',
  'font:12px ui-sans-serif,system-ui,sans-serif',
  'background:#151823',
  'color:#e6e9f0',
  'border:1px solid #2a2f3d',
  'border-radius:10px',
  'padding:6px 10px',
  'box-shadow:0 8px 30px rgba(0,0,0,.5)',
].join(';');

const BTN_CSS = [
  'font:inherit',
  'cursor:pointer',
  'background:#262b3a',
  'color:#e6e9f0',
  'border:1px solid #3a4151',
  'border-radius:7px',
  'padding:3px 9px',
].join(';');

const NAME_CSS = [
  'font:inherit',
  'background:#0e1018',
  'color:#e6e9f0',
  'border:1px solid #3a4151',
  'border-radius:7px',
  'padding:3px 8px',
].join(';');

const STATUS_CSS = ['opacity:.75', 'margin-left:4px'].join(';');
const MENU_CSS = ['display:flex', 'gap:6px', 'align-items:center', 'flex-wrap:wrap'].join(';');

/** Install the floating recorder toolbar. Default off; gated by the host (iris.ts recorder flag). */
export function installRecorder(deps: RecorderDeps): RecorderHandle {
  return new Recorder(deps);
}
