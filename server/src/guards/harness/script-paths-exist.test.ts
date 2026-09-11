import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * A path named in a package script must exist.
 *
 * `lint:docs` sat in the release checklist naming six test files under `src/tools/`. The tools
 * moved to `src/agent/tools/` in a directory regrouping, nobody updated the script, and it
 * **could not run at all** from that day. It failed with vitest's "no test files" path, which
 * prints `undefined` and an exit code and looks like a tooling fault rather than a stale string.
 *
 * Nothing caught it because `lint:docs` is not part of `pnpm verify`: it is a RELEASE-time gate,
 * so the first person to discover it would have been whoever was cutting the release, at the
 * moment they least want a surprise. It stayed broken for a day only because a release happened
 * not to be cut in that window.
 *
 * This is the same shape as the e2e spec that imported `agent/mcp/mcp-outage.js` by path and
 * broke when that file moved: a string that names a file, unchecked by any compiler. That one
 * had a guard. This one did not.
 */

const REPO = REPO_ROOT;

/** Every workspace manifest, since a script in any of them can name a path. */
function manifests(): string[] {
  return execFileSync('git', ['ls-files', '*package.json'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((f) => '' !== f && !f.includes('node_modules'));
}

/**
 * Paths a script names, as opposed to the flags and package names around them.
 *
 * Deliberately narrow: a token is only checked when it looks like a repository path -- it
 * contains a `/`, starts with a directory that exists, and is not a URL, a glob or an npm
 * package. Over-matching here would fail on `@reticlehq/server` or `--filter`, and a guard that
 * cries wolf about package names gets switched off.
 */
function pathsNamedIn(script: string): string[] {
  // `ln -s` targets are relative to the LINK's directory, not the working directory, so
  // `ln -sf ../../pre-commit.sh .git/hooks/pre-commit` names a file at the repo root and looks
  // like a miss to anything resolving from cwd. Skipped rather than modelled: symlink semantics
  // are not what this guard is for, and a wrong answer here would be the noise that gets a
  // guard switched off.
  if (script.includes('ln -s')) return [];
  return script
    .split(/\s+/)
    .filter((token) => token.includes('/'))
    .filter((token) => !token.startsWith('-') && !token.startsWith('@') && !token.includes('://'))
    .filter((token) => !token.includes('*') && !token.includes('$'))
    .filter((token) => /\.(ts|tsx|mjs|cjs|js|json|md|yaml|yml|sh)$/.test(token));
}

/** Where the package with this name lives, so a `--filter` script resolves from the right root. */
function packageDirectory(name: string, all: readonly string[]): string | undefined {
  for (const rel of all) {
    const pkg = JSON.parse(readFileSync(join(REPO, rel), 'utf8')) as { name?: string };
    if (pkg.name === name) return join(REPO, rel).replace(/package\.json$/, '');
  }
  return undefined;
}

describe('a path named in a package script still exists', () => {
  it('finds manifests and scripts, so a passing run cannot mean it read nothing', () => {
    expect(manifests().length).toBeGreaterThan(5);
  });

  it('names no file that is not there', () => {
    const missing: string[] = [];
    for (const rel of manifests()) {
      const dir = join(REPO, rel).replace(/package\.json$/, '');
      const pkg = JSON.parse(readFileSync(join(REPO, rel), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        // `pnpm --filter <pkg> exec …` runs in THAT package's directory, so a path after it is
        // relative to the filtered package and not to this manifest. Getting this wrong is what
        // made the first version of this guard report six files that were all present.
        const filtered = /--filter\s+(@?[\w/-]+)/.exec(script)?.[1];
        const filteredDir =
          filtered === undefined ? undefined : packageDirectory(filtered, manifests());
        for (const path of pathsNamedIn(script)) {
          // Resolved against the manifest's own directory, which is how the script runs, then
          // the filtered package's, then the repo root for a root script naming a package path.
          if (filteredDir !== undefined && existsSync(join(filteredDir, path))) continue;
          if (existsSync(join(dir, path)) || existsSync(join(REPO, path))) continue;
          missing.push(`${rel} → ${name} → ${path}`);
        }
      }
    }
    expect(
      missing,
      'these package scripts name files that do not exist, so the script cannot do what it says. ' +
        'A release-checklist gate broke this way and went unnoticed for a day, because it is not ' +
        'part of `pnpm verify` and only runs when somebody cuts a release.',
    ).toEqual([]);
  });
});

/**
 * A path a loose script REQUIRES, as opposed to a path a package script NAMES.
 *
 * The check above reads `package.json` scripts. It passes when the file named there exists,
 * and `scripts/check-stale-issues.mjs` did exist. Inside it, the require pointed at
 * `../server/dist/dev/stale-issue-guard.js`, and the compiled file is at
 * `../server/dist/command/dev/stale-issue-guard.js`. That module moved into `command/` during
 * this release's regrouping and the require never followed.
 *
 * So `pnpm check:stale-issues` exited 1 with MODULE_NOT_FOUND, and so did its own self-test.
 * Nothing noticed, because the guard was looking one level too shallow: at the path naming the
 * script, not at the paths the script names. The orphan-modules entry for that module even
 * recorded the symptom and drew the wrong conclusion from it, saying nothing invoked the file
 * when a package script did and was crashing on the way.
 *
 * Only `dist` requires are checked, because those are the ones a directory move breaks
 * silently: TypeScript catches a bad relative import in source, and nothing catches a string
 * in a plain `.mjs` reaching into a build output.
 */
describe('a dist path a loose script requires still exists', () => {
  const scripts = (): string[] =>
    execFileSync('git', ['ls-files', 'scripts/*.mjs'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter((f) => '' !== f);

  it('finds the scripts and at least one dist require, so a pass is not a pass over nothing', () => {
    expect(scripts().length).toBeGreaterThan(5);
    const withRequires = scripts().filter((f) =>
      /['"][^'"]*\/dist\/[^'"]+\.(js|cjs|mjs)['"]/.test(readFileSync(join(REPO, f), 'utf8')),
    );
    expect(withRequires.length).toBeGreaterThan(0);
  });

  it('resolves every dist path a script reaches for', () => {
    const missing: string[] = [];
    for (const script of scripts()) {
      const text = readFileSync(join(REPO, script), 'utf8');
      for (const m of text.matchAll(/['"](\.\.?\/[^'"]*\/dist\/[^'"]+\.(?:js|cjs|mjs))['"]/g)) {
        const target = join(REPO, dirname(script), m[1] ?? '');
        if (!existsSync(target)) missing.push(`${script} -> ${m[1] ?? ''}`);
      }
    }
    expect(
      missing.sort(),
      'A loose script requires a build output that is not there. A directory move breaks this ' +
        'silently: TypeScript checks a source import, and nothing checks a string reaching into ' +
        'dist. Run `pnpm build` first if this is a fresh checkout.',
    ).toEqual([]);
  });
});
