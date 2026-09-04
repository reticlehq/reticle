/**
 * Webpack 4 cannot parse nullish coalescing, optional chaining, or logical assignment, and
 * react-scripts 4 excludes node_modules from Babel — so any of those tokens in the published
 * SDK dist breaks the app's compile before a session can connect (issue #680). The browser and
 * core packages pin `target: ES2017` in their own tsconfigs for exactly this reason (tighter than
 * strictly required — a deliberate, separately-verified choice for syntax this repo controls).
 * This file fails if that pin is removed or if newer syntax reaches dist again — in this
 * package's own output, or in `zod`, the one runtime dependency `@reticlehq/core` (and so every
 * consumer of `@reticlehq/browser`) actually installs. `zod` is pinned to an exact version in
 * `packages/core/package.json` (with a matching dependabot ignore) precisely because its OWN
 * dist ships `??`/`?.` from 3.23.0 onward — a transitive copy of the exact bug this file exists
 * to catch, invisible to every check that only looks at this repo's own build output. Below, a
 * second gate actually parses dist with acorn at the real webpack-4 ceiling (ES2019) rather than
 * grepping a fixed token list — the ceiling a third-party build like zod's needs to clear, since
 * this repo does not control zod's own target.
 */
// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as acorn from 'acorn';

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_DIST = join(HERE, '..', 'dist');
const CORE_DIST = join(HERE, '..', '..', 'core', 'dist');
const CORE_PACKAGE_JSON = join(HERE, '..', '..', 'core', 'package.json');

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...jsFiles(full));
    } else if (/\.(?:js|cjs|mjs)$/.test(full) && !full.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

function stripNonCode(src: string): string {
  return stripTemplates(
    src
      // block comments, line comments, single/double-quoted strings
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""'),
  );
}

/**
 * Blanks template-literal text but keeps ${} interpolation contents: an operator inside an
 * interpolation is code webpack 4 must parse, while one in literal text is inert.
 */
function stripTemplates(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf('`', i);
    if (-1 === start) return out + src.slice(i);
    out += src.slice(i, start);
    // Collect the literal's ${...} spans verbatim; everything else cooked text is blanked.
    let kept = '';
    let j = start + 1;
    while (j < src.length) {
      if ('\\' === src[j]) {
        j += 2;
        continue;
      }
      if ('`' === src[j]) break;
      if ('$' === src[j] && '{' === src[j + 1]) {
        let depth = 1;
        let m = j + 2;
        while (m < src.length && 0 < depth) {
          if ('\\' === src[m]) {
            m += 2;
            continue;
          }
          if ('$' === src[m] && '{' === src[m + 1]) depth += 1;
          else if ('}' === src[m]) depth -= 1;
          m += 1;
        }
        kept += src.slice(j, m);
        j = m;
        continue;
      }
      j += 1;
    }
    out += `""${kept}""`;
    i = j + 1;
  }
  return out;
}

const MODERN_SYNTAX_TOKENS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: '??=', re: /\?\?=/ },
  { name: '||=', re: /\|\|=/ },
  { name: '&&=', re: /&&=/ },
  { name: '??', re: /\?\?/ },
  { name: '?.', re: /\?\.(?![0-9])/ },
];

function scanDistForModernSyntax(dir: string): string[] {
  const hits: string[] = [];
  for (const file of jsFiles(dir)) {
    const code = stripNonCode(readFileSync(file, 'utf8'));
    for (const token of MODERN_SYNTAX_TOKENS) {
      if (token.re.test(code)) hits.push(`${file}: ${token.name}`);
    }
  }
  return hits;
}

/** The exact `zod` directory `@reticlehq/core` resolves at install time — not a hardcoded path. */
function resolvedZodDir(): string {
  const require = createRequire(CORE_PACKAGE_JSON);
  const zodPackageJson = require.resolve('zod/package.json');
  return dirname(zodPackageJson);
}

/**
 * Webpack 4's bundled acorn parses up through ES2019 (object/array spread and rest, async
 * iteration, optional catch binding) without a bundler-config edit — issue #680 was specifically
 * nullish coalescing, optional chaining, and logical assignment, all ES2020. `target: ES2017` in
 * this repo's own tsconfigs is a deliberately tighter, separately-enforced choice (the
 * `resolves a target at or below ES2017` case above) for syntax THIS repo controls; ES2019 here
 * is the actual webpack-4 ceiling, which is what a third-party dependency's own build (zod's)
 * needs to clear. `.cjs` parses as a script (`require`/`module.exports`, no top-level
 * `import`/`export`); everything else parses as a module, matching how these packages (and zod)
 * ship ESM `.js` under `"type": "module"`.
 */
function parseEachUnderWebpack4Ceiling(dir: string): string[] {
  const failures: string[] = [];
  for (const file of jsFiles(dir)) {
    const sourceType = file.endsWith('.cjs') ? 'script' : 'module';
    try {
      acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 2019, sourceType });
    } catch (err) {
      failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failures;
}

describe('published SDK dist stays parseable by webpack 4', () => {
  it.each([
    ['browser', BROWSER_DIST],
    ['core', CORE_DIST],
  ] as const)(
    '%s dist carries no nullish, optional-chain, or logical-assignment syntax',
    (pkg, dist) => {
      expect(existsSync(dist), `${pkg} dist is missing — run pnpm build before test:unit`).toBe(
        true,
      );
      expect(
        jsFiles(dist).length,
        `${pkg} dist holds no scannable files — the guard would pass vacuously`,
      ).toBeGreaterThan(0);
      expect(scanDistForModernSyntax(dist)).toEqual([]);
    },
  );

  it('the scanner sees through comments and strings to code-position tokens', () => {
    // A fixture, not dist: proves the guard is red-capable without depending on a broken build.
    const fixture = [
      '// `??` in a comment and "??" in a string are fine',
      '/* ??= in a block comment */',
      "const s = '?. decoy';",
      'const label = `did you mean ${s} ?? half`;',
      'const chosen = a ?? b;',
      'const el = maybe?.child;',
      'const msg = `value ${a ?? b}`;',
      'opts.retry ??= 3;',
      'opts.count ||= 1;',
      'opts.flag &&= ready;',
    ].join('\n');
    const code = stripNonCode(fixture);
    expect(
      MODERN_SYNTAX_TOKENS.filter((t) => t.re.test(code))
        .map((t) => t.name)
        .sort(),
    ).toEqual(['&&=', '?.', '??', '??=', '||=']);
  });

  it.each(['browser', 'core'] as const)('%s resolves a target at or below ES2017', (pkg) => {
    const base = JSON.parse(
      readFileSync(join(HERE, '..', '..', '..', 'tsconfig.base.json'), 'utf8'),
    ) as { compilerOptions?: { target?: string } };
    const config = JSON.parse(
      readFileSync(join(HERE, '..', '..', pkg, 'tsconfig.json'), 'utf8'),
    ) as { compilerOptions?: { target?: string } };
    const resolved = (
      config.compilerOptions?.target ??
      base.compilerOptions?.target ??
      ''
    ).toLowerCase();
    expect(
      ['es3', 'es5', 'es2015', 'es2016', 'es2017'].includes(resolved),
      `${pkg} resolves target ${resolved || '(unset)'} — the webpack-4 pin must stay at ES2017 or below`,
    ).toBe(true);
  });
});

describe('the transitive zod dependency stays parseable too', () => {
  it('the zod that @reticlehq/core actually resolves carries no modern syntax', () => {
    const zodDir = resolvedZodDir();
    expect(
      jsFiles(zodDir).length,
      'zod dist holds no scannable files — the guard would pass vacuously',
    ).toBeGreaterThan(0);
    expect(scanDistForModernSyntax(zodDir)).toEqual([]);
  });
});

describe('a real webpack-4-ceiling grammar parse, not just a 5-token grep', () => {
  it.each([
    ['browser', BROWSER_DIST],
    ['core', CORE_DIST],
  ] as const)('%s dist parses cleanly under the webpack-4 ceiling', (pkg, dist) => {
    expect(existsSync(dist), `${pkg} dist is missing — run pnpm build before test:unit`).toBe(true);
    expect(parseEachUnderWebpack4Ceiling(dist)).toEqual([]);
  });

  it('zod dist parses cleanly under the webpack-4 ceiling', () => {
    expect(parseEachUnderWebpack4Ceiling(resolvedZodDir())).toEqual([]);
  });

  it('the parser is red-capable: ES2020+ syntax fails a webpack-4-ceiling parse', () => {
    const cases = ['const x = a ?? b;', 'const y = a?.b;', 'a ??= b;', 'a ||= b;', 'a &&= b;'];
    for (const source of cases) {
      expect(() => acorn.parse(source, { ecmaVersion: 2019, sourceType: 'script' })).toThrow();
    }
  });

  it('the parser is NOT overly strict: ES2018 object spread parses fine (the real webpack-4 floor)', () => {
    expect(() =>
      acorn.parse('const merged = { ...a, ...b };', { ecmaVersion: 2019, sourceType: 'script' }),
    ).not.toThrow();
  });
});
