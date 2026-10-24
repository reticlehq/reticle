/**
 * What a person sees wrong at a glance, measured instead of looked at: text cut off mid-word, two
 * controls on top of each other, text too faint to read against what is behind it.
 *
 * Deterministic on purpose. A vision model asked "does this look broken?" answers differently each
 * time and costs a screenshot per screen; the page already knows its own boxes and colours. Read on
 * request only (`buildSnapshot({ audit: true })`): it forces layout on every candidate element.
 */
import { refs } from './addressing/refs.js';
import { getAccessibleName } from './a11y.js';
import { isIgnored } from './dom-ignore.js';

export const LayoutDefect = {
  /** Text cut off by its box, with no ellipsis or line clamp saying it was meant to be. */
  CLIPPED: 'clipped',
  /** Two controls a person presses drawn over each other. */
  OVERLAP: 'overlap',
  /** Text under the WCAG minimum against its own background. */
  CONTRAST: 'contrast',
} as const;
export type LayoutDefect = (typeof LayoutDefect)[keyof typeof LayoutDefect];

export interface LayoutFinding {
  kind: LayoutDefect;
  ref: string;
  /** The element's name or text, short. */
  what: string;
  detail: string;
  /** What was measured (px of text, share covered, contrast ratio) and the bound it crossed. */
  value: number;
  bound: number;
}

/** The most findings one audit reports: a broken page repeats one defect, and the first few say it. */
const MAX_FINDINGS = 20;
/** The most controls compared pairwise for overlap (n² checks). */
const MAX_CONTROLS = 300;
const WHAT_CHARS = 60;
/** A box this many pixels too small for its content is rounding, not clipping. */
const SLACK_PX = 1;
/** Two controls overlap when they share at least this much of the smaller one. */
const OVERLAP_SHARE = 0.25;
const MIN_CONTRAST = 4.5;
const MIN_CONTRAST_LARGE = 3;
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;
const BOLD_WEIGHT = 700;

const CONTROLS =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';

/** A clip that leaves nothing: `rect(0 0 0 0)` in either spelling, or a zero inset. */
const CLIPPED_AWAY = /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)|inset\(\s*50%/;
/** Smaller than this is not meant to be seen: screen-reader-only text is clipped to a 1px box. */
const MIN_BOX_PX = 4;

const shown = (el: Element): DOMRect | null => {
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_BOX_PX || rect.height < MIN_BOX_PX) {
    return null;
  }
  const style = getComputedStyle(el);
  if ('hidden' === style.visibility || 'none' === style.display || '0' === style.opacity) {
    return null;
  }
  // Clipped away on purpose (`sr-only`: a skip link until it is focused), however big its box is.
  if (CLIPPED_AWAY.test(style.clip) || CLIPPED_AWAY.test(style.clipPath)) {
    return null;
  }
  return rect;
};

const whatOf = (el: Element): string =>
  (getAccessibleName(el) || (el.textContent ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, WHAT_CHARS);

/** The element's own text, not a descendant's. */
const ownText = (el: Element): string =>
  [...el.childNodes]
    .filter((n) => Node.TEXT_NODE === n.nodeType)
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();

const CUTS: ReadonlySet<string> = new Set(['hidden', 'clip']);

const clipped = (el: Element): { detail: string; value: number; bound: number } | null => {
  const style = getComputedStyle(el);
  const wide = el.scrollWidth > el.clientWidth + SLACK_PX && CUTS.has(style.overflowX);
  const tall = el.scrollHeight > el.clientHeight + SLACK_PX && CUTS.has(style.overflowY);
  // An ellipsis or a line clamp is the design saying "shorten this here": not a defect.
  const declared =
    'ellipsis' === style.textOverflow ||
    ('' !== style.getPropertyValue('-webkit-line-clamp') &&
      'none' !== style.getPropertyValue('-webkit-line-clamp'));
  if (declared || (!wide && !tall)) {
    return null;
  }
  return wide
    ? {
        detail: `${String(el.scrollWidth)}px of text in a ${String(el.clientWidth)}px box, cut with no ellipsis`,
        value: el.scrollWidth,
        bound: el.clientWidth,
      }
    : {
        detail: `${String(el.scrollHeight)}px of text in a ${String(el.clientHeight)}px box, cut with no line clamp`,
        value: el.scrollHeight,
        bound: el.clientHeight,
      };
};

type Rgba = [number, number, number, number];
const RGB = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/;

const parse = (value: string): Rgba | null => {
  const m = RGB.exec(value);
  if (null === m) {
    return null;
  }
  const alphaRaw = m[4];
  let alpha = 1;
  if (alphaRaw !== undefined) {
    alpha = alphaRaw.endsWith('%') ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
};

const luminance = ([r, g, b]: Rgba): number => {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

const over = (top: Rgba, under: Rgba): Rgba => {
  const a = top[3];
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a),
    1,
  ];
};

/** The solid colour behind an element, or null when an image or gradient makes it unknowable. */
const backdrop = (el: Element): Rgba | null => {
  const layers: Rgba[] = [];
  for (let at: Element | null = el; null !== at; at = at.parentElement) {
    const style = getComputedStyle(at);
    if ('none' !== style.backgroundImage && '' !== style.backgroundImage) {
      return null;
    }
    const colour = parse(style.backgroundColor);
    if (null !== colour && colour[3] > 0) {
      layers.push(colour);
      if (1 === colour[3]) {
        break;
      }
    }
  }
  return layers.reduceRight<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
};

/** Contrast ratio of the element's text on its backdrop, or null when it cannot be measured. */
const contrastOf = (el: Element): { ratio: number; min: number } | null => {
  const style = getComputedStyle(el);
  const fg = parse(style.color);
  const bg = backdrop(el);
  if (null === fg || null === bg) {
    return null;
  }
  const text = over(fg, bg);
  const [hi, lo] = [luminance(text), luminance(bg)].sort((a, b) => b - a) as [number, number];
  const size = Number.parseFloat(style.fontSize);
  const weight = Number.parseInt(style.fontWeight, 10);
  const large = size >= LARGE_PX || (size >= LARGE_BOLD_PX && weight >= BOLD_WEIGHT);
  return { ratio: (hi + 0.05) / (lo + 0.05), min: large ? MIN_CONTRAST_LARGE : MIN_CONTRAST };
};

/**
 * Whether a person sees one of `els` at (x, y): the topmost element there is one of them or inside
 * one. A box an ancestor clips away (a canvas panned past its edge) still has a rect, and only the
 * hit test knows nobody can see it. Off the viewport is not seen; no hit testing at all is.
 */
const seenAt = (x: number, y: number, ...els: Element[]): boolean => {
  if ('function' !== typeof document.elementFromPoint) {
    return true;
  }
  const top = document.elementFromPoint(x, y);
  return null !== top && els.some((el) => el === top || el.contains(top));
};

/** Seen anywhere: at its centre or just inside a corner, so a control half under another still counts. */
const INSET_PX = 2;
const visible = (el: Element, r: DOMRect): boolean =>
  [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + INSET_PX, r.top + INSET_PX],
    [r.right - INSET_PX, r.top + INSET_PX],
    [r.left + INSET_PX, r.bottom - INSET_PX],
    [r.right - INSET_PX, r.bottom - INSET_PX],
  ].some(([x = 0, y = 0]) => seenAt(x, y, el));

const share = (a: DOMRect, b: DOMRect): number => {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) {
    return 0;
  }
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
};

/** Visible layout defects under `root`, at most MAX_FINDINGS, each with a ref to act or look on. */
export function auditLayout(root: Element = document.body): LayoutFinding[] {
  const found: LayoutFinding[] = [];
  const add = (
    kind: LayoutDefect,
    el: Element,
    measured: { detail: string; value: number; bound: number },
  ): void => {
    if (found.length < MAX_FINDINGS) {
      found.push({ kind, ref: refs.refFor(el), what: whatOf(el), ...measured });
    }
  };
  for (const el of root.querySelectorAll('*')) {
    if (found.length >= MAX_FINDINGS) {
      break;
    }
    if (isIgnored(el) || '' === ownText(el)) {
      continue;
    }
    const rect = shown(el);
    if (null === rect || !seenAt(rect.left + rect.width / 2, rect.top + rect.height / 2, el)) {
      continue;
    }
    const cut = clipped(el);
    if (null !== cut) {
      add(LayoutDefect.CLIPPED, el, cut);
    }
    const contrast = contrastOf(el);
    if (null !== contrast && contrast.ratio < contrast.min) {
      add(LayoutDefect.CONTRAST, el, {
        detail: `contrast ${contrast.ratio.toFixed(2)}:1, under ${String(contrast.min)}:1`,
        value: Math.round(contrast.ratio * 100) / 100,
        bound: contrast.min,
      });
    }
  }
  const controls = [...root.querySelectorAll(CONTROLS)]
    .filter((el) => !isIgnored(el))
    .slice(0, MAX_CONTROLS)
    .flatMap((el) => {
      const rect = shown(el);
      return null === rect ? [] : [{ el, rect }];
    });
  for (const [i, a] of controls.entries()) {
    for (const b of controls.slice(i + 1)) {
      if (found.length >= MAX_FINDINGS) {
        return found;
      }
      if (a.el.contains(b.el) || b.el.contains(a.el)) {
        continue;
      }
      const covered = share(a.rect, b.rect);
      // Both have to be seen somewhere: a node its canvas clips away is under nothing a person sees.
      if (covered >= OVERLAP_SHARE && visible(a.el, a.rect) && visible(b.el, b.rect)) {
        add(LayoutDefect.OVERLAP, a.el, {
          detail: `drawn over "${whatOf(b.el)}" (${refs.refFor(b.el)})`,
          value: Math.round(covered * 100) / 100,
          bound: OVERLAP_SHARE,
        });
      }
    }
  }
  return found;
}
