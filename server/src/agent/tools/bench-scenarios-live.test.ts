/**
 * Every bug the benchmark can inject still has a handler, and something still scores it.
 *
 * `apps/bench-app/src/reticle-bug-injector.ts` declares ~80 defect scenarios in a dozen `Record`
 * literals. `apps/bench-app` has no test setup at all, so nothing anywhere asserts that a scenario id
 * still reaches code — and the failure is silent in the worst possible direction: an id whose table is
 * no longer consumed injects NOTHING, the harness observes a clean app, and the result is recorded as
 * NOT MEASURED and dropped from the catch-rate denominator. Coverage shrinks while the headline stays
 * perfect, which is a documented failure mode of this benchmark, not a hypothetical one.
 *
 * Two directions, both silent:
 *   - a scenario whose table nothing installs is a bug that cannot fire;
 *   - a scenario nothing references is a bug nobody scores.
 *
 * Static, because the alternative is a browser. The injector is one file, the dispatch is one
 * function, and "is this table wired into the entry point" is a question a string scan answers in
 * milliseconds — the same trade `e2e-surface-drift.test.ts` makes for the tool surface.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../repo-root.js';

const REPO = REPO_ROOT;
const INJECTOR = join(REPO, 'apps', 'bench-app', 'src', 'reticle-bug-injector.ts');
/** The one function a URL parameter reaches. Anything it does not call is dead. */
const ENTRY = 'installBugInjector';

/** Scenarios dispatched by a bare `bugs.has('id')` branch rather than through a table. */
const BARE_BRANCH_IDS = ['state-desync', 'status-stale', 'render-storm'] as const;

/**
 * Scenarios that no harness, spec or scorecard references — SHIPPED BUT UNSCORED.
 *
 * They inject correctly; nothing measures them, so they contribute nothing to any catch rate. Listed
 * rather than failing the build because an unscored scenario is a gap in the benchmark's coverage, not
 * a broken injector, and deleting a working defect to quiet a test is the wrong direction. The value
 * of the list is that it is SHORT and visible: when it grows, the benchmark is measuring less than its
 * fixture can produce.
 */
const UNSCORED = new Map<string, string>([
  [
    'empty-200-deployments',
    'a 200 with an empty list where rows are expected. No harness drives it and no scorecard names ' +
      'it, so it has never appeared in a catch rate.',
  ],
  [
    'payload-wrong-value',
    'a response body with a plausible but wrong field. Same status: injectable, never scored.',
  ],
]);

const source = (): string => readFileSync(INJECTOR, 'utf8');

/** Every `Record` table in the injector, with the scenario ids it declares. */
function tables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of source().split('\n')) {
    const open = /^const ([A-Z_0-9]+): Record<string, .*> = \{$/.exec(line);
    if (null !== open) {
      const name = open[1];
      if (undefined !== name) {
        current = name;
        out.set(current, []);
      }
      continue;
    }
    if (null !== current && /^\};?$/.test(line)) {
      current = null;
      continue;
    }
    if (null === current) continue;
    // Top-level keys only: a nested option object is indented deeper.
    const key = /^ {2}(?:'([^']+)'|([A-Za-z_][\w]*)):/.exec(line);
    const id = key?.[1] ?? key?.[2];
    if (undefined !== id) out.get(current)?.push(id);
  }
  return out;
}

const declaredIds = (): string[] => [...tables().values()].flat();

/** The body of `installBugInjector`, which is where dispatch either happens or does not. */
function entryBody(): string {
  const text = source();
  const at = text.indexOf(`export function ${ENTRY}(`);
  return -1 === at ? '' : text.slice(at);
}

/** Map a line number to the top-level function it sits in, so a table's consumer can be named. */
function consumerOf(table: string): string | null {
  let fn: string | null = null;
  // A mention BEFORE the declaration is the file's own header comment, not a consumer. Scanning from
  // line one reported four live tables as never-read, because the comment naming them is the first
  // match — a guard that is confidently wrong about working code.
  let seenDeclaration = false;
  let declaring = false;
  for (const line of source().split('\n')) {
    const start = /^(?:export )?function (\w+)/.exec(line);
    if (null !== start) fn = start[1] ?? null;
    if (new RegExp(`^const ${table}\\b`).test(line)) {
      seenDeclaration = true;
      declaring = true;
      continue;
    }
    if (declaring) {
      if (/^\};?$/.test(line)) declaring = false;
      continue;
    }
    if (!seenDeclaration) continue;
    const code = line.trimStart();
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
    if (new RegExp(`\\b${table}\\b`).test(line)) return fn;
  }
  return null;
}

describe('every declared bench scenario can still fire', () => {
  it('finds the injector and its tables (a pass over zero scenarios proves nothing)', () => {
    expect(existsSync(INJECTOR)).toBe(true);
    expect(tables().size).toBeGreaterThan(10);
    expect(declaredIds().length).toBeGreaterThan(50);
  });

  it('every scenario table is consumed by a function the entry point calls', () => {
    const body = entryBody();
    const orphaned: string[] = [];
    for (const table of tables().keys()) {
      const consumer = consumerOf(table);
      if (null === consumer) {
        orphaned.push(`${table} (declared, never read)`);
        continue;
      }
      if (consumer !== ENTRY && !new RegExp(`\\b${consumer}\\(`).test(body))
        orphaned.push(`${table} (read only by ${consumer}, which ${ENTRY} never calls)`);
    }
    expect(
      orphaned,
      `these scenario tables cannot fire. Every id in them injects NOTHING, the harness sees a clean ` +
        `app, and the result is recorded as not-measured — the catch rate goes UP because coverage ` +
        `went down:\n${orphaned.join('\n')}`,
    ).toEqual([]);
  });

  it('every bare-branch scenario still has its branch', () => {
    const body = entryBody();
    const missing = BARE_BRANCH_IDS.filter((id) => !body.includes(`bugs.has('${id}')`));
    expect(
      missing,
      `${ENTRY} no longer dispatches these ids, so the harness runs them against a clean app`,
    ).toEqual([]);
  });
});

/**
 * The other direction: a scenario nothing drives is a scenario nothing scores.
 *
 * Scanned across the harnesses (`bench/`), the e2e specs, and the published scorecards, because a
 * scenario earns its place by appearing in a measurement — being injectable is not the same as being
 * counted.
 */
describe('every declared bench scenario is scored by something', () => {
  const SEARCH_ROOTS = [
    join(REPO, 'bench'),
    join(REPO, 'apps', 'e2e', 'specs'),
    join(REPO, 'docs'),
  ];
  const SEARCH_EXT = ['.mjs', '.js', '.ts', '.json', '.md', '.mdx'];

  function files(dir: string): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
      if ('node_modules' === entry || 'dist' === entry || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...files(full));
      else if (SEARCH_EXT.some((e) => entry.endsWith(e))) out.push(full);
    }
    return out;
  }

  const corpus = (): string =>
    SEARCH_ROOTS.flatMap(files)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

  it('finds harnesses and scorecards to check', () => {
    expect(SEARCH_ROOTS.flatMap(files).length).toBeGreaterThan(20);
  });

  it('every scenario is either driven by a harness or listed as unscored', () => {
    const text = corpus();
    const orphaned = [...declaredIds(), ...BARE_BRANCH_IDS].filter(
      (id) => !UNSCORED.has(id) && !text.includes(id),
    );
    expect(
      orphaned,
      `these scenarios are injectable but nothing drives or scores them, so they contribute to no ` +
        `catch rate. Wire them into a harness, or add them to UNSCORED with the reason:\n${orphaned.join('\n')}`,
    ).toEqual([]);
  });

  it('every UNSCORED entry is still declared, and still unscored', () => {
    const declared = new Set<string>([...declaredIds(), ...BARE_BRANCH_IDS]);
    const text = corpus();
    for (const [id, why] of UNSCORED) {
      expect(declared.has(id), `UNSCORED lists ${id}, which the injector no longer declares`).toBe(
        true,
      );
      expect(
        text.includes(id),
        `${id} is now referenced by a harness or scorecard — drop it from UNSCORED (${why})`,
      ).toBe(false);
    }
  });
});
