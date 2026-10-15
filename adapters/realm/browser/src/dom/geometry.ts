import { type ElementDescriptor, type ElementGeometry } from '@reticlehq/core';
import { measureGeometry } from './a11y.js';

type Box = ElementGeometry['box'];

/** Positive-area intersection: boxes that only touch at an edge do not overlap. */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Attach the measured geometry (#1539) to a descriptor. `overlapTarget` is the first match of
 * the overlaps query when the predicate named one; its box rides along with the measurement.
 */
export function attachGeometry(
  base: ElementDescriptor,
  el: Element,
  visMemo: Map<Element, boolean>,
  overlapTarget: Element | undefined,
): ElementDescriptor {
  const measured = measureGeometry(el, visMemo);
  if (overlapTarget !== undefined) {
    const otherRect = overlapTarget.getBoundingClientRect();
    const other = {
      x: otherRect.x,
      y: otherRect.y,
      width: otherRect.width,
      height: otherRect.height,
    };
    measured.overlap = { intersects: boxesIntersect(measured.box, other), box: other };
  }
  return { ...base, geometry: measured };
}
