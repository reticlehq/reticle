/**
 * What a page shows about how well Reticle can see it.
 *
 * No zod here: the SDK reads these on the way in, and a module that builds classic zod schemas
 * brings about 85 KB onto every page (#2369).
 */

/**
 * Markers a daemon adds to an app's `channels` beside the protocol channel ids, for the two
 * capabilities no channel names. Sent only on evidence, never while the gap that names the same
 * capability is recorded: absence of both reads as "not seen yet", never as covered.
 */
export const CoverageMarker = {
  /** The page carries `data-reticle-source` (the build plugin is active). */
  SOURCE: 'source',
  /** The app's snapshots show `data-testid` on its controls. */
  TESTID: 'testid',
} as const;
export type CoverageMarker = (typeof CoverageMarker)[keyof typeof CoverageMarker];

/**
 * The file:line capability's name (`CoverageCapability.SOURCE_MAPPING` is this). Here, beside the
 * markers, so a page can say it does not apply without loading the coverage rules into first load.
 */
export const SOURCE_MAPPING_CAPABILITY = 'file:line source mapping';
