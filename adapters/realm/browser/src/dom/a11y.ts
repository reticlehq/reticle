import { readTestId } from './addressing/testid-attr.js';
import {
  DEFAULT_TESTID_ATTR,
  ElementState,
  REDACTED_VALUE,
  type ElementDescriptor,
} from '@reticlehq/core';
import {
  isButton,
  isHtmlElement,
  isImage,
  isInput,
  isMeter,
  isOutput,
  isProgress,
  isSelect,
  isTextArea,
} from './realm.js';
import { refs } from './addressing/refs.js';
import { capturedRootOf } from './shadow-registry.js';
import { inspectChart } from './chart.js';
import { isSensitiveKey } from '@/security/serialization.js';
import { formatSource, sourceFromDom } from './addressing/source.js';

const HTML_DETAILS_TAG = 'details';
const HTML_DETAILS_OPEN_ATTRIBUTE = 'open';
// `localName`, not `tagName`: an XHTML document keeps `tagName` lowercase, an HTML one uppercases it.
const HTML_SUMMARY_TAG = 'summary';

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

const INPUT_TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'password', '']);

function inputRole(input: HTMLInputElement): string {
  const type = input.type.toLowerCase();
  if ('search' === type) return 'searchbox';
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
  let result = '';
  let lastWasElement = false;
  for (const child of el.childNodes) {
    const piece = textWithoutHidden(child);
    if (0 === piece.length) continue;
    const isEl = Node.ELEMENT_NODE === child.nodeType;
    if (result.length > 0 && (isEl || lastWasElement)) result += ' ';
    result += piece;
    lastWasElement = isEl;
  }
  return result;
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

  // `.labels` exists on every labelable element (input, textarea, select, button, meter, output,
  // progress) per the HTML spec, not only the three handled below, so this read must not be gated
  // on `isInput/isTextArea/isSelect` alone: a `<button role="combobox">` (or `<meter>`/`<output>`)
  // with a native `<label for>` was falling through to its own text content or NAME_FROM_CONTENT,
  // and a `by: role` + name lookup for it found nothing.
  //
  // It must still be gated on THAT full labelable set, and not read unconditionally: this function
  // runs over every element a snapshot walks, including custom elements an app defines with its own
  // `labels` property for its own purposes, so touching `.labels` on a non-labelable element risks a
  // hostile getter or a value that isn't a NodeList.
  const isLabelable =
    isInput(el) ||
    isTextArea(el) ||
    isSelect(el) ||
    isButton(el) ||
    isMeter(el) ||
    isOutput(el) ||
    isProgress(el);
  if (isLabelable) {
    const labels = el.labels;
    if (labels !== null && labels.length > 0) {
      const text = [...labels]
        .map((l) => collapse(textWithoutHidden(l)))
        .join(' ')
        .trim();
      if (text.length > 0) return text;
    }
  }

  if ('fieldset' === el.tagName.toLowerCase()) {
    const legend = [...el.children].find((child) => 'legend' === child.tagName.toLowerCase());
    if (legend !== undefined) {
      const text = collapse(textWithoutHidden(legend));
      if (text.length > 0) return text;
    }
  }

  if (isInput(el) || isTextArea(el) || isSelect(el)) {
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
  if (true === ariaBool(el, 'aria-pressed')) states.push(ElementState.PRESSED);
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
    readTestId(el) ?? '',
    el.getAttribute(DEFAULT_TESTID_ATTR) ?? '',
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

/**
 * Whether the nearest `<details>` ancestor is closed and does not keep this element on screen.
 *
 * A closed native `<details>` unrenders its content — everything except its first `<summary>`
 * child — without setting `display:none` on it, and in some engines the content keeps a layout
 * box, so the own-box signals cannot see it. Reported from the field: a control inside a closed
 * `<details>` read as `visible`, and the expanding click returned `already_true`/no-fault. Only
 * the first summary child stays on screen; an element inside it stays visible, and a nested open
 * `<details>` inside a closed one is still hidden — the ancestor walk in isVisible composes it.
 */
function hiddenInsideClosedDetails(el: Element): boolean {
  const parent = el.parentElement;
  if (null === parent) return false;
  const details = parent.closest(HTML_DETAILS_TAG);
  if (null === details || details.hasAttribute(HTML_DETAILS_OPEN_ATTRIBUTE)) return false;
  // The first `<summary>` CHILD, read from `children` rather than `:scope > summary`: inside a
  // shadow root some selector engines answer `:scope` with nothing, and every summary slotted
  // content sits under then read as hidden.
  const summary = Array.from(details.children).find(
    (child) => HTML_SUMMARY_TAG === child.localName,
  );
  return summary === undefined || !summary.contains(el);
}

/**
 * Opacity 0 because a fade-in is stalled, not because the app hides it. A hidden tab's animations do
 * not advance, so a fading element sits at its first frame and every "visible?" asked of it disagreed
 * with the element being rendered (#793). Only on a hidden tab, and only with an animation still live
 * on the element; at rest, opacity 0 is hidden.
 */
function stalledFade(el: Element): boolean {
  if (!el.ownerDocument.hidden || !('getAnimations' in el)) return false;
  return el.getAnimations().some((a) => 'running' === a.playState || a.pending);
}

/**
 * Whether the element's OWN box is hidden by a non-ARIA mechanism: CSS, the `hidden` attribute,
 * or a closed `<details>`. Shared by `selfHidden` and `isHiddenByAriaOnly` so the checks stay
 * in one place — #1111/#1112 are changing `selfHidden`, and a copy will drift.
 */
function selfCssHidden(el: Element, style: CSSStyleDeclaration | null): boolean {
  if (isHtmlElement(el) && el.hidden) return true;
  if (hiddenInsideClosedDetails(el)) return true;
  if (style !== null) {
    if (
      'none' === style.display ||
      'hidden' === style.visibility ||
      'collapse' === style.visibility
    ) {
      return true;
    }
    if (0 === Number.parseFloat(style.opacity || '1') && !stalledFade(el)) return true;
  }
  return false;
}

/**
 * Whether the element's OWN box hides it — one forced-style resolution, no composed ancestor
 * walk. The one ancestor reading is `hiddenInsideClosedDetails`, which consults only the nearest
 * `<details>` boundary; composing the chain is still isVisible's job.
 */
function selfHidden(el: Element, style: CSSStyleDeclaration | null): boolean {
  if ('true' === el.getAttribute('aria-hidden')) return true;
  return selfCssHidden(el, style);
}

/**
 * Whether the element is hidden ONLY because of `aria-hidden="true"` on itself or an ancestor,
 * and not by any CSS/HTML mechanism. Walks the full ancestor chain across shadow boundaries.
 *
 * Returns `false` when ANY ancestor has `display:none`, `visibility:hidden`, `opacity:0`,
 * `[hidden]`, or sits inside a closed `<details>` — in those cases the element is invisible
 * regardless of `aria-hidden`, and blaming the attribute would mislead the caller (#1070).
 */
export function isHiddenByAriaOnly(el: Element): boolean {
  let foundAriaHidden = false;
  let current: Element | null = el;
  while (null !== current) {
    if ('true' === current.getAttribute('aria-hidden')) foundAriaHidden = true;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current) ?? null;
    if (selfCssHidden(current, style)) return false;
    current = parentAcrossShadowBoundary(current);
  }
  return foundAriaHidden;
}

/**
 * Whether the element is rendered on screen AND not inside an `aria-hidden` subtree.
 * Returns `false` when any ancestor is CSS-hidden OR carries `aria-hidden="true"`.
 * Used by the hint builder to suppress the aria-hidden note when a visible, accessible
 * element also carries the searched text (#1070).
 */
export function isRenderedOutsideAriaHidden(el: Element): boolean {
  let current: Element | null = el;
  while (null !== current) {
    if ('true' === current.getAttribute('aria-hidden')) return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current) ?? null;
    if (selfCssHidden(current, style)) return false;
    current = parentAcrossShadowBoundary(current);
  }
  return true;
}

/**
 * The slot a light-DOM child renders in when its host's shadow root is CLOSED. `assignedSlot` is
 * null there by design, but a root the registry captured can still be asked from inside which of
 * its slots holds the child. Null when the host has no captured closed root.
 */
function slotInCapturedClosedRoot(el: Element): HTMLSlotElement | null {
  const host = el.parentElement;
  if (null === host || null !== host.shadowRoot) return null;
  const root = capturedRootOf(host);
  if (null === root) return null;
  for (const slot of Array.from(root.querySelectorAll('slot'))) {
    if (slot.assignedElements().includes(el)) return slot;
  }
  return null;
}

/**
 * The next node up the COMPOSED tree: the assigned slot for slotted content, else `parentElement`,
 * or the shadow host when the walk reaches the top of a shadow tree. A ShadowRoot is a DocumentFragment, so `parentElement` is null there,
 * and query candidates include shadow content (open roots always, captured closed roots too — see
 * `embeddedRootsUnder`). Without the hop, nothing that hides the host — a closed `<details>`,
 * display:none, aria-hidden — is ever seen by the walk inside the host's shadow tree.
 */
function parentAcrossShadowBoundary(el: Element): Element | null {
  // A SLOTTED element renders where its slot is, not as a child of the host: its composed parent
  // is `assignedSlot`, inside the host's shadow tree. Going straight to `parentElement` (the host)
  // skipped every ancestor of the slot, so light-DOM content slotted into a closed `<details>` in a
  // component's shadow root still read visible (#1175). A closed root reports no `assignedSlot`, so
  // for one Reticle captured the slot is found from inside it; an uncaptured one falls back to the
  // host as before.
  const slot = el.assignedSlot ?? slotInCapturedClosedRoot(el);
  if (null !== slot) return slot;
  if (null !== el.parentElement) return el.parentElement;
  // `host` exists on a ShadowRoot and not on a Document, the other thing getRootNode() returns
  // for a connected element.
  const host: Element | undefined = (el.getRootNode() as Partial<ShadowRoot>).host;
  return host ?? null;
}

const CLIPPING_OVERFLOW = new Set(['hidden', 'clip']);
const NON_CLIPPING_DISPLAY = new Set([
  'contents',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-column',
  'table-column-group',
]);
const TRANSFORM_CONTAINING_BLOCK_PROPERTIES = new Set([
  'transform',
  'translate',
  'rotate',
  'scale',
  'perspective',
]);
const CONTAINING_BLOCK_PROPERTIES = new Set([
  ...TRANSFORM_CONTAINING_BLOCK_PROPERTIES,
  'filter',
  'backdrop-filter',
]);
const CONTAINING_BLOCK_CONTAIN = new Set(['layout', 'paint', 'strict', 'content']);
const REPLACED_INLINE_TAGS = new Set([
  'img',
  'video',
  'audio',
  'canvas',
  'iframe',
  'embed',
  'object',
  'input',
  'textarea',
  'select',
]);

type VisibleBounds = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
interface VisibilityInfo {
  hidden: boolean;
  style: CSSStyleDeclaration | null;
  parent: Element | null;
  clipX: boolean;
  clipY: boolean;
  hasClipping: boolean;
  clipBox?: VisibleBounds;
}

// Keyed by the caller's ONE synchronous pass, so shared style/box reads live exactly as long as
// that pass. The boolean memo still stores only the result for the target itself: a parent's box
// can be clipped while a descendant overflowing back into the clipping region remains visible.
const visibilityInfoMemos = new WeakMap<Map<Element, boolean>, Map<Element, VisibilityInfo>>();

function visibilityInfoMemo(memo?: Map<Element, boolean>): Map<Element, VisibilityInfo> {
  if (memo === undefined) return new Map();
  let info = visibilityInfoMemos.get(memo);
  if (info === undefined) {
    info = new Map();
    visibilityInfoMemos.set(memo, info);
  }
  return info;
}

function ownVisibilityInfo(el: Element, memo: Map<Element, VisibilityInfo>): VisibilityInfo {
  let info = memo.get(el);
  if (info === undefined) {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
    // Own hiding needs no ancestor metadata: preserve the early return for hidden targets,
    // including deeply nested ones. This cached CSS result never stands for clipped geometry.
    if (selfHidden(el, style)) {
      info = { hidden: true, style, parent: null, clipX: false, clipY: false, hasClipping: false };
      memo.set(el, info);
      return info;
    }
    const parent = parentAcrossShadowBoundary(el);
    const inherited = null === parent ? undefined : ownVisibilityInfo(parent, memo);
    const [overflowX, overflowY] = overflowAxes(style);
    const root = el.ownerDocument.documentElement;
    // Root/body overflow propagated to the viewport stays separate from element visibility.
    const viewportOverflow =
      el === root ||
      (el === el.ownerDocument.body &&
        overflowAxes(ownVisibilityInfo(root, memo).style).every((axis) => 'visible' === axis));
    const hasClipBox =
      !viewportOverflow &&
      !NON_CLIPPING_DISPLAY.has(style?.display ?? '') &&
      !(isHtmlElement(el) && 'inline' === style?.display);
    const clipX = hasClipBox && CLIPPING_OVERFLOW.has(overflowX);
    const clipY = hasClipBox && CLIPPING_OVERFLOW.has(overflowY);
    info = {
      hidden: true === inherited?.hidden,
      style,
      parent,
      clipX,
      clipY,
      hasClipping: clipX || clipY || true === inherited?.hasClipping,
    };
    memo.set(el, info);
  }
  return info;
}

function overflowAxes(style: CSSStyleDeclaration | null): [string, string] {
  const shorthand = style?.overflow ?? '';
  const [x = 'visible', y = x] = ('' === shorthand ? 'visible' : shorthand).split(/\s+/);
  return [
    null === style || '' === style.overflowX ? x : style.overflowX,
    null === style || '' === style.overflowY ? y : style.overflowY,
  ];
}

function positionedContainingBlock(
  el: Element,
  fixed: boolean,
  memo: Map<Element, VisibilityInfo>,
): Element | null {
  for (
    let parent = ownVisibilityInfo(el, memo).parent;
    parent !== null;
    parent = ownVisibilityInfo(parent, memo).parent
  ) {
    const style = ownVisibilityInfo(parent, memo).style;
    if (null === style || 'contents' === style.display) continue;
    if (!fixed && '' !== style.position && 'static' !== style.position) return parent;
    // Transforms/containment do not apply to ordinary inline boxes. Filters still establish
    // containing blocks there; individual identity transforms do on transformable boxes.
    const transformable =
      !(
        'inline' === style.display &&
        isHtmlElement(parent) &&
        !REPLACED_INLINE_TAGS.has(parent.localName)
      ) &&
      'table-column' !== style.display &&
      'table-column-group' !== style.display;
    const applies = (property: string): boolean =>
      transformable || !TRANSFORM_CONTAINING_BLOCK_PROPERTIES.has(property);
    if (
      [...CONTAINING_BLOCK_PROPERTIES].some((property) => {
        const value = style.getPropertyValue(property);
        return applies(property) && '' !== value && 'none' !== value;
      }) ||
      style.willChange
        .split(',')
        .some(
          (property) =>
            CONTAINING_BLOCK_PROPERTIES.has(property.trim()) && applies(property.trim()),
        ) ||
      (transformable &&
        !NON_CLIPPING_DISPLAY.has(style.display) &&
        (style.contain.split(/\s+/).some((value) => CONTAINING_BLOCK_CONTAIN.has(value)) ||
          'auto' === style.contentVisibility))
    )
      return parent;
  }
  return null;
}

function clippingBox(el: Element, info: VisibilityInfo): VisibleBounds {
  if (info.clipBox !== undefined) return info.clipBox;
  const rect = el.getBoundingClientRect();
  const style = info.style;
  const px = (value: string | undefined): number => Number.parseFloat(value ?? '') || 0;
  const border = (value: string | undefined, kind: string | undefined): number =>
    kind === undefined || '' === kind || 'none' === kind || 'hidden' === kind ? 0 : px(value);
  const scaleX = isHtmlElement(el) && el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
  const scaleY = isHtmlElement(el) && el.offsetHeight > 0 ? rect.height / el.offsetHeight : 1;
  const left =
    isHtmlElement(el) && el.offsetWidth > 0
      ? rect.left + el.clientLeft * scaleX
      : rect.left + border(style?.borderLeftWidth, style?.borderLeftStyle);
  const top =
    isHtmlElement(el) && el.offsetHeight > 0
      ? rect.top + el.clientTop * scaleY
      : rect.top + border(style?.borderTopWidth, style?.borderTopStyle);
  const right =
    isHtmlElement(el) && el.offsetWidth > 0
      ? left + el.clientWidth * scaleX
      : rect.right - border(style?.borderRightWidth, style?.borderRightStyle);
  const bottom =
    isHtmlElement(el) && el.offsetHeight > 0
      ? top + el.clientHeight * scaleY
      : rect.bottom - border(style?.borderBottomWidth, style?.borderBottomStyle);
  const margin = (style?.overflowClipMargin ?? '').split(/\s+/);
  const outset = px(margin.at(-1));
  const borderBox = margin.includes('border-box');
  const contentBox = margin.includes('content-box');
  const [x, y] = overflowAxes(style);
  const clipLeft =
    'clip' === x
      ? (borderBox ? rect.left : left + (contentBox ? px(style?.paddingLeft) * scaleX : 0)) -
        outset * scaleX
      : left;
  const clipRight =
    'clip' === x
      ? (borderBox ? rect.right : right - (contentBox ? px(style?.paddingRight) * scaleX : 0)) +
        outset * scaleX
      : right;
  const clipTop =
    'clip' === y
      ? (borderBox ? rect.top : top + (contentBox ? px(style?.paddingTop) * scaleY : 0)) -
        outset * scaleY
      : top;
  const clipBottom =
    'clip' === y
      ? (borderBox ? rect.bottom : bottom - (contentBox ? px(style?.paddingBottom) * scaleY : 0)) +
        outset * scaleY
      : bottom;
  info.clipBox = {
    left: clipLeft,
    right: clipRight,
    top: clipTop,
    bottom: clipBottom,
    width: clipRight - clipLeft,
    height: clipBottom - clipTop,
  };
  return info.clipBox;
}

/** Undefined means no box was needed; null means hidden. Only real clipping reads layout. */
function visibleBounds(
  el: Element,
  memo: Map<Element, VisibilityInfo>,
  initial?: VisibleBounds,
): VisibleBounds | null | undefined {
  let bounds = initial;
  const target = ownVisibilityInfo(el, memo);
  if (target.hidden) return null;
  // CSS hiding composes, geometry does not. An unclipped ancestor chain needs no layout reads
  // or repeated walk; a clipped parent can still have a descendant overflowing back into view.
  if (null === target.parent || !ownVisibilityInfo(target.parent, memo).hasClipping) return bounds;
  let clipFrom: Element | null | undefined;
  for (
    let current: Element | null = el;
    current !== null;
    current = ownVisibilityInfo(current, memo).parent
  ) {
    const info = ownVisibilityInfo(current, memo);
    if (info.hidden) return null;
    if (current === clipFrom) clipFrom = undefined;
    const style = info.style;
    if (current !== el && undefined === clipFrom && (info.clipX || info.clipY)) {
      bounds ??= el.getBoundingClientRect();
      // Preserve the existing visibility semantics for elements without an own layout box
      // (including display:contents); inViewport still requires a positive-size box.
      if (bounds.width > 0 && bounds.height > 0) {
        const clip = clippingBox(current, info);
        const left = info.clipX ? Math.max(bounds.left, clip.left) : bounds.left;
        const right = info.clipX ? Math.min(bounds.right, clip.right) : bounds.right;
        const top = info.clipY ? Math.max(bounds.top, clip.top) : bounds.top;
        const bottom = info.clipY ? Math.min(bounds.bottom, clip.bottom) : bounds.bottom;
        if (right <= left || bottom <= top) return null;
        bounds = { left, right, top, bottom, width: right - left, height: bottom - top };
      }
    }
    // Positioned subtrees escape clips before their containing block. Find it in the composed
    // tree: offsetParent is retargeted outside shadow roots and misses positioned slot wrappers.
    if (clipFrom === undefined && ('absolute' === style?.position || 'fixed' === style?.position)) {
      clipFrom = positionedContainingBlock(current, 'fixed' === style?.position, memo);
    }
  }
  return bounds;
}

/**
 * True when the visible portion of the element's box intersects the window. Ordinary off-window
 * document content remains `visible`/`present`, so this separate state makes a scroll assertable
 * (#398). getBoundingClientRect already accounts for scrolling; ancestor clips further constrain
 * the region that can intersect the viewport. The check stays synchronous inside the predicate pass.
 */
export function isInViewport(el: Element, memo?: Map<Element, boolean>): boolean {
  if (!isVisible(el, memo)) return false;
  const view = el.ownerDocument.defaultView;
  if (null === view) return false;
  const r = visibleBounds(el, visibilityInfoMemo(memo), el.getBoundingClientRect());
  if (null === r || undefined === r) return false;
  if (r.width <= 0 || r.height <= 0) return false;
  return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
}

/** Visibility combines inherited CSS/ARIA hiding with this target's surviving clipping region. */
export function isVisible(el: Element, memo?: Map<Element, boolean>): boolean {
  if (!el.isConnected) return false;
  const cached = memo?.get(el);
  if (cached !== undefined) return cached;
  const result = visibleBounds(el, visibilityInfoMemo(memo)) !== null;
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
