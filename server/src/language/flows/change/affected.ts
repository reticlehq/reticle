/**
 * The file→flow reverse index — the heart of the unavoidable loop. When a file changes, which flows must
 * re-verify? A flow persists the source files its anchors were stamped from (its "sources manifest"); a
 * changed file that appears in a flow's manifest makes that flow affected. A flow with NO manifest
 * (recorded before v2.2, or un-stampable) is `unknown` — and unknown always means affected, never
 * silently skipped: the loop fails safe toward re-verifying.
 */

export interface FlowSources {
  name: string;
  /** Repo-relative source files this flow's anchors came from. Empty/absent ⇒ unknown provenance. */
  sources?: readonly string[];
}

export interface AffectedResult {
  /** Flows to re-verify: those touching a changed file, plus all unknown-provenance flows. */
  affected: string[];
  /** Of the affected, which were included only because their provenance is unknown (fail-safe). */
  unknownProvenance: string[];
}

/** Normalize a path for comparison — strip a leading./ and any file:line suffix. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/:\d+(:\d+)?$/, '');
}

/**
 * Which flows are affected by a set of changed files. Deterministic; a flow with no sources manifest is
 * always affected (fail-safe). `changedFiles` and flow sources are matched by normalized path suffix so
 * a repo-relative change matches an absolute stamp and vice-versa.
 */
export function affectedFlows(
  flows: readonly FlowSources[],
  changedFiles: readonly string[],
): AffectedResult {
  const changed = changedFiles.map(normalize);
  const matchesChange = (source: string): boolean => {
    const s = normalize(source);
    return changed.some((c) => c === s || c.endsWith(`/${s}`) || s.endsWith(`/${c}`));
  };

  const affected: string[] = [];
  const unknownProvenance: string[] = [];
  for (const flow of flows) {
    if (flow.sources === undefined || 0 === flow.sources.length) {
      affected.push(flow.name);
      unknownProvenance.push(flow.name);
      continue;
    }
    if (flow.sources.some(matchesChange)) affected.push(flow.name);
  }
  return { affected, unknownProvenance };
}
