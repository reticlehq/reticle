import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * What a publishable package must do before it is packed.
 *
 * `prepare-dist.mjs` drops two things from `dist` at pack time: the compiled tests, and the source
 * maps. Both matter for a reason that is invisible from the source tree — the maps reference
 * `../src/*.ts`, which the tarball does not contain, so a consumer's debugger follows them, finds
 * nothing, and logs a failure in the console of every app embedding the SDK. On `@reticlehq/browser`
 * that was 36% of the download for nothing.
 *
 * Nine packages ran it and two did not. `@reticlehq/openreality` — the protocol, added this release
 * — shipped its five compiled test files and every map; `@reticlehq/engine` shipped 890 such
 * entries and had been doing so for longer. Neither is visible to any gate short of `npm pack`,
 * which is why this exists: the last time a `prepack` was wrong it broke publishing for five of
 * nine packages and only the fifteen-minute install gate could see it.
 *
 * The rule is stated in terms of what a package actually EMITS rather than as a list of names. A
 * package with no tests under `src` has nothing to strip and needs no `prepack` — that is why
 * `@reticlehq/electron` and `@reticlehq/next` are not failures here rather than exemptions
 * somebody has to remember to maintain.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Every workspace package.json git knows about, outside `apps/` and `node_modules`. */
function manifests(): string[] {
  return execFileSync('git', ['ls-files', '*package.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => '' !== f && !f.startsWith('apps/') && !f.includes('node_modules'));
}

interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly scripts?: Readonly<Record<string, string>>;
}

/** A package that `pnpm -r publish` would push to npm: ours, and not marked private. */
function publishable(): { dir: string; pkg: Manifest }[] {
  const out: { dir: string; pkg: Manifest }[] = [];
  for (const rel of manifests()) {
    const pkg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Manifest;
    if (true === pkg.private) continue;
    if (undefined === pkg.name || !pkg.name.startsWith('@reticlehq/')) continue;
    out.push({ dir: dirname(join(ROOT, rel)), pkg });
  }
  return out;
}

/** Does this package compile any tests into its `dist`? */
function hasTests(dir: string): boolean {
  const src = join(dir, 'src');
  if (!existsSync(src)) return false;
  return execFileSync('git', ['ls-files', 'src'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .some((f) => f.includes('.test.'));
}

describe('a package that is published strips what must not ship', () => {
  it('finds the workspace to check', () => {
    // A guard that silently matched nothing would pass forever. This is the negative control.
    expect(publishable().length).toBeGreaterThan(8);
  });

  it('runs prepare-dist in prepack wherever there are compiled tests to drop', () => {
    const leaking = publishable()
      .filter(({ dir }) => hasTests(dir))
      .filter(({ pkg }) => true !== pkg.scripts?.['prepack']?.includes('prepare-dist.mjs'))
      .map(({ pkg }) => pkg.name ?? '(unnamed)');
    expect(
      leaking,
      'these packages compile tests into dist and do not strip them at pack time, so the tarball ' +
        'ships test files and source maps pointing at sources it does not contain. Add ' +
        '`node ../scripts/prepare-dist.mjs dist` to the end of their `prepack`.',
    ).toEqual([]);
  });

  it('points prepare-dist at a path that exists from each package', () => {
    // The failure this catches is specific and has happened: five packages used `../../scripts/`
    // from three levels down, which resolved to nothing, so `prepack` died and publishing broke.
    // The depth is not guessable from the package name -- `core` is one level down and
    // `adapters/build/vite` is three.
    const wrong: string[] = [];
    for (const { dir, pkg } of publishable()) {
      const prepack = pkg.scripts?.['prepack'];
      if (undefined === prepack) continue;
      for (const m of prepack.matchAll(/node ((?:\.\.\/)+scripts\/[\w-]+\.mjs)/g)) {
        const target = m[1];
        if (undefined !== target && !existsSync(resolve(dir, target))) {
          wrong.push(`${pkg.name ?? '?'} -> ${target}`);
        }
      }
    }
    expect(wrong, 'a prepack points at a script that does not exist from that package').toEqual([]);
  });
});
