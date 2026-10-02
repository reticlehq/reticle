/**
 * Prepare a package's `dist` for packing: drop the tests, then drop the source maps.
 *
 * The test half used to be `find dist -name "*.test.*" -delete`, in the prepack of all eight
 * publishable packages. On Windows `find` is `C:\Windows\System32\find.exe`, a string search with
 * no relation to the POSIX tool, so that line did not prune anything — it failed with "Access
 * denied - DIST / File not found - -NAME / File not found - -DELETE" and took the whole prepack
 * with it. Every `@reticlehq/*` package was therefore unpackable and unpublishable from a Windows
 * machine, which nothing had noticed because releases have only ever been cut from a mac. Found by
 * making the install gate run on Windows, where the first thing it does is publish to a local
 * registry. It is folded in here rather than given its own script because this already walks the
 * same tree for the same reason, one step later.
 *
 * The source-map half:
 *
 * The maps we were shipping could not work. They reference `../src/*.ts`, and the published package
 * contains only `dist`, `README.md` and `NOTICE` — no sources — and tsc emits no `sourcesContent`
 * because `inlineSources` is off. So a consumer's debugger followed the map, looked for a file that
 * is not in the tarball, and gave up. Measured on `@reticlehq/browser`: 340KB of the 947KB package,
 * 36% of what users download, for nothing. It is also what pushed the SDK past its 900KB budget.
 *
 * The two honest options were "ship the sources so the maps resolve" (+479KB, taking the package to
 * 1.44MB — 60% over budget for a dev-only SDK) or "stop shipping maps" (621KB, back under budget
 * with the headroom the budget was written for). This is the second.
 *
 * Maps are still EMITTED — `tsc -b` is untouched, so they exist in `dist` for local debugging and
 * for anything in this repo that runs against built output. Only the tarball loses them.
 *
 * The `sourceMappingURL` comments go too. Leaving them would trade dead bytes for a worse problem:
 * DevTools fetches the missing `.map` and logs a failure in the console of every app embedding a
 * tool whose entire job is to be trustworthy about what it observes.
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_SUFFIXES } from './test-suffixes.mjs';

/**
 * Test scaffolding, as the COMPILED file it becomes.
 *
 * The suffix list is written against sources (`.test-harness.ts`); by the time this runs, `tsc` has
 * emitted `.test-harness.js` and `.test-harness.d.ts` beside it. Stripping the source extension and
 * matching the stem covers every emitted form without a second list to keep true.
 *
 * `bridge.test-harness.js` shipped to npm because the old rule was a literal `.test.` and that name
 * has no dot after `test`.
 */
const TEST_STEMS = TEST_SUFFIXES.map((suffix) => suffix.replace(/\.[cm]?[jt]sx?$/, ''));
const isTestArtifact = (name) =>
  name.includes('.test.') || TEST_STEMS.some((stem) => name.includes(stem + '.'));

const MAP_COMMENT = /\n?\/\/# sourceMappingURL=.*\.map\s*$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? 'dist';

// `--clean` is the other half of a prepack: `rm -rf dist` before `tsc -b --force`, so a stale file
// from a previous build cannot ride along in the tarball. Only `@reticlehq/server` needs it, and it
// lives here rather than in a script of its own because it is the same directory and the same
// reason. Windows has no `rm`, and the retries are for the same EPERM every Windows delete can hit.
if (args.includes('--clean')) {
  rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  console.error(`prepare-dist: cleaned ${target}`);
  process.exit(0);
}
/**
 * An `@/…` that is a real import STATEMENT, or undefined.
 *
 * Line-by-line and comment-aware, because a plain substring search is wrong in both directions here.
 * It fires on prose — `server/src/command/cli.ts` has a comment reading "keep resolving from
 * `@/cli.js`", which is not an import and would have blocked every publish. And `@/` is a common
 * alias in the apps Reticle scaffolds, so `init`'s own source quotes `import … from '@/components/…'`
 * as the text it writes into somebody's Next.js project: OUR emitted code must not contain the
 * alias, but code we generate for a user legitimately does.
 *
 * So this matches the shape tsc actually emits — an import or export whose specifier begins `@/` —
 * and only outside a comment. A quoted example inside a string keeps its quotes and does not match.
 */
function unresolvedAlias(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const match =
      /^(?:import|export)\s[^'"]*from\s*(['"])(@\/[^'"]*)\1|^import\s*\(\s*(['"])(@\/[^'"]*)\3/.exec(
        line,
      );
    if (match !== null) return `'${match[2] ?? match[4] ?? '@/'}'`;
  }
  return undefined;
}

/**
 * The same check, over the packages this one REFERENCES.
 *
 * `tsc -b` builds the reference graph; `tsc-alias` rewrites one `outDir`. So a package's own build
 * re-emitted its dependencies' dist with the alias back in it, and the dependency — already packed
 * and gone — never got a second rewrite. That is `scripts/alias-dist.mjs`, and this is what makes
 * forgetting it loud: a dist somebody else's build broke fails HERE, naming the file, instead of at
 * the first `import` of a sibling's built output.
 */
function referencedDists() {
  let config;
  try {
    config = readFileSync('tsconfig.json', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
  } catch {
    return [];
  }
  const refs = JSON.parse(config).references ?? [];
  return refs
    .map((ref) => join(ref.path.replace(/tsconfig\.json$/, ''), 'dist'))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

for (const dist of referencedDists()) {
  for (const file of walk(dist)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts') && !file.endsWith('.cjs')) continue;
    const unresolved = unresolvedAlias(readFileSync(file, 'utf8'));
    if (unresolved !== undefined) {
      throw new Error(
        `prepare-dist: ${file} still imports ${unresolved}. A referenced package's dist was rebuilt ` +
          `without its alias rewrite — build with \`node scripts/alias-dist.mjs\`, which covers the ` +
          `whole project-reference graph, not \`tsc-alias\`, which covers one package.`,
      );
    }
  }
}

let removed = 0;
let stripped = 0;

let tests = 0;

for (const file of walk(target)) {
  // Tests first, so their maps are never counted or rewritten on the way out.
  if (isTestArtifact(file.split(/[\\/]/).pop() ?? '')) {
    rmSync(file);
    tests += 1;
    continue;
  }
  if (file.endsWith('.map')) {
    rmSync(file);
    removed += 1;
    continue;
  }
  if (!file.endsWith('.js') && !file.endsWith('.d.ts') && !file.endsWith('.cjs')) continue;
  const before = readFileSync(file, 'utf8');
  /*
   * An unrewritten `@/…` must never leave this directory.
   *
   * Source uses `@/x` for anything outside its own directory, and `tsc-alias` turns that back into a
   * relative path after `tsc`. TypeScript resolves the alias at COMPILE time and Node does not
   * resolve it at all, so a survivor here is a bare specifier Node looks for in `node_modules`: the
   * package typechecks, builds, packs, publishes, and then fails on the user's first import.
   *
   * Checked HERE, in the one script every publishable package already runs at prepack, rather than
   * in a guard per package. That is the repo's own rule about fixing the shared function instead of
   * watching its callers — and it is what makes "somebody adds a package and forgets the rewrite
   * step" impossible rather than merely unlikely, which is the one risk this convention carries.
   */
  const unresolved = unresolvedAlias(before);
  if (unresolved !== undefined) {
    throw new Error(
      `prepare-dist: ${file} still imports ${unresolved}. tsc-alias did not run for this package — ` +
        `its build must be \`tsc -b && tsc-alias\`. Publishing this would fail on the user's first ` +
        `import.`,
    );
  }
  const after = before.replace(MAP_COMMENT, '\n');
  if (after !== before) {
    writeFileSync(file, after);
    stripped += 1;
  }
}

// stderr, NOT stdout. `npm pack --json` writes its report to stdout and the size gate parses it —
// one console.log here makes that JSON unparseable and takes the gate down with a syntax error
// rather than a size failure. Verified: it did exactly that the first time.
console.error(
  `prepare-dist: removed ${String(tests)} test files and ${String(removed)} maps, stripped ${String(stripped)} references`,
);
