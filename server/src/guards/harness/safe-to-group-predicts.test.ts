import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The advice tool, which the directory guard's own header tells people to ask FIRST.
 *
 * `directory-reach.test.ts` says, in capitals: BEFORE MOVING FILES, ask
 * `node scripts/safe-to-group.mjs`. Six extractions on this branch did not ask it, and it had
 * no test, so the tool nobody ran was also the tool nobody checked.
 *
 * Two things are asserted, and the second is the one that was missing entirely.
 *
 * SAFE vs UNSAFE — the prediction it exists to make. A group is unsafe exactly when something
 * it reaches out to also reaches back in, because that is a mutual pair by definition.
 *
 * The TEST-FILE NOTE — because the quiet failure here is not a wrong answer, it is a confident
 * empty one. `sources()` drops tests, mirroring the guard, so naming test files produced
 * "group of 0" and "(nothing)" on every line: a clean bill of health that actually meant "I
 * cannot see these files". The guard cannot see them either, so moving tests can never raise
 * MUTUAL_PAIRS_TODAY whatever they import, and a green run afterwards is a fact about the
 * guard rather than about the move. Two extractions on this branch were reported as verified
 * on exactly that basis.
 *
 * The PUBLIC-SUBPATH NOTE — the third thing it cannot see, and the one that costs somebody else
 * rather than us. A wildcard export like `"./alpha/*.js"` makes every filename under `alpha/` a
 * public entry point. Moving one into a subdirectory keeps resolving here, because a pattern
 * substitutes across slashes, so the type checker, the build, the tests and this tool's own
 * SAFE verdict are all unchanged; the path a user was told to import simply stops existing.
 * That happened: a four-file extraction from `engine/src/evidence` was predicted SAFE, made,
 * and reverted only because `public-subpaths-are-pinned.test.ts` had written the warning into
 * a comment. Advice that is right about coupling and silent about the package boundary sends
 * people at exactly this move.
 */

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();

/** A package with `alpha` holding the candidate, and `beta` wired as asked. */
function fixture(betaReachesBack: boolean, exported?: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'safe-group-'));
  mkdirSync(join(dir, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(dir, 'src', 'beta'), { recursive: true });
  if (exported !== undefined) {
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: '@scope/fixture', exports: exported }, undefined, 2)}\n`,
    );
  }
  writeFileSync(join(dir, 'src', 'alpha', 'candidate.ts'), "export const candidate = 'x';\n");
  writeFileSync(join(dir, 'src', 'alpha', 'candidate.test.ts'), 'export const t = 1;\n');
  writeFileSync(
    join(dir, 'src', 'alpha', 'other.ts'),
    "import { beta } from '../beta/thing.js';\nexport const other = beta;\n",
  );
  writeFileSync(
    join(dir, 'src', 'beta', 'thing.ts'),
    betaReachesBack
      ? "import { candidate } from '../alpha/candidate.js';\nexport const beta = candidate;\n"
      : "export const beta = 'b';\n",
  );
  return dir;
}

/**
 * Run it, and report both halves of what it says.
 *
 * It exits NON-ZERO on an unsafe group, which `execFileSync` turns into a throw. That is the
 * tool being more useful than its own usage line admits -- it can gate a script, not just
 * advise a person -- so the code is returned and asserted rather than swallowed.
 */
function ask(root: string, ...names: string[]): { said: string; code: number } {
  try {
    const said = execFileSync(
      'node',
      [join(REPO, 'scripts', 'safe-to-group.mjs'), join(root, 'src', 'alpha'), ...names],
      { encoding: 'utf8' },
    );
    return { said, code: 0 };
  } catch (thrown) {
    const e = thrown as { stdout?: string; status?: number };
    return { said: e.stdout ?? '', code: e.status ?? -1 };
  }
}

describe('the tool the guard tells people to ask first', () => {
  it('sees the group at all, so an empty verdict cannot mean it read nothing', () => {
    expect(ask(fixture(false), 'candidate').said).toContain('group of 1');
  });

  it('calls it UNSAFE when a directory it reaches also reaches back', () => {
    const asked = ask(fixture(true), 'candidate', 'other');
    expect(asked.said).toContain('UNSAFE');
    // And it exits non-zero, so a script can trust it and not only a reader.
    expect(asked.code).not.toBe(0);
  });

  it('does not cry wolf on a group with no way back', () => {
    // The control. A tool that answers UNSAFE to everything satisfies the case above and is
    // worth less than no tool, because it would stop every extraction this work depends on.
    const asked = ask(fixture(false), 'candidate', 'other');
    expect(asked.said).not.toContain('UNSAFE');
    expect(asked.code).toBe(0);
  });

  it('says out loud that it cannot see a test file, rather than answering "(nothing)"', () => {
    const { said } = ask(fixture(true), 'candidate.test');
    expect(said).toContain('are TESTS');
    expect(said).toContain('cannot see them');
  });

  it('answers about a package ROOT, not only a directory inside src', () => {
    // `core/src` is a normal thing to ask about and it used to die on `scandir 'cor'`: the
    // root was found with `indexOf('/src/')`, which needs BOTH slashes and so never matches a
    // path that ENDS at src. Four of this repo's biggest flat directories are package roots,
    // and a sweep over them read as "no groups here" rather than as a crash.
    const root = mkdtempSync(join(tmpdir(), 'safe-root-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
      writeFileSync(join(root, 'src', 'alone.ts'), 'export const alone = 1;\n');
      let said = '';
      let code = 0;
      try {
        said = execFileSync(
          'node',
          [join(REPO, 'scripts', 'safe-to-group.mjs'), join(root, 'src'), 'alone'],
          { encoding: 'utf8' },
        );
      } catch (thrown) {
        const e = thrown as { stdout?: string; status?: number };
        said = e.stdout ?? '';
        code = e.status ?? -1;
      }
      expect(code, said).toBe(0);
      expect(said).toContain('group of 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a group where no name resolved, instead of printing SAFE about nothing', () => {
    // An empty group reaches nothing, frees nothing and used to print SAFE. It told me three
    // groupings were safe when my shell had passed every name as ONE argument: zsh does not
    // word-split an unquoted parameter. Same shape as an orphan scan over zero files.
    const asked = ask(fixture(true), 'candidate other');
    expect(asked.said).not.toContain('SAFE');
    expect(asked.code).not.toBe(0);
  });

  it('stays quiet about tests when none were named', () => {
    expect(ask(fixture(true), 'candidate').said).not.toContain('are TESTS');
  });

  it('warns that a wildcard export makes the filename public, and prints the path that breaks', () => {
    // SAFE and a breaking change at the same time. The group has no way back -- the control two
    // cases up proves this same fixture reads SAFE -- so the coupling verdict is right and is
    // also not the whole answer.
    const { said } = ask(fixture(false, { './alpha/*.js': './dist/alpha/*.js' }), 'candidate');
    expect(said).not.toContain('UNSAFE');
    expect(said).toContain('PUBLIC');
    // The specifier a user wrote, not just the filename, because that is the thing that stops
    // resolving and the thing a changelog entry has to name.
    expect(said).toContain('@scope/fixture/alpha/candidate.js');
  });

  it('says nothing about the package boundary when no export pattern covers the file', () => {
    // The control. A tool that warns on every move teaches people to skip the warning, and the
    // root-barrel packages -- where every file under src/ is private and may be rearranged
    // freely -- are most of this repository.
    const { said } = ask(fixture(false, { '.': './dist/index.js' }), 'candidate');
    expect(said).not.toContain('PUBLIC');
  });
});
