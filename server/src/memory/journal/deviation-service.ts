import type { EnvelopeStore } from './envelope-store.js';
import { routeTemplate } from './route-template.js';
import { addSegmentToEnvelope, emptyEnvelope } from './envelope.js';
import { buildDeviationReport, type DeviationReport } from './deviation-report.js';
import type { SegmentRollup } from './rollups.js';
import { withFileLock } from '@/memory/project/file-lock.js';

/**
 * The accumulate-and-compare loop behind the push default. Given the segments a drive/replay produced:
 * judge them against the envelopes learned from PAST runs, then fold them in so the baseline sharpens
 * over time. Order matters — compare first, learn second — so a run never grades itself against a
 * baseline it just polluted. Below MIN_ENVELOPE_SAMPLES the report says insufficientSamples and the
 * caller shows the causal summary instead.
 */
export async function reportAndAccumulate(
  store: EnvelopeStore,
  segments: readonly SegmentRollup[],
  zThreshold?: number,
): Promise<DeviationReport> {
  // Serialized per file: the compare-then-learn read-modify-write runs concurrently under parallel
  // flow_verify. Without the lock, two runs load the same baseline and the later save drops the other's
  // learned segments (and could grade against a half-updated baseline). "Compare first, learn second"
  // only holds within one holder of the lock.
  return withFileLock(store.path, async () => {
    const envelopes = await store.load();
    const report = buildDeviationReport(envelopes, segments, zThreshold);
    for (const segment of segments) {
      if (segment.route === undefined) continue;
      // Never learn from a truncated sample — its understated counts would poison the baseline.
      if (true === segment.truncated) continue;
      /*
       * Keyed on the route TEMPLATE, not the observed path. Keyed on the path, an app with ids in
       * its URLs mints one envelope per id, every envelope holds a single sample, and nothing ever
       * reaches MIN_ENVELOPE_SAMPLES — so the deviation report answers "envelope too new" forever
       * and the feature never turns on. See route-template.ts.
       */
      const key = routeTemplate(segment.route);
      const current = envelopes.get(key) ?? emptyEnvelope(key);
      envelopes.set(key, addSegmentToEnvelope(current, segment));
    }
    await store.save(envelopes);
    return report;
  });
}
