import { isHtmlElement } from './realm.js';
import { parentAcrossShadowBoundary } from './shadow-registry.js';
import {
  clippingBox,
  overflowAxes,
  scrolledInto,
  type VisibilityInfo,
  type VisibleBounds,
} from './paint-context.js';

export const HTML_DETAILS_TAG = 'details';
export const HTML_DETAILS_OPEN_ATTRIBUTE = 'open';
// `localName`, not `tagName`: an XHTML document keeps `tagName` lowercase, an HTML one uppercases it.
export const HTML_SUMMARY_TAG = 'summary';

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
  if (null === parent) {
    return false;
  }
  const details = parent.closest(HTML_DETAILS_TAG);
  if (null === details || details.hasAttribute(HTML_DETAILS_OPEN_ATTRIBUTE)) {
    return false;
  }
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
  if (!el.ownerDocument.hidden || !('getAnimations' in el)) {
    return false;
  }
  return el.getAnimations().some((a) => 'running' === a.playState || a.pending);
}

/**
 * The attribute an open menu or dialog stamps beside the `aria-hidden` it puts on the rest of the
 * page (the `aria-hidden` package Radix and most kits use). That hides the page from assistive tech
 * while the overlay is up; the page is still on screen. Read as hidden, the header's project picker
 * and the menu it opened were graded `hidden_match` while both were on screen and focused.
 */
const OVERLAY_ARIA_HIDDEN = 'data-aria-hidden';

function hiddenByAnOverlay(el: Element): boolean {
  return el.hasAttribute(OVERLAY_ARIA_HIDDEN);
}

/**
 * Whether the element's OWN box is hidden by a non-ARIA mechanism: CSS, the `hidden` attribute,
 * or a closed `<details>`. Shared by `selfHidden` and `isHiddenByAriaOnly` so the checks stay
 * in one place — #1111/#1112 are changing `selfHidden`, and a copy will drift.
 */
function selfCssHidden(el: Element, style: CSSStyleDeclaration | null): boolean {
  if (isHtmlElement(el) && el.hidden) {
    return true;
  }
  if (hiddenInsideClosedDetails(el)) {
    return true;
  }
  if (style !== null) {
    if (
      'none' === style.display ||
      'hidden' === style.visibility ||
      'collapse' === style.visibility
    ) {
      return true;
    }
    if (0 === Number.parseFloat(style.opacity || '1') && !stalledFade(el)) {
      return true;
    }
    if (clippedAway(style)) {
      return true;
    }
  }
  return false;
}

/**
 * The visually-hidden (sr-only) pattern keeps text for screen readers and paints none of it: a
 * `clip: rect()` with no area on a positioned box, or a `clip-path: inset()` whose edges meet.
 */
function clippedAway(style: CSSStyleDeclaration): boolean {
  const rect = /^rect\((.*)\)$/.exec(style.getPropertyValue('clip').trim());
  if (null !== rect && ('absolute' === style.position || 'fixed' === style.position)) {
    const [top, right, bottom, left] = (rect[1] ?? '').split(/[\s,]+/).map(Number.parseFloat);
    // `auto` edges parse as NaN and leave that side unclipped.
    if (right !== undefined && left !== undefined && right <= left) {
      return true;
    }
    if (bottom !== undefined && top !== undefined && bottom <= top) {
      return true;
    }
  }
  const inset = /^inset\(([^)]*)\)$/.exec(style.getPropertyValue('clip-path').trim());
  const edges =
    inset?.[1]
      ?.split(/\s+round\s/)[0]
      ?.trim()
      .split(/\s+/) ?? [];
  // Percentages and zero lengths can be judged without layout.
  const known = (edge: string): boolean => edge.endsWith('%') || 0 === Number.parseFloat(edge);
  if (0 === edges.length || !edges.every(known)) {
    return false;
  }
  const [top = 0, right = top, bottom = top, left = right] = edges.map(Number.parseFloat);
  return top + bottom >= 100 || left + right >= 100;
}

/**
 * Whether the element's OWN box hides it — one forced-style resolution, no composed ancestor
 * walk. The one ancestor reading is `hiddenInsideClosedDetails`, which consults only the nearest
 * `<details>` boundary; composing the chain is still isVisible's job.
 */
function selfHidden(el: Element, style: CSSStyleDeclaration | null): boolean {
  if ('true' === el.getAttribute('aria-hidden') && !hiddenByAnOverlay(el)) {
    return true;
  }
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
    if ('true' === current.getAttribute('aria-hidden')) {
      foundAriaHidden = true;
    }
    const style = current.ownerDocument.defaultView?.getComputedStyle(current) ?? null;
    if (selfCssHidden(current, style)) {
      return false;
    }
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
    if ('true' === current.getAttribute('aria-hidden')) {
      return false;
    }
    const style = current.ownerDocument.defaultView?.getComputedStyle(current) ?? null;
    if (selfCssHidden(current, style)) {
      return false;
    }
    current = parentAcrossShadowBoundary(current);
  }
  return true;
}

const CLIPPING_OVERFLOW = new Set(['hidden', 'clip']);
/** A box a person can scroll: what it holds past its edge is below the fold, not hidden. */
const SCROLLING_OVERFLOW = new Set(['auto', 'scroll']);
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

// Keyed by the caller's ONE synchronous pass, so shared style/box reads live exactly as long as
// that pass. The boolean memo still stores only the result for the target itself: a parent's box
// can be clipped while a descendant overflowing back into the clipping region remains visible.
const visibilityInfoMemos = new WeakMap<Map<Element, boolean>, Map<Element, VisibilityInfo>>();

function visibilityInfoMemo(memo?: Map<Element, boolean>): Map<Element, VisibilityInfo> {
  if (memo === undefined) {
    return new Map();
  }
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
      info = {
        hidden: true,
        style,
        parent: null,
        clipX: false,
        clipY: false,
        scrollX: false,
        scrollY: false,
        hasClipping: false,
      };
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
      scrollX: hasClipBox && SCROLLING_OVERFLOW.has(overflowX),
      scrollY: hasClipBox && SCROLLING_OVERFLOW.has(overflowY),
      hasClipping: clipX || clipY || true === inherited?.hasClipping,
    };
    memo.set(el, info);
  }
  return info;
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
    if (null === style || 'contents' === style.display) {
      continue;
    }
    if (!fixed && '' !== style.position && 'static' !== style.position) {
      return parent;
    }
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
    ) {
      return parent;
    }
  }
  return null;
}

/** Undefined means no box was needed; null means hidden. Only real clipping reads layout. */
function visibleBounds(
  el: Element,
  memo: Map<Element, VisibilityInfo>,
  initial?: VisibleBounds,
  /**
   * Read a box scrolled out of a scroll container as if scrolled back in, so a clip ABOVE the
   * container judges where a person would see it. Visibility asks this; the viewport check does not.
   */
  throughScrollers = false,
): VisibleBounds | null | undefined {
  let bounds = initial;
  const target = ownVisibilityInfo(el, memo);
  if (target.hidden) {
    return null;
  }
  // CSS hiding composes, geometry does not. An unclipped ancestor chain needs no layout reads
  // or repeated walk; a clipped parent can still have a descendant overflowing back into view.
  if (null === target.parent || !ownVisibilityInfo(target.parent, memo).hasClipping) {
    return bounds;
  }
  let clipFrom: Element | null | undefined;
  for (
    let current: Element | null = el;
    current !== null;
    current = ownVisibilityInfo(current, memo).parent
  ) {
    const info = ownVisibilityInfo(current, memo);
    if (info.hidden) {
      return null;
    }
    if (current === clipFrom) {
      clipFrom = undefined;
    }
    const style = info.style;
    // An app shell (`overflow: hidden`, full height) around a scrolling main read every row below
    // the fold as hidden: the row sat outside the shell's box though one scroll brings it in.
    if (
      throughScrollers &&
      current !== el &&
      undefined === clipFrom &&
      (info.scrollX || info.scrollY)
    ) {
      bounds ??= el.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        bounds = scrolledInto(bounds, clippingBox(current, info), info.scrollX, info.scrollY);
      }
    }
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
        if (right <= left || bottom <= top) {
          return null;
        }
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
  if (!isVisible(el, memo)) {
    return false;
  }
  const view = el.ownerDocument.defaultView;
  if (null === view) {
    return false;
  }
  const r = visibleBounds(el, visibilityInfoMemo(memo), el.getBoundingClientRect());
  if (null === r || undefined === r) {
    return false;
  }
  if (r.width <= 0 || r.height <= 0) {
    return false;
  }
  return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
}

/**
 * A box of no size that clips its own overflow shows nothing: a control collapsed to 0×0 read
 * `visible` and a visible-state check on it held. Only an element that clips is judged, because an
 * unclipped one can still show content overflowing it; one with no layout box (display: contents)
 * is left alone. A 1×1 box clipped on both axes is the sr-only pattern and shows nothing either.
 */
function collapsed(el: Element, memo: Map<Element, VisibilityInfo>): boolean {
  const own = ownVisibilityInfo(el, memo);
  if (!own.clipX && !own.clipY) {
    return false;
  }
  const rects = Array.from(el.getClientRects());
  return (
    rects.length > 0 &&
    rects.every(
      (r) =>
        (own.clipX && 0 === r.width) ||
        (own.clipY && 0 === r.height) ||
        (own.clipX && own.clipY && r.width <= 1 && r.height <= 1),
    )
  );
}

/** Visibility combines inherited CSS/ARIA hiding with this target's surviving clipping region. */
export function isVisible(el: Element, memo?: Map<Element, boolean>): boolean {
  if (!el.isConnected) {
    return false;
  }
  const cached = memo?.get(el);
  if (cached !== undefined) {
    return cached;
  }
  const info = visibilityInfoMemo(memo);
  const result = visibleBounds(el, info, undefined, true) !== null && !collapsed(el, info);
  if (memo !== undefined) {
    memo.set(el, result);
  }
  return result;
}
