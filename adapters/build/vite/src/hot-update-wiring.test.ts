import { describe, expect, it } from 'vitest';
import { connectModuleSource } from './index.js';

/**
 * The injected connect module is the ONLY place in a Vite app that can see hot updates.
 *
 * `import.meta.hot` exists per module and only for modules Vite serves through its own transform
 * pipeline. The SDK is a dependency: it is pre-bundled by the optimizer and gets no hot context, so
 * it cannot observe an update by reading `import.meta.hot` of its own module however it is written.
 * This module can, and it is already generated for every Vite app — so it hands the channel over and
 * the SDK owns everything after that, including which event names it cares about.
 *
 * Guarded because the wiring is invisible when it breaks: with no hot channel the SDK degrades
 * silently to "no edits observed", which is exactly what it is supposed to do everywhere else.
 */

describe('the injected connect module hands Vite hot updates to the SDK', () => {
  it('passes import.meta.hot to the SDK when Vite provides one', () => {
    const source = connectModuleSource({});
    expect(source).toContain('import.meta.hot');
    expect(source).toContain('observeHotUpdates');
  });

  it('guards the call, so a build without a hot context does not throw on load', () => {
    expect(connectModuleSource({})).toMatch(/if\s*\(import\.meta\.hot\)/);
  });

  it('wires it after connect(), so an update that arrives first is not reported into nothing', () => {
    const source = connectModuleSource({});
    expect(source.indexOf('observeHotUpdates')).toBeGreaterThan(source.indexOf('reticle.connect('));
  });
});
