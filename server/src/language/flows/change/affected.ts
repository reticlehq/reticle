/**
 * The file→flow reverse index — the heart of the unavoidable loop. When a file changes, which flows must
 * re-verify? A flow persists the source files its anchors were stamped from (its "sources manifest"); a
 * changed file that appears in a flow's manifest makes that flow affected. A flow with NO manifest
 * (recorded before source stamping, or un-stampable) is `unknown` — and unknown always means affected, never
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

/** A file a source stamper can put on an element — the only files a flow's manifest can ever name. */
const COMPONENT_FILE = /\.(?:jsx|tsx|vue|svelte|astro)$/;
/** Same test-file rule the stampers use, so a test is never demanded a flow. */
const TEST_FILE = /(?:\.(?:test|spec)\.[^./]+$)|(?:^|\/)__tests__\//;
/**
 * Something a step could act on: a handler prop (`onClick=`, `@click`, `v-on:`, `on:submit`) or a
 * native control.
 *
 * ponytail: a text heuristic, not a parse. A flow's manifest only names the file of the element a
 * step ACTED on, so a display-only component can never be attributed and demanding a flow for one
 * would block forever. A handler passed in from a parent under another name escapes it; upgrade to
 * recording the source of the element an `expect` matched if that proves common.
 */
const INTERACTIVE =
  /\bon[A-Z]\w*=|@[a-z]+[=.]|\bv-on:|\bon:[a-z]+|<(?:button|input|select|textarea|form|a|summary)[\s>/]/;

export function isInteractiveSource(text: string): boolean {
  return INTERACTIVE.test(text);
}

/**
 * Changed interactive components that no saved flow's manifest names.
 *
 * `affectedFlows` starts from the flows, so a file no flow ever touched affects nothing — and a gate
 * built only on it passed a brand-new feature that had never been driven. This starts from the
 * change instead. `isInteractive` is injected so the decision stays pure; the CLI reads the file.
 */
export function unflowedFiles(
  flows: readonly FlowSources[],
  changedFiles: readonly string[],
  isInteractive: (file: string) => boolean,
): string[] {
  const sources = flows.flatMap((flow) => (flow.sources ?? []).map(normalize));
  return changedFiles.filter((file) => {
    const c = normalize(file);
    if (!COMPONENT_FILE.test(c) || TEST_FILE.test(c)) return false;
    if (sources.some((s) => c === s || c.endsWith(`/${s}`) || s.endsWith(`/${c}`))) return false;
    return isInteractive(file);
  });
}
