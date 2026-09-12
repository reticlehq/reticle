import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Every `vi.mock` path names a file that exists.
 *
 * A mock specifier is a string, and moving the file it names does not break the build, does not
 * upset the type checker, and does not fail the mock. It makes the mock match nothing. The real
 * module then loads in its place, and the test carries on against code it believed it had
 * replaced.
 *
 * That happened while grouping `features/flows`: a test mocked `./server-verify.js`, the file
 * moved into `suite/`, and the real module loaded. It failed loudly, but only by luck -- the real
 * module wanted an export that a NEIGHBOURING mock did not provide. Had it needed nothing extra,
 * it would have run for real inside a test written on the assumption that it could not, and the
 * test would have passed.
 *
 * So the invariant is the cheap half: a mock that names a path must name a path that is there.
 * This says nothing about whether mocking that module was wise, only that the string still points
 * at something.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();

/** Relative specifiers only. A bare name is a package, and resolving those is node's business. */
const MOCK_CALL = /vi\.(?:mock|doMock|unmock)\(\s*(['"])(\.[^'"]+)\1/g;

interface Mock {
  readonly file: string;
  readonly specifier: string;
}

function everyMock(): Mock[] {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((line) => '' !== line);
  const found: Mock[] = [];
  for (const file of tracked) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const call of source.matchAll(MOCK_CALL)) {
      const specifier = call[2];
      if (undefined !== specifier) found.push({ file, specifier });
    }
  }
  return found;
}

/** A mock names a built `.js` path; the source beside it is `.ts` or `.tsx`. */
function pointsAtSomething(mock: Mock): boolean {
  const asTs = resolve(REPO_ROOT, dirname(mock.file), mock.specifier.replace(/\.js$/, '.ts'));
  return (
    existsSync(asTs) ||
    existsSync(asTs.replace(/\.ts$/, '.tsx')) ||
    existsSync(asTs.replace(/\.ts$/, '.js'))
  );
}

describe('every vi.mock names a file that is there', () => {
  it('finds mocks at all, so a pass is not a pass over none', () => {
    // Without this the whole check is green on a regex that stopped matching. Measured 9
    // relative specifiers across the repository on 2026-09-11; the floor sits below that so an
    // ordinary deletion does not fail here, and well above zero so a dead regex does.
    expect(everyMock().length).toBeGreaterThanOrEqual(5);
  });

  it('resolves every relative mock specifier', () => {
    const dangling = everyMock()
      .filter((mock) => !pointsAtSomething(mock))
      .map((mock) => `${mock.file} mocks ${mock.specifier}`)
      .sort();
    expect(
      dangling,
      'these mocks name a file that does not exist. The mock matches nothing, so the REAL module ' +
        'loads and the test runs against the code it meant to replace — which usually passes.',
    ).toEqual([]);
  });
});
