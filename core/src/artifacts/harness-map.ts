/**
 * The Harness's map of an app: the pages a survey reached before a drive, and what each showed.
 *
 * Built on the daemon with no model (the survey clicks nav links and toggles, never a field and never
 * a write), kept in `.reticle/harness-map.json`, refreshed from what each drive reads, and sent to the
 * platform when a drive starts. A drive that misses its goal on one page looks it up here instead of
 * guessing, and the search before grading starts from it.
 */
import * as z from 'zod';

/** Bounds on what one map holds: a dashboard's pages, not its rows. */
export const HarnessMapLimit = {
  PAGES: 40,
  TEXTS: 60,
  CONTROLS: 40,
  TEXT: 200,
} as const;

const Text = z.string().max(HarnessMapLimit.TEXT);

export const HarnessMapPageSchema = z.object({
  /** The page's path (and hash), without its query or Reticle's own parameters. */
  route: Text.min(1),
  /** Its first heading, when it has one. */
  heading: Text.optional(),
  /** The words it showed: headings, labels and text, in reading order. */
  texts: z.array(Text).max(HarnessMapLimit.TEXTS),
  /** Its controls, as `role "name"`. */
  controls: z.array(Text).max(HarnessMapLimit.CONTROLS),
  /** How the survey got here: the control on the start page, or absent for the start page. */
  reachedBy: Text.optional(),
  /** When this page was last read (epoch ms, injected). */
  at: z.number().int().min(0),
});
export type HarnessMapPage = z.infer<typeof HarnessMapPageSchema>;

export const HarnessMapSchema = z.object({
  /** When the survey last ran (epoch ms, injected); a drive's own reads refresh pages, not this. */
  surveyedAt: z.number().int().min(0),
  pages: z.array(HarnessMapPageSchema).max(HarnessMapLimit.PAGES),
});
export type HarnessMap = z.infer<typeof HarnessMapSchema>;
