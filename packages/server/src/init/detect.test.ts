import { describe, expect, it } from 'vitest';
import {
  detect,
  parseMajor,
  installCommand,
  installCommandParts,
  Framework,
  PackageManager,
  UiLibrary,
  type DetectInput,
} from './detect.js';

function input(partial: Partial<DetectInput>): DetectInput {
  return {
    pkg: partial.pkg ?? {},
    configFiles: partial.configFiles ?? new Set(),
    lockfiles: partial.lockfiles ?? new Set(),
  };
}

describe('parseMajor', () => {
  it('reads the major from common range forms', () => {
    expect(parseMajor('^19.0.0')).toBe(19);
    expect(parseMajor('~18.2.1')).toBe(18);
    expect(parseMajor('19.1.1')).toBe(19);
    expect(parseMajor('>=18')).toBe(18);
  });
  it('returns undefined for missing/garbage', () => {
    expect(parseMajor(undefined)).toBeUndefined();
    expect(parseMajor('latest')).toBeUndefined();
  });
});

describe('detect framework', () => {
  it('detects next from the dependency', () => {
    expect(detect(input({ pkg: { dependencies: { next: '15.0.0' } } })).framework).toBe(
      Framework.NEXT,
    );
  });
  it('detects next from a config file even without the dep listed', () => {
    expect(detect(input({ configFiles: new Set(['next.config.mjs']) })).framework).toBe(
      Framework.NEXT,
    );
  });
  it('detects vite from the dependency', () => {
    expect(detect(input({ pkg: { devDependencies: { vite: '^5.0.0' } } })).framework).toBe(
      Framework.VITE,
    );
  });
  it('falls back to html when no bundler is present', () => {
    expect(detect(input({ pkg: { dependencies: { react: '^18' } } })).framework).toBe(
      Framework.HTML,
    );
  });
  it('prefers next over vite when both are present', () => {
    expect(detect(input({ pkg: { dependencies: { next: '15', vite: '5' } } })).framework).toBe(
      Framework.NEXT,
    );
  });
  it('detects SvelteKit from the @sveltejs/kit dep (even though it ships vite)', () => {
    expect(
      detect(input({ pkg: { devDependencies: { '@sveltejs/kit': '^2', vite: '^5' } } })).framework,
    ).toBe(Framework.SVELTEKIT);
  });
  it('detects SvelteKit from svelte.config.js, not the generic vite path', () => {
    expect(
      detect(
        input({
          pkg: { devDependencies: { vite: '^5' } },
          configFiles: new Set(['svelte.config.js', 'vite.config.ts']),
        }),
      ).framework,
    ).toBe(Framework.SVELTEKIT);
  });
});

describe('detect source mapping need', () => {
  it('flags React 19 as needing source mapping', () => {
    const d = detect(input({ pkg: { dependencies: { react: '^19.0.0', vite: '5' } } }));
    expect(d.reactMajor).toBe(19);
    expect(d.needsSourceMapping).toBe(true);
  });
  it('does not flag React 18', () => {
    const d = detect(input({ pkg: { dependencies: { react: '^18.2.0', vite: '5' } } }));
    expect(d.needsSourceMapping).toBe(false);
  });
});

describe('detect package manager', () => {
  it('reads the lockfile', () => {
    expect(detect(input({ lockfiles: new Set(['pnpm-lock.yaml']) })).packageManager).toBe(
      PackageManager.PNPM,
    );
    expect(detect(input({ lockfiles: new Set(['yarn.lock']) })).packageManager).toBe(
      PackageManager.YARN,
    );
    expect(detect(input({ lockfiles: new Set(['bun.lockb']) })).packageManager).toBe(
      PackageManager.BUN,
    );
    expect(detect(input({})).packageManager).toBe(PackageManager.NPM);
  });
});

describe('installCommand', () => {
  it('renders the dev-install command per manager', () => {
    expect(installCommand(PackageManager.PNPM, '@reticlehq/react')).toBe(
      'pnpm add -D @reticlehq/react',
    );
    expect(installCommand(PackageManager.NPM, '@reticlehq/react')).toBe(
      'npm i -D @reticlehq/react',
    );
  });

  it('installs multiple packages in one command (the kit + its build plugin)', () => {
    expect(
      installCommand(PackageManager.PNPM, ['@reticlehq/react', '@reticlehq/vite-plugin']),
    ).toBe('pnpm add -D @reticlehq/react @reticlehq/vite-plugin');
  });
});

/**
 * Detection used to stop at "vite is in package.json". A Vue or Preact app therefore got the React
 * kit installed and an all-green report — a support claim nothing backs.
 */
describe('detect — UI library', () => {
  const withDeps = (dependencies: Record<string, string>): DetectInput => ({
    pkg: { dependencies },
    configFiles: new Set(['vite.config.ts']),
    lockfiles: new Set(),
  });

  it('names the library the app actually renders through', () => {
    expect(detect(withDeps({ react: '^19' })).uiLibrary).toBe(UiLibrary.REACT);
    expect(detect(withDeps({ preact: '^10' })).uiLibrary).toBe(UiLibrary.PREACT);
    expect(detect(withDeps({ vue: '^3' })).uiLibrary).toBe(UiLibrary.VUE);
    expect(detect(withDeps({ svelte: '^5' })).uiLibrary).toBe(UiLibrary.SVELTE);
    expect(detect(withDeps({ lodash: '^4' })).uiLibrary).toBe(UiLibrary.UNKNOWN);
  });

  it('prefers React when both are present (preact/compat aliasing)', () => {
    expect(detect(withDeps({ preact: '^10', react: '^18' })).uiLibrary).toBe(UiLibrary.REACT);
  });
});

/**
 * Astro is Vite-based but SSRs its own HTML and does not list `vite` as a direct dependency, so it
 * fell all the way through to HTML — and was handed connect instructions for an entry module it does
 * not have. SKILL.md offers Astro as a gated framework the whole time.
 */
describe('detect — Astro', () => {
  it('is recognised from the dependency or the config, before the generic Vite branch', () => {
    expect(
      detect({
        pkg: { dependencies: { astro: '^7' } },
        configFiles: new Set(),
        lockfiles: new Set(),
      }).framework,
    ).toBe(Framework.ASTRO);
    expect(
      detect({ pkg: {}, configFiles: new Set(['astro.config.mjs']), lockfiles: new Set() })
        .framework,
    ).toBe(Framework.ASTRO);
  });

  it('wins over a bare vite dependency, which Astro pulls in transitively anyway', () => {
    expect(
      detect({
        pkg: { dependencies: { astro: '^7' }, devDependencies: { vite: '^7' } },
        configFiles: new Set(['astro.config.mjs', 'vite.config.ts']),
        lockfiles: new Set(),
      }).framework,
    ).toBe(Framework.ASTRO);
  });
});

/**
 * electron-vite ships `vite` as a dependency and uses `electron.vite.config.ts`, so the generic
 * Vite branch would claim it and then fail to find a file to patch. Detected in its own right so
 * the renderer-scoped patcher runs instead.
 */
describe('detect — electron-vite', () => {
  it('is recognised from the dependency or the config, before the generic Vite branch', () => {
    expect(
      detect({
        pkg: { devDependencies: { 'electron-vite': '^5' } },
        configFiles: new Set(),
        lockfiles: new Set(),
      }).framework,
    ).toBe(Framework.ELECTRON_VITE);
    expect(
      detect({
        pkg: {},
        configFiles: new Set(['electron.vite.config.ts']),
        lockfiles: new Set(),
      }).framework,
    ).toBe(Framework.ELECTRON_VITE);
  });

  it('wins over a bare vite dependency, which electron-vite apps always list', () => {
    expect(
      detect({
        pkg: { devDependencies: { 'electron-vite': '^5', vite: '^7' } },
        configFiles: new Set(['electron.vite.config.ts']),
        lockfiles: new Set(),
      }).framework,
    ).toBe(Framework.ELECTRON_VITE);
  });

  it('leaves a plain Vite app as Vite', () => {
    expect(
      detect({
        pkg: { devDependencies: { vite: '^7' } },
        configFiles: new Set(['vite.config.ts']),
        lockfiles: new Set(),
      }).framework,
    ).toBe(Framework.VITE);
  });
});

/**
 * No lockfile is not the same as "npm". A pnpm-installed project with an uncommitted lockfile was
 * read as npm, and `npm i -D` then died on pnpm's symlink layout with "Cannot read properties of
 * null (reading 'matches')" — leaving the package present in node_modules but absent from
 * package.json, so every later run reported the same failure. A setup that cannot be retried into
 * working is worse than one that fails outright.
 */
describe('detect package manager — from an installed tree', () => {
  const withMarkers = (nodeModulesMarkers: Set<string>): DetectInput => ({
    pkg: {},
    configFiles: new Set(),
    lockfiles: new Set(),
    nodeModulesMarkers,
  });

  it('reads the manager that built node_modules when no lockfile is committed', () => {
    expect(detect(withMarkers(new Set(['.modules.yaml']))).packageManager).toBe(
      PackageManager.PNPM,
    );
    expect(detect(withMarkers(new Set(['.yarn-state.yml']))).packageManager).toBe(
      PackageManager.YARN,
    );
    expect(detect(withMarkers(new Set(['.package-lock.json']))).packageManager).toBe(
      PackageManager.NPM,
    );
  });

  it('a committed lockfile still wins over the installed tree', () => {
    expect(
      detect({
        pkg: {},
        configFiles: new Set(),
        lockfiles: new Set(['yarn.lock']),
        nodeModulesMarkers: new Set(['.modules.yaml']),
      }).packageManager,
    ).toBe(PackageManager.YARN);
  });

  it('still falls back to npm when there is nothing to go on', () => {
    expect(detect(withMarkers(new Set())).packageManager).toBe(PackageManager.NPM);
  });
});

/**
 * The install `init` runs is a CHILD process whose output lands above ours.
 *
 * Measured on a real install: the run opened with "added 602 packages", a funding notice and
 * "14 vulnerabilities (7 moderate, 7 high)" plus `npm audit fix` advice, before a single line of
 * Reticle output. A user's first impression of a verification tool was a wall of somebody else's
 * security warnings, at the moment they are deciding whether this tool is careful — and the audit
 * summary is about their existing dependency tree, which our two dev packages did not cause and
 * cannot fix.
 *
 * Quieted, not silenced: a genuine failure still has to be loud, which is why the exit code and
 * stderr are untouched.
 */
describe('the dependency install is quiet about things that are not ours', () => {
  it('suppresses the audit and funding summaries on npm', () => {
    const { args } = installCommandParts(PackageManager.NPM, ['@reticlehq/react']);
    expect(args).toContain('--no-audit');
    expect(args).toContain('--no-fund');
  });

  it('still installs as a dev dependency', () => {
    const { args } = installCommandParts(PackageManager.NPM, ['@reticlehq/react']);
    expect(args).toContain('-D');
    expect(args).toContain('@reticlehq/react');
  });

  it('keeps them OUT of the printed command, which a user may copy by hand', () => {
    // The plan shows this string and a user retypes it; teaching them our noise-suppression flags
    // would be teaching them our problem.
    expect(installCommand(PackageManager.NPM, '@reticlehq/react')).toBe(
      'npm i -D @reticlehq/react',
    );
  });

  it('leaves the other package managers alone — the flags are npm-specific', () => {
    // pnpm/yarn/bun do not take these, and passing an unknown flag turns a working install into a
    // hard failure of the one step everything downstream depends on.
    for (const pm of [PackageManager.PNPM, PackageManager.YARN, PackageManager.BUN]) {
      const { args } = installCommandParts(pm, ['@reticlehq/react']);
      expect(args).not.toContain('--no-audit');
    }
  });
});
