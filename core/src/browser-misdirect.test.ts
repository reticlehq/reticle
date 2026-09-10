import { describe, expect, it } from 'vitest';
import { install, connect, reticle } from './index.js';

/**
 * `@reticlehq/core` is the wire contract, not the browser SDK — but its name reads like the thing you
 * install, so agents and snippets keep reaching for `import { install, reticle } from '@reticlehq/core'`.
 * Reported from the field: that import blanked a Vite app with a bare SyntaxError ("does not provide
 * an export named 'install'"), which names neither the mistake nor the package that has those APIs.
 *
 * The package is NOT renamed. It is made self-explaining: the names exist, so the module still loads,
 * and the failure that follows says where the browser API actually lives.
 */
describe('browser APIs imported from @reticlehq/core', () => {
  it('names the packages that actually have them, instead of failing as a bare SyntaxError', () => {
    for (const call of [() => install(), () => connect(), () => reticle.connect()]) {
      expect(call).toThrow(/@reticlehq\/browser/);
      expect(call).toThrow(/@reticlehq\/vite-plugin/);
      expect(call).toThrow(/@reticlehq\/core/);
    }
  });
});
