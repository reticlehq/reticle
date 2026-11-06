import { RETICLE_OVERLAY_SELECTOR } from '@reticlehq/core';
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
  const d = el.parentElement?.closest(HTML_DETAILS_TAG);
  if (!d || d.hasAttribute(HTML_DETAILS_OPEN_ATTRIBUTE)) {
    return false;
  }
  for (const c of d.children) {
    if (HTML_SUMMARY_TAG === c.localName) {
      return !c.contains(el);
    }
  }
  return true;
}

/**
 * Opacity 0 because a fade-in is stalled, not because the app hides it. A hidden tab's animations do
 * not advance, so a fading element sits at its first frame and every "visible?" asked of it disagreed
 * with the element being rendered (#793). Only on a hidden tab, and only with an animation still live
 * on the element; at rest, opacity 0 is hidden. `unreadableText` asks the same of opacity.
 */
export function stalledFade(el: Element): boolean {
  return (
    el.ownerDocument.hidden &&
    'getAnimations' in el &&
    el.getAnimations().some((a) => 'running' === a.playState || a.pending)
  );
}

/**
 * The attribute an open menu or dialog stamps beside the `aria-hidden` it puts on the rest of the
 * page (the `aria-hidden` package Radix and most kits use). That hides the page from assistive tech
 * while the overlay is up; the page is still on screen. Read as hidden, the header's project picker
 * and the menu it opened were graded `hidden_match` while both were on screen and focused.
 */
const OVERLAY_ARIA_HIDDEN = 'data-aria-hidden';

/** An open menu, list or dialog, as overlay libraries and native dialogs mark one. */
const OPEN_LAYER =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open], [aria-modal="true"]';

export function isNonRendered(el: Element): boolean {
  return /^(script|style|template|noscript)$/i.test(el.tagName);
}

const isUnpaintedTag = (t: string): boolean =>
  /^(script|style|template|noscript|link|meta)$/.test(t);

function hiddenByAnOverlay(el: Element): boolean {
  if (el.hasAttribute(OVERLAY_ARIA_HIDDEN)) {
    return true;
  }
  return hiddenByAModalManager(el);
}

/**
 * MUI's ModalManager and react-modal hide the page behind an open menu or dialog with a bare
 * `aria-hidden`, without the stamp. Their signature: the open layer is a child of `<body>`, and every
 * other painted child of `<body>` carries `aria-hidden`. An app's own `aria-hidden` (a closed drawer)
 * leaves the app root unhidden, so it does not match, and it still hides.
 */
function hiddenByAModalManager(el: Element): boolean {
  const body = el.ownerDocument.body;
  if (el.parentElement !== body) {
    return false;
  }
  let openLayer: Element | undefined;
  let openCount = 0;
  for (const child of body.children) {
    if (
      child !== el &&
      !isUnpaintedTag(child.localName) &&
      !child.matches(RETICLE_OVERLAY_SELECTOR) &&
      'true' !== child.getAttribute('aria-hidden')
    ) {
      openCount += 1;
      openLayer = child;
    }
  }
  return 1 === openCount && openLayer !== undefined && holdsOpenLayer(openLayer);
}

/**
 * Whether `portal` is, or holds, an open layer that its own styles do not hide. Own styles only, up
 * to `portal`: an ancestor walk would ask isVisible, which asks this again.
 */
function holdsOpenLayer(portal: Element): boolean {
  for (
    let n: Element | null = portal.matches(OPEN_LAYER) ? portal : portal.querySelector(OPEN_LAYER);
    null !== n;
    n = n.parentElement
  ) {
    if (selfCssHidden(n, n.ownerDocument.defaultView?.getComputedStyle(n) ?? null)) {
      return false;
    }
    if (n === portal) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the element's OWN box is hidden by a non-ARIA mechanism: CSS, the `hidden` attribute,
 * or a closed `<details>`. Shared by `selfHidden` and `isHiddenByAriaOnly` so the checks stay
 * in one place — #1111/#1112 are changing `selfHidden`, and a copy will drift.
 */
function selfCssHidden(
  el: Element,
  style: CSSStyleDeclaration | null,
  includeVisibility = true,
): boolean {
  if (isHtmlElement(el) && el.hidden) {
    return true;
  }
  if (hiddenInsideClosedDetails(el)) {
    return true;
  }
  if (null === style) {
    return false;
  }
  return (
    'none' === style.display ||
    (includeVisibility && visibilityHidden(style)) ||
    (0 === Number.parseFloat(style.opacity || '1') && !stalledFade(el)) ||
    clippedAway(style)
  );
}

/** CSS computes inherited visibility for each element, including a descendant override. */
function visibilityHidden(style: CSSStyleDeclaration | null): boolean {
  return 'hidden' === style?.visibility || 'collapse' === style?.visibility;
}

/**
 * The visually-hidden (sr-only) pattern keeps text for screen readers and paints none of it: a
 * `clip: rect()` with no area on a positioned box, or a `clip-path: inset()` whose edges meet.
 */
function clippedAway(style: CSSStyleDeclaration): boolean {
  const rect = /^rect\((.*)\)$/.exec(style.getPropertyValue('clip').trim());
  if (null !== rect && ('absolute' === style.position || 'fixed' === style.position)) {
    const [top, right, bottom, left] = (rect[1] ?? '').split(/[\s,]+/).map(Number.parseFloat);
    if (
      (right !== undefined && left !== undefined && right <= left) ||
      (bottom !== undefined && top !== undefined && bottom <= top)
    ) {
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
 * Whether the element hides its whole subtree — one forced-style resolution, no composed ancestor
 * walk. The one ancestor reading is `hiddenInsideClosedDetails`, which consults only the nearest
 * `<details>` boundary; composing the chain is still isVisible's job.
 */
function selfHidden(
  el: Element,
  style: CSSStyleDeclaration | null,
  ignoreAriaHidden = false,
): boolean {
  if (!ignoreAriaHidden && 'true' === el.getAttribute('aria-hidden') && !hiddenByAnOverlay(el)) {
    return true;
  }
  return selfCssHidden(el, style, false);
}

/**
 * Whether the element is hidden ONLY because of `aria-hidden="true"` on itself or an ancestor,
 * and not by any CSS/HTML mechanism. Walks the full ancestor chain across shadow boundaries.
 *
 * Returns `false` when the target has hidden visibility, or any ancestor has `display:none`, `opacity:0`,
 * `[hidden]`, or sits inside a closed `<details>` — in those cases the element is invisible
 * regardless of `aria-hidden`, and blaming the attribute would mislead the caller (#1070).
 */
function isHiddenByAriaOrCss(el: Element, stopOnAria: boolean): boolean {
  let found = false;
  for (let c: Element | null = el; c !== null; c = parentAcrossShadowBoundary(c)) {
    if ('true' === c.getAttribute('aria-hidden')) {
      if (stopOnAria) {
        return false;
      }
      found = true;
    }
    if (selfCssHidden(c, c.ownerDocument.defaultView?.getComputedStyle(c) ?? null, c === el)) {
      return false;
    }
  }
  return stopOnAria || found;
}

/**
 * Whether the element is hidden solely because of an `aria-hidden="true"` attribute on itself or an
 * ancestor, and would otherwise be rendered on screen. If an ancestor is `display: none`, it is hidden
 * regardless of `aria-hidden`, and blaming the attribute would mislead the caller (#1070).
 */
export function isHiddenByAriaOnly(el: Element): boolean {
  return isHiddenByAriaOrCss(el, false);
}

/**
 * Whether the element is rendered on screen AND not inside an `aria-hidden` subtree.
 * Returns `false` when any ancestor is CSS-hidden OR carries `aria-hidden="true"`.
 * Used by the hint builder to suppress the aria-hidden note when a visible, accessible
 * element also carries the searched text (#1070).
 */
export function isRenderedOutsideAriaHidden(el: Element): boolean {
  return isHiddenByAriaOrCss(el, true);
}

const BACKFACE_VISIBILITY_HIDDEN = 'hidden';

/**
 * The resolved transform a browser reports for one element. `computedStyle.transform` is already a
 * matrix; an element with none gets the identity. `null` means the value could not be parsed, and
 * every facing above it becomes unknowable.
 */
function localTransform(style: CSSStyleDeclaration | null): DOMMatrix | null {
  if ('undefined' === typeof DOMMatrix) {
    return null;
  }
  try {
    const t = style?.transform ?? '';
    return '' === t || 'none' === t ? new DOMMatrix() : new DOMMatrix(t);
  } catch {
    return null;
  }
}

/**
 * Whether the element, or a face it sits on, turns its back to the viewer while declaring
 * `backface-visibility: hidden` (#1940). A flip card rotates a container, so the facing is the
 * transform chain from the element up to the root, not the element's own `transform`. The check
 * runs per ancestor because the declaration can sit on a face while the control inside it has no
 * transform of its own.
 */
function backfaceHidden(el: Element, memo: Map<Element, VisibilityInfo>): boolean {
  const chain: Element[] = [];
  let declares = false;
  for (let c: Element | null = el; null !== c; c = parentAcrossShadowBoundary(c)) {
    if (BACKFACE_VISIBILITY_HIDDEN === ownVisibilityInfo(c, memo).style?.backfaceVisibility) {
      declares = true;
    }
    chain.unshift(c);
  }
  if (!declares) {
    return false;
  }
  let composed: DOMMatrix | null = null;
  for (const c of chain) {
    const style = ownVisibilityInfo(c, memo).style;
    const local = localTransform(style);
    if (null === local) {
      return false;
    }
    composed = null === composed ? local : composed.multiply(local);
    if (
      BACKFACE_VISIBILITY_HIDDEN === style?.backfaceVisibility &&
      Number.isFinite(composed.m33) &&
      0 > composed.m33
    ) {
      return true;
    }
  }
  return false;
}

const isNonClippingDisplay = (d: string): boolean =>
  /^(contents|table-(row|row-group|header-group|footer-group|column|column-group))$/.test(d);
const isReplacedTag = (t: string): boolean =>
  /^(img|video|audio|canvas|iframe|embed|object|input|textarea|select)$/.test(t);
const CONTAINING_BLOCK_PROPERTIES: readonly string[] = [
  'transform',
  'translate',
  'rotate',
  'scale',
  'perspective',
  'filter',
  'backdrop-filter',
];

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

/**
 * Whether an ancestor of `el` is already known to be hidden. A known visible ancestor ends the walk:
 * resolving it resolved every ancestor above it, and none of them hides.
 */
function underKnownHidden(el: Element, memo: Map<Element, VisibilityInfo>): boolean {
  for (let up = parentAcrossShadowBoundary(el); null !== up; up = parentAcrossShadowBoundary(up)) {
    const known = memo.get(up);
    if (known !== undefined) {
      return known.hidden;
    }
  }
  return false;
}

const hiddenInfo = (style: CSSStyleDeclaration | null = null): VisibilityInfo => ({
  hidden: true,
  style,
  parent: null,
  clipX: false,
  clipY: false,
  scrollX: false,
  scrollY: false,
  hasClipping: false,
});

function ownVisibilityInfo(
  el: Element,
  memo: Map<Element, VisibilityInfo>,
  ignoreAriaHidden = false,
): VisibilityInfo {
  let info = memo.get(el);
  if (info === undefined) {
    if (underKnownHidden(el, memo)) {
      info = hiddenInfo();
      memo.set(el, info);
      return info;
    }
    const style = el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
    if (selfHidden(el, style, ignoreAriaHidden)) {
      info = hiddenInfo(style);
      memo.set(el, info);
      return info;
    }
    const parent = parentAcrossShadowBoundary(el);
    const inherited =
      null === parent ? undefined : ownVisibilityInfo(parent, memo, ignoreAriaHidden);
    const [overflowX, overflowY] = overflowAxes(style);
    const root = el.ownerDocument.documentElement;
    // Root/body overflow propagated to the viewport stays separate from element visibility.
    const viewportOverflow =
      el === root ||
      (el === el.ownerDocument.body &&
        overflowAxes(ownVisibilityInfo(root, memo, ignoreAriaHidden).style).every(
          (axis) => 'visible' === axis,
        ));
    const hasClipBox =
      !viewportOverflow &&
      !isNonClippingDisplay(style?.display ?? '') &&
      !(isHtmlElement(el) && 'inline' === style?.display);
    const clipX = hasClipBox && ('hidden' === overflowX || 'clip' === overflowX);
    const clipY = hasClipBox && ('hidden' === overflowY || 'clip' === overflowY);
    info = {
      hidden: true === inherited?.hidden,
      style,
      parent,
      clipX,
      clipY,
      scrollX: hasClipBox && ('auto' === overflowX || 'scroll' === overflowX),
      scrollY: hasClipBox && ('auto' === overflowY || 'scroll' === overflowY),
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
      !('inline' === style.display && isHtmlElement(parent) && !isReplacedTag(parent.localName)) &&
      'table-column' !== style.display &&
      'table-column-group' !== style.display;
    const applies = (p: string): boolean =>
      transformable || 'filter' === p || 'backdrop-filter' === p;
    const hasProp = CONTAINING_BLOCK_PROPERTIES.some((property) => {
      const value = style.getPropertyValue(property);
      return applies(property) && '' !== value && 'none' !== value;
    });
    if (
      hasProp ||
      style.willChange
        .split(',')
        .some((p) => CONTAINING_BLOCK_PROPERTIES.includes(p.trim()) && applies(p.trim())) ||
      (transformable &&
        !isNonClippingDisplay(style.display) &&
        (style.contain.split(/\s+/).some((v) => /^(layout|paint|strict|content)$/.test(v)) ||
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
    if (current !== el && undefined === clipFrom) {
      if (throughScrollers && (info.scrollX || info.scrollY)) {
        bounds ??= el.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) {
          bounds = scrolledInto(bounds, clippingBox(current, info), info.scrollX, info.scrollY);
        }
      }
      if (info.clipX || info.clipY) {
        bounds ??= el.getBoundingClientRect();
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
    }
    // Positioned subtrees escape clips before their containing block. Find it in the composed
    // tree: offsetParent is retargeted outside shadow roots and misses positioned slot wrappers.
    if (clipFrom === undefined && ('absolute' === style?.position || 'fixed' === style?.position)) {
      clipFrom = positionedContainingBlock(current, 'fixed' === style?.position, memo);
    }
  }
  return bounds;
}

/** True when the element's box intersects the window. */
export function intersectsViewport(el: Element, b?: VisibleBounds | DOMRect | null): boolean {
  const v = el.ownerDocument.defaultView;
  const r = b === undefined ? el.getBoundingClientRect() : b;
  return (
    null !== v &&
    null !== r &&
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < v.innerHeight &&
    r.left < v.innerWidth
  );
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
  return intersectsViewport(
    el,
    visibleBounds(el, visibilityInfoMemo(memo), el.getBoundingClientRect()),
  );
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
  const rects = el.getClientRects();
  if (0 === rects.length) {
    return false;
  }
  for (const r of rects) {
    if (!(
      (own.clipX && 0 === r.width) ||
      (own.clipY && 0 === r.height) ||
      (own.clipX && own.clipY && r.width <= 1 && r.height <= 1)
    )) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a CSS/HTML mechanism hides the whole subtree. A text reader can skip such a root.
 * CSS visibility is excluded because a descendant can override its inherited value.
 */
export function isHiddenSubtree(el: Element, memo?: Map<Element, boolean>): boolean {
  return ownVisibilityInfo(el, visibilityInfoMemo(memo)).hidden;
}

function geometryVisible(el: Element, info: Map<Element, VisibilityInfo>): boolean {
  return (
    null !== visibleBounds(el, info, undefined, true) &&
    !collapsed(el, info) &&
    !backfaceHidden(el, info)
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
  const result = !visibilityHidden(ownVisibilityInfo(el, info).style) && geometryVisible(el, info);
  memo?.set(el, result);
  return result;
}

/**
 * Whether the element is CSS-painted on screen, regardless of whether aria-hidden="true" excludes
 * it from the accessibility tree. An element with aria-hidden="true" (like a decorative canvas,
 * background illustration, or icon glyph) that is rendered and not CSS-hidden passes this check (#1648).
 *
 * Runs the same geometry checks as isVisible (visibleBounds, collapsed, backfaceHidden) and skips
 * only the aria-hidden attribute check.
 */
export function isPainted(el: Element, memo?: Map<Element, boolean>): boolean {
  if (!el.isConnected) {
    return false;
  }
  if (isVisible(el, memo)) {
    return true;
  }
  if (!isHiddenByAriaOnly(el)) {
    return false;
  }
  if (isHtmlElement(el) && isReplacedTag(el.localName)) {
    for (const r of el.getClientRects()) {
      if (0 === r.width || 0 === r.height) {
        return false;
      }
    }
  }
  const info = new Map<Element, VisibilityInfo>();
  ownVisibilityInfo(el, info, true);
  return geometryVisible(el, info);
}
