/**
 * The words a desktop realm read in its picture of a window, each with its box in the pixels of
 * the picture. A canvas, a game or a remote desktop has no elements: the box of a word is the
 * point an agent gives to a click (`args.point`). The realm sends them with the picture, and the
 * daemon passes them to the agent.
 */
import * as z from 'zod';

/** The most words of one picture that the daemon passes on. */
export const MAX_PICTURE_TEXTS = 200;

export const PictureTextSchema = z.object({
  text: z.string().max(200),
  /** x, y, width and height, in the pixels of the picture. */
  box: z.array(z.number()).length(4),
});
export type PictureText = z.infer<typeof PictureTextSchema>;

/** The words, and how many the realm left out (unsure, or past the most). */
export const PictureTextsSchema = z.object({
  texts: z.array(PictureTextSchema).max(MAX_PICTURE_TEXTS),
  textsCut: z.number().int().nonnegative().optional(),
});
