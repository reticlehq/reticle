import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * How much JavaScript a page downloads just for loading the SDK, and a ceiling on it.
 *
 * This is the number a developer actually pays. It is not "how big is the package": most of what a
 * package contains is only downloaded if something reaches it, and the whole point of the work this
 * check watches over is that the in-page panel is now reached for only when somebody wants it.
 *
 * So it is measured the way a real app would produce it: bundle the entry the way a bundler does,
 * follow only the imports that happen on the way in, and add up what comes back. An earlier version
 * of this check added up every file in the build folder instead, which counted the test files, and
 * -- worse -- could not have seen the improvement it existed to motivate, because deferring
 * something does not make its file go away.
 *
 * The panel is what makes Reticle visible while an agent drives, and it is the moment somebody first
 * understands what the tool does. It earns its place in the product. It does not earn its place in
 * every page load: during ordinary development almost no page ever connects to an agent, and until
 * one does the panel is a third of a megabyte nobody looked at.
 *
 * Two numbers are pinned. The first is what a page pays on the way in, which may not grow. The
 * second is how much of the panel is STILL paid for on the way in, which is what would creep back
 * if somebody named one panel constant from a file that loads early. That has already happened
 * once: a single z-index dragged the panel's whole stylesheet into the first load, a hundred
 * kilobytes reached through one integer.
 */

const PACKAGE_ROOT = join(__dirname, '..');
/**
 * Where the repository is, asked rather than counted.
 *
 * Counting `..` segments up to the root is a statement about how deep this package happens to sit,
 * and this package has just moved. Three checks broke on that count in one afternoon, each one
 * silently reading the wrong directory. Git already knows the answer.
 */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: PACKAGE_ROOT,
  encoding: 'utf8',
}).trim();
const DIST_ENTRY = join(PACKAGE_ROOT, 'dist', 'index.js');

/**
 * Measured 2026-09-10, after the panel was made something a page fetches when it wants it.
 *
 * First load went from 346,088 B to 219,545 B. The ceilings are set a little above what was
 * measured, so an ordinary change does not fail on rounding; raising either one needs a reason
 * written here, the way the tool-surface budget does.
 */
const MAX_FIRST_LOAD_BYTES = 232_500;
/**
 * Raised again, 231,000 to 232,500, when the previous release merged into this branch. Measured
 * 231,715,
 * attributed from the same metafile rather than guessed at:
 *
 *   adapters/realm/dom   126,941 -> 127,400   +459   the previous release's SDK work
 *   core                  31,745 ->  32,508   +763   see below
 *   @reticlehq/openreality 8,352 ->   8,658   +306   the `measure` predicate's schema
 *   zod                   59,536 unchanged
 *
 * **328 B of core's growth is a server-only helper on every page load.** `global-press` answers
 * whether a key press is a document key, and it is used by `act-preflight` and `act-target` and
 * by nothing in the browser. It reaches a page because it is exported from core's ROOT barrel,
 * which is the same shape as `verification-run` two entries below: the browser pays for a thing
 * only the daemon reads.
 *
 * Not fixed here, and the reason is narrow. Removing the export breaks the server's import,
 * because core publishes `.`, `./telemetry` and `./artifacts` and nothing else, so the server
 * has no other way to reach it. Giving it one is a change to a published package's exports, and
 * a merge of fifty-eight commits is the wrong place to make a public-surface decision.
 *
 * Both costs now point at the same fix: a `core` subpath for the things a page never reads.
 * `verification-run` is 3,635 B, the protocol behind it 8,352 B, and this is 328 B. Together
 * that is about 12.3 KB of every page load, spent on a run artifact, a specification and a
 * keyboard helper, none of which a browser uses.
 */
/**
 * Raised from 230,000 on 2026-09-11, with the reason the comment above asks for.
 *
 * Measured 230,149 B -- 149 B over, and the ceiling had almost no headroom left. Raised by
 * 1,000 B rather than to the measurement, so an ordinary change does not fail on rounding.
 *
 * The cause, attributed from the same metafile rather than guessed at: `core/index.js`
 * re-exports `verdict/verification-run`, and this release gave it an import of
 * `@reticlehq/openreality`, because a run artifact now carries a `SubjectRef`. That one import
 * is of the protocol's barrel, and the barrel re-exports the whole vocabulary -- every one of
 * which builds a zod schema at module scope, so none of it can be shaken out. Ten protocol
 * files, 8,352 B minified, arrive on every page load to give one schema to one field.
 *
 * What does NOT arrive is worth writing down, because the first draft of this comment claimed
 * it did: `realm/registry` is not in the first load at all, and neither is the adjudicator nor
 * the reference realm. Those are functions and classes with no module-scope side effects, so
 * esbuild drops them. Only the schemas survive. A protocol addition costs a page load exactly
 * when it is a schema, and nothing when it is a rule.
 *
 * **The structural fix is not this.** `core` already has the pattern: `./telemetry` and
 * `./artifacts` are subpath entry points precisely so the barrel does not drag everything in.
 * Moving `verification-run` behind one would take back its own 3,635 B and the protocol's
 * 8,352 B with it -- about 12 KB, well below 230,000 -- and stop the next schema arriving on
 * every page load. That is a public-surface change to `@reticlehq/core` and wants deciding
 * rather than doing under a size guard.
 *
 * For scale, the largest single line item in the first load is neither: zod itself is 59,536 B,
 * and it has been there since long before the protocol existed.
 */
/** What is left is the handful of small leaf files a page names on the way in. See log-kinds.ts. */
const MAX_PANEL_BYTES_IN_FIRST_LOAD = 5_000;

interface Chunk {
  readonly bytes: number;
  readonly imports?: readonly { readonly path: string; readonly kind: string }[];
  readonly inputs?: Readonly<Record<string, { readonly bytesInOutput: number }>>;
  readonly entryPoint?: string;
}

/** Where the bundler lives. It is a build dependency here, not something this package ships. */
function bundlerPath(): string {
  const found = execFileSync(
    'bash',
    [
      '-c',
      `ls -d "${REPO_ROOT}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | tail -1`,
    ],
    { encoding: 'utf8' },
  ).trim();
  return found;
}

/** Bundle the entry and report what a first load costs, and how much of that is the panel. */
function firstLoad(): { bytes: number; panelBytes: number; deferredBytes: number } {
  const out = mkdtempSync(join(tmpdir(), 'reticle-first-load-'));
  execFileSync(
    bundlerPath(),
    [
      DIST_ENTRY,
      '--bundle',
      '--format=esm',
      '--splitting',
      '--minify',
      `--outdir=${out}`,
      '--log-level=error',
      `--metafile=${join(out, 'meta.json')}`,
    ],
    { encoding: 'utf8' },
  );
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) as {
    outputs: Record<string, Chunk>;
  };
  const chunks = meta.outputs;
  const entry = Object.keys(chunks).find((name) => chunks[name]?.entryPoint !== undefined) ?? '';

  // Only the imports that happen on the way in. A dynamic import is by definition not one of those.
  const onTheWayIn = new Set<string>();
  const walk = (name: string): void => {
    if (onTheWayIn.has(name)) return;
    onTheWayIn.add(name);
    for (const dependency of chunks[name]?.imports ?? []) {
      if ('dynamic-import' !== dependency.kind) walk(dependency.path);
    }
  };
  walk(entry);

  let bytes = 0;
  let panelBytes = 0;
  for (const name of onTheWayIn) {
    bytes += chunks[name]?.bytes ?? 0;
    for (const [source, piece] of Object.entries(chunks[name]?.inputs ?? {})) {
      if (source.includes('/presenter/')) panelBytes += piece.bytesInOutput;
    }
  }
  let deferredBytes = 0;
  for (const [name, chunk] of Object.entries(chunks)) {
    if (!onTheWayIn.has(name) && name.endsWith('.js')) deferredBytes += chunk.bytes;
  }
  return { bytes, panelBytes, deferredBytes };
}

describe('what a page downloads just for loading the SDK', () => {
  it('there is a build to measure, and a bundler to measure it with', () => {
    // Without this the whole check passes on a missing build, reporting a first load of zero --
    // which reads as spectacular good news.
    expect(existsSync(DIST_ENTRY), `${DIST_ENTRY} is missing — run pnpm build`).toBe(true);
    expect(bundlerPath(), 'no bundler found, so nothing below measured anything').not.toBe('');
  });

  it('really does defer something, so the numbers below are not a bundle that never split', () => {
    // If splitting silently stopped working, everything would land in the first load and the two
    // ceilings would be the only thing standing between that and a green run. This says out loud
    // that some of the package is genuinely fetched later.
    expect(firstLoad().deferredBytes).toBeGreaterThan(50_000);
  });

  it(`costs at most ${String(MAX_FIRST_LOAD_BYTES)} bytes on the way in`, () => {
    const { bytes } = firstLoad();
    expect(
      bytes,
      `a page now downloads ${String(bytes)} B just for loading the SDK. Every developer pays this ` +
        'on every page load, including the ones where no agent ever connects. Either find what ' +
        'grew, or raise this ceiling here with the reason.',
    ).toBeLessThanOrEqual(MAX_FIRST_LOAD_BYTES);
  });

  it('keeps almost none of the in-page panel in that first load', () => {
    const { panelBytes } = firstLoad();
    expect(
      panelBytes,
      `${String(panelBytes)} B of the panel is downloaded before anybody asks for it. This creeps ` +
        'back one constant at a time: naming a single value that lives beside the panel pulls in ' +
        'everything that value’s file imports. Put the value in a leaf file of its own instead, ' +
        'the way log-kinds.ts and layers.ts do.',
    ).toBeLessThanOrEqual(MAX_PANEL_BYTES_IN_FIRST_LOAD);
  });
});
