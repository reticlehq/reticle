import { ElementState, REDACTED_VALUE, type ElementDescriptor } from '@reticlehq/core';
import { isButton, isHtmlElement, isImage, isInput, isSelect, isTextArea } from './realm.js';
import { refs } from './refs.js';
import { inspectChart } from './chart.js';
import { isSensitiveKey } from '../security/serialization.js';
import { formatSource, sourceFromDom } from './source.js';

/**
 * Roles whose accessible name comes from their text content (ARIA's `nameFrom: author content`).
 *
 * `radio`, `checkbox`, `row` and `tooltip` were missing, and the gap is not cosmetic: a segmented
 * filter written as `<button role="radio">held</button>` — an extremely ordinary design-system
 * control — reported as a nameless `radio`, so `by: role` + name could not address it at all and an
 * agent had to fall back to a testid the app has no reason to carry. Measured on a shipments console:
 * six filters, six nameless radios, none reachable by name.
 *
 * `listitem`, `status` and `alert` are NOT in the spec's list. They are kept as a deliberate
 * over-approximation — a name computed from content is more useful than no name — and removing them
 * has no measured symptom to justify the risk.
 */
const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'option',
  'listitem',
  'cell',
  'checkbox',
  'columnheader',
  'radio',
  'row',
  'rowheader',
  'tab',
  'tooltip',
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
  if ('checkbox' === type) return 'checkbox';
  if ('radio' === type) return 'radio';
  if ('range' === type) return 'slider';
  if ('number' === type) return 'spinbutton';
  if ('submit' === type || 'button' === type || 'reset' === type) return 'button';
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
  if (null === ids) return null;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/)) {
    const ref = el.ownerDocument.getElementById(id);
    if (ref !== null) parts.push(collapse(textWithoutHidden(ref)));
  }
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : null;
}

/** Accessible name via a practical subset of the accname algorithm. */
/** Accessible name via a practical subset of the accname algorithm. */
/**
 * Text content with `aria-hidden` subtrees removed.
 *
 * The accessible-name spec excludes them, and — decisively — so does dom-accessibility-api, which is
 * what `by: role` + name MATCHES against via testing-library. Reading raw `textContent` here made the
 * name we REPORT differ from the name that can be SELECTED: Material UI renders its required-field
 * marker as `<span aria-hidden="true"> *</span>`, so a login field was reported as `"Username *"` and
 * addressable only as `"Username"`. Reporting a name the agent cannot use defeats the purpose of
 * reporting it at all, so both must come from the same rule.
 */
function textWithoutHidden(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if ('true' === el.getAttribute('aria-hidden')) return '';
  let out = '';
  for (const child of el.childNodes) out += textWithoutHidden(child);
  return out;
}

export function getAccessibleName(el: Element): string {
  const labelled = labelledByText(el);
  if (labelled !== null) return labelled;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return ariaLabel.trim();

  if (isImage(el)) {
    const alt = el.getAttribute('alt');
    if (alt !== null) return alt.trim();
  }

  if (isInput(el) || isTextArea(el) || isSelect(el)) {
    const labels = el.labels;
    if (labels !== null && labels.length > 0) {
      const text = [...labels]
        .map((l) => collapse(textWithoutHidden(l)))
        .join(' ')
        .trim();
      if (text.length > 0) return text;
    }
    if (isInput(el) || isTextArea(el)) {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder.trim().length > 0) return placeholder.trim();
    }
  }

  if (NAME_FROM_CONTENT.has(getRole(el))) {
    const text = collapse(textWithoutHidden(el));
    if (text.length > 0) return text;
  }

  const title = el.getAttribute('title');
  if (title !== null && title.trim().length > 0) return title.trim();

  return '';
}

function ariaBool(el: Element, attr: string): boolean | undefined {
  const value = el.getAttribute(attr);
  if (null === value) return undefined;
  return 'true' === value;
}

/**
 * The set of states relevant to assertions. `visible` is an O(depth) forced-style walk; callers that
 * already computed it (describe) pass it in so it isn't resolved twice per element.
 */
export function getStates(
  el: Element,
  visible: boolean = isVisible(el),
  visMemo?: Map<Element, boolean>,
): ElementState[] {
  const states: ElementState[] = [ElementState.PRESENT];
  states.push(visible ? ElementState.VISIBLE : ElementState.HIDDEN);

  const disabledProp =
    (isButton(el) || isInput(el) || isSelect(el) || isTextArea(el)) && el.disabled;
  const disabled = disabledProp || true === ariaBool(el, 'aria-disabled');
  states.push(disabled ? ElementState.DISABLED : ElementState.ENABLED);

  const checkedProp = isInput(el) && ('checkbox' === el.type || 'radio' === el.type) && el.checked;
  if (checkedProp || true === ariaBool(el, 'aria-checked')) states.push(ElementState.CHECKED);
  if (true === ariaBool(el, 'aria-expanded')) states.push(ElementState.EXPANDED);
  if (el.ownerDocument.activeElement === el) states.push(ElementState.FOCUSED);
  if (visible && isInViewport(el, visMemo)) states.push(ElementState.IN_VIEWPORT);

  return states;
}

/**
 * True when a form field holds a secret the SDK must never capture verbatim — a password input, a
 * sensitive `autocomplete` (cc-number, one-time-code, …), or a name/id/testid/aria-label that trips
 * `isSensitiveKey`. The single source of truth for both live-snapshot redaction (`getValue`) and the
 * flow recorder's fill-value redaction, so recorded flows never persist typed passwords/OTPs/keys.
 */
export function isSensitiveField(el: Element): boolean {
  if (!isInput(el) && !isTextArea(el) && !isSelect(el)) {
    return false;
  }
  const autocomplete = el.getAttribute('autocomplete') ?? '';
  const identifiers = [
    el.getAttribute('name') ?? '',
    el.id,
    el.getAttribute('data-testid') ?? '',
    el.getAttribute('aria-label') ?? '',
  ];
  const sensitiveAutocomplete =
    /current-password|new-password|cc-number|cc-csc|one-time-code/i.test(autocomplete);
  return (
    (isInput(el) && 'password' === el.type.toLowerCase()) ||
    sensitiveAutocomplete ||
    identifiers.some(isSensitiveKey)
  );
}

export function getValue(el: Element): string | undefined {
  if (isInput(el) || isTextArea(el) || isSelect(el)) {
    if (isSensitiveField(el)) return REDACTED_VALUE;
    return el.value;
  }
  const valueNow = el.getAttribute('aria-valuenow');
  return valueNow ?? undefined;
}

/** Whether the element's OWN box hides it — one forced-style resolution, no ancestor walk. */
function selfHidden(el: Element): boolean {
  if ('true' === el.getAttribute('aria-hidden')) return true;
  if (isHtmlElement(el) && el.hidden) return true;
  const view = el.ownerDocument.defaultView;
  if (view !== null) {
    const style = view.getComputedStyle(el);
    if (
      'none' === style.display ||
      'hidden' === style.visibility ||
      'collapse' === style.visibility
    ) {
      return true;
    }
    if (0 === Number.parseFloat(style.opacity || '1')) return true;
  }
  return false;
}

/**
 * Whether the element is actually visible (not display:none/hidden/aria-hidden/opacity:0), walking to
 * root. This is an O(depth) forced-style walk PER node; `memo` (optional, scoped to ONE synchronous
 * query pass) caches the full inherited result per element so a broad state-filtered query stops
 * re-resolving getComputedStyle up the same ancestor chain for every sibling. Sound because the DOM is
 * static for the pass's duration — the cache MUST be a per-call Map, never module-level (that would go
 * stale the instant the app mutates, the same trap the shadow-root note in query.ts documents).
 */
export function isVisible(el: Element, memo?: Map<Element, boolean>): boolean {
  if (!el.isConnected) return false;
  const cached = memo?.get(el);
  if (cached !== undefined) return cached;
  const parent = el.parentElement;
  // Each cached boolean already folds in that node's own aria-hidden/[hidden]/display/visibility/opacity,
  // so inherited visibility composes by AND up the chain and a sibling short-circuits at the first
  // cached ancestor.
  const result = !selfHidden(el) && (null === parent || isVisible(parent, memo));
  if (memo !== undefined) memo.set(el, result);
  return result;
}

interface ViewportBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function hasLayout(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

/** True when the two boxes share any area (partial overlap counts as in-view). */
function rectsIntersect(a: ViewportBox, b: ViewportBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function windowViewport(win: Window): ViewportBox {
  return { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
}

/** Padding-box clip region of `el` in viewport coordinates — the area overflow can hide against. */
function clientViewportBox(el: Element): ViewportBox {
  const border = el.getBoundingClientRect();
  if (!(el instanceof HTMLElement)) {
    return {
      left: border.left,
      top: border.top,
      right: border.right,
      bottom: border.bottom,
    };
  }
  const left = border.left + el.clientLeft;
  const top = border.top + el.clientTop;
  return {
    left,
    top,
    right: left + el.clientWidth,
    bottom: top + el.clientHeight,
  };
}

function overflowClips(style: CSSStyleDeclaration): boolean {
  return style.overflowX !== 'visible' || style.overflowY !== 'visible';
}

function isScrollContainer(el: HTMLElement): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style === undefined) return false;
  const scrollableY =
    ('auto' === style.overflowY || 'scroll' === style.overflowY) &&
    el.scrollHeight > el.clientHeight;
  const scrollableX =
    ('auto' === style.overflowX || 'scroll' === style.overflowX) && el.scrollWidth > el.clientWidth;
  return scrollableY || scrollableX;
}

function ancestorClips(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return overflowClips(getComputedStyle(el));
  return overflowClips(getComputedStyle(el)) || isScrollContainer(el);
}

/**
 * Whether `el` intersects the visible clip of the window and every clipping ancestor.
 *
 * Unlike `isVisible`, this is pure geometry: a CSS-visible row below the document fold or scrolled
 * out of an overflow panel is still `visible` but not `inViewport`. Hidden/zero-area elements are
 * never in-viewport.
 */
export function isInViewport(el: Element, memo?: Map<Element, boolean>): boolean {
  if (!isVisible(el, memo)) return false;
  if ('function' !== typeof el.getBoundingClientRect) return false;
  const rect = el.getBoundingClientRect();
  if (!hasLayout(rect)) return false;
  const win = el.ownerDocument.defaultView;
  if (null === win) return false;
  const box: ViewportBox = {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
  if (!rectsIntersect(box, windowViewport(win))) return false;
  let parent = el.parentElement;
  while (parent !== null) {
    if (ancestorClips(parent)) {
      if (!rectsIntersect(box, clientViewportBox(parent))) return false;
    }
    parent = parent.parentElement;
  }
  return true;
}

const MAX_TEXT = 80;

function getVisibleText(el: Element): string {
  const text = collapse(el.textContent ?? '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Build the compact descriptor surfaced to the agent. `memo` (optional) shares the per-call
 * visibility cache with the query's state filter so ancestors aren't re-walked per element. */
export function describe(el: Element, memo?: Map<Element, boolean>): ElementDescriptor {
  const value = getValue(el);
  const text = getVisibleText(el);
  const name = getAccessibleName(el);
  const visible = isVisible(el, memo); // O(depth) style walk — computed ONCE and reused by getStates
  const base: ElementDescriptor = {
    ref: refs.refFor(el),
    role: getRole(el),
    name,
    states: getStates(el, visible, memo),
    visible,
  };
  if (value !== undefined && value.length > 0) base.value = value;
  if (text.length > 0 && text !== name) base.text = text;
  // DOM-only lookup on purpose: describe() runs once per matched element, so the adapter's fiber walk
  // would turn a broad query into thousands of tree traversals. The stamped attribute answers the
  // same question for a fraction of the cost, and single-element paths that can afford the better
  // answer (inspect, act, review) use sourceFor() instead.
  const source = formatSource(sourceFromDom(el));
  if (source !== undefined) base.source = source;
  // Chart faults, only when there are any. Gated on the element actually containing plot geometry so
  // the common case — every non-chart element on the page — pays one querySelector miss and nothing
  // else, and a HEALTHY chart adds no bytes to the wire either.
  if (el.querySelector('path, polyline, polygon') !== null) {
    const faults = inspectChart(el).findings;
    if (faults.length > 0) base.chart = faults;
  }
  return base;
}
