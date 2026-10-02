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

/**
 * Directories holding runnable files that no package's source tree covers.
 *
 * `install` is the one a user actually runs, and it was not on this list until the launchers got
 * their own directory — before that they lived in `setup`, which is now `break`.
 */
const LOOSE_SCRIPT_DIRECTORIES = [
  'scripts',
  'install',
  'break',
  'bench',
  'apps/e2e',
  // Absent until the scan learned to recurse, which is how twelve runnable files in the
  // protocol's own conformance harness were never asked whether anything still calls them.
  'conformance',
];

/** Pages that describe every script by obligation, so a mention in one proves nothing. */
const INDEX_PAGES = new Set(['scripts/README.md']);

/** Loose scripts that sit at the repo root rather than in one of the directories above. */
const ROOT_LEVEL_SCRIPTS = ['pre-commit.sh', 'prepare-commit-msg.sh'];

/**
 * Extensions that make a file runnable rather than data.
 *
 * `ps1` is here because `install.ps1` is a launcher a user pipes into a shell, and without it the
 * one runnable file on the platform with the most users was the one this guard could not see.
 */
const RUNNABLE = /\.(mjs|sh|cmd|ps1)$/;

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

/**
 * A repo-relative path spelled the way the rest of this repository spells one.
 *
 * `git ls-files` always answers with forward slashes, on every platform, and every path literal in
 * this file is written that way too. `path.join` does not: on Windows it yields backslashes, so a
 * path built here never equals the same path read from git. That is not a near-miss — it is a total
 * miss on every entry, which turns a guard into one that passes over nothing.
 */
function posixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Every runnable file under `directory`, at any depth.
 *
 * It read the TOP LEVEL only, which made the guard a near-fiction over the directory it most needed
 * to cover: `bench/` has one runnable file at its root and 103 below it, so 1% was checked and the
 * green tick spoke for the other 99%. `conformance/` was not in the list at all.
 *
 * `node_modules` and build output are skipped: neither is a loose script, and walking them is slow
 * enough to be noticed in the fast gate.
 */
function runnableFilesUnder(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(join(REPO_ROOT, directory))) {
    if ('node_modules' === name || 'dist' === name || '.turbo' === name) continue;
    const path = join(directory, name);
    if (statSync(join(REPO_ROOT, path)).isDirectory()) {
      runnableFilesUnder(path, found);
      continue;
    }
    if (!RUNNABLE.test(name)) continue;
    found.push(path);
  }
  return found;
}

function looseScripts(): string[] {
  const found: string[] = [];
  for (const directory of LOOSE_SCRIPT_DIRECTORIES) {
    for (const path of runnableFilesUnder(directory)) {
      // Repo-relative paths are compared against `git ls-files` output and against POSIX literals
      // spelled in this file, and `join` yields `scripts\check-boundaries.mjs` on Windows. Every
      // comparison then misses and the scan reads as "no loose scripts", which is a guard that
      // cannot fail for the reason it exists. See posixPath.
      found.push(posixPath(path));
    }
  }
  return [...found, ...ROOT_LEVEL_SCRIPTS].sort();
}

/**
 * A test file is COLLECTED by a runner pointed at a directory, never invoked by its own name.
 *
 * So "does any tracked file mention it" is the wrong liveness question for one: the answer is
 * always no, however green the gate that runs it. What makes a test file live is a gate whose
 * command names a directory above it — the root `test:bench` names `bench/harness`, `bench/eval`
 * and `apps/e2e`.
 *
 * Asked rather than declared, on purpose: a `*.test.mjs` sitting in a directory NO gate runs is
 * still caught here, which is the case worth catching. A blanket exemption for test files would
 * have covered that one too.
 */
function collectedByAGate(script: string, runners: readonly string[]): boolean {
  if (!/\.test\.[cm]?[jt]sx?$/.test(script)) return false;
  const parts = script.split('/');
  // Any ancestor directory named on a runner's command line collects this file.
  const namedByRoot = parts.some((_, index) => {
    const ancestor = parts.slice(0, index + 1).join('/');
    return (
      ancestor !== script && runners.some((command) => command.split(/\s+/).includes(ancestor))
    );
  });
  if (namedByRoot) return true;
  /*
   * Or the file's OWN package runs a test runner over itself.
   *
   * `conformance/package.json` is `"test:unit": "vitest run"` with no path, which collects every
   * test in that package — turbo runs it on every `pnpm test:unit`. Asking only about root scripts
   * reported three live conformance specs as unreachable the moment this scan learned to recurse.
   */
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const manifest = join(REPO_ROOT, ...parts.slice(0, index), 'package.json');
    let scripts: Record<string, string>;
    try {
      scripts =
        (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> })
          .scripts ?? {};
    } catch {
      continue;
    }
    return Object.values(scripts).some((command) => command.includes('vitest'));
  }
  return false;
}

/** The command line of every script in the root manifest — where a runner names its directories. */
function runnerCommands(): readonly string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const scripts = (manifest as { scripts?: Record<string, string> }).scripts ?? {};
  return Object.values(scripts);
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
    /*
     * The INDEX pages do not count as reachability.
     *
     * `scripts-documented.test.ts` REQUIRES every script to have a row in `scripts/README.md`, and
     * this test counts any mention anywhere. So a row was simultaneously mandatory and sufficient:
     * every script in `scripts/` passed this check on its own index page, and the question "does
     * anything actually use this" was never asked. A guard satisfied by the documentation of the
     * thing it is checking is the same defect as a guard that passes on a comment, which this
     * repository has already paid for once.
     *
     * The generous matching above STAYS — its own note records an audit that nearly deleted four
     * live scripts by insisting on the file extension. The fix is to drop the one source that is
     * guaranteed to mention everything, not to get stricter about the rest.
     */
    .filter((file) => !INDEX_PAGES.has(file))
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
    const runners = runnerCommands();
    const unreachable = scripts.filter((script) => {
      if (DECLARED_UNREACHABLE[script] !== undefined) return false;
      if (collectedByAGate(script, runners)) return false;
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
