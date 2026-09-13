/**
 * Every CI job either gates a merge or is written down as deliberately not gating.
 *
 * `gate` is the single required status check, and its `needs:` array is hand-maintained. A job absent
 * from that array runs, reports, and is structurally incapable of stopping a merge — the workflow's
 * own comment records that `windows`, `rust`, `rust-macos` and `desktop-e2e` were all in exactly that
 * state, and `rust` is the only thing in CI that compiles `packages/tauri` at all. Four jobs, four
 * separate discoveries, none of them by a machine.
 *
 * Adding a job to the workflow is half the work; adding it to `needs:` is the other half, and nothing
 * checked the second half. This is the same shape as every other completeness guard here: a registry
 * exists, and something has to prove it is complete.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'ci.yml');

/** The aggregate job itself — the thing branch protection requires. */
const GATE = 'gate';

/**
 * Jobs that legitimately do not gate a merge, each with the reason it cannot.
 *
 * The bar is not "this job is unimportant". It is "this job CANNOT fail a PR", which is a property of
 * the job, not an opinion about it. Anything else belongs in `needs:`.
 */
const NOT_A_GATE = new Map<string, string>([
  [
    GATE,
    'the aggregate itself. Listing it in its own `needs:` is a cycle, and it is the job branch ' +
      'protection requires directly.',
  ],
  [
    'fixtures-dispatch',
    'cannot fail a PR in either of the two ways that matter. It is `if: push && ref == main`, so it ' +
      'never runs on a pull request at all; and its one step exits 0 when the token is unset and ' +
      'merely echoes when the dispatch call does not return 204. It asks ANOTHER repo to verify this ' +
      "commit and the verdict lives in that repo's run — a fire-and-forget notification, not a check. " +
      'Adding it to `needs:` would gate merges on a job that is `skipped` on every PR forever.',
  ],
]);

interface Workflow {
  jobs: Record<string, { needs?: string | string[] }>;
}

/** Narrow the parsed YAML at the boundary rather than trusting it. */
function readWorkflow(): Workflow {
  const parsed: unknown = parse(readFileSync(WORKFLOW, 'utf8'));
  if ('object' !== typeof parsed || null === parsed || !('jobs' in parsed))
    throw new Error(`${WORKFLOW} has no jobs map`);
  const jobs: unknown = parsed.jobs;
  if ('object' !== typeof jobs || null === jobs) throw new Error(`${WORKFLOW} jobs is not a map`);
  const out: Workflow['jobs'] = {};
  for (const [name, body] of Object.entries(jobs)) {
    const needs: unknown =
      'object' === typeof body && null !== body && 'needs' in body
        ? (body as { needs: unknown }).needs
        : undefined;
    out[name] =
      'string' === typeof needs
        ? { needs }
        : Array.isArray(needs)
          ? { needs: needs.filter((n): n is string => 'string' === typeof n) }
          : {};
  }
  return { jobs: out };
}

const needsOf = (name: string): readonly string[] => {
  const needs = readWorkflow().jobs[name]?.needs;
  if (undefined === needs) return [];
  return 'string' === typeof needs ? [needs] : needs;
};

describe('every CI job either gates a merge or says why it does not', () => {
  it('finds the workflow and its jobs (a passing test over zero jobs proves nothing)', () => {
    expect(Object.keys(readWorkflow().jobs).length).toBeGreaterThan(10);
  });

  it(`${GATE} exists and depends on real jobs`, () => {
    const jobs = readWorkflow().jobs;
    expect(
      jobs[GATE],
      `${GATE} is the single required status check and it is missing`,
    ).toBeDefined();
    const unknownDeps = needsOf(GATE).filter((n) => !(n in jobs));
    expect(unknownDeps, `${GATE} needs jobs that do not exist in the workflow`).toEqual([]);
  });

  it('no job runs outside the gate without a written reason', () => {
    const gated = new Set(needsOf(GATE));
    const ungated = Object.keys(readWorkflow().jobs).filter(
      (name) => !gated.has(name) && !NOT_A_GATE.has(name),
    );
    expect(
      ungated,
      `these jobs run, report, and cannot stop a merge: ${ungated.join(', ')}. Add each to the ` +
        `\`needs:\` array of the \`${GATE}\` job, or to NOT_A_GATE here with the reason it cannot ` +
        `fail a PR.`,
    ).toEqual([]);
  });

  it('every NOT_A_GATE entry names a job that still exists', () => {
    const jobs = readWorkflow().jobs;
    for (const [name, why] of NOT_A_GATE) {
      expect(name in jobs, `NOT_A_GATE exempts ${name}, which is no longer a job (${why})`).toBe(
        true,
      );
    }
  });

  it('no NOT_A_GATE entry is also in the gate — an exemption that is gated anyway is stale', () => {
    const gated = new Set(needsOf(GATE));
    const contradictory = [...NOT_A_GATE.keys()].filter((n) => gated.has(n));
    expect(
      contradictory,
      `these are exempted here AND listed in \`${GATE}\`'s needs — drop the exemption`,
    ).toEqual([]);
  });
});

/**
 * A scaffold the install gate knows about but CI never runs is coverage on paper only.
 *
 * The gate reads its scaffold list from `install-gate.mjs` and its expectations from
 * `install-baseline.json`; CI runs one matrix cell per scaffold. Those are three lists that have to
 * agree, and nothing made them. Adding a scaffold and forgetting the matrix leaves a baseline
 * nobody checks — silent, and indistinguishable from coverage.
 *
 * This went from five scaffolds to ten in one branch, which is exactly when the drift happens.
 */
describe('every install-gate scaffold runs in CI', () => {
  const baselineIds = (): string[] => {
    const raw = readFileSync(join(REPO, 'apps/e2e/install-baseline.json'), 'utf8');
    return Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
  };

  const matrixIds = (): string[] => {
    const yml = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    const block = /scaffold:\s*\[([^\]]+)\]/s.exec(yml);
    if (null === block) return [];
    return (block[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .sort();
  };

  it('the CI matrix and the recorded baseline name the same scaffolds', () => {
    const inBaseline = baselineIds();
    const inMatrix = matrixIds();

    expect(
      inMatrix.length,
      'no scaffold matrix found in ci.yml — has the job changed shape?',
    ).toBeGreaterThan(0);

    expect(
      inBaseline.filter((id) => !inMatrix.includes(id)),
      'these scaffolds have a recorded baseline but no CI cell, so nothing ever runs them',
    ).toEqual([]);

    expect(
      inMatrix.filter((id) => !inBaseline.includes(id)),
      'these CI cells name a scaffold with no recorded baseline, so the cell fails asking for one',
    ).toEqual([]);
  });
});
