import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '@/machine/repo-root.js';

/**
 * No sibling directory reaches back into the tool aggregator.
 *
 * `surface/tools/tools.ts` composes the whole tool surface: it imports twenty-seven `*_TOOLS`
 * arrays from five sibling directories. That direction is correct and is what a composition root
 * does. The problem was the other direction — those same directories imported `ToolDef` and
 * `ToolDeps` back OUT of it, and that back-edge closed a cycle for every one of them.
 *
 * MEASURED: removing it took `madge --circular` on `server/src` from **41 cycles to 25**, and the
 * change was an import path. Nothing moved, nothing was registered, no module-load order became
 * significant — because both types already lived in `tool-kit.ts`, a light module, and `tools.ts`
 * merely re-exported them. Twenty-five files were taking the long way round through the aggregator
 * to reach a leaf they could import directly.
 *
 * The cheap lesson worth keeping: a re-export from a heavy module is a cycle waiting to be
 * declared. This guard fails the moment somebody adds one back.
 */
/** Assembled, never written literally. See the note at the grep below. */
const ALIAS = `@${'/'}`;

const OUTSIDE_SURFACE = ['memory', 'language', 'judgement', 'features', 'portal', 'command'];

describe('the tool aggregator is composed, never consumed', () => {
  /**
   * BOTH spellings, and that is the whole guard.
   *
   * This matched only the relative form -- `from '../../surface/tools/tools.js'` -- in a package
   * whose house style is the `@/` alias. There were zero relative importers and live alias ones, so
   * the check ran over an empty set and passed, every time, while the back-edge it exists to refuse
   * was sitting in the tree. Planting `import type { ToolDef } from '@/surface/tools/tools.js'` in
   * an OUTSIDE_SURFACE directory left it green.
   *
   * The liveness test below had the same shape as the incident rule 13 records: it asserted the
   * file EXISTS. Existence was never the question.
   */
  const importersOf = (target: string): string[] => {
    const out = execFileSync(
      'git',
      [
        'grep',
        '-l',
        '-E',
        // The alias prefix is assembled rather than written out: `every-build-resolves-its-aliases`
        // greps every built file for the literal `from '@/`, and a guard that SEARCHES for that
        // string would otherwise look, to that guard, exactly like a build that failed to rewrite
        // one. Two guards, one substring, and only one of them means anything by it.
        `from '(\\.\\./)+surface/tools/${target}\\.js'|from '${ALIAS}surface/tools/${target}\\.js'`,
        '--',
        'server/src',
        ':!*test*',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    return 0 === out.length ? [] : out.split('\n');
  };

  it('finds the aggregator, so a pass is not a pass over a renamed file', () => {
    // Without this the check below goes green the day somebody renames tools.ts.
    const tools = execFileSync('git', ['ls-files', 'server/src/surface/tools/tools.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    expect(tools, 'surface/tools/tools.ts must exist for this guard to mean anything').not.toBe('');
  });

  it('no sibling directory imports from it', () => {
    let importers: string[] = [];
    try {
      importers = importersOf('tools');
    } catch (error: unknown) {
      // ONLY exit 1, which is git grep's "no matches" and the genuinely passing case. A bare catch
      // read every other failure as a clean bill of health too: exit 128 on a bad pathspec, ENOENT
      // when git is not on PATH, or `server/src` not being there at all. Each of those produced an
      // empty list and a green tick, so the guard reported "no sibling imports the aggregator"
      // precisely when it had been unable to look.
      if (1 !== (error as { status?: unknown }).status) throw error;
      importers = [];
    }
    const offenders = importers.filter((f) =>
      OUTSIDE_SURFACE.some((dir) => f.startsWith(`server/src/${dir}/`)),
    );
    expect(
      offenders,
      'these reach back into the aggregator that imports them, which is a cycle. `ToolDef` and ' +
        '`ToolDeps` live in `tool-kit.ts` — import them from there. Removing this edge took the ' +
        'package from 41 circular dependencies to 25.',
    ).toEqual([]);
  });
});
