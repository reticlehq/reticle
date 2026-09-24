/**
 * A test file is not the app under test, so it is never stamped (#995).
 *
 * Reported from the field, measured by the reporter on a React 19 + Vite 6 + Vitest 4 app of ~1250
 * jsdom tests:
 *
 *   without the plugin:  34 pass          218s
 *   with the plugin:     33 pass + 1 FAIL 411s
 *
 * Roughly double the wall clock, and a test that passes without instrumentation fails with it.
 * `apply: 'serve'` keeps the plugin out of `vite build` but not out of a test run, because Vitest
 * loads the project's vite config and counts as serve.
 *
 * What actually runs per test file is the SOURCE STAMPER: `shouldStamp` admits every JSX file
 * outside node_modules, so every `.test.tsx` went through Babel to have `data-reticle-source`
 * inserted into its JSX. Nothing reads those attributes on a test file - an agent inspects the app's
 * DOM, never a test's - so the work was pure cost, and inserting attributes into JSX is exactly the
 * kind of thing an assertion on rendered output notices.
 *
 * Cutting on test-file NAMES rather than on "are we under Vitest" is deliberate. `vitest-browser.ts`
 * records what happened the last time this was cut on the `VITEST` environment variable: it also
 * reads true when a Vitest suite BOOTS AN APP to test it, and `frameworks.integration.test.ts` -
 * which starts a real dev server per example app and asserts Reticle connects - went red in CI while
 * three local battery runs stayed green. A name check cannot make that mistake: the example apps'
 * own sources are not test files.
 */
import { describe, expect, it } from 'vitest';
import { reticle } from './index.js';

const transformOf = (plugin: unknown): ((code: string, id: string) => unknown) => {
  const hook = (plugin as { transform: (code: string, id: string) => unknown }).transform;
  return hook.bind(plugin);
};

const JSX = 'export const A = () => <div>hi</div>;\n';

describe('the source stamper and test files', () => {
  const plugin = reticle({ port: 4400 });
  const transform = transformOf(plugin);

  it('stamps an ordinary component, which is the whole point of the plugin', () => {
    const out = transform(JSX, '/app/src/Button.tsx') as { code?: string } | null;
    expect(out?.code ?? '').toContain('data-reticle-source');
  });

  it('leaves every shape of test file alone', () => {
    const paths = [
      '/app/src/Button.test.tsx',
      '/app/src/Button.spec.tsx',
      '/app/src/__tests__/Button.tsx',
      '/app/tests/Button.test.jsx',
    ];
    for (const path of paths) {
      const out = transform(JSX, path) as { code?: string } | null;
      expect(out?.code ?? '', `${path} was stamped`).not.toContain('data-reticle-source');
    }
  });

  /* A file that merely has "test" in its name is somebody's component, not a test. */
  it('does not mistake a component whose name contains the word', () => {
    for (const path of ['/app/src/TestBanner.tsx', '/app/src/latest.tsx', '/app/src/contest.tsx']) {
      const out = transform(JSX, path) as { code?: string } | null;
      expect(out?.code ?? '', `${path} was skipped`).toContain('data-reticle-source');
    }
  });
});
