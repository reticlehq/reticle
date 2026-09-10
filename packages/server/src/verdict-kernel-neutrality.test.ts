import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The part of the system that decides a verdict must not know which kind of app it is looking at.
 *
 * That is the whole bet behind supporting more than the web. A verdict rule that asks "is this
 * Electron?" has to be edited again for the next kind of app, and again after that, and each edit is
 * a chance to break the kinds that already worked. A rule that asks the realm instead does not.
 *
 * A COUNT of such questions would be the wrong measure. Most places that ask are perfectly right to:
 * which screenshot backend to use, where the state directory lives, how long to wait for a command.
 * Driving that number to zero would mean deleting correct code, so it would either be gamed or
 * ignored. What matters is not how many there are, it is WHERE they are.
 *
 * So this pins the set for the deciding layer only. One entry today, with its reason. Adding another
 * turns this red, and the question to answer is not "how do I list it here" but "can the realm tell
 * us this instead of the rule knowing it".
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * The files that decide a verdict. Not the whole server: the tools that carry an action out are
 * allowed to know they are driving a browser, because they are.
 */
const VERDICT_KERNEL = ['engine/src/honesty', 'packages/core/src'];

/** How a question about the kind of app looks in source. */
const ASKS_ABOUT_RUNTIME = /AppRuntime\.|runtime ===|=== runtime/;

/**
 * file -> why the deciding layer is allowed to ask, for now.
 *
 * Every entry here is a place a realm should eventually answer for itself. They are listed rather
 * than banned because each is CORRECT today and deleting it would break something real.
 */
const ALLOWED_TO_ASK: Record<string, string> = {
  'packages/core/src/realm/registry.ts':
    'this is the table that ANSWERS the question, not a rule that asks it. Naming every realm is its ' +
    'entire job, and it is what lets the rules stop branching -- two of them already have. Listed ' +
    'rather than exempted by narrowing the search, because the search being wide is what makes it ' +
    'worth having.',
  'engine/src/honesty/blind-spots.ts':
    'Electron-only coverage rows must not be reported for a web page, or a plain browser tab reads ' +
    'as an un-instrumented Electron renderer. The realm should declare which coverage kinds are ' +
    'its own; until a second realm exists there is nothing to ask.',
};

/** Every tracked source file under the deciding layer that asks about the runtime. */
function filesThatAsk(): string[] {
  // `--others --exclude-standard` as well as tracked files: a guard that runs before `git add` and
  // one that runs after must agree, or it passes in the terminal and fails in the commit hook -- which
  // is where this file first met a new module. Ignored paths stay invisible, so build output and
  // scratch files do not appear.
  const tracked = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', ...VERDICT_KERNEL],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !file.includes('.test.'));

  return tracked
    .filter((file) => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      // Comments mention the runtime constantly and explaining a rule is not applying one. A guard
      // in this repository has gone green on a comment before; this one strips them first.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return ASKS_ABOUT_RUNTIME.test(code);
    })
    .sort();
}

describe('the layer that decides a verdict does not ask what kind of app this is', () => {
  it('the search works at all', () => {
    // Without this, a rename of AppRuntime would empty the search and the check below would pass by
    // having nothing left to find.
    const anywhere = execFileSync(
      'bash',
      ['-c', `grep -rl "AppRuntime\\." packages/server/src | grep -v test | wc -l`],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    expect(Number(anywhere)).toBeGreaterThan(0);
  });

  it('only the listed files ask, and every one that does is listed', () => {
    expect(
      filesThatAsk(),
      'A verdict rule started asking what kind of app it is looking at. Before adding it to ' +
        'ALLOWED_TO_ASK, try the other way round: can the realm declare this, so the rule does not ' +
        'have to know? Each entry on that list is a rule that will need editing again for the next ' +
        'kind of app.',
    ).toEqual(Object.keys(ALLOWED_TO_ASK).sort());
  });
});
