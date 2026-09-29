import { describe, expect, it } from 'vitest';
import { portForInit } from './init-port.js';

const OTHER_PROJECT = 'shop-1234abcd';
const RELOCATED = 4401;

function deps(holder: string | undefined, present = true, others: readonly string[] = []) {
  return {
    daemonProjects: () => Promise.resolve(holder === undefined ? others : [holder, ...others]),
    daemonPresent: () => Promise.resolve(present),
    pickPort: () => Promise.resolve(RELOCATED),
  };
}

describe('portForInit', () => {
  it('keeps a port the person typed', async () => {
    expect(await portForInit(4999, undefined, undefined, deps(OTHER_PROJECT))).toBe(4999);
  });

  it('keeps the port this project already recorded', async () => {
    expect(await portForInit(undefined, 4471, undefined, deps(OTHER_PROJECT))).toBe(4471);
  });

  it('takes the default when nothing is listening there', async () => {
    expect(
      await portForInit(undefined, undefined, undefined, deps(OTHER_PROJECT, false)),
    ).toBeUndefined();
  });

  // A second project on one machine was wired to the first project's daemon, and the bridge
  // refused every connect from its app.
  it("moves a new project off the default when another project's daemon holds it", async () => {
    expect(await portForInit(undefined, undefined, undefined, deps(OTHER_PROJECT))).toBe(RELOCATED);
  });

  it('keeps the default when the daemon there is this project’s own', async () => {
    expect(
      await portForInit(undefined, undefined, OTHER_PROJECT, deps(OTHER_PROJECT)),
    ).toBeUndefined();
  });

  it('keeps the default when the daemon there claims no project', async () => {
    expect(await portForInit(undefined, undefined, undefined, deps(undefined))).toBeUndefined();
  });

  it('keeps the default when the daemon there serves several projects, which it accepts', async () => {
    expect(
      await portForInit(
        undefined,
        undefined,
        undefined,
        deps(OTHER_PROJECT, true, ['blog-9f00aa11']),
      ),
    ).toBeUndefined();
  });
});
