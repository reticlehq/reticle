import {
  HERO_ICON_BODIES,
  HERO_ICON_SOLID_BODIES,
  type HeroIconBodyKey,
  type HeroIconSolidBodyKey,
} from './presenter-heroicons-data.js';

/** Presenter icon keys used by the HUD. */
export const PresenterIcon = {
  VIEW: 'view',
  POINTER: 'pointer',
  SEND: 'send',
  CHART: 'chart',
  CARET_DOWN: 'caret-down',
  CHECK: 'check',
  REMOVE: 'remove',
  PAUSE: 'pause',
  PLAY: 'play',
  STOP: 'stop',
  COPY: 'copy',
  DOWNLOAD: 'download',
  MESSAGE: 'message',
  GEAR: 'gear',
  LAYOUT: 'layout',
  TRASH: 'trash',
  HELP: 'help',
  CARET_RIGHT: 'caret-right',
  ANNOTATE: 'annotate',
} as const;

export type PresenterIconName = (typeof PresenterIcon)[keyof typeof PresenterIcon];

/** Shared HUD icon sizes (px) - one knob for visual density. */
export const PRESENTER_ICON_SIZE = {
  CHIP: 11,
  LOG: 11,
  TALLY: 12,
  CTL: 10,
  SEND: 14,
  MIN: 12,
  HELP: 12,
  TOOLBAR: 18,
  FAB: 22,
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';
const HERO_VIEWBOX = '0 0 24 24';
const svgCache = new Map<string, SVGSVGElement>();

function buildSvg(name: HeroIconBodyKey, sizePx: number): SVGSVGElement {
  const cacheKey = `${name}:${String(sizePx)}`;
  const cached = svgCache.get(cacheKey);
  if (cached !== undefined) {
    return document.importNode(cached, true);
  }
  const body = HERO_ICON_BODIES[name];
  if (body === undefined) {
    throw new Error(`missing heroicon body: ${String(name)}`);
  }
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}" viewBox="${HERO_VIEWBOX}" fill="none">${body}</svg>`,
    'image/svg+xml',
  );
  const root = parsed.documentElement;
  const svg =
    root instanceof SVGSVGElement
      ? document.importNode(root, true)
      : document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', HERO_VIEWBOX);
  svg.setAttribute('width', String(sizePx));
  svg.setAttribute('height', String(sizePx));
  svg.setAttribute('fill', 'none');
  if (!(root instanceof SVGSVGElement)) {
    svg.innerHTML = body;
  }
  svgCache.set(cacheKey, svg);
  return document.importNode(svg, true);
}

/** Create an inline Heroicons outline SVG (24px grid, currentColor stroke). */
export function hiIcon(name: HeroIconBodyKey, sizePx = 16): HTMLSpanElement {
  const wrap = document.createElement('span');
  wrap.className = 'reticle-hi-icon';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.width = `${String(sizePx)}px`;
  wrap.style.height = `${String(sizePx)}px`;
  wrap.appendChild(buildSvg(name, sizePx));
  return wrap;
}

/** Replace a parent's children with a Heroicon. */
export function setHiIcon(parent: HTMLElement, name: HeroIconBodyKey, sizePx = 16): void {
  parent.replaceChildren(hiIcon(name, sizePx));
}

/** Inline SVG markup for static HUD templates - survives mount order and dep-cache staleness. */
export function hiIconHtml(name: HeroIconBodyKey, sizePx = 16): string {
  const body = HERO_ICON_BODIES[name];
  if (body === undefined) {
    throw new Error(`missing heroicon body: ${String(name)}`);
  }
  return `<span class="reticle-hi-icon" aria-hidden="true" style="width:${String(sizePx)}px;height:${String(sizePx)}px"><svg xmlns="${SVG_NS}" viewBox="${HERO_VIEWBOX}" width="${String(sizePx)}" height="${String(sizePx)}" fill="none">${body}</svg></span>`;
}

/** Outline + solid pair for toolbar toggles - solid layer shows when the button is active. */
export function hiToggleIconHtml(name: HeroIconSolidBodyKey, sizePx = 16): string {
  const outline = HERO_ICON_BODIES[name];
  const solid = HERO_ICON_SOLID_BODIES[name];
  if (outline === undefined || solid === undefined) {
    throw new Error(`missing heroicon toggle pair: ${String(name)}`);
  }
  const size = String(sizePx);
  return (
    `<span class="reticle-hi-toggle" aria-hidden="true" style="width:${size}px;height:${size}px">` +
    `<span class="reticle-hi-icon reticle-hi-icon--outline" style="width:${size}px;height:${size}px">` +
    `<svg xmlns="${SVG_NS}" viewBox="${HERO_VIEWBOX}" width="${size}" height="${size}" fill="none">${outline}</svg></span>` +
    `<span class="reticle-hi-icon reticle-hi-icon--solid" style="width:${size}px;height:${size}px">` +
    `<svg xmlns="${SVG_NS}" viewBox="${HERO_VIEWBOX}" width="${size}" height="${size}" fill="currentColor">${solid}</svg></span>` +
    `</span>`
  );
}
