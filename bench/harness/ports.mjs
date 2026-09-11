/**
 * The ports every bench harness agrees on. One place, because disagreeing about them has now
 * silently invalidated the benchmark twice.
 *
 * The failure mode is specific and it does not look like a failure: the fixture app's SDK dials one
 * port, the daemon a pass spawns listens on another, no browser session ever attaches, and every tool
 * call comes back "no browser session connected". The pass catches that as a per-flow error, writes a
 * summary of nulls, prints a headline like `detection 0/3 … => nullx`, and exits 0. Nothing is red.
 *
 * It happened first when adapters.mjs hardcoded 4455 while apps/bench-app/vite.config.ts defaulted to
 * 4460 — fixed by moving the adapter to 4460. It happened again immediately, because bench-all.mjs
 * still defaulted to 4455 and set it only on the fixture it spawned, so the passes it ran inherited
 * nothing and fell back to 4460 while the app had been told 4455. Two "sources of truth" plus a third
 * in the vite config is not a naming problem, it is a measurement-integrity problem.
 *
 * So: import from here. Do not write a port literal in a harness script.
 */

/**
 * The daemon port the bench fixture's SDK dials. 4460 is deliberate — apps/bench-app/vite.config.ts
 * picked it "so it never collides with reticle:4400 or the local mcp daemon", and that config is the
 * one this value has to agree with.
 */
export const RETICLE_PORT = process.env.RETICLE_PORT ?? process.env.BENCH_RETICLE_PORT ?? '4460';

/** The bench fixture app (apps/bench-app). */
export const DEMO_PORT = process.env.BENCH_DEMO_PORT ?? '4312';

/** The Express backend the fixture calls (apps/api). */
export const API_PORT = process.env.BENCH_API_PORT ?? '8787';

/** The URL the passes drive. Derived, so overriding BENCH_DEMO_PORT can't leave it pointing elsewhere. */
export const BENCH_URL = process.env.BENCH_URL ?? `http://localhost:${DEMO_PORT}/`;
