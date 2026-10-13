import {
  CoverageMarker,
  SOURCE_MAPPING_CAPABILITY,
  DATA_RETICLE_SOURCE_ATTR,
  RETICLE_OVERLAY_SELECTOR,
} from '@reticlehq/core';
import { testIdSelector } from './testid-attr.js';

/** Whether any element matching `selector` is the app's, not Reticle's own UI. */
const appCarries = (doc: Document, selector: string): boolean =>
  Array.from(doc.querySelectorAll(selector)).some(
    (el) => null === el.closest(RETICLE_OVERLAY_SELECTOR),
  );

/**
 * The coverage markers this page carries: a `data-reticle-source` stamp (the build plugin is
 * active) and a test id, each on at least one element the APP rendered. Reticle's HUD never counts,
 * hatch open or not: its controls are not the app's.
 */
export function coverageMarkers(doc: Document): string[] {
  return [
    ...(appCarries(doc, `[${DATA_RETICLE_SOURCE_ATTR}]`) ? [CoverageMarker.SOURCE] : []),
    ...(appCarries(doc, testIdSelector()) ? [CoverageMarker.TESTID] : []),
  ];
}

/**
 * The coverage capabilities that cannot apply to this page: file:line, on a page no build plugin
 * set up, that runs no component framework and carries no stamp — plain HTML, which a plugin would
 * have nothing to stamp in. It was counted missing and held the Harness at 75% forever.
 */
export function notApplicableFor(page: {
  buildPlugin: boolean;
  adapters: readonly string[];
  markers: readonly string[];
}): string[] {
  const couldStamp =
    page.buildPlugin || 0 < page.adapters.length || page.markers.includes(CoverageMarker.SOURCE);
  return couldStamp ? [] : [SOURCE_MAPPING_CAPABILITY];
}
