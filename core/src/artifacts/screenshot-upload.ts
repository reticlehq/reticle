import * as z from 'zod';
import { ScreenshotSource } from '@/verdict/verification-run.js';

/**
 * The body of `POST /v1/runs/:runId/screenshots` — one step screenshot, sent once, after the
 * platform has accepted its run. One schema for both ends, so the daemon cannot send a field the
 * platform does not read.
 *
 * `jpeg` is base64 of real JPEG bytes, and `sha256` is of those decoded bytes. The platform answers
 * 201 stored, 200 already held (same run, seq and sha256), 404 run not found, 400 invalid, 413 too
 * large, 409 too many for one run or a different image already at that seq (a seq is never reused).
 */
/** The platform's bound on every text field of an upload. */
export const UPLOAD_TEXT_MAX = 300;

export const ScreenshotUploadSchema = z.object({
  seq: z.number().int().min(0),
  file: z.string().min(1).max(UPLOAD_TEXT_MAX),
  step: z.string().min(1).max(UPLOAD_TEXT_MAX).optional(),
  tool: z.string().min(1).max(UPLOAD_TEXT_MAX).optional(),
  /** The check this picture is of, so the platform's run page can show it beside that check. */
  checkId: z.string().min(1).max(UPLOAD_TEXT_MAX).optional(),
  source: z.nativeEnum(ScreenshotSource),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  jpeg: z.string().min(1),
});
export type ScreenshotUpload = z.infer<typeof ScreenshotUploadSchema>;
