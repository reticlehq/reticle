/**
 * Whatever runs after merge must be able to run before it.
 *
 * Incident (#1514): most pushes to main went red on `bench` and on Windows install cells that
 * the merge queue never ran, while `gate` counted them as skipped. Two shapes hide that gap, and
 * this guard reads both:
 *
 * - a job whose `if:` admits `push` but not `merge_group` (bench);
 * - an install cell that the `install_matrix` step lists for push but not for `merge_group`
 *   (`merge_group) ... WINDOWS=""`). Reading job conditions alone misses this one.
 *
 * A gap is accepted only when `.github/flaky.json` names it with an issue: the job name, or
 * `install-gate/<os>/<scaffold>` for one cell. Expiry is NOT judged here; `flaky-expiry.mjs`
 * owns it, so a date never turns this test red on an unrelated pull request.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '@/machine/repo-root.js';

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const FLAKY = join(REPO_ROOT, '.github', 'flaky.json');

const SIDE_EFFECT = new Set(['gate', 'fixtures-dispatch', 'nightly-watch']);
const INSTALL_JOB = 'install-gate';
const LINUX = 'ubuntu-latest';
const WINDOWS = 'windows-latest';
const PUSH_BRANCH = '*';
const QUEUE_BRANCH = 'merge_group';

type Cells = Record<string, Set<string>>;

function jobIf(body: unknown): string {
  if ('object' !== typeof body || null === body || !('if' in body)) return '';
  const value = (body as { if?: unknown }).if;
  return 'string' === typeof value ? value : '';
}

/** Names that `.github/flaky.json` quarantines with an issue. */
export function quarantinedNames(flakyText: string): Set<string> {
  const parsed = JSON.parse(flakyText) as {
    entries?: { id?: unknown; job_or_test?: unknown; issue?: unknown }[];
  };
  const names = new Set<string>();
  for (const entry of parsed.entries ?? []) {
    if ('string' !== typeof entry.issue || '' === entry.issue) continue;
    if ('string' === typeof entry.job_or_test) names.add(entry.job_or_test);
    if ('string' === typeof entry.id) names.add(entry.id);
  }
  return names;
}

/** Jobs whose condition admits push but not merge_group. */
export function pushOnlyJobs(workflowText: string, allowed: Set<string>): string[] {
  const parsed = parse(workflowText) as { jobs?: Record<string, unknown> };
  return Object.entries(parsed.jobs ?? {})
    .filter(([name, body]) => {
      if (SIDE_EFFECT.has(name) || allowed.has(name)) return false;
      const condition = jobIf(body);
      return condition.includes('push') && !condition.includes(QUEUE_BRANCH);
    })
    .map(([name]) => name);
}

function words(value: string, vars: Record<string, string>): string[] {
  const unquoted = value.replace(/^["']|["']$/g, '');
  const ref = /^\$\{?([A-Z_]+)\}?$/.exec(unquoted);
  const body = null !== ref && undefined !== ref[1] ? (vars[ref[1]] ?? '') : unquoted;
  return body.split(/\s+/).filter((word) => 0 < word.length);
}

/** The install_matrix step's `case` block, as event branch -> os -> scaffolds. */
export function installCellsByBranch(runText: string): Record<string, Cells> {
  const vars: Record<string, string> = {};
  for (const match of runText.matchAll(/^\s*([A-Z_]+)=(['"])([^'"]*)\2\s*$/gm)) {
    if (undefined !== match[1] && undefined !== match[3]) vars[match[1]] = match[3];
  }
  const branches: Record<string, Cells> = {};
  const branch = /^\s*([a-z_*]+)\)\s*LINUX=(\S+);\s*WINDOWS=(\S+)\s*;;/gm;
  for (const match of runText.matchAll(branch)) {
    const [, name, linux, windows] = match;
    if (undefined === name || undefined === linux || undefined === windows) continue;
    branches[name] = {
      [LINUX]: new Set(words(linux, vars)),
      [WINDOWS]: new Set(words(windows.replace(/;$/, ''), vars)),
    };
  }
  return branches;
}

/** Install cells that run on push but not in the queue, minus quarantined ones. */
export function cellsMissingFromQueue(runText: string, allowed: Set<string>): string[] {
  const branches = installCellsByBranch(runText);
  const push = branches[PUSH_BRANCH];
  const queue = branches[QUEUE_BRANCH];
  if (undefined === push || undefined === queue) {
    return [`install_matrix: could not read the '${PUSH_BRANCH}' and '${QUEUE_BRANCH}' branches`];
  }
  const missing: string[] = [];
  for (const [os, scaffolds] of Object.entries(push)) {
    for (const scaffold of scaffolds) {
      if (true === queue[os]?.has(scaffold)) continue;
      const id = `${INSTALL_JOB}/${os}/${scaffold}`;
      if (!allowed.has(id) && !allowed.has(`${INSTALL_JOB}/${os}`)) missing.push(id);
    }
  }
  return missing;
}

function installMatrixRun(workflowText: string): string {
  const parsed = parse(workflowText) as {
    jobs?: { changes?: { steps?: { id?: unknown; run?: unknown }[] } };
  };
  const step = (parsed.jobs?.changes?.steps ?? []).find((s) => 'install_matrix' === s.id);
  return 'string' === typeof step?.run ? step.run : '';
}

const PLANTED_RUN = `
ALL='vite-react next-app-router cra'
PR_LINUX='vite-react'
case "x" in
  pull_request) LINUX="$PR_LINUX"; WINDOWS='vite-react' ;;
  merge_group) LINUX="$ALL"; WINDOWS="" ;;
  *) LINUX="$ALL"; WINDOWS="$ALL" ;;
esac
`;

describe('post-merge jobs can also run pre-merge', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const allowed = quarantinedNames(readFileSync(FLAKY, 'utf8'));

  it('no push-only job is missing from merge_group unless quarantined', () => {
    expect(
      pushOnlyJobs(workflow, allowed),
      'these jobs run on push to main but cannot run on merge_group. Add merge_group to the if:, or a flaky.json entry with an issue',
    ).toEqual([]);
  });

  it('no install cell runs on push but not in the queue unless quarantined', () => {
    const run = installMatrixRun(workflow);
    expect(run, 'the changes job has no install_matrix step').not.toBe('');
    expect(
      cellsMissingFromQueue(run, allowed),
      'these install cells run on push to main but not in the merge queue. Add them to the merge_group branch of install_matrix, or quarantine install-gate/<os>/<scaffold> in flaky.json',
    ).toEqual([]);
  });

  it('a queue that drops the Windows cells is caught (planted)', () => {
    expect(cellsMissingFromQueue(PLANTED_RUN, new Set())).toEqual([
      'install-gate/windows-latest/vite-react',
      'install-gate/windows-latest/next-app-router',
      'install-gate/windows-latest/cra',
    ]);
  });

  it('a quarantined cell is accepted, and only that one (planted)', () => {
    const allowedOne = new Set(['install-gate/windows-latest/cra']);
    expect(cellsMissingFromQueue(PLANTED_RUN, allowedOne)).toEqual([
      'install-gate/windows-latest/vite-react',
      'install-gate/windows-latest/next-app-router',
    ]);
  });

  it('a job gated on push alone is caught (planted)', () => {
    const planted = `jobs:\n  slow:\n    if: github.event_name == 'push'\n    runs-on: x\n`;
    expect(pushOnlyJobs(planted, new Set())).toEqual(['slow']);
    expect(pushOnlyJobs(planted, new Set(['slow']))).toEqual([]);
  });

  it('an entry without an issue does not quarantine anything', () => {
    const names = quarantinedNames(
      JSON.stringify({ entries: [{ id: 'x', job_or_test: 'bench' }] }),
    );
    expect(names.has('bench')).toBe(false);
  });
});
