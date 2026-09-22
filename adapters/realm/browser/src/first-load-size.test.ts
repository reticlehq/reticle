// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { existsSync } from 'node:fs';
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
const DIST_ENTRY = join(PACKAGE_ROOT, 'dist', 'index.js');

/**
 * Measured 2026-09-10, after the panel was made something a page fetches when it wants it.
 *
 * First load went from 346,088 B to 219,545 B. The ceilings are set a little above what was
 * measured, so an ordinary change does not fail on rounding; raising either one needs a reason
 * written here, the way the tool-surface budget does.
 */
/*
 * Raised by 100 B for the learned-guards contract, and the reason is recorded because the guard
 * asks for one.
 *
 * Adding `learned` to `FlowFileSchema` cost this bundle 89 bytes — proven by reverting only that
 * file and watching the check pass. It is a zod schema built at module scope, so the bundler cannot
 * drop it even though a browser never validates a flow FILE; flow files are read and written by the
 * daemon.
 *
 * Then 41 more for `cleanRuns` on the same schema. THREE schema additions have now moved this
 * number, and that pattern is the real finding rather than any of the three amounts.
 *
 * `core`'s barrel does `export * from './artifacts/flow-types.js'`, the SDK imports the barrel in
 * 151 places, and zod schemas are built at module scope so the bundler cannot drop them. A browser
 * never validates a flow FILE — flows are read and written by the daemon — so every page load in
 * every instrumented app carries a schema it can never use, and it grows whenever the daemon's file
 * format does.
 *
 * Nobody has measured what ALL of it costs; the three increments only prove the channel exists.
 * The fix is to stop re-exporting flow artifacts from the barrel the SDK imports (core has a
 * `./artifacts` subpath already), which is free while core is unpublished and is not free after.
 * Raising this constant a fourth time is the wrong answer.
 *
 * The fourth raise, 200 B, is a DIFFERENT kind and the distinction is the point. The three above
 * were dead weight — a flow-file schema a browser can never use. This one is the recorder writing
 * each step's source file, which is functionality, and it is what lets a saved flow say which
 * source files it covers. Measured before it: `verify { action: "change" }` on two edited files
 * replayed FIFTY-TWO flows, took 46 seconds, and answered `unknown`, because not one flow could say
 * what it covered. `sourceFromDom` was already in the bundle — `a11y.ts` uses it — so this is the
 * recorder's own code, not a new dependency.
 *
 * A ceiling is for catching weight nobody chose. Paying 200 B to turn a 46-second `unknown` into a
 * scoped answer is a choice, and it is written here so the next reader can disagree with it.
 *
 * The fifth raise is 57 B for four fields: `scrollLeft`, `scrollWidth`, `clientWidth`, `overflowX`.
 * `inspect` reported the Y axis only, so a scrolling panel was diagnosable and a clipped label was
 * not — and `text-overflow: ellipsis` is the one CSS property whose whole job is to hide the
 * evidence that content did not fit. Four numbers make the most common visual defect on the web
 * READABLE rather than something an agent has to infer from a picture. At roughly 14 bytes a field
 * this is the best ratio in the file.
 *
 * The sixth raise is 649 B for the paint context — an ancestor-chain walk for the five properties
 * that change how an element rasterises without changing its own computed style. It is the largest
 * raise here and the easiest to justify: it is the one regression this project has MEASURABLY lost
 * to a screenshot. `filter: hue-rotate` on an ancestor moved 21,393 pixels while the element's own
 * style stayed byte-identical, and the answer was readable from inside the whole time — we were
 * composing nothing.
 *
 * 649 bytes once, against 1,365 image tokens EVERY look, for an answer a screenshot cannot give at
 * any price: which element and which property. This is the trade the ceiling exists to make
 * visible, and it is the right way round.
 */
/**
 * 237_600 since the input vocabulary was completed: `tap` (a real touch sequence, not a click under
 * another name), bidirectional and horizontal `scroll`, a held key with its auto-repeat, multi-key
 * combos released in reverse, and a `zoom` that refuses in-page.
 *
 * +2,893 B measured, and paid by every page load including the ones no agent ever connects to. It
 * buys gestures that were previously undriveable rather than merely awkward: a `touchstart`
 * handler never ran for a synthetic click, and a page could be scrolled forward but never back.
 */
/*
 * Raised to 237_760 for the three fields that let a flow describe its own safety: a step's `effect`
 * and `id`, and a flow's `requires`/`ensures`. 79 B, and the page pays them because a zod object is
 * not provably side-effect free, so the barrel retains the flow schemas whether or not a page ever
 * validates one. That is the same reason `flow-step-tool.ts` was split out, and the same reason this
 * ceiling exists at all.
 *
 * What the 79 bytes buy: `effect: "commits"` is what lets a resume REFUSE to re-drive a prefix that
 * charges a card. Resuming re-drives the steps before the one you asked for — it cannot restore
 * state — and until a step could say what it does, the only thing that could refuse was the surface
 * profile, which answers for the realm and cannot see that one click in a harmless browser journey
 * takes payment. A silent re-send is not a slow page; it is somebody's money.
 *
 * The cheaper alternative was considered and rejected: `StepEffect` itself was first put in
 * `flow-constants.ts`, which the recorder imports for `FLOW_FILE_VERSION`, and that shipped the
 * whole enum to every page. Moving it to a leaf of its own bought back exactly 1 byte, so the cost
 * is the SCHEMA and not the vocabulary. Splitting the flow schemas further is
 * the way to stop paying it, and that is its own commit rather than a line in this one.
 */
/*
 * 237_760 -> 238_100, for the first-run tour to exist at all. 171 B measured.
 *
 * The tour is a carousel drawn over the user's own app the first time it loads instrumented. What it
 * replaces reached nobody: a pointer somebody had to choose to follow, behind a
 * `process.stdout.isTTY` check that is `undefined` through every pipe.
 *
 * What is NOT in this number is the point. The slides, their prose and ~3 kB of CSS sit behind a
 * dynamic `import('./presenter/tour/tour.js')` inside the block that already lazy-loads the panel,
 * and the shared step list is a `@reticlehq/core/tour` SUBPATH rather than a root export — the
 * first attempt put it on core's root entry and this guard caught 2 kB landing on every page load,
 * plus 14 kB more when the project id was read through a panel-side helper instead of the reader
 * `reticle.ts` already owns. Both were fixed rather than absorbed. The 171 B left is the mount call
 * itself, which a page cannot avoid downloading if the tour is ever to appear.
 */
/*
 * 238_100 -> 239_100, for a modal that mounts in a bare div. 222 B measured.
 *
 * The observer flushed on rAF and reported a mutation only when the mounted subtree carried
 * something it recognised, so a dialog rendered into an unadorned `<div>` read as SILENCE — and
 * silence is evidence here: it is what `settled` waits for and what an absence-derived finding
 * rests on. A modal that opened correctly could therefore be reported as a control that did
 * nothing, which is the false negative this product exists to refuse.
 *
 * Raised by 1,000 rather than to the measurement, per the note above: an ordinary change should
 * not fail on rounding.
 *
 * The structural fix named further down this file is still available and still unspent: moving
 * `verdict/verification-run` behind a `core` subpath takes back its own 3,635 B and the
 * protocol barrel's 8,352 B with it, about 12 kB. That is a public-surface change to
 * `@reticlehq/core` and wants deciding rather than doing under a size guard — but it is the
 * reason this ceiling keeps climbing, and every raise borrows against it.
 */
/*
 * 239_100 -> 240_100, for the console channel seeing CSP violations. 184 B measured.
 *
 * A Content-Security-Policy violation is not a console error: the browser reports it through
 * `securitypolicyviolation`, so a page whose script or connection was blocked outright looked, to
 * an assertion over the console, exactly like a page with nothing wrong. That is the shape this
 * product exists to refuse -- a clean answer about a page that never got to run.
 *
 * It is also the failure mode that hides Reticle's OWN setup problems: a CSP that blocks the
 * bridge is one of the named causes in the "the SDK is in the page and never dialled" diagnosis,
 * and until now the channel that should have said so was silent about it.
 *
 * Raised by 1,000 rather than to the measurement, per the note above: an ordinary change should
 * not fail on rounding. The structural refund named above is still unspent.
 */
const MAX_FIRST_LOAD_BYTES = 240_100;
/*
 * Raised a fifth time, 233_300 -> 233_400, for a route to be assertable in a SAVED flow. 57 B.
 *
 * `FlowExpect` had signal, net, console, element, text and state, and no route. Measured by driving
 * a real upstream app: a nav click asserted with `until: { kind: "route" }` returned
 * `verified: "yes"`, and the flow saved from that same drive graded `assertion-free` — "it claims
 * to verify a goal it cannot actually check". Both true at once, which is the defect. Navigation is
 * one of the commonest journeys there is, so every route-asserted drive persisted a flow that could
 * never go red.
 *
 * In the page because the in-page RECORDER compiles FlowFile-shaped objects, the same reason
 * `Flow.knownBugs` and the composition schema are here. Unlike those two, this one pays immediately:
 * it is the difference between a saved navigation that can fail and one that cannot.
 */
/*
 * Raised a fourth time, 232_900 -> 233_300, for grammar v2 — and this one has NOT paid for itself yet.
 *
 * The Flow document gained composition: `InvokeSchema`, `StepSchema` and a `FlowNameSchema` pattern,
 * so `steps` is a union rather than a list of actions. The in-page RECORDER compiles FlowFile-shaped
 * objects, which is what makes the schema genuinely reachable from the browser rather than dead
 * weight — the same reason `Flow.knownBugs` was admitted above. 306 B measured.
 *
 * What it buys TODAY: nothing a user can see. The recorder cannot yet close a sub-flow boundary, so
 * no composite can be authored from the page. What it buys once that lands is attribution: a drift
 * inside `onboarding/signup` reports THAT address instead of "step 34 of onboarding", which is the
 * whole reason composition is worth having. Written down as a debt rather than a benefit, because a
 * ceiling raised for a promise is the kind that gets raised again for the next promise.
 */
/*
 * Raised a third time, 232_800 -> 232_900, for 36 B that PAY FOR THEMSELVES on the first navigation.
 *
 * `appeared` reports the text an action put on the page, and an added node's `textContent` flattens
 * its whole subtree with no separators — so a navigation that swapped a view returned the new
 * screen run together into one string. Measured on a real drive against bench-app, clicking a nav
 * item: `"Compose | generate a release note | DraftRelease note generatorTitle · commits on
 * blurWhat shipped?GenerateOutputYour generated note appears here."` — 146 B, 36 tokens, on every
 * navigation verdict, with the fragment boundaries lost ("DraftRelease", "blurWhat") so it is not
 * even readable as a list. A container with more than three descendant elements is now treated as
 * a render rather than a message.
 *
 * The trade is 36 B ONCE per page load against ~36 tokens per navigation verdict, and the threshold
 * is generous on purpose: a message with emphasis, a link and an icon inside it still reports. The
 * two keep-cases were written before the cut and passed throughout, which is what says this bought
 * route and not evidence — a dropped view is still described properly by `reticle_snapshot`, which
 * is what a reader wanted for a new screen anyway.
 */
/*
 * Raised a second time, 232_700 -> 232_800, for a different reason than the first.
 *
 * `Flow.knownBugs` landed on the flow schema, and the in-page RECORDER compiles FlowFile-shaped
 * objects, so the schema is genuinely reachable from the browser rather than dead weight: 31 B.
 *
 * What it buys: a flow can carry the bugs it is known to expose, so a suite red for a filed reason
 * is not re-investigated and does not get quarantined — which would stop it watching the rest of the
 * journey it covers. The note names the assertions it was written against and reports itself STALE
 * when they change, because an old excuse attached to a new break reads as "known issue" and nobody
 * looks again.
 *
 * Checked before raising: `shouldRetry` and `staleKnownBugs` are NOT referenced by the SDK, so this
 * is the schema and not suite logic leaking into every page load.
 */
/*
 * Raised once, 232_500 -> 232_700, with the measurement that bought it.
 *
 * Occlusion stopped being a single centre-point hit test. It now samples five points and requires a
 * MAJORITY of them to be blocked by the same element, and it reads the whole stack at each point so
 * chrome above the occluder cannot hide it. That is ~77 B more than the one-liner it replaced.
 *
 * What the 77 B buys, MEASURED on this repo's detection suite: `occluded`, `nav-deployments-occluded`
 * and `cmdk-occluded` went from missed to caught, taking the run from 84/88 to **86 of 86 catchable
 * with 0 false positives** — the ceiling, since the remaining two are traps that a correct tool must
 * NOT flag. The clean variants all still read not-caught, which is the half that matters: any-point
 * sampling would have fired on a clipped corner and bought detection with false alarms.
 *
 * Two bugs a page load is a trade worth making; it is recorded here so the next raise has to make
 * its own case rather than inheriting this one.
 */
/**
 * Raised again, 231,000 to 232,500, when the previous release merged into this branch. Measured
 * 231,715,
 * attributed from the same metafile rather than guessed at:
 *
 *   adapters/realm/browser   126,941 -> 127,400   +459   the previous release's SDK work
 *   core                  31,745 ->  32,508   +763   see below
 *   open-verification 8,352 ->   8,658   +306   the `measure` predicate's schema
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
 * `open-verification`, because a run artifact now carries a `SubjectRef`. That one import
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
/**
 * What is left is the handful of small leaf files a page names on the way in. See log-kinds.ts.
 *
 * Lowered 5,000 -> 2,000 on 2026-09-11. Measured 1,023, so the old ceiling carried nearly five
 * times the actual figure in slack, and slack is what a creep hides in: this number exists to
 * catch a single constant dragging the panel's stylesheet into the first load, and it would
 * have let four times the current total arrive before saying anything. The sibling ceiling in
 * `package-quality.yml` had the same shape and let the package grow 19% unremarked.
 *
 * 2,000 leaves about 1KB, which is room for another small leaf file and not room for a
 * stylesheet.
 */
const MAX_PANEL_BYTES_IN_FIRST_LOAD = 2_000;

/**
 * Where the in-page panel's source lives, as a path substring.
 *
 * Named once because two accumulators read it and a rename must move both together — the whole point
 * of the companion assertion is that a rename can no longer pass silently.
 */
const PANEL_DIR = '/presenter/';

/**
 * The panel is tens of KB wherever it sits, so this floor is far below the truth and far above zero.
 * It exists to separate "almost none of the panel loads eagerly" — the thing being asserted — from
 * "PANEL_DIR matches nothing any more", which produces the identical 0 and the identical green tick.
 * CLAUDE.md names this file as a past false green for the adjacent reason: it asserted that a
 * bundler was FOUND rather than that the number meant anything.
 */
const MIN_PANEL_BYTES_SOMEWHERE = 20_000;

interface Chunk {
  readonly bytes: number;
  readonly imports?: readonly { readonly path: string; readonly kind: string }[];
  readonly inputs?: Readonly<Record<string, { readonly bytesInOutput: number }>>;
  readonly entryPoint?: string;
}

/**
 * Bundle the entry and report what a first load costs, and how much of that is the panel.
 *
 * Through esbuild's own API rather than its binary. Finding the binary used to mean globbing
 * `node_modules/.pnpm/esbuild@*` through `bash`, and on Windows that glob FINDS a file it cannot
 * run: the POSIX install swaps `bin/esbuild` for the native executable, the Windows one leaves a
 * Node shim there and puts the real `.exe` in `@esbuild/win32-x64`. So the path existed, the
 * check below reported a bundler, and the spawn died `ENOENT` on every Windows run.
 */
function firstLoad(): {
  bytes: number;
  panelBytes: number;
  panelBytesAnywhere: number;
  deferredBytes: number;
} {
  const meta = buildSync({
    entryPoints: [DIST_ENTRY],
    bundle: true,
    format: 'esm',
    splitting: true,
    minify: true,
    outdir: 'first-load', // splitting needs one; nothing is written
    write: false,
    logLevel: 'error',
    metafile: true,
  }).metafile;
  const chunks = meta.outputs as Record<string, Chunk>;
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
      if (source.includes(PANEL_DIR)) panelBytes += piece.bytesInOutput;
    }
  }
  let deferredBytes = 0;
  // The panel wherever it landed, first-load or not. `panelBytes` alone cannot tell "almost none of
  // the panel loads eagerly" from "the substring stopped matching", and 0 is the passing answer to
  // both — see the companion assertion below.
  let panelBytesAnywhere = 0;
  for (const [name, chunk] of Object.entries(chunks)) {
    if (!onTheWayIn.has(name) && name.endsWith('.js')) deferredBytes += chunk.bytes;
    for (const [source, piece] of Object.entries(chunk.inputs ?? {})) {
      if (source.includes(PANEL_DIR)) panelBytesAnywhere += piece.bytesInOutput;
    }
  }
  return { bytes, panelBytes, panelBytesAnywhere, deferredBytes };
}

describe('what a page downloads just for loading the SDK', () => {
  it('there is a build to measure, and a bundler that really bundled it', () => {
    // Without this the whole check passes on a missing build, reporting a first load of zero --
    // which reads as spectacular good news.
    expect(existsSync(DIST_ENTRY), `${DIST_ENTRY} is missing — run pnpm build`).toBe(true);
    expect(
      firstLoad().bytes,
      'the bundler produced nothing, so nothing below measured anything',
    ).toBeGreaterThan(0);
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
    const { panelBytes, panelBytesAnywhere } = firstLoad();
    // Asserted FIRST: if the panel cannot be found at all, the ceiling below is being cleared by a
    // measurement of nothing, and every later reader is told the panel is lean when it is missing.
    expect(
      panelBytesAnywhere,
      `only ${String(panelBytesAnywhere)} B of panel source was found in the bundle at all. ` +
        `This check keys on the path substring ${PANEL_DIR}; if that directory was renamed or ` +
        'moved, both counters read 0 and the ceiling below passes over a measurement of nothing.',
    ).toBeGreaterThan(MIN_PANEL_BYTES_SOMEWHERE);
    expect(
      panelBytes,
      `${String(panelBytes)} B of the panel is downloaded before anybody asks for it. This creeps ` +
        'back one constant at a time: naming a single value that lives beside the panel pulls in ' +
        'everything that value’s file imports. Put the value in a leaf file of its own instead, ' +
        'the way log-kinds.ts and layers.ts do.',
    ).toBeLessThanOrEqual(MAX_PANEL_BYTES_IN_FIRST_LOAD);
  });
});
