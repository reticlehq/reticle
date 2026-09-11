import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { REPO_ROOT } from './machine/repo-root.js';

/**
 * Every loose script in the repo must be reachable from something.
 *
 * "Loose" means a runnable file that lives outside a package's source tree: the helpers in
 * `scripts/`, the onboarding harness in `setup/`, the benchmark runner, the end-to-end runners. The
 * orphan guard next door covers package sources only, so this was the one zone nothing watched.
 *
 * That gap had a cost. A one-off debug script sat in `apps/e2e/` until an audit found it, and it had
 * arrived in a RELEASE commit — nothing objected, because nothing was looking. One dead file is
 * cheap; a directory nobody audits is where the next ten go.
 *
 * "Reachable" is deliberately generous. A script counts as reachable if ANY other tracked file
 * mentions it: a package.json script, a CI workflow, another script, a doc. The question this asks is
 * only "could a reader find their way to this from somewhere?", because the alternative — trying to
 * decide whether each script is genuinely useful — is a judgement no test can make.
 *
 * Matching is on the whole file name and on the name without its extension, because references go
 * both ways in practice: package.json says `node scripts/set-version.mjs`, while prose says "the
 * source-localize scenario". An earlier audit of this same question nearly deleted four live scripts
 * by searching for the name WITH the extension only, so both forms are checked.
 */

/** Directories holding runnable files that no package's source tree covers. */
const LOOSE_SCRIPT_DIRECTORIES = ['scripts', 'setup', 'bench', 'apps/e2e'];

/** Loose scripts that sit at the repo root rather than in one of the directories above. */
const ROOT_LEVEL_SCRIPTS = ['pre-commit.sh', 'prepare-commit-msg.sh'];

/** Extensions that make a file runnable rather than data. */
const RUNNABLE = /\.(mjs|sh|cmd)$/;

/**
 * Scripts allowed to have no reference anywhere, each with the reason.
 *
 * Empty on purpose, and it should stay that way. Adding a name here is the moment to ask the real
 * question: if nothing points at this script, who is ever going to run it? Deleting is usually the
 * honest answer, and wiring it up is the other one.
 */
const DECLARED_UNREACHABLE: Record<string, string> = {};

/** Files that hold no readable text worth searching. */
const NOT_TEXT = /\.(png|jpe?g|svg|ico|woff2?|lock|pdf|zip)$/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

function looseScripts(): string[] {
  const found: string[] = [];
  for (const directory of LOOSE_SCRIPT_DIRECTORIES) {
    for (const name of readdirSync(join(REPO_ROOT, directory))) {
      const path = join(directory, name);
      if (!statSync(join(REPO_ROOT, path)).isFile()) continue;
      if (!RUNNABLE.test(name)) continue;
      found.push(path);
    }
  }
  return [...found, ...ROOT_LEVEL_SCRIPTS].sort();
}

/** True when `text` mentions the script by file name, or by its name without the extension. */
function mentions(text: string, scriptPath: string): boolean {
  const fileName = basename(scriptPath);
  const withoutExtension = fileName.slice(0, fileName.length - extname(fileName).length);
  // Bounded on both sides so `matrix` does not match `matrix-freshness`, and `reticle.sh` does not
  // match inside a longer word. Written as two alternatives rather than one clever pattern.
  const pattern = new RegExp(
    `(?<![\\w.-])${fileName}(?![\\w])|(?<![\\w.-])${withoutExtension}(?![\\w.-])`,
  );
  return pattern.test(text);
}

describe('every loose script is reachable from somewhere', () => {
  const scripts = looseScripts();
  const haystack = trackedFiles()
    .filter((file) => !NOT_TEXT.test(file))
    .map((file) => {
      try {
        return [file, readFileSync(join(REPO_ROOT, file), 'utf8')] as const;
      } catch {
        return [file, ''] as const;
      }
    });

  it('finds the loose scripts at all (guards against an empty scan passing by default)', () => {
    // Without this, a broken directory list would make every test below pass with nothing to check.
    expect(scripts.length).toBeGreaterThan(20);
    expect(scripts).toContain('scripts/check-boundaries.mjs');
  });

  it('no loose script is unreachable, unless it is declared', () => {
    const unreachable = scripts.filter((script) => {
      if (DECLARED_UNREACHABLE[script] !== undefined) return false;
      return !haystack.some(([file, text]) => file !== script && mentions(text, script));
    });
    expect(unreachable).toEqual([]);
  });

  it('every declared entry is still unreachable — a wired one must be removed from the list', () => {
    const nowReachable = Object.keys(DECLARED_UNREACHABLE).filter((script) =>
      haystack.some(([file, text]) => file !== script && mentions(text, script)),
    );
    expect(nowReachable).toEqual([]);
  });

  it('catches a script nothing points at (negative control)', () => {
    // The list above is empty today, so the real test would pass just as happily if `mentions` were
    // broken and always returned true. This proves it can still say no.
    //
    // The name is assembled from pieces on purpose. Written as one literal, it would appear in this
    // very file -- which `git ls-files` then hands back as part of the haystack, the search finds
    // the probe quoting itself, and the control passes when it should fail. That is not
    // hypothetical: it is what this test did on its first run, and it is the same shape as a guard
    // in this repo that once went green because a comment quoted the code it was checking for.
    const invented = ['scripts/', 'absent', '-from', '-every', '-file', '.mjs'].join('');
    expect(haystack.some(([, text]) => mentions(text, invented))).toBe(false);
  });
});
