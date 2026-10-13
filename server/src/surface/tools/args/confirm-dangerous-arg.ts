import { z } from 'zod';

/**
 * The per-call acknowledgement of steps the replay guard holds as destructive. Never persisted into
 * a flow: a destructive confirmation is a decision made for one run.
 */
export const confirmDangerousArg = (scope: string): z.ZodOptional<z.ZodBoolean> =>
  z.boolean().optional().describe(`Set true to allow destructive controls during ${scope} only.`);
