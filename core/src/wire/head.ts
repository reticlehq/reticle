/**
 * What `HEAD_READ` answers: the live `<head>`'s `<link rel>` and `<meta>` tags (#1425).
 *
 * Every tag, unfiltered, so the matching rule lives once on the Node side and is tested there without
 * a DOM. Not strict, so an SDK that later reports more about a tag does not break an older daemon.
 * Bounded by `HEAD_READ_MAX_TAGS`, because a page can put anything in its head. The cap lives in
 * constants.ts, not here: the browser needs the number but not these schemas, and importing it from
 * this module would put zod-built schemas on every page's first load (first-load-size.test.ts).
 */
import { z } from 'zod';

/**
 * Set when the value reported is not the page's exact text: redacted, a `data:` URL summarized, or
 * capped for length. A check it cannot settle on what is left must say `unknown`, never `no`.
 */
const ALTERED = z.boolean().optional();

export const HeadLinkSchema = z.object({ rel: z.string(), href: z.string(), altered: ALTERED });
export const HeadMetaSchema = z.object({
  name: z.string().optional(),
  property: z.string().optional(),
  content: z.string(),
  altered: ALTERED,
});
export const HeadSnapshotSchema = z.object({
  links: z.array(HeadLinkSchema),
  metas: z.array(HeadMetaSchema),
  truncated: z.boolean().optional(),
});
export type HeadLink = z.infer<typeof HeadLinkSchema>;
export type HeadMeta = z.infer<typeof HeadMetaSchema>;
export type HeadSnapshot = z.infer<typeof HeadSnapshotSchema>;
