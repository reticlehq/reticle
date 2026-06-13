import { ElementState, type ElementDescriptor } from '@iris/protocol';
import { refs } from './refs.js';

/** Roles whose accessible name comes from their text content. */
const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'option',
  'listitem',
  'cell',
  'columnheader',
  'rowheader',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'gridcell',
  'switch',
  'status',
  'alert',
]);

const INPUT_TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'search', 'password', '']);

function inputRole(input: HTMLInputElement): string {
  const type = input.type.toLowerCase();
  if (INPUT_TEXT_TYPES.has(type)) return 'textbox';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'range') return 'slider';
  if (type === 'number') return 'spinbutton';
  if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
  return 'textbox';
}

/** Compute the ARIA role (explicit wins, else implicit from the tag). */
export function getRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit !== null && explicit.trim().length > 0) return explicit.trim();
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'input':
      return inputRole(el as HTMLInputElement);
    case 'textarea':
      return 'textbox';
    case 'select':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'aside':
      return 'complementary';
    case 'dialog':
      return 'dialog';
    case 'img':
      return 'img';
    case 'table':
      return 'table';
    case 'form':
      return 'form';
    case 'p':
      return 'paragraph';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    default:
      return 'generic';
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function labelledByText(el: Element): string | null {
  const ids = el.getAttribute('aria-labelledby');
  if (ids === null) return null;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/)) {
    const ref = el.ownerDocument.getElementById(id);
    if (ref !== null) parts.push(collapse(ref.textContent ?? ''));
  }
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : null;
}

/** Accessible name via a practical subset of the accname algorithm. */
export function getAccessibleName(el: Element): string {
  const labelled = labelledByText(el);
  if (labelled !== null) return labelled;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return ariaLabel.trim();

  if (el instanceof HTMLImageElement) {
    const alt = el.getAttribute('alt');
    if (alt !== null) return alt.trim();
  }

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    const labels = el.labels;
    if (labels !== null && labels.length > 0) {
      const text = [...labels]
        .map((l) => collapse(l.textContent ?? ''))
        .join(' ')
        .trim();
      if (text.length > 0) return text;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder.trim().length > 0) return placeholder.trim();
    }
  }

  if (NAME_FROM_CONTENT.has(getRole(el))) {
    const text = collapse(el.textContent ?? '');
    if (text.length > 0) return text;
  }

  const title = el.getAttribute('title');
  if (title !== null && title.trim().length > 0) return title.trim();

  return '';
}

function ariaBool(el: Element, attr: string): boolean | undefined {
  const value = el.getAttribute(attr);
  if (value === null) return undefined;
  return value === 'true';
}

/** The set of states relevant to assertions (plan/06). */
export function getStates(el: Element): ElementState[] {
  const states: ElementState[] = [ElementState.PRESENT];
  if (isVisible(el)) states.push(ElementState.VISIBLE);
  else states.push(ElementState.HIDDEN);

  const disabledProp =
    (el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement) &&
    el.disabled;
  const disabled = disabledProp || ariaBool(el, 'aria-disabled') === true;
  states.push(disabled ? ElementState.DISABLED : ElementState.ENABLED);

  const checkedProp =
    el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && el.checked;
  if (checkedProp || ariaBool(el, 'aria-checked') === true) states.push(ElementState.CHECKED);
  if (ariaBool(el, 'aria-expanded') === true) states.push(ElementState.EXPANDED);
  if (el.ownerDocument.activeElement === el) states.push(ElementState.FOCUSED);

  return states;
}

export function getValue(el: Element): string | undefined {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.value;
  }
  const valueNow = el.getAttribute('aria-valuenow');
  return valueNow ?? undefined;
}

/** Whether the element is actually visible (not display:none/hidden/aria-hidden/opacity:0). */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  let node: Element | null = el;
  while (node !== null) {
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node instanceof HTMLElement && node.hidden) return false;
    const view = node.ownerDocument.defaultView;
    if (view !== null) {
      const style = view.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      ) {
        return false;
      }
      if (Number.parseFloat(style.opacity || '1') === 0) return false;
    }
    node = node.parentElement;
  }
  return true;
}

const MAX_TEXT = 80;

export function getVisibleText(el: Element): string {
  const text = collapse(el.textContent ?? '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Build the compact descriptor surfaced to the agent. */
export function describe(el: Element): ElementDescriptor {
  const value = getValue(el);
  const text = getVisibleText(el);
  const name = getAccessibleName(el);
  const base: ElementDescriptor = {
    ref: refs.refFor(el),
    role: getRole(el),
    name,
    states: getStates(el),
    visible: isVisible(el),
  };
  if (value !== undefined && value.length > 0) base.value = value;
  if (text.length > 0 && text !== name) base.text = text;
  return base;
}
