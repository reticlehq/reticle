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

/**
 * Cheap author-supplied-naming probe: an explicit `aria-label`, any `aria-labelledby`, or a
 * `title`. Attribute reads only - no name computation - so `getRole` can consult it without
 * recursion into `getAccessibleName`.
 *
 * This decides `section` -> `region`, which the implicit-role table makes CONDITIONAL: an unnamed
 * `<section>` is a plain `generic` container, while one carrying an accessible name is exposed as
 * `region`. Getting that backwards either floods every page with phantom regions or hides real
 * ones, so both halves are pinned by tests.
 */
function hasAuthorNaming(el: Element): boolean {
  const label = el.getAttribute('aria-label');
  if (label !== null && label.trim().length > 0) return true;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby !== null && labelledby.trim().length > 0) return true;
  const title = el.getAttribute('title');
  return title !== null && title.trim().length > 0;
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
    case 'tr':
      return 'row';
    case 'tbody':
    case 'thead':
    case 'tfoot':
      return 'rowgroup';
    // A cell's role follows its grid context: plain tables expose `cell`/`columnheader`,
    // while inside an explicit `role="grid"`/`role="treegrid"` the same markup is exposed as
    // `gridcell` - the pair data-grid queries actually reach for (`{ role: "cell" }` against a
    // CSS grid pretending to be a table would otherwise answer zero).
    case 'td':
      return el.closest('[role~="grid"], [role~="treegrid"]') !== null ? 'gridcell' : 'cell';
    case 'th': {
      const scope = (el.getAttribute('scope') ?? '').toLowerCase();
      return 'row' === scope || 'rowgroup' === scope ? 'rowheader' : 'columnheader';
    }
    case 'option':
      return 'option';
    case 'optgroup':
      return 'group';
    case 'section':
      return hasAuthorNaming(el) ? 'region' : 'generic';
    case 'article':
      return 'article';
    case 'fieldset':
      return 'group';
    case 'details':
      return 'group';
    case 'summary':
      return 'button';
    case 'progress':
      return 'progressbar';
    case 'meter':
      return 'meter';
    case 'output':
      return 'status';
    case 'hr':
      return 'separator';
    case 'area':
      return el.hasAttribute('href') ? 'link' : 'generic';
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
 * The accessible-name spec excludes them, and so does the matcher, because THIS function is what
 * `by: role` + name matches through. Reading raw `textContent` here made the name we REPORT differ
 * from the name that can be SELECTED: Material UI renders its required-field marker as
 * `<span aria-hidden="true"> *</span>`, so a login field was reported as `"Username *"` and
 * addressable only as `"Username"`. Reporting a name the agent cannot use defeats the purpose of
 * reporting it at all, so both come from the same rule.
 *
 * An `<img alt>` contributes its alt text the way the spec's subtree step treats embedded
 * alternatives: `<button><img alt="Close"></button>` is named "Close", not nameless. Pieces are
 * joined with spaces so an icon followed by a word never fuses into one unmatchable token.
 */
function textWithoutHidden(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if ('true' === el.getAttribute('aria-hidden')) return '';
  if (isImage(el)) {
    const alt = el.getAttribute('alt');
    return null === alt ? '' : alt;
  }
  const parts: string[] = [];
  for (const child of el.childNodes) {
    const piece = textWithoutHidden(child);
    if (piece.length > 0) parts.push(piece);
  }
  return parts.join(' ');
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
    // Submit-like inputs carry their name on `value`, exactly where the visible caption comes
    // from: `<input type="submit" value="Send">` renders a button reading Send. Without this the
    // descriptor printed `button ""` while `by: text` found the very same input by "Send", so the
    // two locators disagreed about one element - the disagreement this engine exists to prevent.
    if (isInput(el)) {
      const type = el.type.toLowerCase();
      if ('submit' === type || 'button' === type || 'reset' === type) {
        const value = collapse(el.value);
        if (value.length > 0) return value;
      }
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
export function getStates(el: Element, visible: boolean = isVisible(el)): ElementState[] {
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
/**
 * True when the element is inside the viewport right now: visible AND its bounding box intersects
 * the window. This is what makes a scroll assertable (#398) — content below the fold of a scrolling
 * container is `visible`/`present` before any scroll, so only a viewport-intersection check can tell
 * "scrolled into view" from "was always in the DOM". Uses getBoundingClientRect (viewport-relative,
 * already accounts for scroll position), not an IntersectionObserver, so it stays synchronous inside
 * the predicate pass.
 */
export function isInViewport(el: Element, memo?: Map<Element, boolean>): boolean {
  if (!isVisible(el, memo)) return false;
  const view = el.ownerDocument.defaultView;
  if (null === view) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
}

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
    states: getStates(el, visible),
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
