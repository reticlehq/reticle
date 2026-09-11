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
function fixture(betaReachesBack: boolean): string {
  dir = mkdtempSync(join(tmpdir(), 'safe-group-'));
  mkdirSync(join(dir, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(dir, 'src', 'beta'), { recursive: true });
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
});
