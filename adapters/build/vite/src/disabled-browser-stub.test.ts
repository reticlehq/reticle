import { describe, expect, it } from 'vitest';
import { RETICLE_DISABLED_STUB_CODE } from './disabled-browser-stub.js';

/** The stub as a production bundle receives it: an ES module the app imports. */
async function loadStub(): Promise<Record<string, unknown>> {
  const url = `data:text/javascript,${encodeURIComponent(RETICLE_DISABLED_STUB_CODE)}`;
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}

describe('the production stub keeps the app working', () => {
  // `commitAndSignal(emitter, mutate, name)` wraps the APP's own write. The stub was an empty
  // function, so in a production build the write never ran and the call returned undefined: the
  // release shipped without its state changes. Reticle may do nothing in production; the app may not.
  it('commitAndSignal still runs the mutation and returns its result', async () => {
    const stub = await loadStub();
    const commitAndSignal = stub['commitAndSignal'] as (
      emitter: unknown,
      mutate: () => number,
      name: string,
    ) => number;
    let applied = 0;
    const result = commitAndSignal(
      {},
      () => {
        applied += 1;
        return 42;
      },
      'order:placed',
    );
    expect(applied).toBe(1);
    expect(result).toBe(42);
  });
});
