/**
 * Risk classification — map a change set onto the risk surfaces a host must reason about before
 * shipping generated software (the surfaces real AI-app-builder incidents cluster around: production
 * data loss, auth/payment/RLS/secrets mistakes). Pure + heuristic: path patterns → surfaces now,
 * refine later. A RiskPolicy marks chosen surfaces as gated, which the verdict turns into blocking
 * risks. Every pattern is a named constant (no free strings / inline regexes scattered around).
 */

import {
  RiskSeverity,
  RiskSurface,
  RunChangeKind,
  type RunChangedFile,
  type RunRisk,
} from '@reticlehq/core';

/** Path heuristics per surface. Order is irrelevant — a path may match several surfaces. */
const RISK_PATTERNS: ReadonlyArray<{ surface: RiskSurface; pattern: RegExp }> = [
  {
    surface: RiskSurface.AUTH,
    pattern: /(\bauth\b|login|logout|sign-?in|sign-?up|session|oauth|jwt|password)/i,
  },
  {
    surface: RiskSurface.PAYMENT,
    pattern: /(payment|checkout|stripe|billing|invoice|charge|subscription)/i,
  },
  {
    surface: RiskSurface.DB,
    pattern: /(schema\.|prisma|drizzle|\bdb\b|database|\.sql$|repository)/i,
  },
  { surface: RiskSurface.MIGRATION, pattern: /(migration|migrate)/i },
  { surface: RiskSurface.RLS, pattern: /(\brls\b|row-?level|policy\.sql|policies)/i },
  { surface: RiskSurface.SECRETS, pattern: /(\.env|secret|api[-_]?key|credential|\btoken\b)/i },
  { surface: RiskSurface.DESTRUCTIVE, pattern: /(delete|destroy|\bdrop\b|truncate|purge|wipe)/i },
  { surface: RiskSurface.EXTERNAL, pattern: /(webhook|external|third-?party|integration)/i },
];

/** Severity per surface — the "how bad if this is wrong" floor. */
const SURFACE_SEVERITY: Readonly<Record<RiskSurface, RiskSeverity>> = {
  [RiskSurface.AUTH]: RiskSeverity.HIGH,
  [RiskSurface.PAYMENT]: RiskSeverity.CRITICAL,
  [RiskSurface.DB]: RiskSeverity.HIGH,
  [RiskSurface.MIGRATION]: RiskSeverity.HIGH,
  [RiskSurface.RLS]: RiskSeverity.CRITICAL,
  [RiskSurface.SECRETS]: RiskSeverity.CRITICAL,
  [RiskSurface.DESTRUCTIVE]: RiskSeverity.HIGH,
  [RiskSurface.EXTERNAL]: RiskSeverity.MEDIUM,
};

/** The risk surfaces a single path implicates (unique, stable order = RISK_PATTERNS order). */
export function risksForPath(path: string): RiskSurface[] {
  return RISK_PATTERNS.filter((r) => r.pattern.test(path)).map((r) => r.surface);
}

/** A change set Reticle was told about (the live wiring derives this from the diff). */
export interface ChangedFileInput {
  path: string;
  changeKind: RunChangeKind;
}

/** Policy: which surfaces, if touched, block the verdict (require human confirmation). */
export interface RiskPolicy {
  requiresConfirmation?: RiskSurface[];
}

/** Tag each changed file with the surfaces it touches (for the artifact's changedFiles[]). */
export function classifyChangedFiles(files: ReadonlyArray<ChangedFileInput>): RunChangedFile[] {
  return files.map((f) => ({ path: f.path, changeKind: f.changeKind, risk: risksForPath(f.path) }));
}

/**
 * Collapse the per-file surfaces into one risk row per surface (deduped across the change set), with
 * severity and a gated flag driven by the policy. This is what the verdict counts as blocking.
 */
export function buildRisks(
  changedFiles: ReadonlyArray<RunChangedFile>,
  policy: RiskPolicy = {},
): RunRisk[] {
  const gatedSet = new Set<RiskSurface>(policy.requiresConfirmation ?? []);
  const filesBySurface = new Map<RiskSurface, string[]>();
  for (const file of changedFiles) {
    for (const surface of file.risk) {
      const list = filesBySurface.get(surface) ?? [];
      list.push(file.path);
      filesBySurface.set(surface, list);
    }
  }

  const risks: RunRisk[] = [];
  for (const { surface } of RISK_PATTERNS) {
    const files = filesBySurface.get(surface);
    if (files === undefined || files.length === 0) continue;
    risks.push({
      surface,
      severity: SURFACE_SEVERITY[surface],
      detail: `${files.length} changed file(s) touch the ${surface} surface (e.g. ${files[0]})`,
      gated: gatedSet.has(surface),
    });
  }
  return risks;
}
