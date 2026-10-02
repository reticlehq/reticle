import { z } from 'zod';

/**
 * The shape of the file the learned ambient map is kept in.
 *
 * Only the storing of the map lives here. What counts as background churn is a judgement about what
 * happened on the page, and that reasoning sits with the rules that decide a verdict, in
 * `events/ambient.ts`.
 *
 * Example of a valid file: `{ "version": 1, "regions": { "#chat-feed": 43 } }` — the chat feed has
 * changed on its own forty-three times, with no action to explain it.
 */
export const AmbientFileSchema = z.object({
  version: z.literal(1),
  regions: z.record(z.number()),
});
