/**
 * The spec body's `t` must carry the matchers, checked by the type-checker rather than at runtime.
 *
 * `reticleTest` is a public export and its callback parameter was typed as a context declaring only
 * `invoke`, so every TypeScript spec written against the documented API failed to compile on its
 * first matcher while running correctly. Nothing caught it: this repo's own spec is `.mjs`, which
 * type-checks none of it, and a runtime test cannot see the problem at all because the object
 * handed over at runtime always had the matchers on it.
 *
 * So this file's real assertion is that `pnpm typecheck` passes with it present. The runtime
 * expectations below exist so the file is also a test rather than a comment, and so the registry
 * still proves it accepted what it was given.
 */
import { describe, expect, it } from 'vitest';
import { reticleTest } from './spec.js';
import { clearRegistry, getRegistered } from './registry.js';
import type { SpecContext } from './types.js';

describe('the `t` handed to a spec', () => {
  it('exposes the matchers, so a documented TypeScript spec type-checks', () => {
    clearRegistry();

    // Written exactly as a user would write it, and deliberately never run: the point is that the
    // compiler accepts these member accesses. A spec body is only executed by the runner.
    reticleTest('a documented TypeScript spec', async (t) => {
      await t.expectText('Saved');
      await t.expectNoConsoleErrors();
      await t.expectAbsent({ role: 'alert' });
      await t.state('session');
      await t.clock.freeze();
    });

    const specs = getRegistered();
    expect(specs.map((s) => s.name)).toEqual(['a documented TypeScript spec']);
    clearRegistry();
  });

  it('is the full context, not a narrower view of it', () => {
    // If `SpecContext` is ever narrowed back to `{ invoke }`, this assignment stops compiling —
    // which is the whole failure, caught at the only layer that can see it.
    const usesMatchers: (t: SpecContext) => void = (t) => {
      void t.expectText;
      void t.actAndWait;
      void t.invoke;
    };
    expect(typeof usesMatchers).toBe('function');
  });
});
