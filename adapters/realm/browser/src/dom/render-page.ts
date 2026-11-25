/**
 * The page, drawn by the page: the `rendered` step screenshot.
 *
 * A tab nobody launched through CDP has no screenshotter, and every step still owes a picture. So
 * the SDK clones the document, inlines what it can read of the styles, and draws it through an SVG
 * `foreignObject` onto a canvas. It is an approximation and is labelled one: anything the page loads
 * from elsewhere (images, fonts, cross-origin stylesheets) cannot be pulled into the image, and a
 * shadow root or a canvas's own pixels do not survive a clone.
 *
 * Lazy-loaded by the command registry, so a page pays for this only when a capture is asked of it.
 *
 * Privacy is decided HERE, before a pixel exists: the image leaves the machine with its run. A
 * password field, and any field whose name says it holds a secret, is drawn as a row of dots.
 */
import { isSensitiveKey, STEP_SCREENSHOT } from '@reticlehq/core/page';
import { RETICLE_OVERLAY } from './dom-ignore.js';
import { errorText } from '@/util/error-text.js';

/** What a masked field shows instead of its value. */
export const MASK = '••••••••';

/**
 * Most base64 the answer may carry. The transport caps one message's text near 256K characters
 * across every string in it; this leaves room for the rest of the envelope.
 */
const BUDGET_CHARS = 240_000;
/** Each string stays under the transport's per-string cap, or it arrives cut and undecodable. */
const CHUNK_CHARS = 60_000;
/** Each retry over budget draws this much smaller. */
const SHRINK = 0.75;
const MAX_ATTEMPTS = 4;
/** A page whose SVG image never loads has failed to render; it must not hang the capture. */
const LOAD_TIMEOUT_MS = 5_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK_BACKGROUND = '#ffffff';
const JPEG_MIME = 'image/jpeg';
const DATA_URL_PREFIX = /^data:[^,]*,/;

export type RenderResult =
  { ok: true; width: number; height: number; chunks: string[] } | { ok: false; reason: string };

/** A field whose value is a secret: by type, or by what its name, id or autocomplete says. */
function isSecretField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el instanceof HTMLInputElement && 'password' === el.type) {
    return true;
  }
  return [el.name, el.id, el.getAttribute('autocomplete') ?? ''].some(
    (key) => key.length > 0 && isSensitiveKey(key),
  );
}

/**
 * Carry the live state a clone loses into attributes the serializer keeps.
 *
 * `cloneNode` copies attributes, not properties: a typed value, a ticked box and a chosen option are
 * all properties, so a clone draws the form as it was first served.
 */
function carryState(from: Element, to: Element): void {
  if (from instanceof HTMLInputElement || from instanceof HTMLTextAreaElement) {
    const value = isSecretField(from) && from.value.length > 0 ? MASK : from.value;
    if (from instanceof HTMLTextAreaElement) {
      to.textContent = value;
    } else {
      to.setAttribute('value', value);
    }
  }
  if (from instanceof HTMLInputElement) {
    if (from.checked) {
      to.setAttribute('checked', '');
    } else {
      to.removeAttribute('checked');
    }
  }
  if (from instanceof HTMLOptionElement) {
    if (from.selected) {
      to.setAttribute('selected', '');
    } else {
      to.removeAttribute('selected');
    }
  }
}

/** Keyframe keys that are not CSS properties. */
const NOT_A_PROPERTY = new Set(['offset', 'easing', 'composite', 'computedOffset']);

/**
 * Write the frame the page shows now onto the clone, and stop its motion there.
 *
 * An SVG image starts every animation again at its first keyframe, so a row that fades in from
 * `opacity: 0` is drawn blank. Each animated property gets its current computed value inline.
 */
function freezeMotion(from: Element, to: Element, animations: readonly Animation[]): void {
  const view = from.ownerDocument.defaultView;
  if (null === view || !(to instanceof HTMLElement || to instanceof SVGElement)) {
    return;
  }
  const computed = view.getComputedStyle(from);
  for (const animation of animations) {
    const effect = animation.effect as KeyframeEffect | null;
    for (const frame of effect?.getKeyframes() ?? []) {
      for (const key of Object.keys(frame)) {
        if (NOT_A_PROPERTY.has(key)) {
          continue;
        }
        const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        to.style.setProperty(name, computed.getPropertyValue(name));
      }
    }
  }
  to.style.setProperty('animation', 'none');
  to.style.setProperty('transition', 'none');
}

/** Every element that has an animation now, with its animations. One call, not one per element. */
function animationsByElement(doc: Document): Map<Element, Animation[]> {
  const byElement = new Map<Element, Animation[]>();
  if (typeof doc.getAnimations !== 'function') {
    return byElement;
  }
  for (const animation of doc.getAnimations()) {
    const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
    if (null === target) {
      continue;
    }
    byElement.set(target, [...(byElement.get(target) ?? []), animation]);
  }
  return byElement;
}

/** Above everything the page can stack: the top layer draws over every z-index. */
const TOP_Z_INDEX = '2147483647';
/** The pseudo-classes of an element the browser draws in the top layer. */
const TOP_LAYER = [':modal', ':popover-open'];
const BACKDROP = '::backdrop';

/**
 * Is this element in the top layer: a dialog opened with `showModal()`, or an open popover?
 *
 * A clone keeps the `open` attribute but not the top layer, so the dialog is drawn where it sits in
 * the tree: not centred, with no backdrop, and under any overlay that stacks above its ancestors.
 */
function inTopLayer(el: Element): boolean {
  return TOP_LAYER.some((pseudo) => {
    try {
      return el.matches(pseudo);
    } catch {
      // An engine that does not know the pseudo-class has no top layer of that kind.
      return false;
    }
  });
}

/**
 * Write every computed property of `from` inline on `to`. A top-layer twin moves to the end of the
 * body, so the selectors and inherited values that styled it in place no longer reach it.
 */
function inlineComputed(view: Window, from: Element, to: Element, pseudo?: string): void {
  if (!(to instanceof HTMLElement || to instanceof SVGElement)) {
    return;
  }
  const computed = view.getComputedStyle(from, pseudo);
  for (const name of Array.from(computed)) {
    to.style.setProperty(name, computed.getPropertyValue(name));
  }
  // The computed values are the frame the page shows now. A running animation would start again.
  to.style.setProperty('animation', 'none');
  to.style.setProperty('transition', 'none');
}

/**
 * Draw the top layer on top. Each top-layer element's twin, styled as the page shows it now, moves
 * into a box that draws its `::backdrop` over the whole viewport, above everything else. Returns the
 * boxes, in document order, for the caller to put at the end of the clone.
 */
function liftTopLayer(doc: Document, pairs: ReadonlyArray<readonly [Element, Element]>): Element[] {
  const view = doc.defaultView;
  const lifted: Element[] = [];
  if (null === view) {
    return lifted;
  }
  const byLive = new Map(pairs);
  for (const [el, twin] of pairs) {
    if (!inTopLayer(el)) {
      continue;
    }
    const host = twin.ownerDocument.createElement('div');
    inlineComputed(view, el, host, BACKDROP);
    host.style.setProperty('position', 'fixed');
    host.style.setProperty('inset', '0');
    host.style.setProperty('z-index', TOP_Z_INDEX);
    inlineComputed(view, el, twin);
    el.querySelectorAll('*').forEach((child) => {
      const copy = byLive.get(child);
      if (copy !== undefined) {
        inlineComputed(view, child, copy);
      }
    });
    if (twin instanceof HTMLElement || twin instanceof SVGElement) {
      twin.style.setProperty('position', 'fixed');
      twin.style.setProperty('z-index', TOP_Z_INDEX);
    }
    host.append(twin);
    lifted.push(host);
  }
  return lifted;
}

/** Every stylesheet the page can read, as text. A cross-origin sheet throws and is left out. */
function readableCss(doc: Document): string {
  const sheets = [...Array.from(doc.styleSheets), ...(doc.adoptedStyleSheets ?? [])];
  const parts: string[] = [];
  for (const sheet of sheets) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        parts.push(rule.cssText);
      }
    } catch {
      // Cross-origin: the browser will not let the page read it, so the image goes without it.
    }
  }
  return parts.join('\n');
}

/**
 * Move the clone so the image shows the viewport, not the top of the document: the same frame a
 * browser screenshot takes.
 *
 * A relative offset, not a transform. A transform on the root makes the root the box that a fixed
 * element fills, so a full-screen overlay was drawn only as tall as the content: a thin band (#2433).
 */
function showViewport(doc: Document, clone: HTMLElement): void {
  const view = doc.defaultView;
  clone.style.setProperty('position', 'relative');
  clone.style.setProperty('left', `${String(-(view?.scrollX ?? 0))}px`);
  clone.style.setProperty('top', `${String(-(view?.scrollY ?? 0))}px`);
}

/**
 * The document, ready to draw: live form state and the current animation frame carried over, secrets masked, scripts and Reticle's
 * own UI removed, every readable stylesheet inlined into one `<style>` (a linked sheet would not
 * load inside an SVG image), the top layer drawn on top, and the viewport in the frame.
 */
export function cloneForRender(doc: Document): HTMLElement {
  const root = doc.documentElement;
  const clone = root.cloneNode(true) as HTMLElement;
  // Same tree, same order: walk both together before anything is removed from the clone.
  const live = root.querySelectorAll('*');
  const copied = clone.querySelectorAll('*');
  const moving = animationsByElement(doc);
  const pairs: Array<readonly [Element, Element]> = [];
  live.forEach((el, i) => {
    const twin = copied[i];
    if (twin !== undefined) {
      pairs.push([el, twin]);
      carryState(el, twin);
      const animations = moving.get(el);
      if (animations !== undefined) {
        freezeMotion(el, twin, animations);
      }
    }
  });
  (clone.querySelector('body') ?? clone).append(...liftTopLayer(doc, pairs));
  const dropped = [RETICLE_OVERLAY, 'script', 'noscript', 'link[rel~="stylesheet"]', 'style'];
  clone.querySelectorAll(dropped.join(',')).forEach((el) => el.remove());
  const style = doc.createElement('style');
  style.textContent = readableCss(doc);
  (clone.querySelector('head') ?? clone).append(style);
  showViewport(doc, clone);
  return clone;
}

/** The colour behind the page, so a transparent body does not come out black in a JPEG. */
function backgroundOf(doc: Document): string {
  const view = doc.defaultView;
  for (const el of [doc.body, doc.documentElement]) {
    if (null === view || null === el) {
      continue;
    }
    const colour = view.getComputedStyle(el).backgroundColor;
    if (colour.length > 0 && 'transparent' !== colour && 'rgba(0, 0, 0, 0)' !== colour) {
      return colour;
    }
  }
  return FALLBACK_BACKGROUND;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(
      () => reject(new Error('the page did not render in time')),
      LOAD_TIMEOUT_MS,
    );
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('the page could not be drawn as an image'));
    };
    img.src = url;
  });
}

/** Split base64 into strings the transport carries whole. */
function chunked(base64: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < base64.length; i += CHUNK_CHARS) {
    out.push(base64.slice(i, i + CHUNK_CHARS));
  }
  return out;
}

/** Draw the visible viewport to a JPEG, longest side at most STEP_SCREENSHOT.MAX_SIDE_PX. */
export async function renderPage(): Promise<RenderResult> {
  try {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const clone = cloneForRender(document);
    const xhtml = new XMLSerializer().serializeToString(clone);
    const svg =
      `<svg xmlns="${SVG_NS}" width="${String(width)}" height="${String(height)}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const background = backgroundOf(document);
    let scale = Math.min(1, STEP_SCREENSHOT.MAX_SIDE_PX / Math.max(width, height));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1, scale *= SHRINK) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (null === ctx) {
        return { ok: false, reason: 'this page has no 2D canvas to draw into' };
      }
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // Throws SecurityError where the engine taints a canvas drawn from a foreignObject (WebKit).
      const base64 = canvas
        .toDataURL(JPEG_MIME, STEP_SCREENSHOT.JPEG_QUALITY)
        .replace(DATA_URL_PREFIX, '');
      if (base64.length <= BUDGET_CHARS) {
        return { ok: true, width: canvas.width, height: canvas.height, chunks: chunked(base64) };
      }
    }
    return { ok: false, reason: 'the rendered page was too large to send, even scaled down' };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}
