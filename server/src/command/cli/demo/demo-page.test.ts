import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { sdkGraph, demoPageHtml, DemoTestId, DEMO_SIGNAL } from './demo-page.js';

/**
 * The resolver these tests run on, and why it is not the production one.
 *
 * `sdkGraph` resolves with `import.meta.resolve`, which honours the `import` condition and so picks
 * the ESM build a browser can load. Vitest's transform does not provide it, so the tests supply the
 * CommonJS resolver instead. That changes WHICH FILE zod resolves to and nothing else, and nothing
 * below asserts on a file extension: what is under test here is the DISCOVERY — whether the walk
 * finds everything the SDK reaches and mounts it — which is the half that drifts when a dependency
 * is added. That the ESM resolution itself works is not something a unit test can honestly claim;
 * it is settled by running the tour against a real browser.
 */
const resolveLikeNode = createRequire(import.meta.url).resolve;

/**
 * What can go wrong here is silent, which is why these are the assertions.
 *
 * The page loads the SDK through an import map. If discovery returns a map that is SHORT by one
 * specifier, nothing here throws — the page is served, the browser fails to resolve one module, the
 * SDK never runs, and the tour reports that the demo never dialled the bridge. That reads exactly
 * like a broken install, on the one command whose job is to show the product working.
 *
 * So the tests below ask whether the map COVERS what the code actually imports, rather than whether
 * it matches a list written down beside it. A list would be the defect, not the check.
 */
describe('the demo page can load the real SDK', () => {
  it('maps every bare specifier the SDK reaches, resolved to a mounted URL', () => {
    const graph = sdkGraph(resolveLikeNode);

    // A walk that silently stopped resolving would return an empty map, and every assertion about
    // the contents of an empty map passes.
    expect(graph.entry.length).toBeGreaterThan(0);
    expect(Object.keys(graph.imports).length).toBeGreaterThan(0);

    const prefixes = graph.mounts.map((m) => m.prefix);
    for (const url of [graph.entry, ...Object.values(graph.imports)]) {
      expect(
        prefixes.some((p) => url.startsWith(p)),
        `${url} is not under any mount, so the page would 404 on it`,
      ).toBe(true);
    }
  });

  it('reaches the packages the SDK is actually built on', () => {
    // Deliberately a FLOOR, not an equality: this says the walk got past the first hop and out of
    // our own scope, which is what distinguishes real discovery from a one-entry map that happens
    // to be non-empty. Pinning the exact set here would recreate the list the walk exists to remove.
    const { imports } = sdkGraph(resolveLikeNode);
    expect(Object.keys(imports)).toEqual(
      expect.arrayContaining(['@reticlehq/core', 'open-verification', 'zod']),
    );
  });

  it('serves a page that connects, with the controls the tour drives', () => {
    const graph = sdkGraph(resolveLikeNode);
    const html = demoPageHtml(graph, 'tok-123', 'ws://localhost:4400/reticle');

    expect(html).toContain(`data-testid="${DemoTestId.SAVE}"`);
    expect(html).toContain(`data-testid="${DemoTestId.STATUS}"`);
    // The token has to reach connect(): the daemon auto-provisions one and refuses a hello without
    // it, so a page built without it fails authentication and never appears as a session.
    expect(html).toContain('tok-123');
    // The consequence the tour declares has to be one the app actually fires, or the verdict is
    // `unknown` on a demo that worked.
    expect(html).toContain(DEMO_SIGNAL);
    expect(html).toContain(graph.entry);
  });
});
