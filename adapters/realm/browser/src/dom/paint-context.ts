/**
 * What is painting this element, composed down the ancestor chain.
 *
 * `getComputedStyle(el)` answers one link of a chain. CSS rasterisation composes: an ancestor's
 * `filter`, `opacity`, `transform`, `mix-blend-mode` or `backdrop-filter` changes how this element
 * reaches the screen while leaving its own computed style byte-identical.
 *
 * That is not a hypothetical. It is the regression Reticle measurably lost to a screenshot: a
 * `hue-rotate(90deg)` on an ancestor changed 21,393 pixels, and the element's own style was the same
 * before and after — correctly, because the filter was never its property. The read was not wrong;
 * it was at the wrong layer.
 *
 * Verified in a real browser before this was written. Same element, before and after:
 *
 *   own computed style   padding 16px, background rgb(255,255,255), filter "none"   IDENTICAL
 *   paint context        []  ->  [{ on: "wrap", property: "filter", value: "hue-rotate(90deg)" }]
 *
 * A screenshot is the lazy way to collapse this composition — it collapses it into pixels and throws
 * away every term, which is why it can report that 21,393 pixels differ and never say which element,
 * which property, or which line of code. This keeps the terms, so a finding is attributable.
 */

/** One reason this element does not rasterise the way its own style suggests. */
export interface PaintContextEntry {
  /** A description of the element applying it — its id, else its classes, else its tag. */
  readonly on: string;
  readonly property: string;
  readonly value: string;
}

/**
 * The properties that alter rasterisation WITHOUT altering the subject's own computed style.
 *
 * Deliberately short. Every entry is a property whose effect is inherited by the rendering of
 * descendants rather than by their computed values, which is precisely the blind spot. Colour,
 * font and spacing are NOT here: those show up in the element's own style, where they are already
 * read.
 */
const PAINT_PROPERTIES = [
  'filter',
  'opacity',
  'transform',
  'mix-blend-mode',
  'backdrop-filter',
] as const;

/** The value each property has when it is doing nothing. A default is not a paint context. */
const INERT: Readonly<Record<string, string>> = {
  filter: 'none',
  opacity: '1',
  transform: 'none',
  'mix-blend-mode': 'normal',
  'backdrop-filter': 'none',
};

/** Enough to find the element again, in the words a reader already has. */
function describeElement(el: Element): string {
  if (el.id.length > 0) return `#${el.id}`;
  const cls = el.getAttribute('class');
  if (cls !== null && cls.trim().length > 0) return `.${cls.trim().split(/\s+/).join('.')}`;
  return el.tagName.toLowerCase();
}

/**
 * Nearest first, so the closest cause reads first — that is the one somebody edits.
 *
 * Walks the element itself and then its ancestors: the question is "what is painting this", not
 * "what is above this", and an element can tint itself.
 */
export function paintContextOf(el: Element): PaintContextEntry[] {
  const view = el.ownerDocument.defaultView;
  if (null === view) return [];
  const found: PaintContextEntry[] = [];
  for (
    let node: Element | null = el;
    node !== null && node !== el.ownerDocument.documentElement;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    for (const property of PAINT_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (value.length > 0 && value !== INERT[property]) {
        found.push({ on: describeElement(node), property, value });
      }
    }
  }
  return found;
}
