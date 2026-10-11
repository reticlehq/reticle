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
import { isSensitiveKey, STEP_SCREENSHOT } from '@reticlehq/core';
import { RETICLE_OVERLAY } from './dom-ignore.js';

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
  if (el instanceof HTMLInputElement && 'password' === el.type) return true;
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
    if (from instanceof HTMLTextAreaElement) to.textContent = value;
    else to.setAttribute('value', value);
  }
  if (from instanceof HTMLInputElement) {
    if (from.checked) to.setAttribute('checked', '');
    else to.removeAttribute('checked');
  }
  if (from instanceof HTMLOptionElement) {
    if (from.selected) to.setAttribute('selected', '');
    else to.removeAttribute('selected');
  }
}

/** Every stylesheet the page can read, as text. A cross-origin sheet throws and is left out. */
function readableCss(doc: Document): string {
  const sheets = [...Array.from(doc.styleSheets), ...(doc.adoptedStyleSheets ?? [])];
  const parts: string[] = [];
  for (const sheet of sheets) {
    try {
      for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
    } catch {
      // Cross-origin: the browser will not let the page read it, so the image goes without it.
    }
  }
  return parts.join('\n');
}

/**
 * The document, ready to draw: live form state carried over, secrets masked, scripts and Reticle's
 * own UI removed, and every readable stylesheet inlined into one `<style>` (a linked sheet would not
 * load inside an SVG image).
 */
export function cloneForRender(doc: Document): HTMLElement {
  const root = doc.documentElement;
  const clone = root.cloneNode(true) as HTMLElement;
  // Same tree, same order: walk both together before anything is removed from the clone.
  const live = root.querySelectorAll('*');
  const copied = clone.querySelectorAll('*');
  live.forEach((el, i) => {
    const twin = copied[i];
    if (twin !== undefined) carryState(el, twin);
  });
  const dropped = [RETICLE_OVERLAY, 'script', 'noscript', 'link[rel~="stylesheet"]', 'style'];
  clone.querySelectorAll(dropped.join(',')).forEach((el) => el.remove());
  const style = doc.createElement('style');
  style.textContent = readableCss(doc);
  (clone.querySelector('head') ?? clone).append(style);
  return clone;
}

/** The colour behind the page, so a transparent body does not come out black in a JPEG. */
function backgroundOf(doc: Document): string {
  const view = doc.defaultView;
  for (const el of [doc.body, doc.documentElement]) {
    if (null === view || null === el) continue;
    const colour = view.getComputedStyle(el).backgroundColor;
    if (colour.length > 0 && 'transparent' !== colour && 'rgba(0, 0, 0, 0)' !== colour)
      return colour;
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
  for (let i = 0; i < base64.length; i += CHUNK_CHARS) out.push(base64.slice(i, i + CHUNK_CHARS));
  return out;
}

/** Draw the visible viewport to a JPEG, longest side at most STEP_SCREENSHOT.MAX_SIDE_PX. */
export async function renderPage(): Promise<RenderResult> {
  try {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const clone = cloneForRender(document);
    // The viewport, not the document: the same frame a browser screenshot would take.
    clone.style.transform = `translate(${String(-window.scrollX)}px, ${String(-window.scrollY)}px)`;
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
      if (null === ctx) return { ok: false, reason: 'this page has no 2D canvas to draw into' };
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
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
