/**
 * Geometry grading for element predicates (#1539): the page measures, this side grades.
 *
 * Split out of `predicate-element.ts` when the geometry asks carried that file past the line
 * cap. The asks themselves, and the one round-trip that fetches the measurements, stay with
 * the element predicates; only the grading lives here.
 */
import type { ElementDescriptor, ElementQuery } from './predicate-element.js';
import type { EvalResult } from './predicate-eval.js';

/** The geometry an element predicate asserts on (#1539): measured in the page, graded here. */
export interface ElementGeometryAsks {
  fullyInViewport?: boolean;
  textClipped?: boolean;
  overlaps?: ElementQuery;
}

/** A measured box, the way a failure message prints it. */
function formatBox(box: { x: number; y: number; width: number; height: number }): string {
  return `{ x: ${String(box.x)}, y: ${String(box.y)}, width: ${String(box.width)}, height: ${String(box.height)} }`;
}

/**
 * Grade the geometry asks against the described matches, or return undefined when one element
 * satisfies all of them (#1539).
 *
 * The failure names the measured box and, for clipping, the overflow amounts: "not fully in
 * viewport" with no numbers sends the caller to measure by hand, which is the fallback this
 * feature replaces. A match whose descriptors carry no geometry was measured by a page that
 * cannot answer — inconclusive, not a verdict in either direction.
 */
export function checkGeometry(
  elements: readonly ElementDescriptor[],
  asks: ElementGeometryAsks,
  subject: string,
): EvalResult | undefined {
  const measured = elements.filter((element) => element.geometry !== undefined);
  if (0 === measured.length) {
    const reason =
      0 === elements.length
        ? `elements matching ${subject} were found but none were described, so their geometry could not be checked`
        : `the page reported no geometry for the element matching ${subject} — a page whose SDK predates the geometry fields cannot measure it, so the check cannot be graded`;
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      assertion: 'element.geometry',
    };
  }
  const satisfies = (element: ElementDescriptor): boolean => {
    const geometry = element.geometry;
    if (geometry === undefined) {
      return false;
    }
    if (asks.fullyInViewport !== undefined && geometry.fullyInViewport !== asks.fullyInViewport) {
      return false;
    }
    if (asks.textClipped !== undefined && geometry.textClipped !== asks.textClipped) {
      return false;
    }
    if (asks.overlaps !== undefined && true !== geometry.overlap?.intersects) {
      return false;
    }
    return true;
  };
  if (measured.some(satisfies)) {
    return undefined;
  }

  const first = measured[0];
  const geometry = first?.geometry;
  if (first === undefined || geometry === undefined) {
    return {
      pass: false,
      failureReason: `geometry for ${subject} could not be graded`,
      inconclusive: `geometry for ${subject} could not be graded`,
      assertion: 'element.geometry',
    };
  }
  const box = formatBox(geometry.box);
  if (asks.fullyInViewport !== undefined && geometry.fullyInViewport !== asks.fullyInViewport) {
    const reason =
      true === asks.fullyInViewport
        ? `element matching ${subject} is not fully in the viewport: its box is ${box} in a ${String(geometry.viewport.width)}x${String(geometry.viewport.height)} viewport`
        : `element matching ${subject} is fully in the viewport (box ${box}), but the predicate asked for fullyInViewport: false`;
    return {
      pass: false,
      failureReason: reason,
      observed: `box ${box} in a ${String(geometry.viewport.width)}x${String(geometry.viewport.height)} viewport`,
      expected: `an element matching ${subject} with fullyInViewport: ${String(asks.fullyInViewport)}`,
      assertion: 'element.fullyInViewport',
      evidence: measured,
    };
  }
  if (asks.textClipped !== undefined && geometry.textClipped !== asks.textClipped) {
    const reason =
      true === geometry.textClipped
        ? `text of the element matching ${subject} is clipped by ${String(geometry.clippedX)}px horizontally and ${String(geometry.clippedY)}px vertically (box ${box})`
        : `text of the element matching ${subject} is not clipped (box ${box}), but the predicate asked for textClipped: true`;
    return {
      pass: false,
      failureReason: reason,
      observed: `clipped by ${String(geometry.clippedX)}px horizontally, ${String(geometry.clippedY)}px vertically`,
      expected: `an element matching ${subject} with textClipped: ${String(asks.textClipped)}`,
      assertion: 'element.textClipped',
      evidence: measured,
    };
  }
  // The overlaps ask is the only one left, and no measured element satisfied it.
  const overlap = geometry.overlap;
  if (overlap === undefined) {
    // The query matched no visible element: a different fact from the boxes not intersecting,
    // and under `not` a plain failure here would become a pass. Inconclusive instead (#1539).
    const reason = `the overlaps query ${JSON.stringify(asks.overlaps)} matched no visible element, so overlap with ${subject} could not be confirmed`;
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      assertion: 'element.overlaps',
      evidence: measured,
    };
  }
  const reason = `the element matching ${subject} (box ${box}) does not overlap the element matching ${JSON.stringify(asks.overlaps)} (box ${formatBox(overlap.box)})`;
  return {
    pass: false,
    failureReason: reason,
    observed: `box ${box}`,
    expected: `an element matching ${subject} overlapping ${JSON.stringify(asks.overlaps)}`,
    assertion: 'element.overlaps',
    evidence: measured,
  };
}
