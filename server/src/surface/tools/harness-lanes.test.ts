/*
 * From a persona drive: a three-lane plan leased new browser contexts that started signed out, and
 * spent the whole run, twelve credits, on /login. Lanes start from what the caller's tab holds; when
 * that cannot be copied they take turns in the caller's tab instead.
 */
import { describe, expect, it } from 'vitest';
import type { ToolDeps } from './tool-kit.js';
import { laneSeed } from './harness-script.js';

const URL_ = 'http://localhost:4391/settings';
const deps = (realInput: unknown): ToolDeps =>
  ({ realInput, sessions: { resolve: () => ({ url: URL_ }) } }) as unknown as ToolDeps;

describe("a plan's lanes", () => {
  it("start from the caller's sign-in", async () => {
    const cookies = [{ name: 'sid', value: 'abc', domain: 'localhost', path: '/' }];
    const realInput = {
      isAvailableFor: () => Promise.resolve(true),
      storageState: (url: string) => Promise.resolve(URL_ === url ? { cookies } : undefined),
      applyStorageState: () => Promise.resolve(true),
    };
    expect(await laneSeed(deps(realInput), 's1', 'http://localhost:4391')).toEqual({ cookies });
  });

  it('take turns in the caller tab when its sign-in cannot be copied', async () => {
    expect(await laneSeed(deps(undefined), 's1', 'http://localhost:4391')).toBeUndefined();
  });
});
