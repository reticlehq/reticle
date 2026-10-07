/**
 * What a drive found that no single click's check could: the page rendering something other than
 * what the API sent (`reticle_reconcile`, run on each page the Harness reaches), and the crawl's
 * anomalies (blank routes, dead controls, console errors, contradictions).
 *
 * Listed in the drive's report beside the verdict, because the agent reading it reports what it is
 * shown: a defect the drive saw and the report left out is a defect nobody hears about.
 */
import { ReticleTool, asRecord, asString } from '@reticlehq/core';
import type { ToolOutcome } from './harness.js';

/** Enough to act on without burying the verdict. */
const MAX_FINDINGS = 20;

export function appFindings(toolCalls: readonly ToolOutcome[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (key: string, line: string): void => {
    if (seen.has(key) || MAX_FINDINGS <= lines.length) return;
    seen.add(key);
    lines.push(line);
  };
  for (const call of toolCalls) {
    if (call.isError) continue;
    const result = asRecord(call.result);
    if (ReticleTool.RECONCILE === call.name) {
      const mismatches = result['mismatches'];
      for (const raw of Array.isArray(mismatches) ? mismatches : []) {
        const m = asRecord(raw);
        const entity = asString(m['entity']) ?? '?';
        const field = asString(m['field']) ?? '?';
        const shown = asString(m['rendered']);
        add(
          `r:${entity}:${field}`,
          `  RENDERED ≠ API: ${entity} ${field} — the API says ${String(m['api'])}${shown === undefined ? '' : `, the page shows ${shown}`} (${asString(m['why']) ?? ''})`,
        );
      }
    }
    if (ReticleTool.CRAWL === call.name) {
      const anomalies = result['anomalies'];
      for (const raw of Array.isArray(anomalies) ? anomalies : []) {
        const a = asRecord(raw);
        const kind = asString(a['kind']) ?? 'anomaly';
        const desc = asString(a['desc']) ?? '';
        const detail = asString(a['detail']);
        add(
          `c:${kind}:${desc}`,
          `  CRAWL ${kind}: ${desc}${detail === undefined ? '' : ` — ${detail}`}`,
        );
      }
    }
  }
  return 0 === lines.length
    ? []
    : [
        'Found beyond the clicks (each page compared with the API, and a crawl of the app):',
        ...lines,
      ];
}
