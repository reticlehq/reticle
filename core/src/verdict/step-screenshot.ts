/**
 * Where a run keeps its step screenshots.
 *
 * No zod here: the SDK reads these on the way in, and a module that builds classic zod schemas
 * brings about 85 KB onto every page (#2369).
 */

/** How a step screenshot is taken and kept — shared by the daemon, the SDK and the platform. */
export const STEP_SCREENSHOT = {
  /** `.reticle/visual/runs/<runId>/<seq>-<tool>.jpg` */
  RUNS_DIR: 'runs',
  /** One line per landed screenshot, beside the images: what the run artifact and the upload read. */
  MANIFEST_FILE: 'shots.jsonl',
  JPEG_QUALITY: 0.7,
  MAX_SIDE_PX: 1600,
  /** The platform refuses more than this for one run, so the daemon stops taking them there. */
  MAX_PER_RUN: 300,
  /** The platform refuses an image larger than this, decoded. */
  MAX_BYTES: 1.5 * 1024 * 1024,
  /**
   * The `tool` of a frame: a picture taken between steps while Reticle drives a tab, about once a
   * second. Frames share the run's `seq`, so the shots in `seq` order play the run as a film.
   */
  FRAME_TOOL: 'frame',
} as const;
