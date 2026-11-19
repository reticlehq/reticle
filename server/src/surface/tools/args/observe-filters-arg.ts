import { z } from 'zod';
import { EventType, ReticleTool } from '@reticlehq/core';
import { OBSERVE_FILTER_BUCKETS } from '@reticlehq/engine/window/event-filters.js';

/**
 * `reticle_observe`'s `filters`, as one bucket name or a list of them.
 *
 * The description says "Use a bucket name", so `filters: "state"` is the natural first call, and an
 * array-only schema refused it (#2294). One string is read as a list of one. Some clients send an
 * array as the JSON text of one, so a string that starts with `[` is read as that array; when it is
 * not an array of strings it is refused.
 *
 * A single string must name a bucket or an event type. Taken as one filter name, "net, console",
 * "NET" or "" match nothing and answer an empty timeline without a word, which reads as "the app did
 * nothing". The array-only schema refused those, and they stay refused.
 *
 * The buckets are listed with commas, not `|`: a raw event type is accepted too, so the list is not
 * a closed vocabulary the schema could enforce (vocabulary-enforced.test.ts). It never was — an
 * array of any strings passed before — and that guard only held because a bare string failed.
 *
 * The refusals open with the tool name, which is how the error table tells an invalid call from a
 * Reticle defect (error-recovery.ts).
 */
export const observeFiltersSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe(
    'Event type allowlist — the cheapest way to shrink a large timeline. One bucket name or an ' +
      'array of them: dom, net, route, console, animation, signal, perf, state, storage, or a raw ' +
      'type (e.g. "net.request"). E.g. "net" or ["net", "console"]. Omit to return all types.',
  );

const BUCKETS = Object.keys(OBSERVE_FILTER_BUCKETS);
const KNOWN_NAMES: ReadonlySet<string> = new Set([...BUCKETS, ...Object.values(EventType)]);

const HOW_TO_SEND =
  `Send one bucket name (${BUCKETS.join(', ')}) or one event type, e.g. "net", ` +
  'or an array, e.g. ["net", "console"].';

/** The filter list a call asked for, or `undefined` when it asked for every type. */
export function readObserveFilters(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value as string[];
  }
  if ('string' !== typeof value) {
    return undefined;
  }
  if (!value.trimStart().startsWith('[')) {
    if (!KNOWN_NAMES.has(value)) {
      throw new Error(
        `${ReticleTool.OBSERVE} filters ${JSON.stringify(value)} names no bucket and no event type. ${HOW_TO_SEND}`,
      );
    }
    return [value];
  }
  const notAList = new Error(
    `${ReticleTool.OBSERVE} filters starts with "[" but is not an array of strings. ${HOW_TO_SEND}`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw notAList;
  }
  if (!Array.isArray(parsed) || !parsed.every((f) => 'string' === typeof f)) {
    throw notAList;
  }
  return parsed;
}
