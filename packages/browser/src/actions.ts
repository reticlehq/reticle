import { ActionType } from '@iris/protocol';
import { refs } from './refs.js';

export interface ActionResult {
  ok: true;
  ref: string;
  action: string;
}

/** Set a value on a controlled input the way React expects (native setter + input event). */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- setter is invoked via .call(el)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter !== undefined) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function requireElement(ref: string): HTMLElement {
  const el = refs.resolve(ref);
  if (el === null) throw new Error(`ref '${ref}' no longer resolves to an element`);
  if (!(el instanceof HTMLElement)) throw new Error(`ref '${ref}' is not an HTMLElement`);
  return el;
}

/** Execute a single action against a ref. Returns immediately; reactions are observed. */
export function executeAction(
  ref: string,
  action: string,
  args: Record<string, unknown> = {},
): ActionResult {
  const el = requireElement(ref);
  switch (action) {
    case ActionType.CLICK:
      el.click();
      break;
    case ActionType.DBLCLICK:
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      break;
    case ActionType.HOVER:
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      break;
    case ActionType.FOCUS:
      el.focus();
      break;
    case ActionType.BLUR:
      el.blur();
      break;
    case ActionType.FILL:
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, asString(args['value']));
      } else {
        throw new Error(`cannot fill a <${el.tagName.toLowerCase()}>`);
      }
      break;
    case ActionType.TYPE:
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, el.value + asString(args['text']));
      } else {
        throw new Error(`cannot type into a <${el.tagName.toLowerCase()}>`);
      }
      break;
    case ActionType.CLEAR:
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, '');
      }
      break;
    case ActionType.SELECT:
      if (el instanceof HTMLSelectElement) {
        el.value = asString(args['value']);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        throw new Error(`cannot select on a <${el.tagName.toLowerCase()}>`);
      }
      break;
    case ActionType.CHECK:
    case ActionType.UNCHECK:
      if (el instanceof HTMLInputElement) {
        el.checked = action === ActionType.CHECK;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        throw new Error(`cannot (un)check a <${el.tagName.toLowerCase()}>`);
      }
      break;
    case ActionType.SUBMIT: {
      const form = el instanceof HTMLFormElement ? el : el.closest('form');
      if (form === null) throw new Error('no form to submit');
      form.requestSubmit();
      break;
    }
    case ActionType.PRESS: {
      const key = asString(args['key'], 'Enter');
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      break;
    }
    case ActionType.SCROLL_INTO_VIEW:
      el.scrollIntoView();
      break;
    case ActionType.UPLOAD: {
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
        throw new Error('upload target must be a <input type="file">');
      }
      const file = new File(
        [asString(args['content'], 'iris test file')],
        asString(args['name'], 'file.txt'),
        {
          type: asString(args['type'], 'text/plain'),
        },
      );
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    case ActionType.DRAG: {
      const toRef = asString(args['toRef']);
      const resolved = toRef !== undefined ? refs.resolve(toRef) : null;
      dragElement(el, resolved instanceof HTMLElement ? resolved : null);
      break;
    }
    default:
      throw new Error(`unknown action '${action}'`);
  }
  return { ok: true, ref, action };
}

/** Synthesize a pointer-based drag (works for dnd-kit / react-beautiful-dnd) plus best-effort HTML5 DnD. */
function dragElement(source: HTMLElement, target: HTMLElement | null): void {
  const dest = target ?? source;
  const fire = (el: Element, type: string): void => {
    if (typeof PointerEvent === 'function' && type.startsWith('pointer')) {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
    } else {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  };
  fire(source, 'pointerdown');
  fire(source, 'mousedown');
  fire(dest, 'pointermove');
  fire(dest, 'mousemove');
  fire(dest, 'pointerup');
  fire(dest, 'mouseup');

  if (typeof DragEvent === 'function') {
    const dataTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    const init: DragEventInit = { bubbles: true, cancelable: true };
    if (dataTransfer !== null) init.dataTransfer = dataTransfer;
    source.dispatchEvent(new DragEvent('dragstart', init));
    dest.dispatchEvent(new DragEvent('dragover', init));
    dest.dispatchEvent(new DragEvent('drop', init));
    source.dispatchEvent(new DragEvent('dragend', init));
  }
}

/** Best-effort WebMCP passthrough: call a navigator.modelContext tool if the site exposes one. */
export async function dispatchWebMcp(
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const mc = (
    navigator as unknown as { modelContext?: { callTool?: (n: string, p: unknown) => unknown } }
  ).modelContext;
  if (mc === undefined || typeof mc.callTool !== 'function') {
    throw new Error('WebMCP (navigator.modelContext) not available on this page');
  }
  return await mc.callTool(tool, params);
}

export interface ActionStep {
  ref: string;
  action: string;
  args?: Record<string, unknown>;
}

export function executeSequence(steps: ActionStep[]): { ok: true; count: number } {
  for (const step of steps) {
    executeAction(step.ref, step.action, step.args ?? {});
  }
  return { ok: true, count: steps.length };
}
